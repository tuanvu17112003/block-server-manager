# Launches the packaged Block Server Manager for Playwright-MCP (CDP) testing with an isolated profile,
# or stops it again. Never uses the developer's real .app-data / legacy Tauri data.
#
#   powershell -ExecutionPolicy Bypass -File scripts/start-test-app.ps1 -Port 9222
#   powershell -ExecutionPolicy Bypass -File scripts/start-test-app.ps1 -Stop -Port 9222
#
# Output: a JSON line with pid, port, profileRoot, dataRoot, cdpUrl, exe. The app keeps running after
# this script exits; connect Playwright MCP with --cdp-endpoint=http://127.0.0.1:<port>.
param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [string]$ExePath,
  [string]$ProfileRoot,
  [int]$Port = 9222,
  [switch]$Stop
)

$ErrorActionPreference = 'Stop'

function Resolve-TestExe {
  param([string]$Root, [string]$Explicit)
  if ($Explicit) { return (Resolve-Path -LiteralPath $Explicit).Path }
  $candidates = @(
    (Join-Path $Root 'release\win-unpacked\Block Server Manager.exe'),
    (Join-Path $Root 'release\win-unpacked\mc-server-manager.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Block Server Manager\Block Server Manager.exe')
  )
  foreach ($candidate in $candidates) { if (Test-Path -LiteralPath $candidate) { return $candidate } }
  throw "Packaged app not found. Run 'npm run pack:dir' first (or pass -ExePath)."
}

function Read-LaunchRecord {
  param([string]$Root, [int]$Port)
  if ($Root) {
    $recordPath = Join-Path $Root 'launch.json'
    if (Test-Path -LiteralPath $recordPath) { return (Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json) }
    return $null
  }
  $records = Get-ChildItem -Path $env:TEMP -Filter 'msm-pw-*' -Directory -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending
  foreach ($dir in $records) {
    $recordPath = Join-Path $dir.FullName 'launch.json'
    if (-not (Test-Path -LiteralPath $recordPath)) { continue }
    $record = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
    if ($record.port -eq $Port) { return $record }
  }
  return $null
}

function Stop-TestApp {
  param([object]$Record)
  if (-not $Record) { Write-Output '{"stopped":false,"reason":"no launch record found"}'; return }
  $alive = Get-Process -Id $Record.pid -ErrorAction SilentlyContinue
  if ($alive) {
    taskkill /PID $Record.pid /T /F *> $null
    Start-Sleep -Milliseconds 800
  }
  $remaining = Get-Process -Id $Record.pid -ErrorAction SilentlyContinue
  $javas = @(Get-CimInstance Win32_Process -Filter "Name='java.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match [regex]::Escape($Record.profileRoot) })
  Write-Output (([pscustomobject]@{
    stopped = -not [bool]$remaining
    pid = $Record.pid
    profileRoot = $Record.profileRoot
    orphanJava = $javas.Count
  } | ConvertTo-Json -Compress))
}

if ($Stop) {
  Stop-TestApp (Read-LaunchRecord -Root $ProfileRoot -Port $Port)
  return
}

if (-not $ProfileRoot) {
  $ProfileRoot = Join-Path $env:TEMP ('msm-pw-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
}
$profileDir = Join-Path $ProfileRoot 'profile'
$legacyDir = Join-Path $ProfileRoot 'legacy-empty'
New-Item -ItemType Directory -Force -Path $profileDir, $legacyDir | Out-Null
$recordPath = Join-Path $ProfileRoot 'launch.json'
if (Test-Path -LiteralPath $recordPath) {
  $old = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
  if (Get-Process -Id $old.pid -ErrorAction SilentlyContinue) {
    throw "An app launched from this profile is still running (pid $($old.pid)). Stop it first or use another -ProfileRoot."
  }
}

$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($listener) { throw "Port $Port is already in use; pick another -Port." }

$exe = Resolve-TestExe -Root $RepoRoot -Explicit $ExePath
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
# Point the legacy Tauri importer at an empty folder so a fresh test profile never imports the
# developer's real Tauri data into the test store.
$env:MSM_LEGACY_ROOT = $legacyDir

$proc = Start-Process -FilePath $exe -ArgumentList @("--remote-debugging-port=$Port", "--user-data-dir=$profileDir") -WorkingDirectory (Split-Path -Parent $exe) -PassThru

$version = $null
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Milliseconds 500
  try { $version = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 2; break } catch { }
}
if (-not $version) {
  try { taskkill /PID $proc.Id /T /F *> $null } catch { }
  throw "The app did not expose CDP on port $Port. Check $ProfileRoot for logs or run the exe manually."
}

$record = [pscustomobject]@{
  pid = $proc.Id
  port = $Port
  exe = $exe
  profileRoot = $ProfileRoot
  dataRoot = Join-Path $profileDir 'data'
  cdpUrl = "http://127.0.0.1:$Port"
  browser = $version.Browser
  startedAt = (Get-Date).ToString('o')
}
$record | ConvertTo-Json -Compress | Set-Content -LiteralPath $recordPath -Encoding utf8
Write-Output ($record | ConvertTo-Json -Compress)
