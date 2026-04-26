// server/src/agents/gemini.ts
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
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

function createEmptyCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fireside-gemini-cwd-'));
}

export const geminiSpec: AgentSpec = {
  id: 'gemini',
  displayName: 'Gemini',
  command: 'gemini',
  defaultTimeoutMs: 480_000,
  // Gemini-cli auto-detects context from cwd and mishandles multi-line prompt
  // text passed as the `-p` argv value on Windows. Keep `-p` present to force
  // headless mode, send the real prompt through stdin, and run each turn in a
  // fresh empty cwd so stale temp files cannot become project context.
  buildCwd: createEmptyCwd,
  buildArgs(_prompt, sessionId) {
    const args = ['-p', '', '--output-format', 'json'];
    if (sessionId) args.push('--resume', sessionId);
    return args;
  },
  buildStdin(prompt) {
    return prompt;
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
