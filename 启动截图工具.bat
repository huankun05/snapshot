@echo off
cd /d "F:\Work\Create\OCR\screenshot"
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object { $_.CommandLine -match 'app.dist.main.js' } | ForEach-Object { taskkill /F /T /PID $_.ProcessId | Out-Null }"
start "" /b cmd /c ""F:\Work\Create\Assa\Xiyue\node_modules\electron\dist\electron.exe" app\dist\main.js >> "%TEMP%\eisland-screenshot.log" 2>&1"
echo 已启动（日志: %TEMP%\eisland-screenshot.log）
