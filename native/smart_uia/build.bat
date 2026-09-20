@echo off
setlocal
cd /d "%~dp0"
echo Building smart_uia.dll ...
call "E:\software\VisualStudio\VC\Auxiliary\Build\vcvars64.bat"
cl /nologo /LD /O2 /EHsc /std:c++17 /utf-8 smart_uia.cpp /Fe:smart_uia.dll /link /DELAYLOAD:UIAutomationCore.dll
if exist smart_uia.dll (
  echo OK: %CD%\smart_uia.dll
  dir smart_uia.dll
) else (
  echo BUILD FAILED
  exit /b 1
)
endlocal
