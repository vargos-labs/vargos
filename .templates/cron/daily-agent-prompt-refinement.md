---
# Optional agent overrides; leave omitted to keep current defaults.
# model: provider:model-id
# reasoningEffort: low
# skills: [skill-name]
# allowedTools: [memory.*]
id: daily-agent-prompt-refinement
name: Daily Agent Prompt Refinement
schedule: "0 22 * * *"
enabled: true
---

Daily Agent Prompt Refinement: review recent agent activity and selectively improve agent prompt files by diffusing recurring intent, context, and useful behavior back into each relevant agent persona without bloating the prompt.

SCOPE:
- Agent prompt files: `${DATA_DIR}/agents/{agentFileKey}.md`
- Recent activity history: `${SESSIONS_DIR}/{agentFileKey}/*.jsonl`
- Shared workspace memory and notes: `${WORKSPACE_DIR}`

PROCESS:
1. Identify agent files with relevant recent session activity, history, notes, or memory.
2. Review only the evidence that applies to each agent. Look for repeated user intent, recurring mistakes, missing context, useful constraints, and stable preferences.
3. Update an agent prompt only when the change will make future behavior clearer, smaller, or more reliable.
4. Remove stale, unused, redundant, or contradictory prompt text when recent evidence shows it no longer helps.
5. Keep edits compact. Prefer pruning, refining wording, and merging duplicate instructions before adding new prompt text.
6. Do not add one-off session details, temporary facts, private noise, or long summaries. Distill durable intent instead.

GUARDRAILS:
- Do not overfit prompts to a single conversation unless it exposes a durable pattern.
- Do not inflate prompts with broad reminders that do not change behavior.
- Resolve contradictions by preserving the instruction that best matches recent evidence, agent purpose, and current workspace practice.
- Preserve existing frontmatter, agent identity, routing rules, and tool restrictions unless the reviewed activity clearly shows they need adjustment.
- Keep the prompt natural and direct. Use more precise wording when existing language is vague or awkward.
- Do not edit unrelated source code, install packages, restart services, commit, push, or create pull requests.

OUTPUT:
- If no agent prompt files need changes, reply exactly: Nothing updated
- Otherwise, provide a brief summary of which agent prompt files were updated and what intent was distilled into each one.
