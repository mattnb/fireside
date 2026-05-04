import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db.js';
import { Broker } from '../../src/broker.js';
import { buildHttpServer, type HttpServer } from '../../src/http-server.js';

describe('provider scoring HTTP endpoint', () => {
  let app: HttpServer | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it('returns explainable provider recommendations for persona slots', async () => {
    const db = openDatabase(':memory:');
    const broker = new Broker({
      db,
      getSpec: () => undefined,
      runAgent: async () => ({ text: '', sessionId: null, raw: { stdout: '', stderr: '' } }),
    });
    app = buildHttpServer({ db, broker, uiDir: process.cwd() });

    const response = await app.inject({
      method: 'POST',
      url: '/api/agents/provider-score',
      payload: {
        slots: [
          {
            id: 'visual',
            personaId: 'visual-design-systems-designer',
            providerId: 'codex',
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      slots: Array<{
        id: string;
        selectedProviderId: string;
        recommendationMatchesCurrent: boolean;
        candidates: Array<{ providerId: string; selected: boolean; reasons: string[] }>;
      }>;
    }>();
    expect(body.slots[0]).toMatchObject({
      id: 'visual',
      selectedProviderId: 'gemini',
      recommendationMatchesCurrent: false,
    });
    expect(body.slots[0]?.candidates.find((candidate) => candidate.selected)).toMatchObject({
      providerId: 'gemini',
    });
    expect(body.slots[0]?.candidates[0]?.reasons.length).toBeGreaterThan(0);
    db.close();
  });

  it('accounts for provider saturation across the draft team', async () => {
    const db = openDatabase(':memory:');
    const broker = new Broker({
      db,
      getSpec: () => undefined,
      runAgent: async () => ({ text: '', sessionId: null, raw: { stdout: '', stderr: '' } }),
    });
    app = buildHttpServer({ db, broker, uiDir: process.cwd() });

    const response = await app.inject({
      method: 'POST',
      url: '/api/agents/provider-score',
      payload: {
        slots: [
          {
            id: 'principal',
            personaId: 'principal-software-engineer',
            providerId: 'codex',
          },
          { id: 'qa', personaId: 'quality-assurance-engineer', providerId: 'codex' },
          { id: 'reliability', personaId: 'reliability-engineer', providerId: 'codex' },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    const principal = response
      .json<{ slots: Array<{ id: string; selectedProviderId: string; candidates: Array<{ providerId: string; warnings: string[] }> }> }>()
      .slots.find((slot) => slot.id === 'principal');

    expect(principal?.selectedProviderId).toBe('claude');
    expect(
      principal?.candidates.find((candidate) => candidate.providerId === 'codex')?.warnings,
    ).toEqual(expect.arrayContaining(['team already has 2 Codex slot(s)']));
    db.close();
  });
});
