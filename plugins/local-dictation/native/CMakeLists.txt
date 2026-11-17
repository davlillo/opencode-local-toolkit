cmake_minimum_required(VERSION 3.20)
project(dictation-core LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Static CRT keeps the executable portable; only the Windows SDK and libvosk
# remain as dependencies.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

add_executable(dictation-core src/main.cpp)

target_include_directories(dictation-core PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}")

if(MSVC)
  target_compile_options(dictation-core PRIVATE /W4 /permissive- /utf-8)
  # main() reads and writes raw bytes through the binary stdio streams.
  target_compile_definitions(dictation-core PRIVATE _CRT_SECURE_NO_WARNINGS)
endif()

# libvosk is loaded with LoadLibraryW, so there is nothing to link.
set_target_properties(dictation-core PROPERTIES OUTPUT_NAME "dictation-core")

set(CMAKE_RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/build")
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_CURRENT_SOURCE_DIR}/build")
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY_DEBUG "${CMAKE_CURRENT_SOURCE_DIR}/build")
