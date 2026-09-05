@echo off
setlocal EnableExtensions
rem HarnessDock one-click local Tauri build for Windows.
rem Build-time Node/pnpm/Rust are developer tools only; the packaged client
rem always runs the sealed Node+dsh Runtime embedded into the installer.

set "SCRIPT_DIR=%~dp0"
set "REPO_ROOT=%SCRIPT_DIR%.."
pushd "%REPO_ROOT%"
if not exist "package.json" (
  echo [build] ERROR: package.json not found above "%SCRIPT_DIR%"
  popd
  exit /b 1
)

echo [build] HarnessDock local Windows build

echo [build] Checking build-time Node...
where node.exe >nul 2>nul
if errorlevel 1 goto :portable_node
node scripts\node-version-check.cjs >nul 2>nul
if errorlevel 1 goto :portable_node
goto :node_ready

:portable_node
echo [build] Supported Node is not available on PATH; preparing verified portable Node...
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%bootstrap-node.ps1"
if errorlevel 1 goto :fail
if not exist ".local-tools\node-home.txt" (
  echo [build] ERROR: portable Node bootstrap did not write .local-tools\node-home.txt
  goto :fail
)
set /p "NODE_HOME="<".local-tools\node-home.txt"
if not exist "%NODE_HOME%\node.exe" (
  echo [build] ERROR: portable Node executable not found: "%NODE_HOME%\node.exe"
  goto :fail
)
set "PATH=%NODE_HOME%;%PATH%"

:node_ready
node scripts\node-version-check.cjs
if errorlevel 1 goto :fail

rem bootstrap.mjs provisions pnpm 10 and installs workspace dependencies when needed.
node scripts\bootstrap.mjs
if errorlevel 1 goto :fail

rem build.mjs prepares the sealed Runtime, verifies real Harness Web readiness,
rem installs an isolated tauri-cli when needed, checks Rust, and builds NSIS.
node scripts\build.mjs --skip-install %*
if errorlevel 1 goto :fail

echo.
echo [build] SUCCESS
if exist "apps\tauri\src-tauri\target\release\bundle\nsis" (
  echo [build] Windows installer directory:
  echo         %REPO_ROOT%\apps\tauri\src-tauri\target\release\bundle\nsis
) else (
  echo [build] Cargo target directory:
  echo         %REPO_ROOT%\apps\tauri\src-tauri\target\release
)
popd
exit /b 0

:fail
echo.
echo [build] FAILED. Review the error above.
echo [build] On Windows, Rust MSVC and the Tauri 2 system prerequisites are required.
popd
exit /b 1
