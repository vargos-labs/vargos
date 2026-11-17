"""Adapt the standard speech API to the LAN Qwen3 Base voice-cloning API."""
import base64
import os
from pathlib import Path

import httpx2
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse
from starlette.background import BackgroundTask

app = FastAPI(title="Vargos Qwen3 voice adapter")


@app.post("/v1/audio/speech")
async def speech(request: Request):
    body = await request.json()
    reference = Path(os.environ["VOICE_REFERENCE_AUDIO"])
    transcript = os.environ["VOICE_REFERENCE_TRANSCRIPT"]
    payload = {
        "model": os.environ["VOICE_TTS_MODEL"],
        "input": body["input"],
        "ref_audio": "data:audio/wav;base64," + base64.b64encode(reference.read_bytes()).decode(),
        "ref_text": transcript,
        "language": os.environ["VOICE_TTS_LANGUAGE"],
        "response_format": body.get("response_format", "pcm"),
        "stream": body.get("stream", False),
    }
    if payload["stream"]:
        payload["stream_format"] = "audio"
    client = httpx2.AsyncClient(timeout=120)
    try:
        response = await client.send(client.build_request(
            "POST", os.environ["VOICE_TTS_URL"], json=payload
        ), stream=True)
    except Exception:
        await client.aclose()
        raise
    if response.status_code != 200:
        status = response.status_code
        await response.aclose()
        await client.aclose()
        raise HTTPException(status_code=status, detail="Remote Qwen3 synthesis failed")

    async def close():
        await response.aclose()
        await client.aclose()

    async def audio():
        try:
            async for chunk in response.aiter_bytes():
                yield chunk
        finally:
            await close()

    return StreamingResponse(audio(), media_type=response.headers.get(
        "content-type", "application/octet-stream"
    ), background=BackgroundTask(close))
