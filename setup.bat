@echo off
REM ===========================================================================
REM  Apollo — one-time setup
REM  Creates a private Python environment and installs what Apollo needs.
REM  You only need to run this ONCE (or again after pulling new code).
REM ===========================================================================

cd /d "%~dp0"

echo.
echo  Setting up Apollo...
echo.

REM 1. Create the virtual environment (an isolated Python just for Apollo)
if not exist "venv\" (
    echo  Creating virtual environment...
    python -m venv venv
    if errorlevel 1 (
        echo.
        echo  ERROR: Could not create the environment. Is Python installed?
        echo  Check with:  python --version
        echo.
        pause
        exit /b 1
    )
)

REM 2. Install the dependencies
echo  Installing dependencies (this can take a minute)...
call "venv\Scripts\python.exe" -m pip install --upgrade pip
call "venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 (
    echo.
    echo  ERROR: Dependency install failed. Check your internet connection.
    echo.
    pause
    exit /b 1
)

REM 3. Create your local .env from the template if it doesn't exist yet
if not exist ".env" (
    copy ".env.example" ".env" >nul
    echo  Created .env  (this is where your secret API key goes).
)

echo.
echo  ============================================================
echo   Setup done!
echo.
echo   Next steps:
echo     1. Open the file ".env" in this folder.
echo     2. Paste your Anthropic API key after ANTHROPIC_API_KEY=
echo     3. Save it, then run  run.bat  to launch Apollo.
echo  ============================================================
echo.
pause
