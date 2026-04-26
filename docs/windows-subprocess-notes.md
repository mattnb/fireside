# Windows Subprocess Notes

Behavioral notes about running each CLI as a child process from the Fireside broker on Windows. These are observations from the Phase 2 fixture-capture spike and should be revisited as the CLIs evolve.

## Subprocess argv on Windows

**Use `shell: false`** (the project's `shouldUseShell` is permanently false). Reasoning:
- `cross-spawn` (used internally by `execa`) handles PATHEXT resolution for `.cmd` shims when `shell: false`. Bare names like `claude` resolve correctly.
- `cross-spawn` also handles `.cmd` argument escaping correctly — multi-line argv strings pass through cleanly.
- `shell: true` on Windows requires manually constructing a single command line for `cmd.exe`, which terminates at embedded newlines. This silently truncated multi-line broker prompts in Phase 8 (Claude exited 0 but only saw the first line of the system prompt and produced a generic greeting instead of a JSON response).
- UTF-8: `execa` decodes child stdout using `encoding: 'utf8'`. No `chcp 65001` needed when bypassing shell.

## Codex CLI

Codex emits structured events as JSONL on stdout when invoked with `codex exec --json "<prompt>"`. The session id is carried on the first `thread.started` event under the field `thread_id`. The final assistant text appears on an `item.completed` event whose nested `item.type` is `agent_message` (the text lives on `item.text`). The trailing `turn.completed` event carries token usage only — no message text.

### Known stderr noise
Codex on Windows occasionally emits `ERROR codex_core::session: failed to record rollout items: thread <id> not found` to stderr. This is benign — the stdout JSONL is captured correctly and resume continues to work. The broker's runSubprocess captures stderr separately, so this won't pollute parsed output.

## Gemini CLI

- Empirical per-turn latency on this Windows install: 60–180s with web-search disabled; 240s default timeout in the gemini adapter.
