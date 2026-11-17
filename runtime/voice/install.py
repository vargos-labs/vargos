"""Explicit one-time install; normal Vargos startup never downloads dependencies."""
import fcntl
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys


def main():
    package = Path(__file__).resolve().parent
    cache = Path(os.environ.get("XDG_CACHE_HOME", str(Path.home() / ".cache")))
    version = hashlib.sha256((package / "requirements.lock").read_bytes()).hexdigest()[:16]
    target = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else cache / "vargos/voice" / version
    target.mkdir(parents=True, exist_ok=True)
    uv = shutil.which("uv")
    if not uv:
        raise SystemExit("Voice setup requires uv on PATH (https://docs.astral.sh/uv/).")
    with (target / "install.lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if (target / "ready").exists():
            return
        environment = target / ".venv"
        if not environment.exists():
            subprocess.run([uv, "venv", "--python", "3.11", str(environment)], check=True)
        python = environment / "bin/python"
        # The complete tested CPU lock is intentional: do not resolve optional GPU backends.
        subprocess.run([uv, "pip", "install", "--python", str(python), "--no-deps", "--torch-backend", "cpu",
                        "-r", str(package / "requirements.lock")], check=True)
        subprocess.run([str(python), "-c", "import speech_to_speech, torch, uvicorn, yaml, httpx2"], check=True)
        (target / "ready").touch()


if __name__ == "__main__":
    main()
