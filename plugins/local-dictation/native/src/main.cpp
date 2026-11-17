// Local dictation recognizer core.
//
// Reads raw PCM (signed 16-bit little-endian, mono, 16000 Hz) from stdin and
// writes one NDJSON protocol object per line to stdout, replacing the Python
// worker with an identical byte contract:
//
//   {"type":"ready"}                    once, after the model is loaded
//   {"type":"partial","text":"<draft>"} whenever the joined draft text changes
//   {"type":"final","text":"<text>"}    exactly once, at stdin EOF
//   {"type":"error","message":"<text>"} on failure, then a non-zero exit
//
// libvosk.dll is loaded dynamically, so no import library is required.

#include <windows.h>

#include <fcntl.h>
#include <io.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "vosk_api.h"

namespace {

// Mirrors the Python worker: 20k characters of transcript and 65 s of audio
// (16000 * 2 bytes * 65). Both bounds exist so a runaway stream cannot
// exhaust memory.
constexpr size_t kMaxText = 20000;
constexpr size_t kMaxAudio = 16000u * 2u * 65u;
constexpr size_t kChunk = 4000;
constexpr size_t kMaxMessage = 4096;

constexpr wchar_t kDllName[] = L"libvosk.dll";

using ModelNewFn = VoskModel *(*)(const char *);
using ModelFreeFn = void (*)(VoskModel *);
using RecognizerNewFn = VoskRecognizer *(*)(VoskModel *, float);
using RecognizerAcceptFn = int (*)(VoskRecognizer *, const char *, int);
using RecognizerResultFn = const char *(*)(VoskRecognizer *);
using RecognizerFreeFn = void (*)(VoskRecognizer *);
using SetLogLevelFn = void (*)(int);

struct VoskApi {
  HMODULE module = nullptr;
  ModelNewFn model_new = nullptr;
  ModelFreeFn model_free = nullptr;
  RecognizerNewFn recognizer_new = nullptr;
  RecognizerAcceptFn accept_waveform = nullptr;
  RecognizerResultFn partial_result = nullptr;
  RecognizerResultFn result = nullptr;
  RecognizerResultFn final_result = nullptr;
  RecognizerFreeFn recognizer_free = nullptr;
  SetLogLevelFn set_log_level = nullptr;
};

std::string g_previous_draft;

void write_all(const std::string &text) {
  HANDLE out = GetStdHandle(STD_OUTPUT_HANDLE);
  const char *data = text.data();
  size_t left = text.size();
  while (left > 0) {
    DWORD written = 0;
    if (!WriteFile(out, data, static_cast<DWORD>(left), &written, nullptr) || written == 0) return;
    data += written;
    left -= written;
  }
}

std::string escape_json(const std::string &text) {
  std::string out;
  out.reserve(text.size() + 8);
  for (unsigned char c : text) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (c < 0x20) {
          char buffer[8];
          std::snprintf(buffer, sizeof buffer, "\\u%04x", c);
          out += buffer;
        } else {
          out += static_cast<char>(c);
        }
    }
  }
  return out;
}

void emit(const std::string &body) { write_all(body + "\n"); }

void emit_ready() { emit("{\"type\":\"ready\"}"); }

void emit_text(const char *type, const std::string &text) {
  emit(std::string("{\"type\":\"") + type + "\",\"text\":\"" + escape_json(text) + "\"}");
}

void emit_error(const std::string &message) {
  std::string bounded = message.substr(0, kMaxMessage);
  emit("{\"type\":\"error\",\"message\":\"" + escape_json(bounded) + "\"}");
}

// Collapses every whitespace run to a single space and trims the ends.
std::string normalize(const std::string &text) {
  std::string out;
  out.reserve(text.size());
  bool pending_space = false;
  for (char c : text) {
    if (c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v') {
      pending_space = !out.empty();
    } else {
      if (pending_space) out += ' ';
      pending_space = false;
      out += c;
    }
  }
  return out;
}

