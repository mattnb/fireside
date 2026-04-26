// server/src/agents/json-extract.ts
//
// Tolerant JSON extraction for CLI stdout. Some agent CLIs (Claude, Gemini)
// emit free-form preamble text before — and occasionally postamble after — the
// JSON object that carries the structured response. A strict `JSON.parse` on
// the raw stdout therefore throws even when the response is well-formed.
//
// `extractTopLevelJsonObject` finds and returns the LAST balanced top-level
// JSON object in `stdout`. If multiple are present, the latest one wins —
// matching the "most recent reply" intuition. String literals are tracked so a
// literal `{` or `}` inside a string does not confuse the brace counter.

export function extractTopLevelJsonObject(stdout: string): unknown | null {
  // Cheap path: full stdout is a JSON object on its own.
  const trimmed = stdout.trim();
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // fall through to scanner
    }
  }

  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  let lastValid: unknown | null = null;

  for (let i = 0; i < stdout.length; i++) {
    const c = stdout[i];

    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (c === '\\') {
        escape = true;
        continue;
      }
      if (c === '"') {
        inString = false;
      }
      continue;
    }

    if (c === '"') {
      inString = true;
      continue;
    }

    if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}') {
      if (depth === 0) continue; // stray closer, ignore
      depth--;
      if (depth === 0 && start >= 0) {
        const candidate = stdout.slice(start, i + 1);
        try {
          lastValid = JSON.parse(candidate);
        } catch {
          // not a valid JSON object — ignore and keep scanning
        }
        start = -1;
      }
    }
  }

  return lastValid;
}
