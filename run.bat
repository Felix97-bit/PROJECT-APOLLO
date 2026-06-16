@echo off
REM ===========================================================================
REM  Apollo — launch
REM  Starts the Apollo server and opens it in a standalone window.
REM  Close that window (and this one) to stop Apollo.
REM ===========================================================================

cd /d "%~dp0"

if not exist "venv\" (
    echo.
    echo  It looks like Apollo isn't set up yet.
    echo  Run  setup.bat  first.
    echo.
    pause
    exit /b 1
)

call "venv\Scripts\python.exe" run.py

REM If the server stops with an error, keep this window open so you can read it.
if errorlevel 1 pause
