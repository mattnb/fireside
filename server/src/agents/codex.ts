// server/src/agents/codex.ts
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
function findAssistantText(events: JsonlEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as Record<string, unknown>;
    if (e['type'] === 'item.completed') {
      const item = e['item'];
      if (item && typeof item === 'object') {
        const itemObj = item as Record<string, unknown>;
        if (itemObj['type'] === 'agent_message' && typeof itemObj['text'] === 'string') {
          return itemObj['text'];
        }
      }
    }
  }
  return null;
}

export const codexSpec: AgentSpec = {
  id: 'codex',
  displayName: 'Codex',
  command: 'codex',
  defaultTimeoutMs: 120_000,
  buildArgs(prompt, sessionId) {
    if (sessionId) {
      return ['exec', 'resume', '--last', '--json', prompt];
    }
    return ['exec', '--json', prompt];
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
