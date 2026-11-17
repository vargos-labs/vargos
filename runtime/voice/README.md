# Optional speech runtime

`pipeline.yaml` is a required internal template, not a user configuration file.
Configure speech in `~/.vargos/agent/settings.json` and networking in `~/.vargos/config.json` under `voice`; startup fills the template.

Owned by `services/voice`, shipped with Vargos, installed explicitly with
`python3 runtime/voice/install.py` (use `dist/runtime/voice/install.py` in a built package). See `docs/voice-console.md` for lifecycle and configuration.
