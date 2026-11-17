"""Local streaming PCM recognition worker; stdout is a bounded NDJSON protocol."""

import argparse
import json
import pathlib
import sys

MAX_TEXT = 20_000
MAX_AUDIO = 16_000 * 2 * 65


def recognize(stream, recognizer, emit):
    """Recognize PCM16 input without accumulating raw audio in memory."""
    committed = []
    previous = ""
    received = 0
    while True:
        chunk = stream.read(4000)
        if not chunk:
            break
        if len(chunk) % 2:
            raise ValueError("Input must contain complete PCM16 samples")
        received += len(chunk)
        if received > MAX_AUDIO:
            raise ValueError("Recording exceeds the audio limit")
        partial = ""
        if recognizer.AcceptWaveform(chunk):
            text = json.loads(recognizer.Result()).get("text", "").strip()
            if text:
                committed.append(text)
        else:
            partial = json.loads(recognizer.PartialResult()).get("partial", "").strip()
        draft = " ".join([*committed, partial]).strip()
        if len(draft) > MAX_TEXT:
            raise ValueError("Transcript exceeds the text limit")
        if draft != previous:
            emit({"type": "partial", "text": draft})
            previous = draft
    tail = json.loads(recognizer.FinalResult()).get("text", "").strip()
    final = " ".join([*committed, tail]).strip()
    if len(final) > MAX_TEXT:
        raise ValueError("Transcript exceeds the text limit")
    emit({"type": "final", "text": final})


def emit(message):
    """Flush one UTF-8 protocol message without logging audio."""
    print(json.dumps(message, ensure_ascii=False), flush=True)


def main():
    """Load only an explicit local model and recognize stdin until EOF."""
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True)
    args = parser.parse_args()
    try:
        if not pathlib.Path(args.model).is_dir():
            raise ValueError("The explicit local model directory does not exist")
        from vosk import KaldiRecognizer, Model, SetLogLevel
        SetLogLevel(-1)
        recognizer = KaldiRecognizer(Model(args.model), 16000)
        emit({"type": "ready"})
        recognize(sys.stdin.buffer, recognizer, emit)
        return 0
    except Exception as error:
        emit({"type": "error", "message": str(error)})
        return 1


if __name__ == "__main__":
    sys.exit(main())
