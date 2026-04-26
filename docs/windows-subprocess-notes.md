# Windows Subprocess Notes

Behavioral notes about running each CLI as a child process from the Fireside broker on Windows. These are observations from the Phase 2 fixture-capture spike and should be revisited as the CLIs evolve.

## Subprocess argv on Windows

**Use `shell: false`** (the project's `shouldUseShell` is permanently false). Reasoning:
- `cross-spawn` (used internally by `execa`) handles PATHEXT resolution for `.cmd` shims when `shell: false`. Bare names like `claude` resolve correctly.
- `cross-spawn` also handles `.cmd` argument escaping correctly — multi-line argv strings pass through cleanly.
- `shell: true` on Windows requires manually constructing a single command line for `cmd.exe`, which terminates at embedded newlines. This silently truncated multi-line broker prompts in Phase 8 (Claude exited 0 but only saw the first line of the system prompt and produced a generic greeting instead of a JSON response).
- UTF-8: `execa` decodes child stdout using `encoding: 'utf8'`. No `chcp 65001` needed when bypassing shell.

## Subprocess stdin

**Open a stdin pipe only when there is content to write.** When the caller passes no `stdin` (or an empty string), `runSubprocess` configures execa with `stdin: 'ignore'`. When `stdin` has content, it switches to `stdin: 'pipe'`, writes the payload, and ends the stream.

Why: opening a pipe and immediately calling `.end()` still presents the child with a real (but empty) stdin handle. Some CLIs sniff stdin readability and append whatever streams in to the prompt that came in via argv. Codex is the worst offender — it logs `Reading additional input from stdin...` to stderr and appends a `<stdin>` block AFTER the argv prompt, mangling the broker's turn cue (the chat transcript ends in `${agentId}:` and Codex was concatenating the empty stdin block on after that). With `stdio: 'ignore'` the child sees fd 0 wired to the OS null device — `process.stdin.constructor` reports `ReadStream` instead of `Socket` — and the CLI skips the stdin-append branch entirely. Same risk applies to claude and gemini even if not currently observed; the conditional pipe protects all three.

## Codex CLI

Codex emits structured events as JSONL on stdout when invoked with `codex exec --json "<prompt>"`. The session id is carried on the first `thread.started` event under the field `thread_id`. The final assistant text appears on an `item.completed` event whose nested `item.type` is `agent_message` (the text lives on `item.text`). The trailing `turn.completed` event carries token usage only — no message text.

### Known stderr noise
Codex on Windows occasionally emits `ERROR codex_core::session: failed to record rollout items: thread <id> not found` to stderr. This is benign — the stdout JSONL is captured correctly and resume continues to work. The broker's runSubprocess captures stderr separately, so this won't pollute parsed output.

## Gemini CLI

- Empirical per-turn latency on this Windows install: 60–180s with web-search disabled; 240s default timeout in the gemini adapter.

Gemini-cli auto-detects project context (presence of `docs/`, source code, `package.json`) and enters agentic mode — narrating intent on stdout, attempting blocked tool calls (`run_shell_command`, file reads) on stderr, and never producing the JSON we asked for via `--output-format json`. To force pure-chat mode the gemini spec sets `defaultCwd: os.tmpdir()`, and the broker's `runAgentTurn` plumbs that into the spawned subprocess as the working directory whenever the caller doesn't pass an explicit `cwd`. Without this, gemini reads project files, attempts tool calls, and produces narrated text instead of JSON; with it, gemini sees a neutral cwd, stays in headless single-shot mode, and emits the expected JSON envelope. (Gemini 0.39.1's `--help` exposes no `--no-tools` flag and the `--allowed-tools` flag is deprecated, so cwd manipulation is the cleanest available knob.)
