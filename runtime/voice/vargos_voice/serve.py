"""Run the HF pipeline using existing Vargos provider settings, without copying keys."""
import os
import signal
import subprocess
import sys
import time
import tempfile
import socket
import threading

import yaml
import urllib.request
from pathlib import Path
from .rpc import call


def main():
    root = Path(__file__).resolve().parents[1]
    data = Path(os.environ["VARGOS_DATA_DIR"])
    config = call("config.get")
    providers = config.get("providers", {})
    auth = config.get("auth", {})
    voice = config.get("agent", {}).get("voice", {})
    if not voice.get("enabled", False):
        raise SystemExit("Voice is disabled in agent/settings.json")
    provider = voice["provider"]
    env = os.environ.copy()
    provider_config = providers.get(provider, {})
    env["VOICE_LLM_MODEL"] = voice["model"]
    env["VOICE_LLM_URL"] = provider_config.get("baseUrl", "")
    if not env["VOICE_LLM_URL"]:
        raise ValueError(f"No baseUrl configured for voice provider {provider}")
    env["VOICE_LLM_KEY"] = env.get(provider.upper().replace("-", "_") + "_API_KEY") or auth.get(provider, {}).get("key", "") or provider_config.get("apiKey", "")
    tts = voice["tts"]
    reference = Path(tts["referenceAudio"]).expanduser()
    if not reference.is_absolute():
        reference = data / reference
    if not reference.is_file():
        raise FileNotFoundError(f"Voice reference audio not found: {reference}")
    env["VOICE_REFERENCE_AUDIO"] = str(reference)
    env["VOICE_REFERENCE_TRANSCRIPT"] = tts["referenceText"]
    env["VOICE_TTS_URL"] = tts["baseUrl"]
    env["VOICE_TTS_MODEL"] = tts["model"]
    env["VOICE_TTS_LANGUAGE"] = tts["language"]
    env.setdefault("OMP_NUM_THREADS", "4")
    env.setdefault("OPENBLAS_NUM_THREADS", "4")
    pipeline = yaml.safe_load((root / "pipeline.yaml").read_text())
    stt = voice["stt"]
    pipeline["blocks"]["stt"]["settings"].update({
        "openai_stt_base_url": stt["baseUrl"],
        "openai_stt_model": stt["model"],
        "openai_stt_language": stt["language"],
    })
    pipeline["blocks"]["tts"]["settings"].update({
        "openai_tts_model": tts["model"],
        "openai_tts_voice": tts["voice"],
        "openai_tts_language": tts["language"],
    })
    host = config["voice"]["host"]
    port = config["voice"]["port"]
    adapter_port = config["voice"]["adapterPort"]
    for address, candidate in ((host, port), ("127.0.0.1", adapter_port)):
        with socket.socket() as probe:
            probe.bind((address, candidate))
    pipeline["runtime"]["server"] = {"host": host, "port": port}
    pipeline["blocks"]["tts"]["settings"]["openai_tts_base_url"] = f"http://127.0.0.1:{adapter_port}/v1"
    command = [sys.executable, "-m", "speech_to_speech.cli"]
    # The reference-voice adapter belongs to the backend, under one user unit.
    children = []
    config = tempfile.NamedTemporaryFile(mode="w", suffix=".yaml", delete=False)
    with config:
        yaml.safe_dump(pipeline, config)

    def stop(_signum, _frame):
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    # The Node owner holds stdin open. Its death must not leave audio servers behind.
    if os.environ.get("VARGOS_VOICE_MANAGED") == "1":
        def watch_parent():
            # Avoid holding a buffered-IO lock while Python shuts down.
            while os.read(sys.stdin.fileno(), 4096):
                pass
            os.kill(os.getpid(), signal.SIGTERM)
        threading.Thread(target=watch_parent, daemon=True).start()
    try:
        proxy = subprocess.Popen([sys.executable, "-m", "uvicorn", "vargos_voice.tts_proxy:app",
            "--host", "127.0.0.1", "--port", str(adapter_port)], cwd=root, env=env)
        children.append(proxy)
        for _ in range(100):
            if proxy.poll() is not None:
                raise RuntimeError("Voice TTS adapter failed to start")
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{adapter_port}/openapi.json", timeout=.2):
                    break
            except OSError:
                time.sleep(.1)
        else:
            raise RuntimeError("Voice TTS adapter startup timed out")
        server = subprocess.Popen([*command, "serve", "--file", config.name,
            "--name", "voice"], cwd=root, env=env)
        children.append(server)
        while server.poll() is None:
            if proxy.poll() is not None:
                raise RuntimeError("Voice TTS adapter stopped unexpectedly")
            time.sleep(.5)
        raise SystemExit(server.returncode)
    finally:
        Path(config.name).unlink(missing_ok=True)
        for child in reversed(children):
            if child.poll() is None:
                child.terminate()
        for child in children:
            try:
                child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()


if __name__ == "__main__":
    main()