size_t utf8_length(const std::string &text) {
  size_t count = 0;
  for (unsigned char c : text) {
    if ((c & 0xC0) != 0x80) ++count;
  }
  return count;
}

// Minimal reader for the flat objects Vosk returns: {"text":"..."} or
// {"partial":"..."}. Values are copied out and unescaped before the next call
// because the recognizer owns the returned buffer.
bool json_string_field(const char *json, const char *key, std::string *out) {
  if (!json) return false;
  const std::string needle = std::string("\"") + key + "\"";
  const char *cursor = std::strstr(json, needle.c_str());
  if (!cursor) return false;
  cursor += needle.size();
  while (*cursor == ' ' || *cursor == '\t' || *cursor == '\n' || *cursor == '\r') ++cursor;
  if (*cursor != ':') return false;
  ++cursor;
  while (*cursor == ' ' || *cursor == '\t' || *cursor == '\n' || *cursor == '\r') ++cursor;
  if (*cursor != '"') return false;
  ++cursor;

  std::string value;
  while (*cursor && *cursor != '"') {
    if (*cursor != '\\') {
      value += *cursor++;
      continue;
    }
    ++cursor;
    switch (*cursor) {
      case 'n': value += '\n'; ++cursor; break;
      case 'r': value += '\r'; ++cursor; break;
      case 't': value += '\t'; ++cursor; break;
      case 'b': value += '\b'; ++cursor; break;
      case 'f': value += '\f'; ++cursor; break;
      case 'u': {
        if (std::strlen(cursor + 1) < 4) return false;
        unsigned code = static_cast<unsigned>(std::strtoul(std::string(cursor + 1, 4).c_str(), nullptr, 16));
        cursor += 5;
        if (code >= 0xD800 && code <= 0xDBFF && cursor[0] == '\\' && cursor[1] == 'u') {
          unsigned low = static_cast<unsigned>(std::strtoul(std::string(cursor + 2, 4).c_str(), nullptr, 16));
          if (low >= 0xDC00 && low <= 0xDFFF) {
            code = 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00);
            cursor += 6;
          }
        }
        if (code < 0x80) {
          value += static_cast<char>(code);
        } else if (code < 0x800) {
          value += static_cast<char>(0xC0 | (code >> 6));
          value += static_cast<char>(0x80 | (code & 0x3F));
        } else if (code < 0x10000) {
          value += static_cast<char>(0xE0 | (code >> 12));
          value += static_cast<char>(0x80 | ((code >> 6) & 0x3F));
          value += static_cast<char>(0x80 | (code & 0x3F));
        } else {
          value += static_cast<char>(0xF0 | (code >> 18));
          value += static_cast<char>(0x80 | ((code >> 12) & 0x3F));
          value += static_cast<char>(0x80 | ((code >> 6) & 0x3F));
          value += static_cast<char>(0x80 | (code & 0x3F));
        }
        break;
      }
      default: value += *cursor++; break;
    }
  }
  *out = normalize(value);
  return true;
}

bool is_directory(const wchar_t *path) {
  const DWORD attributes = GetFileAttributesW(path);
  return attributes != INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
}

std::vector<std::wstring> dll_candidates() {
  std::vector<std::wstring> candidates;
  wchar_t exe_path[MAX_PATH * 4];
  const DWORD length = GetModuleFileNameW(nullptr, exe_path, static_cast<DWORD>(std::size(exe_path)));
  if (length > 0) {
    std::wstring directory(exe_path, length);
    const size_t slash = directory.find_last_of(L"\\/");
    if (slash != std::wstring::npos) {
      directory.resize(slash + 1);
      candidates.push_back(directory + kDllName);
    }
  }
  wchar_t overridden[MAX_PATH * 4];
  const DWORD override_length = GetEnvironmentVariableW(L"DICTATION_CORE_VOSK_DLL", overridden,
                                                        static_cast<DWORD>(std::size(overridden)));
  if (override_length > 0 && override_length < std::size(overridden)) {
    candidates.emplace_back(overridden, override_length);
  }
  wchar_t local_app_data[MAX_PATH * 4];
  const DWORD local_length = GetEnvironmentVariableW(L"LOCALAPPDATA", local_app_data,
                                                     static_cast<DWORD>(std::size(local_app_data)));
  if (local_length > 0 && local_length < std::size(local_app_data)) {
    std::wstring fallback(local_app_data, local_length);
    fallback += L"\\opencode-asr\\venv-vosk\\Lib\\site-packages\\vosk\\";
    fallback += kDllName;
    candidates.push_back(fallback);
  }
  return candidates;
}

