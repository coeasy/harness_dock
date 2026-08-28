@echo off
rem ============================================================
rem  HarnessDock - one-click desktop build (Windows)
rem
rem  Works on a BARE machine: no pre-installed Node / pnpm / dsh.
rem  If Node ^22.19 || >=24 is missing, a portable Node 22.19 is
rem  downloaded into .rundata\toolchain\ automatically.
rem
rem  Usage:
rem    build.bat                       -- current OS, thin package
rem    build.bat win full              -- Windows full (offline bundled runtime)
rem    build.bat win both              -- thin + full
rem    build.bat win full --skip-tests -- fast rebuild
rem
rem  Scenarios:
rem    thin  - small download, fetches pinned dsh via npx on first run
rem    full  - bundles node.exe + dsh runtime, works offline.
rem            Both scenarios emit a standalone portable exe
rem            (HarnessDock-Portable-...-thin/full.exe) - no install needed.
rem ============================================================
setlocal enabledelayedexpansion

set "SCRIPT_DIR=%~dp0"
set "REPO_ROOT=%SCRIPT_DIR%.."
rem ---- Node version single source of truth: scripts\versions.json ----
set "NODE_VERSION="
for /f "usebackq delims=" %%v in (`powershell -NoProfile -Command "$j = Get-Content '%~dp0versions.json' -Raw | ConvertFrom-Json; Write-Output $j.node"`) do set "NODE_VERSION=%%v"
if "%NODE_VERSION%"=="" set "NODE_VERSION=22.19.0"
set "TOOLCHAIN_DIR=%REPO_ROOT%\.rundata\toolchain"

rem ---- locate repo root sanity check ----
if not exist "%REPO_ROOT%\package.json" (
    echo [build] ERROR: package.json not found above "%SCRIPT_DIR%"
    exit /b 1
)

rem ---- defaults ----
set "OS_ARG=current"
set "SCENARIO=thin"
set "EXTRA_ARGS="

if not "%~1"=="" set "OS_ARG=%~1"
if not "%~2"=="" set "SCENARIO=%~2"
shift & shift
:collect
if not "%~1"=="" (
    set "EXTRA_ARGS=!EXTRA_ARGS! %~1"
    shift
    goto collect
)

echo === HarnessDock desktop build ===
echo os=%OS_ARG% scenario=%SCENARIO%%EXTRA_ARGS%
echo.

pushd "%REPO_ROOT%"

rem ============================================================
rem 1. Ensure a usable Node (>=22.19) - download portable if needed
rem ============================================================
set "NODE_OK=0"
node scripts\node-version-check.cjs >nul 2>nul && set "NODE_OK=1"

if "%NODE_OK%"=="1" (
    for /f "delims=" %%v in ('node -v') do echo [build] using system Node %%v
    goto :node_done
)

if exist "%TOOLCHAIN_DIR%\node-v%NODE_VERSION%-win-x64\node.exe" (
    echo [build] using bundled portable Node v%NODE_VERSION%
    set "PATH=%TOOLCHAIN_DIR%\node-v%NODE_VERSION%-win-x64;%PATH%"
    goto :node_done
)

echo [build] Node ^>=22.19 not found. Downloading portable Node v%NODE_VERSION% ...
if not exist "%TOOLCHAIN_DIR%" mkdir "%TOOLCHAIN_DIR%"
set "NODE_ZIP=%TOOLCHAIN_DIR%\node-v%NODE_VERSION%-win-x64.zip"
set "NODE_URL=https://nodejs.org/dist/v%NODE_VERSION%/node-v%NODE_VERSION%-win-x64.zip"
curl.exe -fL --progress-bar -o "%NODE_ZIP%" "%NODE_URL%"
if errorlevel 1 goto :fail_dl
echo [build] extracting...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -Force '%NODE_ZIP%' '%TOOLCHAIN_DIR%'"
if errorlevel 1 goto :fail_dl
set "PATH=%TOOLCHAIN_DIR%\node-v%NODE_VERSION%-win-x64;%PATH%"
node scripts\node-version-check.cjs || goto :fail_dl
for /f "delims=" %%v in ('node -v') do echo [build] portable Node %%v ready
goto :node_done

:fail_dl
echo [build] ERROR: failed to download portable Node v%NODE_VERSION%
echo [build] check network or manually install Node ^22.19+ from https://nodejs.org
goto :fail

:node_done

rem ============================================================
rem 2. Ensure pnpm + dependencies (bootstrap.mjs)
rem ============================================================
node scripts\bootstrap.mjs%EXTRA_ARGS%
if errorlevel 1 goto :fail

rem ---- delegate to the cross-platform build script ----
rem bootstrap already ensured dependencies; skip a second pnpm install
node scripts\build.mjs --os %OS_ARG% --scenario %SCENARIO%%EXTRA_ARGS% --skip-install
if errorlevel 1 goto :fail

popd
echo.
echo [build] Artifacts are in apps\desktop\release\thin and apps\desktop\release\full
pause
exit /b 0

:fail
popd
echo.
echo [build] FAILED. See output above.
pause
exit /b 1
