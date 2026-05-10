// server/tests/unit/dag-layout.test.ts
//
// Pure-module coverage for the dependency DAG layout used by the client's
// graph view. Lives under server/tests because that's where vitest is
// wired; the module under test is pure TypeScript with no Angular deps.

import { describe, it, expect } from 'vitest';
import {
  computeDagLayout,
  type DagInputNode,
} from '../../../client/app/dag-layout.js';

function node(id: string, deps: readonly string[] = [], extras: Partial<DagInputNode> = {}): DagInputNode {
  return {
    id,
    title: extras.title ?? id,
    status: extras.status ?? 'open',
    tone: extras.tone ?? 'open',
    sortOrder: extras.sortOrder ?? 0,
    dependencyIds: deps,
    ...(extras.context !== undefined ? { context: extras.context } : {}),
    ...(extras.active !== undefined ? { active: extras.active } : {}),
  };
}

describe('computeDagLayout', () => {
  it('returns an empty layout for empty input', () => {
    const out = computeDagLayout([]);
    expect(out.nodes).toEqual([]);
    expect(out.edges).toEqual([]);
    expect(out.cycleNodeIds.size).toBe(0);
    expect(out.width).toBeGreaterThan(0);
    expect(out.height).toBeGreaterThan(0);
  });

  it('places isolated nodes at level 0 and stacks them vertically', () => {
    const out = computeDagLayout([node('a'), node('b')]);
    expect(out.nodes).toHaveLength(2);
    expect(out.nodes.every((n) => n.level === 0)).toBe(true);
    const ys = out.nodes.map((n) => n.y);
    expect(ys[0]).not.toBe(ys[1]);
  });

  it('layers a simple chain a → b → c with increasing levels', () => {
    const out = computeDagLayout([node('a'), node('b', ['a']), node('c', ['b'])]);
    const byId = new Map(out.nodes.map((n) => [n.id, n]));
    expect(byId.get('a')!.level).toBe(0);
    expect(byId.get('b')!.level).toBe(1);
    expect(byId.get('c')!.level).toBe(2);
    expect(out.edges).toHaveLength(2);
    expect(out.edges.every((e) => e.cyclic === false)).toBe(true);
  });

  it('uses longest-path layering even when shorter paths exist', () => {
    // a → b → c → d, plus a → d. d should sit at level 3, not 1.
    const out = computeDagLayout([
      node('a'),
      node('b', ['a']),
      node('c', ['b']),
      node('d', ['c', 'a']),
    ]);
    const byId = new Map(out.nodes.map((n) => [n.id, n]));
    expect(byId.get('d')!.level).toBe(3);
  });

  it('detects a back edge in a cycle and marks both endpoints in cycle set', () => {
    // a → b → c → a (cycle).
    const out = computeDagLayout([
      node('a', ['c']),
      node('b', ['a']),
      node('c', ['b']),
    ]);
    expect(out.cycleNodeIds.has('a')).toBe(true);
    expect(out.cycleNodeIds.has('b')).toBe(true);
    expect(out.cycleNodeIds.has('c')).toBe(true);
    const cyclic = out.edges.filter((e) => e.cyclic);
    expect(cyclic).toHaveLength(1);
  });

  it('keeps non-cycle nodes outside the cycle set', () => {
    // x → y (no cycle), plus a → b → a (self-cycle pair).
    const out = computeDagLayout([
      node('a', ['b']),
      node('b', ['a']),
      node('x'),
      node('y', ['x']),
    ]);
    expect(out.cycleNodeIds.has('a')).toBe(true);
    expect(out.cycleNodeIds.has('b')).toBe(true);
    expect(out.cycleNodeIds.has('x')).toBe(false);
    expect(out.cycleNodeIds.has('y')).toBe(false);
  });

  it('drops dependency ids that point to unknown nodes', () => {
    const out = computeDagLayout([node('a', ['ghost']), node('b', ['a'])]);
    // No edge for the ghost dependency.
    expect(out.edges).toHaveLength(1);
    expect(out.edges[0]).toMatchObject({ source: 'a', target: 'b', cyclic: false });
  });

  it('preserves stable ordering within a level via sortOrder then title', () => {
    const out = computeDagLayout([
      node('z', [], { sortOrder: 2, title: 'z' }),
      node('a', [], { sortOrder: 0, title: 'a' }),
      node('m', [], { sortOrder: 1, title: 'm' }),
    ]);
    const sorted = out.nodes.slice().sort((p, q) => p.indexInLevel - q.indexInLevel);
    expect(sorted.map((n) => n.id)).toEqual(['a', 'm', 'z']);
  });

  it('marks active nodes through to the layout output', () => {
    const out = computeDagLayout([node('a', [], { active: true }), node('b')]);
    const byId = new Map(out.nodes.map((n) => [n.id, n]));
    expect(byId.get('a')!.active).toBe(true);
    expect(byId.get('b')!.active).toBe(false);
  });

  it('handles a self-loop without exploding', () => {
    const out = computeDagLayout([node('a', ['a'])]);
    expect(out.cycleNodeIds.has('a')).toBe(true);
    expect(out.edges).toHaveLength(1);
    expect(out.edges[0]!.cyclic).toBe(true);
  });

  it('handles a long chain (>1000 nodes) without stack overflow', () => {
    const nodes: DagInputNode[] = [];
    nodes.push(node('n0'));
    for (let i = 1; i < 1500; i += 1) {
      nodes.push(node(`n${i}`, [`n${i - 1}`]));
    }
    const out = computeDagLayout(nodes);
    const last = out.nodes.find((n) => n.id === 'n1499')!;
    expect(last.level).toBe(1499);
    expect(out.cycleNodeIds.size).toBe(0);
  });
});
