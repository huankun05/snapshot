@echo off
chcp 65001 >nul
rem 拾花 PetalSnap · Tauri 版（F2）启动器：静默重启（无终端窗口，仅任务栏一闪）
if not "%minimized%"=="" goto :run
set minimized=true
start /min cmd /c "%~f0"
exit
:run
taskkill /IM petalsnap-tauri-spike.exe /F >nul 2>&1
timeout /t 1 /nobreak >nul
start "" "F:\Work\Create\OCR\screenshot\tauri-spike\src-tauri\target\release\petalsnap-tauri-spike.exe"
exit
