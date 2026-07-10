# PowerShell wrapper — runs the EC2 APK build via Git Bash.
# Usage (from repo root):  .\build-apk.ps1
$bash = "C:\Program Files\Git\bin\bash.exe"
if (-not (Test-Path $bash)) { Write-Error "Git Bash not found at $bash"; exit 1 }
& $bash "$PSScriptRoot\build-apk.sh"
