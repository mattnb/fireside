// server/src/agents/gemini.ts
import type { AgentReply, AgentSpec } from './types.js';
import { AgentParseError } from './types.js';
import { extractTopLevelJsonObject } from './json-extract.js';

// Field names captured from Phase 2 fixture (gemini-headless.json):
//   top-level `response` carries the assistant text
//   top-level `session_id` carries the session id
// We keep the lookup arrays ordered with the captured names first; later
// names act as forward-compat fallbacks should the CLI evolve.
const RESPONSE_FIELDS = ['response', 'result', 'text', 'output'];
const SESSION_FIELDS = ['session_id', 'sessionId', 'session'];

function pickString(obj: Record<string, unknown>, fields: string[]): string | null {
  for (const f of fields) {
    const v = obj[f];
    if (typeof v === 'string') return v;
  }
  return null;
}

export const geminiSpec: AgentSpec = {
  id: 'gemini',
  displayName: 'Gemini',
  command: 'gemini',
  defaultTimeoutMs: 240_000,
  buildArgs(prompt, sessionId) {
    const args = ['-p', prompt, '--output-format', 'json'];
    if (sessionId) args.push('--resume');
    return args;
  },
  parseOutput(stdout, stderr): AgentReply {
    if (!stdout.trim()) throw new AgentParseError('gemini', 'empty stdout', stdout, stderr);
    // Gemini may emit a preamble on stdout before the JSON object. Tolerate it.
    const parsed = extractTopLevelJsonObject(stdout);
    if (!parsed || typeof parsed !== 'object') {
      throw new AgentParseError(
        'gemini',
        'no top-level JSON object found in stdout',
        stdout,
        stderr,
      );
    }
    const obj = parsed as Record<string, unknown>;
    const text = pickString(obj, RESPONSE_FIELDS);
    const sessionId = pickString(obj, SESSION_FIELDS);
    if (text === null) {
      throw new AgentParseError('gemini', 'no response field found', stdout, stderr);
    }
    return { text, sessionId, raw: { stdout, stderr } };
  },
};
