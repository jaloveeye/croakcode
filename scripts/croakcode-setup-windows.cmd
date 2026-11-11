@echo off
rem croakcode setup for Windows: double-click to install.
rem The croak gate puts its address here when it publishes this file.
setlocal
set "GATE=__CROAK_GATE__"
if not "%GATE:~0,8%"=="https://" (
  echo Download this file from the croak gate's download page.
  pause
  exit /b 1
)
echo Installing croakcode from %GATE%
set "INSTALLER=%TEMP%\croak-install-%RANDOM%.ps1"
curl.exe -fsSLk --proto "=https" "%GATE%/download/install.ps1" -o "%INSTALLER%"
if errorlevel 1 (
  echo Could not download the installer.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%INSTALLER%" -Gate "%GATE%"
set "CODE=%ERRORLEVEL%"
del "%INSTALLER%" >nul 2>&1
echo.
if "%CODE%"=="0" (echo Done. Open a new terminal and run: croakcode) else (echo Installation failed.)
pause
exit /b %CODE%
