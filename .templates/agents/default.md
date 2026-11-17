---
# Optional agent overrides; leave omitted to keep current defaults.
# model: provider:model-id
# reasoningEffort: low
# skills: [skill-name]
# Glob whitelist of bus tools the channel agent can call (e.g. "memory.*", "channel.send").
# Empty/missing = all bus tools allowed. Built-in Pi tools (read/bash/edit/write) always available.
allowedTools: []
---

<!-- Channel-specific instructions appended to the merged bootstrap (AGENTS.md/SOUL.md/TOOLS.md). Leave empty to inherit defaults only. -->
