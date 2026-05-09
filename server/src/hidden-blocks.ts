function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const LINE_MARKER_PREFIX = String.raw`[^\w/\r\n]{0,20}?`;
const LINE_MARKER_SUFFIX = String.raw`[^\w/\r\n]{0,20}?`;
const FIELD_RE = /^(\s*)([A-Za-z][\w -]*?)\s*:\s*(.*)$/;
const INLINE_FIELD_RE = /(?:^|[,;]\s*)([A-Za-z][\w -]*?)\s*:\s*/g;

export function hiddenBlockRegex(startName: string, endNames: string[]): RegExp {
  const start = escapeRegExp(startName);
  const ends = endNames.map(escapeRegExp).join('|');
  return new RegExp(
    String.raw`(^|\n)${LINE_MARKER_PREFIX}\/?${start}(?:[ \t]+|\s*\n)([\s\S]*?)(?:\n${LINE_MARKER_PREFIX}|[ \t]+)[/@]end-(?:${ends})${LINE_MARKER_SUFFIX}(?=\n|$)`,
    'gi',
  );
}

export function stripEmptyHiddenBlockComments(text: string): string {
  return text.replace(/(^|\n)[ \t]*<!--[\s\r\n]*-->[ \t]*(?=\n|$)/g, (_match, prefix: string) =>
    prefix === '\n' ? '\n' : '',
  );
}

const FIRESIDE_ENVELOPE_RE =
  /<!--\s*FIRESIDE:([\w-]+)(?:\s+v=\d+)?\s*([\s\S]*?)\/end-[\w-]+\s*-->/gi;

export interface NormalizedFiresideEnvelopes {
  normalizedText: string;
  count: number;
}

// Defensive sanitizer for the hallucinated `<!--FIRESIDE:<name> v=N ...
// /end-<name>-->` envelope agents emit when they confuse the deprecated
// `<!-- fireside-tool -->` shape with the canonical slash-block fallback.
// `hiddenBlockRegex` rejects this prefix because `FIRESIDE:` carries word
// chars, so without normalization every mission/collab/permission extractor
// misses the payload and the entire envelope leaks into visible chat. This
// function rewrites each envelope into the canonical `/<name>\n...\n/end-<name>`
// form using the *start* name (the close-marker name is sometimes wrong) so
// downstream extractors recognize and strip it.
export function normalizeFiresideEnvelopes(text: string): NormalizedFiresideEnvelopes {
  let count = 0;
  const normalizedText = text.replace(
    FIRESIDE_ENVELOPE_RE,
    (_match, name: string, body: string) => {
      count += 1;
      const inner = body.trim();
      const bodyLines = inner ? `\n${inner}\n` : '\n';
      return `\n/${name}${bodyLines}/end-${name}\n`;
    },
  );
  return { normalizedText, count };
}

export function normalizeHiddenBlockFieldKey(key: string): string {
  return key.trim().toLowerCase().replace(/[-\s]+/g, '_');
}

function isFieldLine(line: string): boolean {
  return FIELD_RE.test(line);
}

function expandInlineFieldLine(line: string): string[] {
  const trimmed = line.trim();
  const matches = [...trimmed.matchAll(INLINE_FIELD_RE)];
  if (matches.length < 2 || matches[0]?.index !== 0) return [line];

  return matches
    .map((match, index) => {
      const key = match[1]!.trim();
      const valueStart = match.index! + match[0]!.length;
      const valueEnd = matches[index + 1]?.index ?? trimmed.length;
      const value = trimmed.slice(valueStart, valueEnd).replace(/[,;\s]+$/g, '').trim();
      return value ? `${key}: ${value}` : `${key}:`;
    })
    .filter(Boolean);
}

function expandInlineHiddenFields(block: string): string {
  const lines = block.split(/\r?\n/);
  const nonBlank = lines.filter((line) => line.trim());
  if (nonBlank.length !== 1) return block;

  const line = nonBlank[0]!;
  if (!FIELD_RE.test(line.trimEnd())) return block;
  return expandInlineFieldLine(line).join('\n');
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
  const lines = expandInlineHiddenFields(block).split(/\r?\n/);

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
