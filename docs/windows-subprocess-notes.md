# Windows Subprocess Notes

Behavioral notes about running each CLI as a child process from the Fireside broker on Windows. These are observations from the Phase 2 fixture-capture spike and should be revisited as the CLIs evolve.

## Codex CLI

Codex emits structured events as JSONL on stdout when invoked with `codex exec --json "<prompt>"`. The session id is carried on the first `thread.started` event under the field `thread_id`. The final assistant text appears on an `item.completed` event whose nested `item.type` is `agent_message` (the text lives on `item.text`). The trailing `turn.completed` event carries token usage only — no message text.

### Known stderr noise
Codex on Windows occasionally emits `ERROR codex_core::session: failed to record rollout items: thread <id> not found` to stderr. This is benign — the stdout JSONL is captured correctly and resume continues to work. The broker's runSubprocess captures stderr separately, so this won't pollute parsed output.

## Gemini CLI

- Empirical per-turn latency on this Windows install: 60–180s with web-search disabled; 240s default timeout in the gemini adapter.
