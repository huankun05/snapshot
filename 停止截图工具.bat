@echo off
chcp 65001 >nul
start "" /min powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object { $_.CommandLine -match 'app.dist.main.js' } | ForEach-Object { taskkill /F /T /PID $_.ProcessId | Out-Null }"
exit
