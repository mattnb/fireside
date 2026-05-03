function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const LINE_MARKER_PREFIX = String.raw`[^\w/\r\n]{0,20}?`;
const LINE_MARKER_SUFFIX = String.raw`[^\w/\r\n]{0,20}?`;

export function hiddenBlockRegex(startName: string, endNames: string[]): RegExp {
  const start = escapeRegExp(startName);
  const ends = endNames.map(escapeRegExp).join('|');
  return new RegExp(
    String.raw`(^|\n)${LINE_MARKER_PREFIX}\/${start}\s*\n([\s\S]*?)\n${LINE_MARKER_PREFIX}[/@]end-(?:${ends})${LINE_MARKER_SUFFIX}(?=\n|$)`,
    'gi',
  );
}