std::string narrow(const std::wstring &text) {
  if (text.empty()) return {};
  const int size = WideCharToMultiByte(CP_UTF8, 0, text.c_str(), static_cast<int>(text.size()),
                                       nullptr, 0, nullptr, nullptr);
  std::string out(static_cast<size_t>(size), '\0');
  WideCharToMultiByte(CP_UTF8, 0, text.c_str(), static_cast<int>(text.size()), out.data(), size,
                      nullptr, nullptr);
  return out;
}

std::wstring widen(const std::string &text) {
  if (text.empty()) return {};
  const int size = MultiByteToWideChar(CP_UTF8, 0, text.c_str(), static_cast<int>(text.size()), nullptr, 0);
  std::wstring out(static_cast<size_t>(size), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, text.c_str(), static_cast<int>(text.size()), out.data(), size);
  return out;
}

bool load_api(VoskApi *api) {
  const wchar_t *expected[3] = {
    L"\"<directory of dictation-core.exe>\\libvosk.dll\"",
    L"\"%DICTATION_CORE_VOSK_DLL%\" (environment variable, full DLL path)",
    L"\"%LOCALAPPDATA%\\opencode-asr\\venv-vosk\\Lib\\site-packages\\vosk\\libvosk.dll\"",
  };
  std::vector<std::wstring> tried;
  for (const std::wstring &candidate : dll_candidates()) {
    // The altered search path also resolves libvosk's MinGW runtime next to it.
    api->module = LoadLibraryExW(candidate.c_str(), nullptr, LOAD_WITH_ALTERED_SEARCH_PATH);
    if (api->module) break;
    tried.push_back(candidate);
  }
  if (!api->module) {
    std::string message = "Cannot load libvosk.dll. Expected, in order: ";
    for (size_t i = 0; i < std::size(expected); ++i) {
      message += narrow(expected[i]);
      message += i + 1 == std::size(expected) ? ". " : "; ";
    }
    message += "Build with -CopyVoskDll or set DICTATION_CORE_VOSK_DLL.";
    emit_error(message);
    return false;
  }

  struct {
    const char *name;
    void **slot;
  } const symbols[] = {
    {"vosk_model_new", reinterpret_cast<void **>(&api->model_new)},
    {"vosk_model_free", reinterpret_cast<void **>(&api->model_free)},
    {"vosk_recognizer_new", reinterpret_cast<void **>(&api->recognizer_new)},
    {"vosk_recognizer_accept_waveform", reinterpret_cast<void **>(&api->accept_waveform)},
    {"vosk_recognizer_result", reinterpret_cast<void **>(&api->result)},
    {"vosk_recognizer_partial_result", reinterpret_cast<void **>(&api->partial_result)},
    {"vosk_recognizer_final_result", reinterpret_cast<void **>(&api->final_result)},
    {"vosk_recognizer_free", reinterpret_cast<void **>(&api->recognizer_free)},
    {"vosk_set_log_level", reinterpret_cast<void **>(&api->set_log_level)},
  };
  for (const auto &symbol : symbols) {
    *symbol.slot = reinterpret_cast<void *>(GetProcAddress(api->module, symbol.name));
    if (!*symbol.slot) {
      emit_error(std::string("libvosk.dll is missing the symbol ") + symbol.name + ".");
      return false;
    }
  }
  return true;
}

