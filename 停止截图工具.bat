@echo off
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object { $_.CommandLine -match 'app.dist.main.js' } | ForEach-Object { taskkill /F /T /PID $_.ProcessId | Out-Null }; Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | Where-Object { $_.CommandLine -match 'rapidocr_service' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
echo 已停止
