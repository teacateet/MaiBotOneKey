@echo off
setlocal
cd /d "%~dp0"

set "RELEASE_EXE=%~dp0src-tauri\target\release\teabot_desktop.exe"
if exist "%RELEASE_EXE%" (
  start "" "%RELEASE_EXE%"
  exit /b 0
)

echo Release version not found. Building it once...
call npm run build
if errorlevel 1 exit /b %errorlevel%

set "CARGO_EXE=%USERPROFILE%\.cargo\bin\cargo.exe"
if not exist "%CARGO_EXE%" set "CARGO_EXE=cargo"

pushd "%~dp0src-tauri"
"%CARGO_EXE%" build --release
set "BUILD_RESULT=%ERRORLEVEL%"
popd
if not "%BUILD_RESULT%"=="0" exit /b %BUILD_RESULT%

if exist "%RELEASE_EXE%" (
  start "" "%RELEASE_EXE%"
  exit /b 0
)

echo Release build finished but executable was not found: "%RELEASE_EXE%"
exit /b 1
