# Voice console

Open `/voice` in the Vargos web console and allow microphone access. The page displays microphone level, input and reply transcripts, and outward agent progress. Mute, pause/resume, end-call, and interrupt controls manage capture and playback. The sphere reacts to microphone and returned audio energy, with reduced-motion support. The activity panel shows actual agent tool start/end events and skill document loads (a `SKILL.md` read), with running, completed, or failed states. Tool arguments and raw results are not included in activity updates. Microphone capture continues during playback and background work, with browser echo cancellation enabled. Native speech-start detection interrupts playback; unheard audio is truncated from model history. Only explicit mute or pause suppresses microphone audio. Ending a call does not cancel an agent task already running.

The console connects to its existing live WebSocket with `?voice=1`. On HTTPS the socket stays on the same authenticated hostname. Route `/ws` to the daemon web WebSocket port (default 9004), just as for live console updates. Microphone capture requires HTTPS, except on localhost.

`edge/web/voice.ts` obtains the configured endpoint through `config.get`. The speech backend is a separate process; it handles VAD, ASR, conversation inference and TTS. Vargos launches it when voice is enabled and installed. The browser streams 16 kHz PCM and plays returned PCM at the rate advertised by the backend. Slow connections fail with an error instead of building an unbounded audio queue.

The voice runtime loads `agent.profile` with the `voice` persona. This internal method reuses the agent service's shared workspace instructions, persona frontmatter, canonical bus schemas, tool names, and `allowedTools` filtering. It also uses the same Pi resource loader as normal agents to discover skills and append configured system instructions. Skill metadata uses the SDK types; bodies stay on disk and explicit-invocation-only skills stay out of the catalog. The voice model receives the catalog when delegation is allowed and uses `agent.execute` to load and run a matching skill, since this speech runtime has no native file-reading tools. It does not start another model or Pi inference session. The bundled `.templates/agents/voice.md` is seeded copy-missing to `~/.vargos/agents/voice.md`; edit it through the existing Agents UI or on disk. Changes apply when the server-owned voice conversation is restarted.

All agent-visible bus methods are available by default, including memory search/read and internally available MCP tools. `internal: true` methods remain hidden; `external: false` does not hide a tool from this internal agent. External MCP gateway exposure is unchanged. Tool names follow the existing agent convention (`memory.search` becomes `memory-search`).

All calls return an immediate dispatch acknowledgement; actual results arrive as background updates. Ordinary calls execute directly through `bus.call()`, with the canonical bus schema validating arguments. Only `agent.execute` starts another agent: each task has its own `web:voice:main:<call>` session. The microphone and voice conversation remain available while it runs. The browser cannot override tool definitions or background task session keys.

Native VAD owns turn detection, automatic replies, and interruption. The edge does not schedule ordinary spoken turns or block audio. Completed outward agent text and final results enter the voice model as background data, so it can relay useful updates and speak results. Updates wait while a reply or user turn is active and coalesce per task. Routine tool events remain visual; reasoning and raw tool arguments are not spoken. Immediate tool acknowledgements retain standard function-output ordering without keeping a tool call pending for the whole background task.


Connection access follows the existing console deployment authentication, such as Cloudflare Access. The voice socket checks the browser Origin hostname. Keep the speech backend on loopback or a trusted private network; never put provider keys in browser code.

## Managed speech runtime

Vargos owns the optional Hugging Face backend and reference-voice adapter as child
processes of its existing `voice` service. There is no separate systemd voice unit.
The packaged launcher, pipeline, locked dependencies
ship in `dist/runtime/voice`; no prototype checkout is required.

Install the optional dependencies once (Linux, `uv`, Git and Python on PATH):

```bash
python3 runtime/voice/install.py
```

This explicitly downloads the pinned Hugging Face revision and CPU dependencies
into the Vargos cache directory (`$XDG_CACHE_HOME/vargos/voice`, or
`~/.cache/vargos/voice`). Normal startup never installs packages. A dependency-lock
change creates a new versioned environment; run setup again
before restarting after such an upgrade. Python inference packages are not bundled
into the npm tarball.

With `voice.enabled: true` in agent settings, starting Vargos starts the backend on
the host/port in `config.json.voice`, with a loopback reference adapter on `adapterPort`. Vargos waits for readiness,
retries unexpected exits up to three times, and terminates the whole speech process
group during shutdown. The launcher also detects loss of its parent connection.
Missing configuration, missing dependencies, and speech failures leave the rest of
Vargos usable; inspect status and the normal Vargos logs:

```bash
systemctl --user restart vargos.service
journalctl --user -u vargos.service -f
```

`config.json.voice.externalUrl` selects an external WebSocket endpoint: when set, Vargos does
not launch a managed backend. Autostart is unchanged. When migrating an existing
installation, stop its old `vargos-voice.service` before restarting Vargos so both
processes do not compete for the same ports.

The voice model and remote ASR/TTS endpoints still come from settings. Consolidating
the local runtime does not move inference onto the Vargos host or change providers.
Voice reasoning remains `none`; background agents retain their own reasoning settings.

## Speech settings

Model and audio configuration lives in `~/.vargos/agent/settings.json` under `voice` (exposed as `agent.voice` by `config.get`). Transport settings live separately in `config.json.voice`. The launcher obtains this section through `config.get` on startup; restart Vargos after changing it.

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

## Conversation lifetime

The single-user Vargos workspace keeps one server-owned voice conversation at
`web:voice:main`. Disconnecting the browser stops its audio connection, while the
speech backend retains history and background tasks can finish. Reconnecting
reattaches to that conversation. A second simultaneous browser is rejected.
Restarting Vargos or the voice backend starts a fresh conversation; this is not
cross-restart persistence. Pi rotation applies only to delegated agent sessions.

Hugging Face runs unmodified with its default history retention and compaction.
The UI reports standard response input/output usage; it does not claim a measured
context percentage, retained turn count, or live compaction state.

## Speech networking (`config.json`)

```json
{
  "voice": {
    "host": "127.0.0.1",
    "port": 8765,
    "adapterPort": 8766
  }
}
```

These defaults are defined once in the config schema. The service passes validated
bind settings to Python and lets the web bridge resolve the same endpoint through
`config.get`. Set `voice.externalUrl` to a `ws://` or `wss://` realtime endpoint
when using an external backend. The old `VARGOS_VOICE_URL`/`VARGOS_VOICE_PORT`
overrides are replaced by this config. Provider API roots belong in
`agent/models.json` (`providers.<provider>.baseUrl`), including built-in providers
used by speech; Python has no provider-specific URL fallback.

The optional installer is a local packaging utility: run `python3 runtime/voice/install.py`
from the source checkout, or `python3 dist/runtime/voice/install.py` from a built
package. It computes the same cache location as the service. There are no voice
setup/status bus methods; use the existing service lifecycle and logs.

The Python runtime starts after gateway readiness and calls `config.get` using
Vargos's existing TCP JSON-RPC protocol. Launch supplies gateway host/port and the
Vargos data directory, not copies of speech settings. Python does not read Vargos
configuration files. Configuration defaults and file ownership remain in the config
service. Service reloads also work when the gateway is already running.
