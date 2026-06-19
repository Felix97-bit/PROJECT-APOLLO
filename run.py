"""
Apollo launcher.

This does three things, in order:
  1. Makes sure Apollo's memory database is ready.
  2. Starts the local Apollo web server.
  3. Opens Apollo in a clean, borderless standalone window (Chrome/Edge "app mode"),
     so it looks like a real desktop app instead of a browser tab.

You normally don't run this directly — just double-click run.bat.
"""

import os
import sys
import shutil
import subprocess
import threading
import time
import urllib.request

# IMPORTANT: when launched via pythonw.exe (the no-console launcher the desktop
# shortcut uses), sys.stdout and sys.stderr are None. Any print() or log write
# then raises an error and the app dies SILENTLY — nothing opens. So redirect
# output to a log file. This is what makes double-clicking the shortcut work.
if sys.stdout is None or sys.stderr is None:
    _log_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "apollo_launch.log")
    _log_file = open(_log_path, "a", encoding="utf-8", buffering=1)
    sys.stdout = _log_file
    sys.stderr = _log_file

import uvicorn

from backend import config, memory

URL = f"http://127.0.0.1:{config.PORT}"


def _find_browser():
    """Find Edge first, then Chrome, by checking the usual Windows install spots.
    Returns the path to the .exe, or None if neither is found.

    Edge is preferred because it provides Microsoft's natural neural voices
    (e.g. "Microsoft Ryan - Natural", a clean British male) that Chrome does not
    expose. This only affects Apollo's own window — not your default browser."""
    candidates = [
        # Microsoft Edge (has the natural-sounding voices we want)
        os.path.expandvars(r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"),
        os.path.expandvars(r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"),
        # Google Chrome (fallback)
        os.path.expandvars(r"%ProgramFiles%\Google\Chrome\Application\chrome.exe"),
        os.path.expandvars(r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"),
        os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
    ]
    for path in candidates:
        if os.path.exists(path):
            return path
    # Last resort: maybe one is on the PATH.
    return shutil.which("msedge") or shutil.which("chrome")


def _wait_until_up(timeout=20):
    """Poll the health endpoint until the server answers (or we give up)."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"{URL}/api/health", timeout=1) as r:
                if r.status == 200:
                    return True
        except Exception:
            time.sleep(0.3)
    return False


def _open_window():
    """Wait for the server, then open Apollo in a standalone app window."""
    if not _wait_until_up():
        print("[Apollo] Server didn't respond in time — open this in your browser:")
        print(f"          {URL}")
        return

    browser = _find_browser()
    if browser:
        # --app= launches a borderless window with no tabs/address bar.
        subprocess.Popen([browser, f"--app={URL}"])
        print(f"[Apollo] Opened in a standalone window. (If it didn't appear, visit {URL})")
    else:
        # No Chrome/Edge found: fall back to the default browser.
        import webbrowser
        webbrowser.open(URL)
        print(f"[Apollo] Opened in your default browser: {URL}")
        print("[Apollo] Tip: Chrome or Edge gives the nicer standalone-window look.")


def _free_port(port):
    """Stop any previous Apollo server still holding our port.

    Closing the app window does NOT stop the background server. Without this, a
    relaunch would silently fail to start (port already in use) and reconnect to
    the OLD server — which wouldn't have picked up any recent .env changes. So on
    every launch we clear the port first, guaranteeing a fresh start. We only kill
    a *python* process (our own server), never anything else."""
    try:
        out = subprocess.check_output(
            ["netstat", "-ano", "-p", "TCP"], text=True, stderr=subprocess.DEVNULL
        )
    except Exception:
        return
    pids = set()
    for line in out.splitlines():
        parts = line.split()
        # Format: TCP  LocalAddr  ForeignAddr  STATE  PID
        if len(parts) >= 5 and parts[0] == "TCP" and parts[3].upper() == "LISTENING":
            if parts[1].rsplit(":", 1)[-1] == str(port):
                pid = parts[4]
                if pid.isdigit() and pid != "0":
                    pids.add(pid)
    for pid in pids:
        try:
            info = subprocess.check_output(
                ["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
                text=True, stderr=subprocess.DEVNULL,
            )
            if "python" in info.lower():
                subprocess.run(["taskkill", "/F", "/PID", pid],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                print(f"[Apollo] Stopped a previous Apollo server (PID {pid}).")
        except Exception:
            pass
    if pids:
        time.sleep(1)  # give Windows a moment to release the port


def main():
    memory.init_db()
    # Fresh chat on every launch: wipe the conversation history so each time you
    # open Apollo you start clean. (Your facts/workflows and the brain are kept —
    # only the back-and-forth chat is cleared.)
    memory.clear_all()
    _free_port(config.PORT)
    print("Apollo is starting…")
    print(f"  Local address: {URL}")
    # Open the window on a background thread once the server is ready.
    threading.Thread(target=_open_window, daemon=True).start()
    # Start the server (this call blocks until you close Apollo).
    uvicorn.run("backend.main:app", host="127.0.0.1", port=config.PORT, log_level="warning")


if __name__ == "__main__":
    main()
