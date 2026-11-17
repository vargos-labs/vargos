---
# Optional agent overrides; leave omitted to keep current defaults.
# model: provider:model-id
# reasoningEffort: low
# skills: [skill-name]
# allowedTools: [memory.*]
id: heartbeat
name: Heartbeat
schedule: "*/30 * * * *"
enabled: true
notify: []
activeHours: [8, 22]
activeHoursTimezone: "Australia/Sydney"
---

Heartbeat poll. Read ${WORKSPACE_DIR}/HEARTBEAT.md for detailed instructions. Follow each task strictly. Use memory.search, memory.read, memory.write bus calls as needed. Use interpolation vars in your prompts: ${WORKSPACE_DIR}, ${DATA_DIR}, etc. If all tasks complete successfully with no issues found, reply with exactly: HEARTBEAT_OK
