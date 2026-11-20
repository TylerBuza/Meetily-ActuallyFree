#!/usr/bin/env python3
"""Bounded packaged-app startup/window probe with isolated home and app data."""
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile


def main():
    executable = Path(sys.argv[1]).resolve()
    if len(sys.argv) == 2:
        subprocess.run(["xvfb-run", "-a", "dbus-run-session", "--", sys.executable,
                        __file__, str(executable), "--inside"], check=True, timeout=60)
        return
    with tempfile.TemporaryDirectory(prefix="meetily-smoke-") as tmp:
        env = dict(os.environ, HOME=tmp, XDG_DATA_HOME=f"{tmp}/data",
                   XDG_CONFIG_HOME=f"{tmp}/config", XDG_CACHE_HOME=f"{tmp}/cache",
                   GDK_BACKEND="x11")
        if executable.suffix == ".AppImage":
            env["APPIMAGE_EXTRACT_AND_RUN"] = "1"
        with open(f"{tmp}/startup.log", "w+") as log:
            app = subprocess.Popen([str(executable)], env=env, cwd=tmp, stdout=log, stderr=log,
                                   start_new_session=True)
            try:
                try:
                    code = app.wait(timeout=15)
                    raise RuntimeError(f"Packaged app exited during startup: {code}")
                except subprocess.TimeoutExpired:
                    pass
                windows = subprocess.check_output(["xwininfo", "-root", "-tree"], text=True, timeout=5)
                if "Meetily - Actually Free" not in windows:
                    raise RuntimeError(f"No main app window:\n{windows}")
                if executable.suffix == ".AppImage":
                    database = Path(tmp) / "data/Meetily/meeting_minutes.sqlite"
                    if not database.is_file():
                        raise RuntimeError("AppImage did not create its database in durable XDG storage")
                log.flush()
                log.seek(0)
                startup = log.read()
                if f'save_folder="{tmp}/Documents/meetily-recordings"' not in startup:
                    raise RuntimeError("Missing XDG Documents must fall back to a durable HOME/Documents folder")
                print(f"PASS isolated native startup/window: {executable.name}")
            finally:
                if app.poll() is None:
                    os.killpg(app.pid, signal.SIGTERM)
                    try:
                        app.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        os.killpg(app.pid, signal.SIGKILL)
                        app.wait(timeout=5)
                log.seek(0)
                print(log.read())


if __name__ == "__main__":
    main()
