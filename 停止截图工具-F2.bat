@echo off
chcp 65001 >nul
rem 拾花 PetalSnap · Tauri 版（F2）停止器
taskkill /IM petalsnap-tauri-spike.exe /F >nul 2>&1
exit
