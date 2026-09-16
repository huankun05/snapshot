@echo off
chcp 65001 >nul
cd /d "F:\Work\Create\OCR\screenshot"
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object { $_.CommandLine -match 'app.dist.main.js' } | ForEach-Object { taskkill /F /T /PID $_.ProcessId | Out-Null }"
powershell -NoProfile -Command "Start-Process -FilePath 'F:\Work\Create\Assa\Xiyue\node_modules\electron\dist\electron.exe' -ArgumentList 'app\dist\main.js' -WorkingDirectory 'F:\Work\Create\OCR\screenshot' -WindowStyle Hidden"
echo 已启动（独立应用，Alt+Q 截图）
