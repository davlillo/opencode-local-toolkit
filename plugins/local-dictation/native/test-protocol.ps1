# Deterministic protocol check against the retained synthetic fixture.
# Exits non-zero on any failure. No microphone is used.
param(
  [string]$Exe = (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "build\dictation-core.exe"),
  [string]$Fixture = "$env:LOCALAPPDATA\Temp\opencode\live-provision-20261116T030015Z-1b857a87\synthetic-es-helena.pcm",
  [string]$Model = "$env:LOCALAPPDATA\opencode-asr\models\vosk-model-small-es-0.42",
  [string[]]$Words = @("prueba", "dictado", "espanol", "codigo", "mensaje"),
  [int]$TimeoutSeconds = 120
)

$ErrorActionPreference = "Stop"

function Sanitize([string]$text) {
  # Case-, accent- and punctuation-insensitive comparison.
  $normalized = $text.Normalize([Text.NormalizationForm]::FormD)
  $builder = New-Object Text.StringBuilder
  foreach ($character in $normalized.ToCharArray()) {
    if ([Globalization.CharUnicodeInfo]::GetUnicodeCategory($character) -ne "NonSpacingMark") {
      [void]$builder.Append([char]::ToLowerInvariant($character))
    }
  }
  return ($builder.ToString() -replace "[^a-z0-9]+", " ").Trim()
}

function Assert([bool]$condition, [string]$message) {
  if (-not $condition) { throw "FAIL: $message" }
}

foreach ($path in @($Exe, $Fixture)) {
  Assert (Test-Path $path) "missing file: $path"
}
Assert (Test-Path $Model -PathType Container) "missing model directory: $Model"

$start = [Diagnostics.Stopwatch]::StartNew()
$info = New-Object Diagnostics.ProcessStartInfo
$info.FileName = $Exe
$info.Arguments = "--model `"$Model`""
$info.RedirectStandardInput = $true
$info.RedirectStandardOutput = $true
$info.RedirectStandardError = $true
$info.UseShellExecute = $false
# Protocol text is raw UTF-8; without this the default console code page mangles it.
$info.StandardOutputEncoding = [Text.Encoding]::UTF8
$info.StandardErrorEncoding = [Text.Encoding]::UTF8

$process = New-Object Diagnostics.Process
$process.StartInfo = $info
[void]$process.Start()

$lines = New-Object Collections.Generic.List[string]
$readyMs = $null
$stderr = $process.StandardError.ReadToEndAsync()

$audio = [IO.File]::ReadAllBytes($Fixture)
$stdin = $process.StandardInput.BaseStream

try {
  $stdin.Write($audio, 0, $audio.Length)
  $stdin.Flush()
  $stdin.Close()
  while ($true) {
    $line = $process.StandardOutput.ReadLine()
    if ($null -eq $line) { break }
    if ($line.Length -gt 0) {
      $lines.Add($line)
      if ($null -eq $readyMs -and $line -match '"type"\s*:\s*"ready"') { $readyMs = $start.ElapsedMilliseconds }
    }
  }
} finally {
  if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
    $process.Kill()
    throw "FAIL: the worker did not exit within $TimeoutSeconds seconds."
  }
  $start.Stop()
}

$exitCode = $process.ExitCode
$messages = $lines | ForEach-Object { $_ | ConvertFrom-Json }
$errors = @($messages | Where-Object { $_.type -eq "error" })
if ($errors.Count -gt 0) { throw "FAIL: worker reported: $($errors[0].message)" }

Assert ($exitCode -eq 0) "expected exit code 0, received $exitCode"
Assert ($lines[0] -match '"type"\s*:\s*"ready"') "the first message must be ready"
Assert (@($messages | Where-Object { $_.type -eq "ready" }).Count -eq 1) "expected exactly one ready message"
Assert ($null -ne $readyMs) "ready was never observed"

$partials = @($messages | Where-Object { $_.type -eq "partial" })
$nonEmpty = @($partials | Where-Object { -not [string]::IsNullOrWhiteSpace($_.text) })
Assert ($nonEmpty.Count -ge 1) "expected at least one non-empty partial before EOF"

$finals = @($messages | Where-Object { $_.type -eq "final" })
Assert ($finals.Count -eq 1) "expected exactly one final message, received $($finals.Count)"
Assert (($lines | Select-Object -Last 1) -match '"type"\s*:\s*"final"') "final must be the last message"

$finalText = [string]$finals[0].text
$normalizedFinal = Sanitize $finalText
$missing = @($Words | Where-Object { -not $normalizedFinal.Contains((Sanitize $_)) })
foreach ($word in $missing) { Write-Host "missing word: $word" }
Assert ($missing.Count -eq 0) "final text is missing $($missing.Count) expected word(s)"

Write-Host ("PASS ready={0}ms total={1}ms partials={2} final={3}ms" -f `
  $readyMs, $start.ElapsedMilliseconds, $nonEmpty.Count, $start.ElapsedMilliseconds)
Write-Host "final text: $finalText"
exit 0
