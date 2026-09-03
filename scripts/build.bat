@echo off
rem HarnessDock Tauri build helper for Windows.
rem Cross-platform release artifacts are built by the Tauri candidate workflow.
setlocal

set "SCRIPT_DIR=%~dp0"
set "REPO_ROOT=%SCRIPT_DIR%.."
pushd "%REPO_ROOT%"
if not exist "package.json" (
  echo [build] ERROR: package.json not found above "%SCRIPT_DIR%"
  exit /b 1
)

node scripts\node-version-check.cjs
if errorlevel 1 (
  echo [build] ERROR: Node 22.19+ or Node 24+ is required.
  echo [build] Run scripts\bootstrap.mjs after installing a supported Node.
  popd
  exit /b 1
)

node scripts\bootstrap.mjs %*
if errorlevel 1 goto :fail
node scripts\build.mjs %* --skip-install
if errorlevel 1 goto :fail

popd
echo.
echo [build] Tauri build completed.
exit /b 0

:fail
popd
echo.
echo [build] FAILED. See output above.
exit /b 1
