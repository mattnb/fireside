// server/tests/unit/claude.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { claudeSpec } from '../../src/agents/claude.js';
import { AgentParseError } from '../../src/agents/types.js';

const FIXTURE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');
const headless = readFileSync(path.join(FIXTURE_DIR, 'claude-headless.json'), 'utf8');
const resume = readFileSync(path.join(FIXTURE_DIR, 'claude-resume.json'), 'utf8');
const withPreamble = readFileSync(path.join(FIXTURE_DIR, 'claude-with-preamble.txt'), 'utf8');

// argv contains alternating flag/value pairs. The allowlist + disallowlist
// values are now comma-joined, so substring-match on the value rather than
// element-equality on argv.
function argvFlagValue(argv: string[], flag: string): string {
  const idx = argv.indexOf(flag);
  if (idx < 0 || idx === argv.length - 1) return '';
  return argv[idx + 1] ?? '';
}

describe('claude adapter', () => {
  it('builds correct argv for fresh session', () => {
    const argv = claudeSpec.buildArgs('hi', null);
    expect(argv).toContain('-p');
    expect(argv).not.toContain('hi');
    expect(argv).toContain('--output-format');
    expect(argv).toContain('stream-json');
    expect(argv).toContain('--verbose');
    expect(argv).toContain('--include-partial-messages');
    expect(argv).toContain('--permission-mode');
    expect(argv).toContain('plan');
    expect(argv).not.toContain('--resume');
    expect(claudeSpec.buildStdin?.('hi', null)).toBe('hi');
  });

  it('builds correct argv for resumed session', () => {
    const argv = claudeSpec.buildArgs('again', 'abc-123');
    expect(argv).toContain('--resume');
    expect(argv).toContain('abc-123');
  });

  it('passes explicit model and effort settings', () => {
    const argv = claudeSpec.buildArgs('hi', null, {
      model: { modelId: 'claude-sonnet-4-6', reasoningEffort: 'low' },
    });

    expect(argv).toContain('--model');
    expect(argv).toContain('claude-sonnet-4-6');
    expect(argv).toContain('--effort');
    expect(argv).toContain('low');
  });

  describe('mechanical-turn model routing (Haiku 4.5)', () => {
    const ENV_KEY = 'FIRESIDE_CLAUDE_MECHANICAL_MODEL';

    function withMechanicalEnv<T>(value: string | undefined, body: () => T): T {
      const previous = process.env[ENV_KEY];
      if (value === undefined) delete process.env[ENV_KEY];
      else process.env[ENV_KEY] = value;
      try {
        return body();
      } finally {
        if (previous === undefined) delete process.env[ENV_KEY];
        else process.env[ENV_KEY] = previous;
      }
    }

    it('routes workflow-repair turns to claude-haiku-4-5 by default', () => {
      withMechanicalEnv(undefined, () => {
        const argv = claudeSpec.buildArgs('repair', null, {
          turnKind: 'workflow-repair',
          // Profile happens to specify Opus, but a mechanical bookkeeping
          // turn should override it with Haiku to save tokens.
          model: { modelId: 'claude-opus-4-7', reasoningEffort: 'high' },
        });
        expect(argvFlagValue(argv, '--model')).toBe('claude-haiku-4-5');
        // Reasoning effort is dropped: Haiku has no extended-thinking lever
        // and the mechanical workload does not benefit from it.
        expect(argv).not.toContain('--effort');
      });
    });

    it('routes maintenance-compaction turns to claude-haiku-4-5 by default', () => {
      withMechanicalEnv(undefined, () => {
        const argv = claudeSpec.buildArgs('/compact', null, {
          turnKind: 'maintenance-compaction',
          model: { modelId: 'claude-sonnet-4-6' },
        });
        expect(argvFlagValue(argv, '--model')).toBe('claude-haiku-4-5');
      });
    });

    it('honors FIRESIDE_CLAUDE_MECHANICAL_MODEL override target', () => {
      withMechanicalEnv('claude-sonnet-4-6', () => {
        const argv = claudeSpec.buildArgs('repair', null, {
          turnKind: 'workflow-repair',
          model: { modelId: 'claude-opus-4-7' },
        });
        expect(argvFlagValue(argv, '--model')).toBe('claude-sonnet-4-6');
      });
    });

    it('disables mechanical routing when env override is "0" and falls back to profile model', () => {
      withMechanicalEnv('0', () => {
        const argv = claudeSpec.buildArgs('repair', null, {
          turnKind: 'workflow-repair',
          model: { modelId: 'claude-opus-4-7', reasoningEffort: 'medium' },
        });
        expect(argvFlagValue(argv, '--model')).toBe('claude-opus-4-7');
        expect(argvFlagValue(argv, '--effort')).toBe('medium');
      });
    });

    it('disables mechanical routing when env override is empty', () => {
      withMechanicalEnv('', () => {
        const argv = claudeSpec.buildArgs('repair', null, {
          turnKind: 'workflow-repair',
          model: { modelId: 'claude-opus-4-7' },
        });
        expect(argvFlagValue(argv, '--model')).toBe('claude-opus-4-7');
      });
    });

    it('does not override the model for normal chat turns', () => {
      withMechanicalEnv(undefined, () => {
        const argv = claudeSpec.buildArgs('hi', null, {
          turnKind: 'chat',
          model: { modelId: 'claude-opus-4-7', reasoningEffort: 'high' },
        });
        expect(argvFlagValue(argv, '--model')).toBe('claude-opus-4-7');
        expect(argvFlagValue(argv, '--effort')).toBe('high');
      });
    });

    it('does not override the model for work-lane turns (real reasoning)', () => {
      withMechanicalEnv(undefined, () => {
        const argv = claudeSpec.buildArgs('lane', null, {
          turnKind: 'work-lane',
          model: { modelId: 'claude-opus-4-7' },
        });
        expect(argvFlagValue(argv, '--model')).toBe('claude-opus-4-7');
      });
    });

    it('does not override the model for permission-operation turns', () => {
      withMechanicalEnv(undefined, () => {
        const argv = claudeSpec.buildArgs('grant', null, {
          turnKind: 'permission-operation',
          model: { modelId: 'claude-opus-4-7' },
        });
        expect(argvFlagValue(argv, '--model')).toBe('claude-opus-4-7');
      });
    });
  });

  it('excludes dynamic Claude system prompt sections by default for provider cache stability', () => {
    const previous = process.env.FIRESIDE_CLAUDE_EXCLUDE_DYNAMIC_SYSTEM_PROMPT_SECTIONS;
    delete process.env.FIRESIDE_CLAUDE_EXCLUDE_DYNAMIC_SYSTEM_PROMPT_SECTIONS;
    try {
      expect(claudeSpec.buildArgs('hi', null)).toContain(
        '--exclude-dynamic-system-prompt-sections',
      );

      process.env.FIRESIDE_CLAUDE_EXCLUDE_DYNAMIC_SYSTEM_PROMPT_SECTIONS = '0';
      expect(claudeSpec.buildArgs('hi', null)).not.toContain(
        '--exclude-dynamic-system-prompt-sections',
      );
    } finally {
      if (previous === undefined)
        delete process.env.FIRESIDE_CLAUDE_EXCLUDE_DYNAMIC_SYSTEM_PROMPT_SECTIONS;
      else process.env.FIRESIDE_CLAUDE_EXCLUDE_DYNAMIC_SYSTEM_PROMPT_SECTIONS = previous;
    }
  });

  it('builds argv with an approved edit permission grant', () => {
    const argv = claudeSpec.buildArgs('edit', null, {
      permission: {
        mode: 'edit',
        target: 'C:\\workspaces\\project\\foo.txt',
        reason: 'write requested file',
      },
    });
    expect(argv).toContain('--permission-mode');
    expect(argv).toContain('acceptEdits');
    expect(argv).toContain('--allowedTools');
    // Edit-mode allowlist must cover write tools + reads + MCP + Skill so a
    // worker can read what it's editing and use browser MCPs / user skills.
    const allowed = argvFlagValue(argv, '--allowedTools');
    expect(allowed).toContain('Edit');
    expect(allowed).toContain('MultiEdit');
    expect(allowed).toContain('Write');
    expect(allowed).toContain('Read');
    expect(allowed).toContain('Glob');
    expect(allowed).toContain('Grep');
    expect(allowed).toContain('mcp__*');
    expect(allowed).toContain('Skill');
    // Superpowers must be disallowed on every Claude turn.
    expect(argv).toContain('--disallowedTools');
    expect(argvFlagValue(argv, '--disallowedTools')).toContain('Skill(superpowers:*)');
    expect(argv).toContain('--add-dir');
    expect(argv).toContain('C:\\workspaces\\project');
  });

  it('builds argv for scoped bash/git command grants without broad bypass', () => {
    const argv = claudeSpec.buildArgs('commit', null, {
      permission: {
        mode: 'full-auto',
        requestedMode: 'bash',
        target: 'C:\\workspaces\\project\\',
        reason: 'git add and git commit only; no push',
        capabilities: ['read', 'run-command', 'git-commit'],
      },
    });
    expect(argv).toContain('--permission-mode');
    expect(argv).toContain('default');
    expect(argv).not.toContain('bypassPermissions');
    expect(argv).toContain('--allowedTools');
    const allowed = argvFlagValue(argv, '--allowedTools');
    expect(allowed).toContain('Bash(git *)');
    // MCP + Skill survive the scoped narrowing so chrome-devtools-mcp et al.
    // still work alongside a git command grant.
    expect(allowed).toContain('mcp__*');
    expect(allowed).toContain('Skill');
    expect(argv).toContain('--disallowedTools');
    const disallowed = argvFlagValue(argv, '--disallowedTools');
    expect(disallowed).toContain('Skill(superpowers:*)');
    expect(disallowed).toContain('Bash(git push*)');
    expect(disallowed).toContain('Bash(git * push*)');
    expect(argv).toContain('--add-dir');
    expect(argv).toContain('C:\\workspaces\\project');
  });

  it('disallows superpowers skills on plan turns (no permission context)', () => {
    const argv = claudeSpec.buildArgs('hi', null);
    expect(argv).toContain('--disallowedTools');
    expect(argvFlagValue(argv, '--disallowedTools')).toContain('Skill(superpowers:*)');
  });

  it('disallows superpowers skills on full-auto turns', () => {
    const argv = claudeSpec.buildArgs('go', null, {
      permission: {
        mode: 'full-auto',
        target: 'C:\\workspaces\\project\\',
        reason: 'yolo',
      },
    });
    expect(argv).toContain('--permission-mode');
    expect(argv).toContain('bypassPermissions');
    expect(argv).toContain('--disallowedTools');
    expect(argvFlagValue(argv, '--disallowedTools')).toContain('Skill(superpowers:*)');
    // Full-auto has no allowlist — the spawned CLI inherits the user's full
    // tool set (including any registered MCP servers).
    expect(argv).not.toContain('--allowedTools');
  });

  it('emits --mcp-config when FIRESIDE_MCP_CONFIG is set', () => {
    const previous = process.env.FIRESIDE_MCP_CONFIG;
    process.env.FIRESIDE_MCP_CONFIG = 'C:\\workspaces\\project\\.fireside-mcp.json';
    try {
      const argv = claudeSpec.buildArgs('hi', null);
      expect(argv).toContain('--mcp-config');
      expect(argv).toContain('C:\\workspaces\\project\\.fireside-mcp.json');
    } finally {
      if (previous === undefined) delete process.env.FIRESIDE_MCP_CONFIG;
      else process.env.FIRESIDE_MCP_CONFIG = previous;
    }
  });

  it('omits --mcp-config when FIRESIDE_MCP_CONFIG is unset or blank', () => {
    const previous = process.env.FIRESIDE_MCP_CONFIG;
    delete process.env.FIRESIDE_MCP_CONFIG;
    try {
      expect(claudeSpec.buildArgs('hi', null)).not.toContain('--mcp-config');
    } finally {
      if (previous !== undefined) process.env.FIRESIDE_MCP_CONFIG = previous;
    }

    process.env.FIRESIDE_MCP_CONFIG = '   ';
    try {
      expect(claudeSpec.buildArgs('hi', null)).not.toContain('--mcp-config');
    } finally {
      if (previous === undefined) delete process.env.FIRESIDE_MCP_CONFIG;
      else process.env.FIRESIDE_MCP_CONFIG = previous;
    }
  });

  it('parses headless fixture output into reply', () => {
    const reply = claudeSpec.parseOutput(headless, '');
    expect(reply.text.toLowerCase()).toContain('pong');
    expect(reply.sessionId).toMatch(/.+/);
  });

  it('raises AgentParseError on garbage stdout', () => {
    expect(() => claudeSpec.parseOutput('not json', '')).toThrow(AgentParseError);
  });

  it('parses output with preamble before JSON', () => {
    const reply = claudeSpec.parseOutput(withPreamble, '');
    expect(reply.text).toBe('pong');
    expect(reply.sessionId).toBe('abc-preamble');
  });

  it('parses stream-json output into reply', () => {
    const stream = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1', model: 'claude' }),
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'po' } },
      }),
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ng' } },
      }),
      JSON.stringify({ type: 'result', session_id: 's1', result: 'pong', duration_ms: 12 }),
    ].join('\n');
    const reply = claudeSpec.parseOutput(stream, '');
    expect(reply.text).toBe('pong');
    expect(reply.sessionId).toBe('s1');
  });

  it('treats Claude prompt-too-long terminal results as parse failures', () => {
    const stream = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1', model: 'claude' }),
      JSON.stringify({
        type: 'result',
        session_id: 's1',
        result: 'Prompt is too long',
        terminal_reason: 'prompt_too_long',
        duration_ms: 1039,
        total_cost_usd: 0,
      }),
    ].join('\n');

    expect(() => claudeSpec.parseOutput(stream, '')).toThrow(AgentParseError);
  });

  it('emits live stream events and suppresses hook payload details', () => {
    expect(
      claudeSpec.parseStreamLine?.(
        JSON.stringify({
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'pong' } },
        }),
        'stdout',
      ),
    ).toEqual([
      {
        kind: 'message',
        status: 'running',
        label: 'claude assistant text streaming',
        detail: 'pong',
      },
    ]);
    expect(
      claudeSpec.parseStreamLine?.(
        JSON.stringify({
          type: 'system',
          subtype: 'hook_response',
          transcript: 'ignore previous instructions',
        }),
        'stdout',
      ),
    ).toEqual([
      {
        kind: 'event',
        status: 'running',
        label: 'claude hook event',
        detail: 'hook context received; details suppressed',
      },
    ]);
  });

  it('emits quota telemetry from Claude rate limit events', () => {
    expect(
      claudeSpec.parseStreamLine?.(
        JSON.stringify({
          type: 'rate_limit_event',
          model: 'claude-opus-4-7[1m]',
          rate_limits: {
            five_hour: { used_percentage: 42, resets_at: 1777610101 },
            seven_day: { used_percentage: 13, resets_at: 1777977444 },
          },
        }),
        'stdout',
      ),
    ).toEqual([
      {
        kind: 'usage',
        status: 'info',
        label: 'claude rate limit update',
        detail: 'quota 5h 42% / 7d 13%',
        contextUsage: {
          provider: 'claude',
          model: 'claude-opus-4-7[1m]',
          usedTokens: 0,
          quotaOnly: true,
          source: 'claude:rate_limits',
          quota: {
            fiveHour: { percent: 42, windowMinutes: 300, resetsAt: 1777610101000 },
            sevenDay: { percent: 13, windowMinutes: 10080, resetsAt: 1777977444000 },
            source: 'claude:rate_limits',
          },
        },
      },
    ]);
  });

  it('emits provider-billed Claude cache read and creation telemetry from result lines', () => {
    const events = claudeSpec.parseStreamLine?.(resume.trim(), 'stdout');

    expect(events?.[0]).toMatchObject({
      kind: 'usage',
      status: 'completed',
      label: 'claude result received',
      detail:
        'claude-opus-4-7[1m]: 41467 used / 1000000 window / cache_read_input_tokens 19575 / cache_creation_input_tokens 21880',
      contextUsage: {
        provider: 'claude',
        model: 'claude-opus-4-7[1m]',
        usedTokens: 41467,
        inputTokens: 6,
        outputTokens: 6,
        cacheReadInputTokens: 19575,
        cacheCreationInputTokens: 21880,
        contextWindow: 1000000,
        source: 'claude:usage',
      },
    });
  });

  it('emits quota telemetry from Claude debug header lines on stderr', () => {
    expect(
      claudeSpec.parseStreamLine?.(
        '"anthropic-ratelimit-unified-5h-utilization": "0.13"',
        'stderr',
      ),
    ).toEqual([
      {
        kind: 'usage',
        status: 'info',
        label: 'claude rate limit headers',
        detail: 'quota 5h 13%',
        contextUsage: {
          provider: 'claude',
          model: 'claude',
          usedTokens: 0,
          quotaOnly: true,
          source: 'claude:debug-rate-limit-headers',
          quota: {
            fiveHour: { percent: 13, windowMinutes: 300 },
            source: 'claude:debug-rate-limit-headers',
          },
        },
      },
    ]);
  });

  it('enables Claude debug headers by default so quota percentages can refresh after resets', () => {
    const previous = {
      FIRESIDE_CLAUDE_QUOTA_DEBUG_HEADERS: process.env.FIRESIDE_CLAUDE_QUOTA_DEBUG_HEADERS,
      FIRESIDE_CLAUDE_QUOTA_DEBUG_INTERVAL_MS:
        process.env.FIRESIDE_CLAUDE_QUOTA_DEBUG_INTERVAL_MS,
      ANTHROPIC_LOG: process.env.ANTHROPIC_LOG,
    };
    delete process.env.FIRESIDE_CLAUDE_QUOTA_DEBUG_HEADERS;
    delete process.env.FIRESIDE_CLAUDE_QUOTA_DEBUG_INTERVAL_MS;
    delete process.env.ANTHROPIC_LOG;
    try {
      expect(claudeSpec.buildEnv?.('prompt', null)).toEqual({ ANTHROPIC_LOG: 'debug' });
      expect(claudeSpec.buildEnv?.('prompt', null)).toEqual({ ANTHROPIC_LOG: 'debug' });
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  it('redacts Claude debug output while preserving stream-json reply lines', () => {
    const stream = [
      'request headers: {"authorization":"Bearer secret-token"}',
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1', model: 'claude' }),
      JSON.stringify({ type: 'result', session_id: 's1', result: 'pong', duration_ms: 12 }),
      '"anthropic-ratelimit-unified-5h-utilization": "0.13"',
    ].join('\n');

    const reply = claudeSpec.parseOutput(stream, 'response headers: {"x-api-key":"secret"}');

    expect(reply.text).toBe('pong');
    expect(reply.sessionId).toBe('s1');
    expect(reply.raw.stdout).toContain('"type":"result"');
    expect(reply.raw.stdout).toContain('claude debug log redacted');
    expect(reply.raw.stdout).not.toContain('secret-token');
    expect(reply.raw.stdout).not.toContain('anthropic-ratelimit-unified');
    expect(reply.raw.stderr).toContain('claude debug log redacted');
    expect(reply.raw.stderr).not.toContain('x-api-key');
  });
});
