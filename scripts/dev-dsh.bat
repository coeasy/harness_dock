@echo off
rem ============================================================
rem  dev-dsh.bat - start the dsh web process only (no Electron)
rem
rem  The embedded client plugin is injected and a ready file is
rem  resolved; the web UI URL is printed to this console.
rem
rem  Runtime mode is auto-detected: bundled (runtimes\pack) first,
rem  then PATH. Override with:
rem    set DSH_RUNTIME=bundled^|local
rem ============================================================
setlocal
set "SCRIPT_DIR=%~dp0"
set "REPO_ROOT=%SCRIPT_DIR%.."

if not exist "%REPO_ROOT%\node_modules\" (
    echo [dev-dsh] node_modules missing, running pnpm install...
    pushd "%REPO_ROOT%"
    call pnpm install || goto :fail
    popd
)

pushd "%REPO_ROOT%"
node --import tsx scripts\dev-dsh.mjs
set "EXITCODE=%ERRORLEVEL%"
popd
exit /b %EXITCODE%

:fail
popd
echo [dev-dsh] FAILED.
exit /b 1
