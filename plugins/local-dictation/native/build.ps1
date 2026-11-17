# Builds native/build/dictation-core.exe with the Visual Studio toolchain.
# Usage: powershell -ExecutionPolicy Bypass -File native/build.ps1
param(
  [switch]$CopyVoskDll,
  [string]$VoskDll
)

$ErrorActionPreference = "Stop"
$native = Split-Path -Parent $MyInvocation.MyCommand.Path
$build = Join-Path $native "build"
New-Item -ItemType Directory -Force $build | Out-Null
$exe = Join-Path $build "dictation-core.exe"
if (Test-Path $exe) { Remove-Item $exe -Force }

function Resolve-VcVars {
  $candidates = @()
  $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
  if (Test-Path $vswhere) {
    # -sort requires an explicit -version range.
    $roots = & $vswhere -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
      -property installationPath -sort -version "[17.0,99.0)" 2>$null
    foreach ($root in $roots) { if ($root) { $candidates += (Join-Path $root "VC\Auxiliary\Build\vcvars64.bat") } }
  }
  foreach ($edition in "BuildTools", "Community", "Professional", "Enterprise") {
    $candidates += "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\$edition\VC\Auxiliary\Build\vcvars64.bat"
  }
  foreach ($candidate in $candidates) { if (Test-Path $candidate) { return $candidate } }
  throw "vcvars64.bat was not found. Install the Visual Studio C++ build tools."
}

function Resolve-VoskDll {
  if ($VoskDll) {
    if (-not (Test-Path $VoskDll)) { throw "The given --VoskDll does not exist: $VoskDll" }
    return $VoskDll
  }
  if ($env:DICTATION_CORE_VOSK_DLL) {
    if (-not (Test-Path $env:DICTATION_CORE_VOSK_DLL)) {
      throw "DICTATION_CORE_VOSK_DLL does not exist: $env:DICTATION_CORE_VOSK_DLL"
    }
    return $env:DICTATION_CORE_VOSK_DLL
  }
  $fallback = Join-Path $env:LOCALAPPDATA "opencode-asr\venv-vosk\Lib\site-packages\vosk\libvosk.dll"
  if (Test-Path $fallback) { return $fallback }
  return $null
}

$vcvars = Resolve-VcVars
$cmake = Join-Path $env:ProgramFiles "CMake\bin\cmake.exe"
if (-not (Test-Path $cmake)) {
  $cmake = (Get-Command cmake -ErrorAction SilentlyContinue).Source
}
if (-not $cmake) { throw "cmake was not found." }

$steps = @(
  "call `"$vcvars`" >nul",
  "`"$cmake`" -S `"$native`" -B `"$build`" -G `"NMake Makefiles`" -DCMAKE_BUILD_TYPE=Release",
  "`"$cmake`" --build `"$build`" --config Release"
) -join " && "
& cmd.exe /d /c $steps
if ($LASTEXITCODE -ne 0) { throw "Build failed with exit code $LASTEXITCODE." }
if (-not (Test-Path $exe)) { throw "Build did not produce $exe" }

# Record the compiler version so a build log is self-describing, regardless of
# the toolchain's UI language.
$banner = & cmd.exe /d /c "call `"$vcvars`" >nul && cl 2>&1"
$banner | Select-String -Pattern "19\.\d+\.\d+" | ForEach-Object { Write-Host "Compiler: $_" }

# libvosk.dll plus its MinGW runtime stay out of the source tree and are only
# placed beside the executable. Resolved at runtime, not compiled in.
$dll = Resolve-VoskDll
if ($dll) {
  $source = Split-Path -Parent $dll
  foreach ($name in "libvosk.dll", "libstdc++-6.dll", "libgcc_s_seh-1.dll", "libwinpthread-1.dll") {
    $from = Join-Path $source $name
    if (Test-Path $from) { Copy-Item $from (Join-Path $build $name) -Force }
  }
  Write-Host "Copied libvosk runtime from $source"
} elseif ($CopyVoskDll) {
  Write-Warning "libvosk.dll was not found; the binary needs DICTATION_CORE_VOSK_DLL at runtime."
}

Write-Host "Built $exe"
