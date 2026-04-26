// server/src/agents/claude.ts
import type { AgentReply, AgentSpec } from './types.js';
import { AgentParseError } from './types.js';
import { extractTopLevelJsonObject } from './json-extract.js';

// Field names captured from Phase 2 fixture (claude-headless.json):
//   top-level `result` carries the assistant text
//   top-level `session_id` carries the session id
const RESULT_FIELD = 'result';
const SESSION_FIELD = 'session_id';

export const claudeSpec: AgentSpec = {
  id: 'claude',
  displayName: 'Claude Code',
  command: 'claude',
  defaultTimeoutMs: 120_000,
  buildArgs(prompt, sessionId) {
    const args = ['-p', prompt, '--output-format', 'json'];
    if (sessionId) args.push('--resume', sessionId);
    return args;
  },
  parseOutput(stdout, stderr): AgentReply {
    if (!stdout.trim()) {
      throw new AgentParseError('claude', 'empty stdout', stdout, stderr);
    }
    // Claude can emit a session-startup greeting (per CLAUDE.md instructions)
    // before the JSON object on stdout. Use a tolerant extractor so the
    // adapter does not crash on that preamble.
    const parsed = extractTopLevelJsonObject(stdout);
    if (!parsed || typeof parsed !== 'object') {
      throw new AgentParseError(
        'claude',
        'no top-level JSON object found in stdout',
        stdout,
        stderr,
      );
    }
    const obj = parsed as Record<string, unknown>;
    const text = typeof obj[RESULT_FIELD] === 'string' ? (obj[RESULT_FIELD] as string) : null;
    const sessionId =
      typeof obj[SESSION_FIELD] === 'string' ? (obj[SESSION_FIELD] as string) : null;
    if (text === null) {
      throw new AgentParseError(
        'claude',
        `missing field "${RESULT_FIELD}" in output`,
        stdout,
        stderr,
      );
    }
    return { text, sessionId, raw: { stdout, stderr } };
  },
};
