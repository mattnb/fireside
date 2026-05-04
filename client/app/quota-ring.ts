// client/app/quota-ring.ts
// Pure math + tone helpers for the rail-agent tri-wedge quota/context ring.
// The ring is composed of three SVG arc wedges; this module owns the geometry
// constants and the threshold thresholds for green/yellow/red tone classes.

export const RING_CIRCUMFERENCE = 163.36;
export const RING_WEDGE_ARC = 52.64;

export type QuotaTone = 'green' | 'yellow' | 'red' | 'idle';

export function ringTrackDash(): string {
  const arc = RING_WEDGE_ARC;
  const gap = RING_CIRCUMFERENCE - arc;
  return `${arc.toFixed(2)} ${gap.toFixed(2)}`;
}

export function ringFillDash(percent: number | null | undefined): string {
  const safe = Math.max(0, Math.min(100, percent ?? 0));
  const fill = (safe / 100) * RING_WEDGE_ARC;
  const remainder = RING_CIRCUMFERENCE - fill;
  return `${fill.toFixed(2)} ${remainder.toFixed(2)}`;
}

export function quotaTone(percent: number | null | undefined): QuotaTone {
  if (percent === null || percent === undefined) return 'idle';
  if (percent >= 85) return 'red';
  if (percent >= 60) return 'yellow';
  return 'green';
}
