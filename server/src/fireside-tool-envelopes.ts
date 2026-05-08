import { stripEmptyHiddenBlockComments } from './hidden-blocks.js';

export interface StrippedFiresideToolEnvelopes {
  visibleText: string;
  count: number;
}

const FIRESIDE_TOOL_ENVELOPE_RE =
  /(^|\n)[ \t]*<!--\s*fireside-tool\b[\s\S]*?\/(?:end-)?fireside-tool\s*-->[ \t]*(?=\n|$)/g;

export function stripFiresideToolEnvelopes(text: string): StrippedFiresideToolEnvelopes {
  let count = 0;
  const replaced = text.replace(FIRESIDE_TOOL_ENVELOPE_RE, (_match, prefix: string) => {
    count += 1;
    return prefix === '\n' ? '\n' : '';
  });
  return {
    visibleText: stripEmptyHiddenBlockComments(replaced).trim(),
    count,
  };
}