// Fills `buffer` up to kChunk bytes unless EOF arrives first. Raw pipe reads
// can split a PCM16 sample, so short reads are padded here; a real odd-length
// stream is rejected by the caller.
size_t read_chunk(char *buffer) {
  size_t filled = 0;
  while (filled < kChunk) {
    const int got = static_cast<int>(std::fread(buffer + filled, 1, kChunk - filled, stdin));
    if (got <= 0) break;
    filled += static_cast<size_t>(got);
  }
  return filled;
}

int run_worker(VoskApi *api, VoskRecognizer *recognizer) {
  std::string committed;
  size_t received = 0;
  char buffer[kChunk];

  for (;;) {
    const size_t got = read_chunk(buffer);
    if (got == 0) break;
    if (got % 2 != 0) {
      emit_error("Input must contain complete PCM16 samples");
      return 1;
    }
    received += got;
    if (received > kMaxAudio) {
      emit_error("Recording exceeds the audio limit");
      return 1;
    }

    const int accepted = api->accept_waveform(recognizer, buffer, static_cast<int>(got));
    if (accepted < 0) {
      emit_error("libvosk failed while decoding audio");
      return 1;
    }

    std::string partial;
    if (accepted > 0) {
      std::string text;
      if (json_string_field(api->result(recognizer), "text", &text) && !text.empty()) {
        if (!committed.empty()) committed += ' ';
        committed += text;
      }
    } else {
      json_string_field(api->partial_result(recognizer), "partial", &partial);
    }

    std::string draft = normalize(committed + " " + partial);
    if (utf8_length(draft) > kMaxText) {
      emit_error("Transcript exceeds the text limit");
      return 1;
    }
    if (!draft.empty() && draft != g_previous_draft) {
      emit_text("partial", draft);
      g_previous_draft = draft;
    }
  }

  std::string tail;
  json_string_field(api->final_result(recognizer), "text", &tail);
  std::string final_text = normalize(committed + " " + tail);
  if (utf8_length(final_text) > kMaxText) {
    emit_error("Transcript exceeds the text limit");
    return 1;
  }
  emit_text("final", final_text);
  return 0;
}

bool parse_arguments(int argc, char **argv, std::wstring *model) {
  bool have_model = false;
  for (int index = 1; index < argc; ++index) {
    const std::string argument = argv[index];
    std::string value;
    if (argument == "--model") {
      if (index + 1 >= argc) {
        emit_error("Argument --model requires a directory");
        return false;
      }
      value = argv[++index];
    } else if (argument.rfind("--model=", 0) == 0) {
      value = argument.substr(8);
    } else {
      emit_error("Unknown argument: " + argument);
      return false;
    }
    if (value.empty()) {
      emit_error("Argument --model requires a directory");
      return false;
    }
    *model = widen(value);
    have_model = true;
  }
  if (!have_model) {
    emit_error("Argument --model is required");
    return false;
  }
  return true;
}

}  // namespace

int main(int argc, char **argv) {
  // Binary mode matters twice: text mode splits reads on line endings and
  // treats an audio byte 0x1A as end-of-file.
  _setmode(_fileno(stdin), _O_BINARY);
  _setmode(_fileno(stdout), _O_BINARY);

  std::wstring model_path;
  if (!parse_arguments(argc, argv, &model_path)) return 1;

  if (!is_directory(model_path.c_str())) {
    emit_error("The explicit local model directory does not exist");
    return 1;
  }

  VoskApi api;
  if (!load_api(&api)) return 1;

  api.set_log_level(-1);
  VoskModel *model = api.model_new(narrow(model_path).c_str());
  if (!model) {
    emit_error("Cannot load the Vosk model from the given directory");
    return 1;
  }
  VoskRecognizer *recognizer = api.recognizer_new(model, 16000.0F);
  if (!recognizer) {
    emit_error("Cannot create the Vosk recognizer");
    api.model_free(model);
    return 1;
  }

  emit_ready();
  const int status = run_worker(&api, recognizer);

  api.recognizer_free(recognizer);
  api.model_free(model);
  return status;
}
