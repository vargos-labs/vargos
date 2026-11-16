# Voice console

Open `/voice` in the Vargos web console and allow microphone access. The page displays microphone level, input and reply transcripts, and outward agent progress. Mute, pause/resume, end-call, and interrupt controls manage capture and playback. The sphere reacts to microphone and returned audio energy, with reduced-motion support. The activity panel shows actual agent tool start/end events and skill document loads (a `SKILL.md` read), with running, completed, or failed states. Tool arguments and raw results are not included in activity updates. Microphone capture continues during playback and background work, with browser echo cancellation enabled. Native speech-start detection interrupts playback; unheard audio is truncated from model history. Only explicit mute or pause suppresses microphone audio. Ending a call does not cancel an agent task already running.

The console connects to its existing live WebSocket with `?voice=1`. On HTTPS the socket stays on the same authenticated hostname. Route `/ws` to the daemon web WebSocket port (default 9004), just as for live console updates. Microphone capture requires HTTPS, except on localhost.

`edge/web/voice.ts` connects to `VARGOS_VOICE_URL` (default `ws://127.0.0.1:8765/v1/realtime`). The speech backend is a separate process; it handles VAD, ASR, conversation inference and TTS. Vargos does not launch it automatically. The browser streams 16 kHz PCM and plays returned PCM at the rate advertised by the backend. Slow connections fail with an error instead of building an unbounded audio queue.

The voice runtime loads `agent.profile` with the `voice` persona. This internal method reuses the agent service's shared workspace instructions, persona frontmatter, canonical bus schemas, tool names, and `allowedTools` filtering. It also uses the same Pi resource loader as normal agents to discover skills and append configured system instructions. Skill metadata uses the SDK types; bodies stay on disk and explicit-invocation-only skills stay out of the catalog. The voice model receives the catalog when delegation is allowed and uses `agent.execute` to load and run a matching skill, since this speech runtime has no native file-reading tools. It does not start another model or Pi inference session. The bundled `.templates/agents/voice.md` is seeded copy-missing to `~/.vargos/agents/voice.md`; edit it through the existing Agents UI or on disk. Changes apply to new voice connections.

All agent-visible bus methods are available by default, including memory search/read and internally available MCP tools. `internal: true` methods remain hidden; `external: false` does not hide a tool from this internal agent. External MCP gateway exposure is unchanged. Tool names follow the existing agent convention (`memory.search` becomes `memory-search`).

All calls return an immediate dispatch acknowledgement; actual results arrive as background updates. Ordinary calls execute directly through `bus.call()`, with the canonical bus schema validating arguments. Only `agent.execute` starts another agent: each task has its own `web:voice:<connection>:<call>` session. The microphone and voice conversation remain available while it runs. The browser cannot override tool definitions or background task session keys.

Native VAD owns turn detection, automatic replies, and interruption. The edge does not schedule ordinary spoken turns or block audio. Completed outward agent text and final results enter the voice model as background data, so it can relay useful updates and speak results. Updates wait while a reply or user turn is active and coalesce per task. Routine tool events remain visual; reasoning and raw tool arguments are not spoken. Immediate tool acknowledgements retain standard function-output ordering without keeping a tool call pending for the whole background task.


Connection access follows the existing console deployment authentication, such as Cloudflare Access. The voice socket checks the browser Origin hostname. Keep the speech backend on loopback or a trusted private network; never put provider keys in browser code.

## Current deployment

- Console: `https://agent.vargos.io/voice` (also `https://voice.vargos.io/voice`).
- One user unit: `/home/choz/apps/vargos-voice.service`, source in `/home/choz/dev/vargos-voice`.
- ASR: `192.168.88.104:12047`; TTS: Qwen3 Base at `192.168.88.104:12046`, Jarvis reference audio.
- Conversation inference: DeepSeek using its existing Vargos auth entry, with voice reasoning effort `none`. The current HF Chat Completions adapter does not preserve the DeepSeek reasoning content required for thinking-mode tool continuations; disabling voice thinking keeps tool results usable and lowers latency. Agent reasoning settings are independent.
- The reference adapter on loopback port 8766 is supervised by the backend unit. There are no separate demo or adapter units, and autostart stays disabled.

Manage the backend with `systemctl --user status vargos-voice.service` and `journalctl --user -u vargos-voice.service -f`.

## Speech settings

Speech configuration lives in `~/.vargos/agent/settings.json` under `voice` (exposed as `agent.voice` by `config.get`). It does not live in `config.json`. The launcher reads this section on startup; restart the voice backend after changing it.

```json
{
  "voice": {
    "enabled": true,
    "provider": "deepseek",
    "model": "deepseek-chat",
    "stt": {
      "baseUrl": "http://192.168.88.104:12047/v1",
      "model": "qwen3-asr",
      "language": "English"
    },
    "tts": {
      "baseUrl": "http://192.168.88.104:12046/v1/audio/speech",
      "model": "qwen3-tts-1.7b-base",
      "voice": "jarvis",
      "referenceAudio": "agent/voice-templates/jarvis.wav",
      "referenceText": "All systems are online. Shall I run the usual diagnostics, or would you prefer music?",
      "language": "English"
    }
  }
}
```

Provider credentials remain in the existing provider/auth configuration. TTS `baseUrl` is the full speech endpoint; STT `baseUrl` is the OpenAI-compatible API root. Relative reference paths resolve against the Vargos data directory, including a custom `VARGOS_DATA_DIR`. The bundled `.templates/agent/voice-templates/jarvis.wav` seeds to `~/.vargos/agent/voice-templates/jarvis.wav` without overwriting an existing file. The reference transcript must match the recording.
