function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const LINE_MARKER_PREFIX = String.raw`[^\w/\r\n]{0,20}?`;
const LINE_MARKER_SUFFIX = String.raw`[^\w/\r\n]{0,20}?`;
const FIELD_RE = /^(\s*)([A-Za-z][\w -]*?)\s*:\s*(.*)$/;

export function hiddenBlockRegex(startName: string, endNames: string[]): RegExp {
  const start = escapeRegExp(startName);
  const ends = endNames.map(escapeRegExp).join('|');
  return new RegExp(
    String.raw`(^|\n)${LINE_MARKER_PREFIX}\/${start}\s*\n([\s\S]*?)\n${LINE_MARKER_PREFIX}[/@]end-(?:${ends})${LINE_MARKER_SUFFIX}(?=\n|$)`,
    'gi',
  );
}

export function stripEmptyHiddenBlockComments(text: string): string {
  return text.replace(/(^|\n)[ \t]*<!--[\s\r\n]*-->[ \t]*(?=\n|$)/g, (_match, prefix: string) =>
    prefix === '\n' ? '\n' : '',
  );
}

export function normalizeHiddenBlockFieldKey(key: string): string {
  return key.trim().toLowerCase().replace(/[-\s]+/g, '_');
}

function isFieldLine(line: string): boolean {
  return FIELD_RE.test(line);
}

function lineIndent(line: string): number {
  const match = /^(\s*)/.exec(line);
  return (match?.[1] ?? '').replace(/\t/g, '  ').length;
}

function trimBlockIndent(lines: string[]): string {
  const nonBlank = lines.filter((line) => line.trim());
  const indent = nonBlank.length
    ? Math.min(...nonBlank.map((line) => lineIndent(line)))
    : 0;
  return lines
    .map((line) => (line.trim() ? line.slice(Math.min(indent, line.length)) : ''))
    .join('\n')
    .trim();
}

function parseIndentedContinuation(lines: string[], startIndex: number): {
  values: string[];
  nextIndex: number;
} {
  const continuation: string[] = [];
  let index = startIndex;
  for (; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim() && lineIndent(line) === 0 && isFieldLine(line)) break;
    continuation.push(line);
  }

  const trimmed = continuation.filter((line) => line.trim());
  if (trimmed.length > 0 && trimmed.every((line) => /^(\s*)-\s+/.test(line))) {
    return {
      values: trimmed.map((line) => line.replace(/^(\s*)-\s+/, '').trim()).filter(Boolean),
      nextIndex: index,
    };
  }

  const value = trimBlockIndent(continuation);
  return {
    values: value ? [value] : [],
    nextIndex: index,
  };
}

export function parseHiddenBlockFields(block: string): Map<string, string[]> {
  const fields = new Map<string, string[]>();
  const lines = block.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index]!;
    if (!rawLine.trim()) continue;

    const match = FIELD_RE.exec(rawLine.trimEnd());
    if (!match) continue;

    const key = normalizeHiddenBlockFieldKey(match[2]!);
    const rawValue = match[3] ?? '';
    let values: string[];

    if (/^[|>][-+]?$/.test(rawValue.trim())) {
      const parsed = parseIndentedContinuation(lines, index + 1);
      values = parsed.values;
      index = parsed.nextIndex - 1;
    } else if (!rawValue.trim()) {
      const parsed = parseIndentedContinuation(lines, index + 1);
      values = parsed.values;
      index = parsed.nextIndex - 1;
    } else {
      values = [rawValue.trim()];
    }

    if (!fields.has(key)) fields.set(key, []);
    fields.get(key)!.push(...values);
  }

  return fields;
}
