@echo off
setlocal EnableExtensions
rem HarnessDock one-click local Tauri build for Windows.
rem Build-time Node/pnpm/Rust are developer tools only; the packaged client
rem always runs the sealed Node+dsh Runtime embedded into the installer.
rem Node resolution is local-first unless CI explicitly forces portable Node.
rem pnpm reuses an exact PATH version or falls back to repository-local .local-tools.

set "SCRIPT_DIR=%~dp0"
set "REPO_ROOT=%SCRIPT_DIR%.."
pushd "%REPO_ROOT%"
if not exist "package.json" (
  echo [build] ERROR: package.json not found above "%SCRIPT_DIR%"
  popd
  exit /b 1
)

echo [build] HarnessDock local Windows build

echo [build] Resolving build-time Node...
if /I "%HARNESSDOCK_FORCE_PORTABLE_NODE%"=="1" goto :force_portable_node
where node.exe >nul 2>nul
if errorlevel 1 goto :system_node_missing
node scripts\node-version-check.cjs >nul 2>nul
if errorlevel 1 goto :system_node_incompatible
for /f "delims=" %%I in ('where node.exe 2^>nul') do if not defined SYSTEM_NODE_EXE set "SYSTEM_NODE_EXE=%%I"
for /f "delims=" %%V in ('node --version 2^>nul') do set "SYSTEM_NODE_VERSION=%%V"
echo [build] Using compatible system Node %SYSTEM_NODE_VERSION%: %SYSTEM_NODE_EXE%
goto :node_ready

:force_portable_node
echo [build] HARNESSDOCK_FORCE_PORTABLE_NODE=1; bypassing system Node
goto :portable_node

:system_node_missing
echo [build] System Node not found; falling back to verified portable Node
goto :portable_node

:system_node_incompatible
for /f "delims=" %%V in ('node --version 2^>nul') do set "SYSTEM_NODE_VERSION=%%V"
if not defined SYSTEM_NODE_VERSION set "SYSTEM_NODE_VERSION=unknown"
echo [build] System Node %SYSTEM_NODE_VERSION% is incompatible; falling back to verified portable Node
goto :portable_node

:portable_node
echo [build] Preparing verified portable Node...
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
for /f "delims=" %%V in ('node --version 2^>nul') do set "PORTABLE_NODE_VERSION=%%V"
echo [build] Using verified portable Node %PORTABLE_NODE_VERSION%: %NODE_HOME%\node.exe

:node_ready
node scripts\node-version-check.cjs
if errorlevel 1 goto :fail

rem bootstrap.mjs resolves exact pnpm without mutating global Corepack/npm state,
rem then installs workspace dependencies using the selected pnpm.
node scripts\bootstrap.mjs
if errorlevel 1 goto :fail

if not exist ".local-tools\pnpm-bin.txt" goto :pnpm_ready
set /p "PNPM_BIN="<".local-tools\pnpm-bin.txt"
if not exist "%PNPM_BIN%\pnpm.cmd" (
  echo [build] ERROR: repository-local pnpm executable not found: "%PNPM_BIN%\pnpm.cmd"
  goto :fail
)
set "PATH=%PNPM_BIN%;%PATH%"
for /f "delims=" %%V in ('pnpm --version 2^>nul') do set "LOCAL_PNPM_VERSION=%%V"
echo [build] Using repository-local pnpm %LOCAL_PNPM_VERSION%: %PNPM_BIN%\pnpm.cmd

:pnpm_ready
rem build.mjs prepares the exact sealed Runtime, verifies real Harness Web readiness,
rem checks Rust first, then pins tauri-cli only when native packaging is requested.
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
