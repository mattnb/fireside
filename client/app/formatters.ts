// client/app/formatters.ts
// Pure formatting helpers. No DI, no state — these are extracted from the
// App component so they can be reused by future child components without
// dragging the whole component along.

export function formatBytes(bytes: number | undefined): string {
  if (!Number.isFinite(bytes)) return '0 B';
  const value = bytes ?? 0;
  if (value < 1024) return `${value} B`;
  const kb = value / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

export function formatShortTime(timestamp: number | undefined): string {
  if (!timestamp) return 'unknown';
  return new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function formatDateTime(timestamp: number | undefined | null): string {
  if (!timestamp) return 'unknown';
  return new Date(timestamp).toLocaleString();
}

export function formatDurationMs(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return `${minutes}m ${rest}s`;
  const hours = Math.floor(minutes / 60);
  const minRest = minutes % 60;
  return `${hours}h ${minRest}m`;
}

export function formatTokenCount(tokens: number | undefined): string {
  if (!Number.isFinite(tokens)) return 'unknown';
  const value = Math.max(0, tokens ?? 0);
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(value >= 10_000_000_000 ? 0 : 1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}K`;
  return String(Math.round(value));
}

export function pad2(value: number): string {
  return String(Math.max(0, Math.floor(value))).padStart(2, '0');
}

export function oneLine(text: string | undefined | null, maxChars = 220): string {
  const normalized = (text || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1))}...`;
}

export function formatResetWindow(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'now';
  const totalMin = Math.round(ms / 60000);
  const days = Math.floor(totalMin / (60 * 24));
  const remain = totalMin - days * 60 * 24;
  const hours = Math.floor(remain / 60);
  const mins = remain - hours * 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return mins > 0 ? `${hours}h${pad2(mins)}m` : `${hours}h`;
  return `${mins}m`;
}

export function elapsedLabel(
  startedAt: number | undefined,
  completedAt: number | undefined | null,
  now: number,
): string {
  if (!startedAt) return 'unknown';
  const end = completedAt ?? now;
  const seconds = Math.max(0, Math.round((end - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m ${rest}s`;
}

export function formatRelativeAgo(timestamp: number | undefined, now: number): string {
  if (!timestamp) return 'unknown';
  const delta = now - timestamp;
  if (delta < 0) return 'just now';
  if (delta < 5_000) return 'just now';
  return `${formatDurationMs(delta)} ago`;
}
