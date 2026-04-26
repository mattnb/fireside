// server/src/windows/encoding.ts
export function normalizeLineEndings(input: string): string {
  return input.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function stripBom(input: string): string {
  return input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
}

export function ensureTrailingNewline(input: string): string {
  return input.endsWith('\n') ? input : input + '\n';
}
