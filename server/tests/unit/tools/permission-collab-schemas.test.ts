import { describe, expect, it } from 'vitest';
import { parsePermissionRequestArgs } from '../../../src/tools/schemas/permission.js';
import {
  collabNoteAddSchema,
  collabNoteUpdateSchema,
  defaultCollabNoteStatus,
  parseCollabNoteAddArgs,
  parseCollabNoteUpdateArgs,
} from '../../../src/tools/schemas/collab.js';

describe('parsePermissionRequestArgs', () => {
  it('accepts a minimal request and trims string fields', () => {
    const parsed = parsePermissionRequestArgs({
      mode: 'edit',
      target: '  packages/server/src  ',
      reason: ' wire phase tools ',
    });
    expect(parsed).toEqual({
      mode: 'edit',
      target: 'packages/server/src',
      reason: 'wire phase tools',
    });
  });

  it('preserves optional capabilities, scope, web flag, and requestedMode alias', () => {
    const parsed = parsePermissionRequestArgs({
      mode: 'full-auto',
      target: 'C:/repo',
      reason: 'unrestricted yolo run',
      requestedMode: 'shell',
      capabilities: ['read', 'run-command', 'read'],
      filesystemScope: 'unrestricted',
      web: true,
    });
    expect(parsed).toMatchObject({
      mode: 'full-auto',
      requestedMode: 'shell',
      capabilities: ['read', 'run-command'],
      filesystemScope: 'unrestricted',
      web: true,
    });
  });

  it('rejects missing required fields and unknown enum values', () => {
    expect(() => parsePermissionRequestArgs({ target: 'x', reason: 'y' })).toThrow(
      /mode is required/,
    );
    expect(() =>
      parsePermissionRequestArgs({ mode: 'edit', target: '', reason: 'y' }),
    ).toThrow(/target is required/);
    expect(() =>
      parsePermissionRequestArgs({ mode: 'edit', target: 'x', reason: '' }),
    ).toThrow(/reason is required/);
    expect(() =>
      parsePermissionRequestArgs({ mode: 'wild', target: 'x', reason: 'y' }),
    ).toThrow(/unknown permission mode/);
    expect(() =>
      parsePermissionRequestArgs({
        mode: 'edit',
        target: 'x',
        reason: 'y',
        capabilities: ['nope'],
      }),
    ).toThrow(/unknown capability/);
    expect(() =>
      parsePermissionRequestArgs({
        mode: 'edit',
        target: 'x',
        reason: 'y',
        web: 'sure',
      }),
    ).toThrow(/web must be a boolean/);
  });

  it('enforces target and reason length caps', () => {
    expect(() =>
      parsePermissionRequestArgs({
        mode: 'edit',
        target: 'a'.repeat(501),
        reason: 'ok',
      }),
    ).toThrow(/target exceeds 500/);
    expect(() =>
      parsePermissionRequestArgs({
        mode: 'edit',
        target: 'ok',
        reason: 'a'.repeat(1001),
      }),
    ).toThrow(/reason exceeds 1000/);
  });
});

describe('parseCollabNoteAddArgs', () => {
  it('accepts a minimal note with title only and trims fields', () => {
    const parsed = parseCollabNoteAddArgs({
      kind: 'PROPOSAL',
      title: '  use tool ledger  ',
    });
    expect(parsed).toEqual({ kind: 'proposal', title: 'use tool ledger' });
  });

  it('parses status, confidence, target, and evidence list', () => {
    const parsed = parseCollabNoteAddArgs({
      kind: 'decision',
      title: 'go',
      body: 'because',
      target: 'phase:abc',
      status: 'accepted',
      confidence: 'High',
      evidence: ['  one ', '', 'two', 'two'],
    });
    expect(parsed).toMatchObject({
      kind: 'decision',
      status: 'accepted',
      confidence: 'high',
      evidence: ['one', 'two', 'two'],
    });
  });

  it('rejects unknown kind/status and missing title+body', () => {
    expect(() => parseCollabNoteAddArgs({ kind: 'rant', title: 'x' })).toThrow(
      /unknown collaboration kind/,
    );
    expect(() =>
      parseCollabNoteAddArgs({ kind: 'proposal', title: 'x', status: 'mystery' }),
    ).toThrow(/unknown collaboration status/);
    expect(() => parseCollabNoteAddArgs({ kind: 'proposal' })).toThrow(
      /at least one of title or body/,
    );
  });

  it('exposes legacy default-status mapping', () => {
    expect(defaultCollabNoteStatus('decision')).toBe('accepted');
    expect(defaultCollabNoteStatus('evidence')).toBe('informational');
    expect(defaultCollabNoteStatus('revision')).toBe('resolved');
    expect(defaultCollabNoteStatus('proposal')).toBe('open');
    expect(defaultCollabNoteStatus('challenge')).toBe('open');
  });
});

describe('parseCollabNoteUpdateArgs', () => {
  it('requires id and at least one mutable field', () => {
    expect(() => parseCollabNoteUpdateArgs({ id: '' })).toThrow(/id is required/);
    expect(() => parseCollabNoteUpdateArgs({ id: 'note-1' })).toThrow(
      /at least one mutable field/,
    );
  });

  it('parses status and trims fields', () => {
    const parsed = parseCollabNoteUpdateArgs({
      id: 'note-1',
      status: 'Resolved',
      body: '  closed by tool  ',
    });
    expect(parsed).toEqual({ id: 'note-1', status: 'resolved', body: 'closed by tool' });
  });
});

describe('collabNoteAddSchema.inputSchema (MCP tools/list visibility)', () => {
  // Without an explicit JSON Schema, registry.listTools falls back to
  // `{ type: 'object', additionalProperties: true }` and MCP-side LLM
  // clients have no way to learn that `evidence` must be an array of
  // strings. The 2026-05-09 smoke test surfaced agents repeatedly passing
  // evidence as a string and getting rejected with no schema-level hint.
  it('declares the full property surface so MCP clients can validate locally', () => {
    const schema = collabNoteAddSchema.inputSchema as {
      type: string;
      additionalProperties: boolean;
      required: string[];
      properties: Record<string, { type: string; items?: { type: string }; enum?: string[] }>;
    };
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['kind']);
    expect(schema.properties.kind?.enum).toEqual([
      'proposal',
      'challenge',
      'revision',
      'decision',
      'evidence',
    ]);
    // The bug: `evidence` must surface as an array of strings, not a free
    // string. Pin the shape so a future refactor can't quietly regress it.
    expect(schema.properties.evidence?.type).toBe('array');
    expect(schema.properties.evidence?.items?.type).toBe('string');
    expect(schema.properties.title?.type).toBe('string');
    expect(schema.properties.body?.type).toBe('string');
    expect(schema.properties.target?.type).toBe('string');
  });

  it('reuses the existing parser so runtime validation is unchanged', () => {
    expect(collabNoteAddSchema.parse).toBe(parseCollabNoteAddArgs);
  });
});

describe('collabNoteUpdateSchema.inputSchema', () => {
  it('declares evidence as an array of strings and id as required', () => {
    const schema = collabNoteUpdateSchema.inputSchema as {
      required: string[];
      properties: Record<string, { type: string; items?: { type: string } }>;
    };
    expect(schema.required).toEqual(['id']);
    expect(schema.properties.evidence?.type).toBe('array');
    expect(schema.properties.evidence?.items?.type).toBe('string');
  });

  it('reuses the existing parser', () => {
    expect(collabNoteUpdateSchema.parse).toBe(parseCollabNoteUpdateArgs);
  });
});
