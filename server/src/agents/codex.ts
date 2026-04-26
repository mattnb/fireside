// server/src/agents/codex.ts
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import type { AgentReply, AgentSpec } from './types.js';
import { AgentParseError } from './types.js';

interface JsonlEvent {
  type?: string;
  [k: string]: unknown;
}

function parseJsonl(input: string): JsonlEvent[] {
  const events: JsonlEvent[] = [];
  for (const line of input.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as JsonlEvent);
    } catch {
      // ignore non-JSON lines (some CLIs print plain status text on stderr-like channels)
    }
  }
  return events;
}

// Codex emits the session id as `thread_id` on the `thread.started` event
// (captured from Phase 2 fixture codex-exec-jsonl.txt). We also accept
// `session_id` / `sessionId` as a forward-compat fallback in case the CLI
// renames the field in a future release.
function findSessionId(events: JsonlEvent[]): string | null {
  for (const e of events) {
    const obj = e as Record<string, unknown>;
    const tid = obj['thread_id'] ?? obj['session_id'] ?? obj['sessionId'];
    if (typeof tid === 'string') return tid;
  }
  return null;
}

// The final assistant text appears on an `item.completed` event whose nested
// `item.type` is `agent_message`; the text lives at `item.text`. The
// `turn.completed` event carries token usage only. Walk in reverse so we pick
// the LAST agent_message event in case of multiple.
//
// With `--output-schema` enabled, codex constrains the model to emit a JSON
// document conforming to CODEX_REPLY_SCHEMA — i.e. the `agent_message.text`
// field is a JSON string like `{"message":"pong"}`. We parse that and pull
// out `message`. If the field isn't valid JSON (older codex versions, or the
// schema not being enforced for some reason), we fall back to the raw text —
// graceful degradation, not a crash.
function findAssistantText(events: JsonlEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as Record<string, unknown>;
    if (e['type'] === 'item.completed') {
      const item = e['item'];
      if (item && typeof item === 'object') {
        const itemObj = item as Record<string, unknown>;
        if (itemObj['type'] === 'agent_message' && typeof itemObj['text'] === 'string') {
          const raw = itemObj['text'] as string;
          try {
            const parsed = JSON.parse(raw) as unknown;
            if (
              parsed !== null &&
              typeof parsed === 'object' &&
              'message' in (parsed as Record<string, unknown>) &&
              typeof (parsed as Record<string, unknown>)['message'] === 'string'
            ) {
              return (parsed as Record<string, unknown>)['message'] as string;
            }
          } catch {
            // raw isn't JSON — schema wasn't enforced, fall through to raw.
          }
          return raw;
        }
      }
    }
  }
  return null;
}

// Schema we hand to codex via `--output-schema <file>`. Constrains the model
// to emit a single JSON object with a `message` string. Description spells
// out exactly what we want in `message` so the model doesn't dump role
// labels, JSON wrappers, or markdown into it.
const CODEX_REPLY_SCHEMA = {
  type: 'object',
  properties: {
    message: {
      type: 'string',
      description:
        'The text of your next chat message. Do not include role labels, JSON wrappers, markdown, or explanations. Just the literal text of what you would say.',
    },
  },
  required: ['message'],
  additionalProperties: false,
};

// codex's `--output-schema` takes a file path, not inline JSON. We write the
// schema to a temp file once per process and reuse the path on every turn.
// The file lives under os.tmpdir() — fine to leak between turns; the OS
// reaps tmpdir on its own schedule. We re-create if it's been deleted under
// us (e.g. aggressive tmp cleaner).
let schemaPath: string | null = null;
function ensureSchemaFile(): string {
  if (schemaPath !== null && fs.existsSync(schemaPath)) return schemaPath;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fireside-codex-schema-'));
  const filePath = path.join(dir, 'reply-schema.json');
  fs.writeFileSync(filePath, JSON.stringify(CODEX_REPLY_SCHEMA), 'utf8');
  schemaPath = filePath;
  return filePath;
}

// Test hook: lets unit tests reset the cached schema path so they can assert
// the side-effect (file creation) deterministically without leaking state
// between runs. Not part of the public API.
export function _resetSchemaPathForTests(): void {
  schemaPath = null;
}

export const codexSpec: AgentSpec = {
  id: 'codex',
  displayName: 'Codex',
  command: 'codex',
  defaultTimeoutMs: 120_000,
  buildArgs(_prompt, sessionId) {
    const schema = ensureSchemaFile();
    // Codex with argv-prompt + non-TTY stdin (our spawn config) was empirically
    // observed to ignore the argv prompt and emit "I don't see the chat
    // transcript included..." instead of processing the turn cue. Switching to
    // the stdin path (positional `-` as the prompt-source sentinel) makes codex
    // read the transcript correctly and reply normally. The prompt itself goes
    // through `buildStdin` below; argv only points codex at stdin.
    //
    // Order for resume: `codex exec resume --json --output-schema <path>
    // <session_id> -`. Per `codex exec resume --help`, the session id is the
    // positional [SESSION_ID]; `-` is kept as the LAST positional (prompt-
    // source). --last is intentionally avoided — multi-room/multi-agent safety.
    if (sessionId) {
      return ['exec', 'resume', '--json', '--output-schema', schema, sessionId, '-'];
    }
    return ['exec', '--json', '--output-schema', schema, '-'];
  },
  buildStdin(prompt) {
    return prompt;
  },
  parseOutput(stdout, stderr): AgentReply {
    const events = parseJsonl(stdout);
    if (events.length === 0) {
      throw new AgentParseError('codex', 'no JSONL events on stdout', stdout, stderr);
    }
    const text = findAssistantText(events);
    if (text === null) {
      throw new AgentParseError(
        'codex',
        'no assistant message event found in stream',
        stdout,
        stderr,
      );
    }
    const sessionId = findSessionId(events);
    return { text, sessionId, raw: { stdout, stderr } };
  },
};
