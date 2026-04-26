# Fireside Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Windows-native, persistent, shared chat room where Claude Code, OpenAI Codex CLI, Google Gemini CLI, and a human collaborate in real time without API keys.

**Architecture:** A long-running Node.js broker holds chat-room state in SQLite, exposes a WebSocket to a browser UI, and spawns each CLI as a one-shot non-interactive subprocess (`claude -p`, `codex exec`, `gemini -p`) when a new message arrives in a room the agent is subscribed to. The CLI inherits its cached login from the user's home directory — no API keys. Session continuity is handled via each CLI's `--resume` mechanism and a per-(room, agent) `session_id` stored in SQLite. The broker is the always-on nervous system; each LLM turn is a fresh, stateless reflex.

**Tech Stack:** Node.js 20 LTS, TypeScript 5.x, Fastify (HTTP), `ws` (WebSocket), `better-sqlite3` (storage), `execa` (subprocess), `tree-kill` (Windows process-tree termination), Vitest (tests), vanilla HTML/JS frontend.

**Critical Windows reality:** None of the three CLIs is a native binary on Windows — `claude`, `codex`, and `gemini` are installed as `.cmd` shims that fork a `node.exe` child running the actual JS implementation. `child_process.spawn('claude')` fails without `shell: true` or PATHEXT resolution; `child.kill()` on a `.cmd` orphans the `node.exe` grandchild; UTF-8 input/output requires explicit encoding hints. We use `execa` (handles PATHEXT + shell quoting) plus `tree-kill` (handles process-tree termination via `taskkill /F /T /PID`). These choices are not negotiable on Windows — every detail below has been bitten before.

---

## File Structure

```
fireside/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── eslint.config.mjs
├── .prettierrc
├── .gitignore
├── .editorconfig
├── README.md
├── docs/
│   ├── 2026-04-26-fireside-implementation-plan.md     (this file)
│   ├── architecture.md
│   ├── windows-subprocess-notes.md
│   └── runbook.md
├── server/
│   ├── src/
│   │   ├── index.ts                  # entry point — boots HTTP + WS + broker
│   │   ├── config.ts                 # config loading from env + defaults
│   │   ├── logger.ts                 # structured logger (pino)
│   │   ├── db.ts                     # SQLite open + schema migration
│   │   ├── repos/
│   │   │   ├── rooms.ts              # rooms table CRUD
│   │   │   ├── messages.ts           # messages table CRUD
│   │   │   └── sessions.ts           # (room_id, agent_id) → session_id mapping
│   │   ├── broker.ts                 # core message routing + agent dispatch
│   │   ├── transcript.ts             # builds the prompt text fed to each agent
│   │   ├── mentions.ts               # @mention parser
│   │   ├── http-server.ts            # Fastify boot + REST routes + static UI
│   │   ├── ws-server.ts              # WebSocket server + room subscription fanout
│   │   ├── windows/
│   │   │   ├── spawn.ts              # execa-based wrapper
│   │   │   ├── tree-kill.ts          # cross-platform tree kill (uses taskkill on win32)
│   │   │   └── encoding.ts           # CRLF normalization + UTF-8 helpers
│   │   ├── agents/
│   │   │   ├── types.ts              # AgentSpec, AgentInvocation, AgentReply
│   │   │   ├── runner.ts             # generic run-one-turn primitive
│   │   │   ├── json-extract.ts       # tolerant top-level JSON object extractor (preamble-safe)
│   │   │   ├── claude.ts             # Claude Code adapter
│   │   │   ├── codex.ts              # Codex CLI adapter
│   │   │   ├── gemini.ts             # Gemini CLI adapter
│   │   │   ├── echo.ts               # fake "echo" adapter for tests
│   │   │   └── registry.ts           # adapter registration + lookup
│   └── tests/
│       ├── fixtures/                 # captured CLI I/O samples
│       │   ├── claude-headless.txt
│       │   ├── codex-exec-jsonl.txt
│       │   └── gemini-headless.json
│       ├── unit/
│       │   ├── encoding.test.ts
│       │   ├── spawn.test.ts
│       │   ├── tree-kill.test.ts
│       │   ├── transcript.test.ts
│       │   ├── mentions.test.ts
│       │   ├── claude.test.ts
│       │   ├── codex.test.ts
│       │   ├── gemini.test.ts
│       │   ├── rooms-repo.test.ts
│       │   ├── messages-repo.test.ts
│       │   └── sessions-repo.test.ts
│       └── integration/
│           ├── broker-echo.test.ts
│           ├── ws-flow.test.ts
│           └── timeout.test.ts
├── ui/
│   ├── index.html
│   ├── app.js
│   └── styles.css
└── scripts/
    ├── verify-clis.cmd               # Windows launcher: checks installs + auth
    ├── start.cmd                     # Windows launcher: runs broker
    └── echo-agent.cjs                # Node script used as a fake CLI in tests
```

---

## Phase 0 — Project Bootstrap

### Task 0.1: Initialize git repo and base directories

**Files:**
- Create: `fireside/.gitignore`
- Create: `fireside/.editorconfig`

- [ ] **Step 1: Initialize git in `fireside/`**

```bash
cd fireside && git init -b main
```

Expected: `Initialized empty Git repository in .../fireside/.git/`

- [ ] **Step 2: Create `.gitignore`**

```
node_modules/
dist/
*.log
*.sqlite
*.sqlite-journal
*.sqlite-wal
*.sqlite-shm
data/
.env
.env.local
.DS_Store
Thumbs.db
coverage/
.vitest-cache/
```

- [ ] **Step 3: Create `.editorconfig`**

```
root = true

[*]
charset = utf-8
end_of_line = lf
indent_style = space
indent_size = 2
insert_final_newline = true
trim_trailing_whitespace = true

[*.md]
trim_trailing_whitespace = false
```

- [ ] **Step 4: Commit**

```bash
git add .gitignore .editorconfig docs/
git commit -m "chore: initialize fireside repo with base config"
```

---

### Task 0.2: Initialize Node.js project + TypeScript

**Files:**
- Create: `fireside/package.json`
- Create: `fireside/tsconfig.json`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "fireside",
  "version": "0.1.0",
  "private": true,
  "description": "Persistent multi-agent chat for Claude Code, Codex CLI, Gemini CLI, and humans.",
  "type": "module",
  "engines": {
    "node": ">=20.10.0"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "node --enable-source-maps dist/server/src/index.js",
    "dev": "tsx watch server/src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint .",
    "format": "prettier --write .",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "verify:clis": "node scripts/verify-clis.cjs"
  },
  "dependencies": {},
  "devDependencies": {}
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": ".",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": false,
    "sourceMap": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": false
  },
  "include": ["server/src/**/*", "server/tests/**/*", "scripts/**/*"],
  "exclude": ["node_modules", "dist", "ui"]
}
```

- [ ] **Step 3: Commit**

```bash
git add package.json tsconfig.json
git commit -m "chore: add package.json and tsconfig"
```

---

### Task 0.3: Install dependencies

**Files:** none (modifies `package.json` + creates `package-lock.json`)

- [ ] **Step 1: Install runtime deps**

```bash
npm install fastify@^5.1.0 @fastify/static@^8.0.3 ws@^8.18.0 better-sqlite3@^11.5.0 execa@^9.5.1 tree-kill@^1.2.2 pino@^9.5.0 pino-pretty@^11.3.0 nanoid@^5.0.9
```

Expected: dependencies appear in `package.json`. `better-sqlite3` will compile a native binding — this can take ~30s on Windows; it requires `windows-build-tools` or Visual Studio Build Tools 2019+ to be installed (most dev machines have it via VS or `npm install --global windows-build-tools` years ago). If compile fails, see runbook task 9.5.

- [ ] **Step 2: Install dev deps**

```bash
npm install --save-dev typescript@^5.6.3 tsx@^4.19.2 @types/node@^22.9.0 @types/ws@^8.5.13 @types/better-sqlite3@^7.6.11 vitest@^2.1.6 @vitest/coverage-v8@^2.1.6 eslint@^9.15.0 typescript-eslint@^8.16.0 @eslint/js@^9.15.0 globals@^15.14.0 prettier@^3.4.1
```

- [ ] **Step 3: Verify install**

```bash
npm run typecheck
```

Expected: PASS (no source files yet, so tsc just exits 0). If you see `Cannot find module 'typescript'`, run `npm install` again.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: install runtime and dev dependencies"
```

---

### Task 0.4: Configure ESLint, Prettier, Vitest

**Files:**
- Create: `fireside/eslint.config.mjs`
- Create: `fireside/.prettierrc`
- Create: `fireside/vitest.config.ts`

- [ ] **Step 1: Create `eslint.config.mjs`**

```js
// eslint.config.mjs
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'ui/**', 'data/**', 'coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.es2022 },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node } },
    rules: {
      // CommonJS files legitimately use require(); the TS-ESLint rule
      // exists to discourage require() in TypeScript/ESM source, not in .cjs.
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
];
```

- [ ] **Step 2: Create `.prettierrc`**

```json
{
  "singleQuote": true,
  "semi": true,
  "trailingComma": "all",
  "printWidth": 100,
  "tabWidth": 2,
  "endOfLine": "lf"
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['server/tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15_000,
    hookTimeout: 15_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: false } },
  },
});
```

- [ ] **Step 4: Verify Vitest boots**

```bash
npx vitest run --reporter=basic
```

Expected: `No test files found, exiting with code 1`. That's correct — we have no tests yet. The next phase will add them.

- [ ] **Step 5: Commit**

```bash
git add eslint.config.mjs .prettierrc vitest.config.ts
git commit -m "chore: configure eslint, prettier, vitest"
```

---

### Task 0.5: CLI verification script

**Files:**
- Create: `fireside/scripts/verify-clis.cjs`
- Create: `fireside/scripts/echo-agent.cjs`

This task confirms the three CLIs are installed and authenticated **before** any code is written that depends on them. Run it now and again whenever a new dev box joins the project.

- [ ] **Step 1: Create `scripts/verify-clis.cjs`**

```js
#!/usr/bin/env node
// Verifies claude / codex / gemini are installed, on PATH, and authenticated.
// Designed to run on Windows; uses execa for PATHEXT-aware spawn.

const { execa } = require('execa');

async function probe(name, args, expectedSubstring) {
  try {
    const result = await execa(name, args, {
      timeout: 30_000,
      windowsHide: true,
      reject: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    const out = `${result.stdout}\n${result.stderr}`;
    const installed = result.exitCode !== null && result.exitCode !== 127;
    const auth =
      installed && (expectedSubstring ? out.toLowerCase().includes(expectedSubstring.toLowerCase()) : true);
    return { name, installed, auth, exitCode: result.exitCode, snippet: out.slice(0, 200).trim() };
  } catch (err) {
    return { name, installed: false, auth: false, error: err.message };
  }
}

(async () => {
  console.log('Probing CLIs...\n');
  const results = await Promise.all([
    probe('claude', ['--version'], 'claude'),
    probe('codex', ['--version'], 'codex'),
    probe('gemini', ['--version'], 'gemini'),
  ]);
  let bad = 0;
  for (const r of results) {
    const status = r.installed ? (r.auth ? 'OK' : 'INSTALLED-BUT-CHECK') : 'MISSING';
    console.log(`[${status}] ${r.name}: exit=${r.exitCode} ${r.snippet ? '— ' + r.snippet : ''}`);
    if (!r.installed) bad++;
  }
  console.log('\nNote: --version only confirms install. Auth must be checked by running `claude`, `codex`, or `gemini` interactively the first time.');
  process.exit(bad === 0 ? 0 : 1);
})();
```

- [ ] **Step 2: Create `scripts/echo-agent.cjs`**

This is the fake "agent" used by integration tests later. It reads stdin and prints a deterministic reply on stdout. Used to test the broker without invoking a real LLM.

```js
#!/usr/bin/env node
// echo-agent.cjs — reads JSON {prompt, sessionId} on stdin, prints a JSON reply on stdout.
// Used as a stand-in for a real CLI in tests.
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (buf += chunk));
process.stdin.on('end', () => {
  let parsed;
  try {
    parsed = JSON.parse(buf || '{}');
  } catch {
    parsed = { prompt: buf };
  }
  const reply = {
    sessionId: parsed.sessionId || 'echo-session-1',
    text: `echo: ${parsed.prompt || '(empty)'}`,
  };
  process.stdout.write(JSON.stringify(reply));
});
```

- [ ] **Step 3: Run the verification script**

```bash
npm run verify:clis
```

Expected: all three CLIs report `[OK]`. If any are missing, install them now (`npm install -g @anthropic-ai/claude-code`, `npm install -g @openai/codex`, `npm install -g @google/gemini-cli`) and run each interactively at least once to complete OAuth login. **Do not proceed past this task with any CLI in MISSING state.**

- [ ] **Step 4: Commit**

```bash
git add scripts/
git commit -m "chore: add CLI verification + echo-agent test stub"
```

---

## Phase 1 — Windows Subprocess Primitives (TDD)

This phase exists because every Windows-specific bug we will hit later traces back to one of: `.cmd` shim resolution, process-tree termination, UTF-8 encoding, CRLF normalization, or stdin EOF signalling. We harden each one in isolation against a known-good Node script (`echo-agent.cjs`) before introducing the real CLIs in Phase 2.

### Task 1.1: Create encoding helpers (TDD)

**Files:**
- Create: `fireside/server/src/windows/encoding.ts`
- Test: `fireside/server/tests/unit/encoding.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/tests/unit/encoding.test.ts
import { describe, it, expect } from 'vitest';
import { normalizeLineEndings, stripBom, ensureTrailingNewline } from '../../src/windows/encoding.js';

describe('encoding helpers', () => {
  it('normalizes CRLF to LF', () => {
    expect(normalizeLineEndings('a\r\nb\r\nc')).toBe('a\nb\nc');
  });

  it('preserves bare LF unchanged', () => {
    expect(normalizeLineEndings('a\nb\nc')).toBe('a\nb\nc');
  });

  it('handles bare CR (old mac line endings)', () => {
    expect(normalizeLineEndings('a\rb\rc')).toBe('a\nb\nc');
  });

  it('strips a UTF-8 BOM', () => {
    expect(stripBom('﻿hello')).toBe('hello');
  });

  it('leaves text without BOM unchanged', () => {
    expect(stripBom('hello')).toBe('hello');
  });

  it('adds a trailing newline if missing', () => {
    expect(ensureTrailingNewline('hello')).toBe('hello\n');
  });

  it('does not add a duplicate trailing newline', () => {
    expect(ensureTrailingNewline('hello\n')).toBe('hello\n');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run server/tests/unit/encoding.test.ts
```

Expected: FAIL — `Cannot find module '../../src/windows/encoding.js'`.

- [ ] **Step 3: Implement `encoding.ts`**

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run server/tests/unit/encoding.test.ts
```

Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add server/src/windows/encoding.ts server/tests/unit/encoding.test.ts
git commit -m "feat(windows): add CRLF/BOM/newline normalization helpers"
```

---

### Task 1.2: Tree-kill wrapper (TDD)

**Files:**
- Create: `fireside/server/src/windows/tree-kill.ts`
- Test: `fireside/server/tests/unit/tree-kill.test.ts`

This task ensures we can kill a `.cmd` shim's `node.exe` grandchild reliably. We test against a Node script that spawns its own child and prints both PIDs.

- [ ] **Step 1: Create a test fixture script**

```bash
mkdir -p server/tests/fixtures
```

Create `server/tests/fixtures/parent-with-child.cjs`:

```js
#!/usr/bin/env node
// Spawns a long-running child and prints both PIDs as JSON, then waits forever.
const { spawn } = require('child_process');
const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], {
  stdio: 'ignore',
  detached: false,
  windowsHide: true,
});
process.stdout.write(JSON.stringify({ parent: process.pid, child: child.pid }) + '\n');
setInterval(() => {}, 1000);
```

- [ ] **Step 2: Write the failing test**

```ts
// server/tests/unit/tree-kill.test.ts
import { describe, it, expect } from 'vitest';
import { execa } from 'execa';
import { killTree, isPidAlive } from '../../src/windows/tree-kill.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const FIXTURE = path.resolve(path.dirname(__filename), '../fixtures/parent-with-child.cjs');

async function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('killTree', () => {
  it('terminates parent and child processes on Windows', async () => {
    const proc = execa(process.execPath, [FIXTURE], {
      stdio: ['ignore', 'pipe', 'inherit'],
      windowsHide: true,
    });
    proc.catch(() => {}); // attach immediately so kill-induced rejection is handled
    let firstLine = '';
    await new Promise<void>((resolve) => {
      proc.stdout!.on('data', (b: Buffer) => {
        firstLine += b.toString('utf8');
        if (firstLine.includes('\n')) resolve();
      });
    });
    // `[0]!` is required because `noUncheckedIndexedAccess` typed `split()[0]` as `string | undefined`.
    const { parent, child } = JSON.parse(firstLine.split('\n')[0]!);
    expect(parent).toBeGreaterThan(0);
    expect(child).toBeGreaterThan(0);

    await killTree(parent);
    await delay(500);

    expect(await isPidAlive(parent)).toBe(false);
    expect(await isPidAlive(child)).toBe(false);
  }, 20_000);

  it('isPidAlive returns false for a non-existent pid', async () => {
    expect(await isPidAlive(0)).toBe(false);
    expect(await isPidAlive(999_999_999)).toBe(false);
  });

  it('killTree resolves (does not reject) for a non-existent pid', async () => {
    await expect(killTree(999_999_999)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
npx vitest run server/tests/unit/tree-kill.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement `tree-kill.ts`**

```ts
// server/src/windows/tree-kill.ts
import treeKill from 'tree-kill';
import { execa } from 'execa';

export function killTree(pid: number, signal: string = 'SIGTERM'): Promise<void> {
  return new Promise((resolve, reject) => {
    treeKill(pid, signal, (err) => {
      if (err) {
        // ESRCH (no such process) is fine — already dead.
        if ((err as NodeJS.ErrnoException).code === 'ESRCH') return resolve();
        // On Windows, tree-kill shells out to `taskkill /pid <pid> /T /F`.
        // When the pid doesn't exist taskkill exits non-zero and prints
        // `ERROR: The process "<pid>" not found.` to stderr. tree-kill surfaces
        // this as an Error whose .message contains both the command and that
        // line. Treat "process not found" the same as ESRCH.
        const msg = (err as Error).message ?? '';
        if (/not found|no tasks/i.test(msg)) return resolve();
        return reject(err);
      }
      resolve();
    });
  });
}

export async function isPidAlive(pid: number): Promise<boolean> {
  if (!pid || pid <= 0) return false;
  if (process.platform === 'win32') {
    // /FO CSV gives a stable shape: "image","pid","session","sessionnum","memory".
    // /NH suppresses the header. When tasklist finds nothing it writes
    // `INFO: No tasks…` to STDERR (not stdout) and stdout is empty, so a
    // substring check on `,"<pid>",` (the unambiguous quoted PID column) is
    // robust against PIDs that happen to appear inside image names or memory
    // sizes.
    const r = await execa('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], {
      reject: false,
      windowsHide: true,
    });
    return r.stdout.includes(`,"${pid}",`);
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run server/tests/unit/tree-kill.test.ts
```

Expected: 3 passed. If the first test fails with `ETIMEDOUT`, increase the test timeout. If `child` is still alive after kill, `tree-kill` is not falling back to `taskkill /T` — verify the package installed correctly.

- [ ] **Step 6: Commit**

```bash
git add server/src/windows/tree-kill.ts server/tests/unit/tree-kill.test.ts server/tests/fixtures/parent-with-child.cjs
git commit -m "feat(windows): add process-tree termination wrapper"
```

---

### Task 1.3: Spawn wrapper (TDD)

**Files:**
- Create: `fireside/server/src/windows/spawn.ts`
- Test: `fireside/server/tests/unit/spawn.test.ts`

This is the single chokepoint through which **every** subprocess invocation in fireside must pass. It handles: PATHEXT resolution, stdin EOF, UTF-8 stdout, CRLF normalization, hard timeouts, console-window suppression, and tree-kill on timeout.

- [ ] **Step 1: Write the failing test**

```ts
// server/tests/unit/spawn.test.ts
import { describe, it, expect } from 'vitest';
import {
  runSubprocess,
  shouldUseShell,
  SubprocessSpawnError,
  SubprocessTimeoutError,
} from '../../src/windows/spawn.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const ECHO = path.resolve(path.dirname(__filename), '../../../scripts/echo-agent.cjs');

describe('runSubprocess', () => {
  it('runs node script with stdin and returns stdout', async () => {
    const result = await runSubprocess({
      command: process.execPath,
      args: [ECHO],
      stdin: JSON.stringify({ prompt: 'hello', sessionId: 's1' }),
      timeoutMs: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('echo: hello');
    expect(result.timedOut).toBe(false);
  });

  it('normalizes CRLF in stdout to LF', async () => {
    const result = await runSubprocess({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("a\\r\\nb\\r\\n")'],
      stdin: '',
      timeoutMs: 5000,
    });
    expect(result.stdout).toBe('a\nb\n');
  });

  it('closes stdin so the child sees EOF', async () => {
    // `cat` would hang forever without stdin.end(); this proves we close it.
    const result = await runSubprocess({
      command: process.execPath,
      args: [
        '-e',
        'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>process.stdout.write("got:"+b))',
      ],
      stdin: 'payload',
      timeoutMs: 5000,
    });
    expect(result.stdout).toBe('got:payload');
  });

  it('does not open a stdin pipe when no stdin content is provided', async () => {
    // 'ignore' wires the child's fd 0 to the OS null device — Node exposes
    // that as a ReadStream, not a Socket. CLIs that sniff stdin (Codex's
    // "Reading additional input from stdin..." path) skip the append branch
    // when stdin is the null device.
    const result = await runSubprocess({
      command: process.execPath,
      args: ['-e', 'process.stdout.write(process.stdin.constructor.name)'],
      timeoutMs: 5000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('ReadStream');
  });

  it('opens a stdin pipe when stdin content is provided', async () => {
    // Counterpart: with non-empty stdin we DO want a real pipe. Constructor
    // flips to Socket and the child reads our payload back out.
    const result = await runSubprocess({
      command: process.execPath,
      args: [
        '-e',
        'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>process.stdout.write(process.stdin.constructor.name+":"+b))',
      ],
      stdin: 'hello',
      timeoutMs: 5000,
    });
    expect(result.stdout).toBe('Socket:hello');
  });

  it('throws SubprocessTimeoutError when command exceeds timeout', async () => {
    await expect(
      runSubprocess({
        command: process.execPath,
        args: ['-e', 'setInterval(()=>{}, 1000)'],
        stdin: '',
        timeoutMs: 1000,
      }),
    ).rejects.toBeInstanceOf(SubprocessTimeoutError);
  });

  it('captures stderr separately', async () => {
    const result = await runSubprocess({
      command: process.execPath,
      args: ['-e', 'process.stderr.write("warn"); process.stdout.write("ok")'],
      stdin: '',
      timeoutMs: 5000,
    });
    expect(result.stdout).toBe('ok');
    expect(result.stderr).toBe('warn');
  });

  it('throws SubprocessSpawnError when the spawn syscall fails (bad cwd)', async () => {
    // We want a true ENOENT/spawn failure — the child never starts, so
    // exitCode is undefined and stderr is empty. Pointing at a non-existent
    // cwd reliably triggers this on every platform: Node.js fails the spawn
    // before the program is even attempted. (On Windows, a bogus *binary*
    // path is wrapped by cmd.exe and surfaces as a normal exit-1 with stderr
    // — that's NOT what SubprocessSpawnError represents.)
    await expect(
      runSubprocess({
        command: process.execPath,
        args: ['-v'],
        cwd:
          process.platform === 'win32'
            ? 'Z:\\nonexistent-fireside-test-dir\\never-here'
            : '/nonexistent-fireside-test-dir/never-here',
        timeoutMs: 5000,
      }),
    ).rejects.toBeInstanceOf(SubprocessSpawnError);
  });

  it.skipIf(process.platform !== 'win32')(
    'preserves non-ASCII characters in argv',
    async () => {
      // With shell: false, argv passes byte-for-byte to node.exe and execa
      // decodes the child's stdout as UTF-8 — no chcp dance required.
      const result = await runSubprocess({
        command: 'node',
        args: ['-e', 'process.stdout.write("日本語")'],
        timeoutMs: 5000,
      });
      expect(result.stdout).toBe('日本語');
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'passes multi-line argv through to a bare-name command on Windows',
    async () => {
      // Use 'node' (a bare name on Windows that resolves via PATHEXT to node.exe).
      // Pass a multi-line string as a single arg; child echoes it verbatim.
      // With shell: true this fails because cmd.exe terminates the command
      // line at the first embedded newline.
      const multiLine = 'line1\nline2\nline3';
      const result = await runSubprocess({
        command: 'node',
        args: ['-e', `process.stdout.write(${JSON.stringify(multiLine)})`],
        timeoutMs: 10_000,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(multiLine);
    },
  );
});

describe('shouldUseShell', () => {
  it('always returns false — execa/cross-spawn handles PATHEXT and .cmd escaping', () => {
    expect(shouldUseShell('claude')).toBe(false);
    expect(shouldUseShell('codex')).toBe(false);
    expect(shouldUseShell('C:\\Program Files\\nodejs\\node.exe')).toBe(false);
    expect(shouldUseShell('/usr/local/bin/node')).toBe(false);
    expect(shouldUseShell('./bin/foo')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run server/tests/unit/spawn.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `spawn.ts`**

```ts
// server/src/windows/spawn.ts
import { execa, type ExecaError } from 'execa';
import { killTree } from './tree-kill.js';
import { normalizeLineEndings, stripBom } from './encoding.js';

/**
 * We never need `shell: true`. `execa` (via `cross-spawn`) already handles the
 * two Windows-specific concerns that originally motivated `shell: true`:
 *   1. PATHEXT resolution — bare names like `claude` resolve to `claude.cmd`
 *      automatically without involving cmd.exe.
 *   2. `.cmd` shim argument escaping — multi-line argv strings (e.g. broker
 *      prompts containing newlines) pass through untouched.
 *
 * Going through cmd.exe required us to manually concatenate one command line,
 * which cmd.exe terminates at the first embedded newline — that silently
 * truncated multi-line prompts and caused Phase 8 real-CLI test failures.
 */
export function shouldUseShell(_command: string): boolean {
  return false;
}

export class SubprocessTimeoutError extends Error {
  constructor(
    public command: string,
    public timeoutMs: number,
    public stdout: string = '',
    public stderr: string = '',
  ) {
    super(`subprocess timed out after ${timeoutMs}ms: ${command}`);
    this.name = 'SubprocessTimeoutError';
  }
}

export class SubprocessSpawnError extends Error {
  constructor(
    public command: string,
    public override cause: unknown,
  ) {
    const causeMsg = cause instanceof Error ? cause.message : String(cause);
    super(`failed to spawn subprocess: ${command} — ${causeMsg}`);
    this.name = 'SubprocessSpawnError';
  }
}

export interface RunOptions {
  command: string;
  args?: string[];
  stdin?: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

const DEFAULT_TIMEOUT = 120_000;

/**
 * True if the error from execa indicates the child process never started
 * (ENOENT, EACCES, invalid cwd, etc.). A real run that exited non-zero still
 * populates `exitCode` with a number; a spawn failure leaves `exitCode`
 * undefined and surfaces the underlying syscall failure on `code` (or on
 * `cause.code`). On Windows, execa's auto-cmd.exe wrapping can mask "command
 * not recognized" as a real exit-1 with stderr — those are NOT spawn failures,
 * they are actual cmd.exe runs that returned an error code.
 */
function isSpawnFailure(err: ExecaError): boolean {
  if (typeof err.exitCode === 'number') return false;
  const errCode = (err as ExecaError & { code?: unknown }).code;
  if (typeof errCode === 'string') return true;
  const cause = (err as ExecaError & { cause?: { code?: unknown } }).cause;
  if (cause && typeof cause.code === 'string') return true;
  return (
    err.exitCode === undefined &&
    (err.stdout === undefined || err.stdout === '') &&
    (err.stderr === undefined || err.stderr === '')
  );
}

export async function runSubprocess(opts: RunOptions): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  // PYTHONIOENCODING helps any Python tool that ends up in the chain. We
  // deliberately do NOT set LANG/LC_ALL — those are POSIX locale knobs that
  // Windows ignores. UTF-8 of child stdout is handled by execa's
  // `encoding: 'utf8'` decode of the raw byte buffer, so no console-codepage
  // dance (`chcp 65001`) is required when we bypass cmd.exe entirely.
  const env = {
    PYTHONIOENCODING: 'utf-8',
    ...process.env,
    ...opts.env,
  };

  const actualCommand = opts.command;
  const actualArgs: string[] = opts.args ?? [];

  const hasStdin = typeof opts.stdin === 'string' && opts.stdin.length > 0;

  const child = execa(actualCommand, actualArgs, {
    // Conditional spread: TypeScript's `exactOptionalPropertyTypes` rejects
    // `cwd: undefined` because execa types `cwd` as `string` (not `string | undefined`).
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    env,
    encoding: 'utf8',
    windowsHide: true,
    // shell: false is critical on Windows. With shell: true, execa concatenates
    // a single command line and hands it to cmd.exe — cmd.exe terminates that
    // line at the first embedded newline, silently truncating multi-line argv
    // (e.g. broker prompts). cross-spawn (used internally by execa) handles
    // PATHEXT resolution and .cmd shim argument escaping with shell: false.
    shell: false,
    // Only open a stdin pipe when there is actually content to write.
    // Opening a pipe and immediately .end()-ing it still presents the child
    // with a real (but empty) stdin handle, and some CLIs (Codex) interpret
    // that as "input is being streamed in" and append it to the argv prompt
    // — mangling the broker's turn cue. With 'ignore' the child's fd 0 is
    // wired to the OS null device and the sniff-and-append path doesn't fire.
    stdin: hasStdin ? 'pipe' : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    reject: false,
    // execa strips trailing newlines by default. We want byte-faithful capture.
    stripFinalNewline: false,
    // execa's own timeout uses SIGTERM which is unreliable on Windows for .cmd
    // shims. We manage our own timer + tree-kill.
  });

  // Write stdin and close it (EOF). Only when we actually have content —
  // otherwise stdin is 'ignore' and child.stdin is null.
  if (hasStdin && child.stdin) {
    child.stdin.write(opts.stdin as string, 'utf8');
    child.stdin.end();
  }

  let completed = false;
  let timedOut = false;
  const timer = setTimeout(async () => {
    // Race guard: if the child already finished and we're just waiting on the
    // event loop to clear the timer, don't flip timedOut and don't kill.
    if (completed) return;
    timedOut = true;
    if (child.pid) {
      try {
        await killTree(child.pid, 'SIGKILL');
      } catch {
        // best effort
      }
    }
  }, timeoutMs);

  let result: ExecaError | Awaited<typeof child> | undefined;
  try {
    result = await child;
  } catch (err) {
    result = err as ExecaError;
  }
  completed = true;
  clearTimeout(timer);

  // C1: distinguish a real run-with-non-zero-exit from a complete failure to
  // launch the binary (ENOENT etc). The latter must surface as a
  // SubprocessSpawnError so callers don't mistake "never ran" for "ran cleanly
  // with no output". Don't classify timeouts as spawn errors.
  if (result instanceof Error && isSpawnFailure(result as ExecaError) && !timedOut) {
    throw new SubprocessSpawnError(opts.command, result);
  }

  // Normalize stdout/stderr (BOM strip, then CRLF → LF) so we can also pass
  // the captured output into the timeout error for debugging.
  const stdout = normalizeLineEndings(
    stripBom(result && typeof result.stdout === 'string' ? result.stdout : ''),
  );
  const stderr = normalizeLineEndings(
    stripBom(result && typeof result.stderr === 'string' ? result.stderr : ''),
  );

  if (timedOut) {
    throw new SubprocessTimeoutError(opts.command, timeoutMs, stdout, stderr);
  }

  return {
    stdout,
    stderr,
    exitCode: result && typeof result.exitCode === 'number' ? result.exitCode : null,
    timedOut: false,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run server/tests/unit/spawn.test.ts
```

Expected on Windows: 11 passed in this file — 5 original `runSubprocess` cases + spawn-failure case + non-ASCII argv case + multi-line argv case + 2 conditional-stdin cases (no-stdin → ReadStream, with-stdin → Socket) + 1 collapsed `shouldUseShell` invariant assertion. On non-Windows the two Windows-only cases skip, leaving 9 passed.

If the timeout test fails because the child doesn't actually die (parent test hangs after the assertion): the most likely cause is `tree-kill` not finding `taskkill`. Verify `where taskkill` returns `C:\Windows\System32\taskkill.exe` in your shell.

If the multi-line argv test fails: `shell: true` is sneaking back in somewhere. Verify `shouldUseShell` returns false unconditionally and the `runSubprocess` execa options pass `shell: false`. Don't reintroduce a shell branch — investigate.

Across all three Phase 1 test files, the full vitest run summary on Windows should read **21 passed (21)** — 7 encoding + 3 tree-kill + 11 spawn (no skips on Windows after the shouldUseShell collapse).

- [ ] **Step 5: Commit**

```bash
git add server/src/windows/spawn.ts server/tests/unit/spawn.test.ts
git commit -m "feat(windows): add subprocess wrapper with timeout, tree-kill, UTF-8"
```

---

## Phase 2 — CLI Spike: Capture Real I/O Fixtures

Each CLI is moving software. The headless-flag, JSON-output-shape, and session-resume semantics drift between releases. **Before writing adapters that parse their output, run each CLI by hand and capture the actual I/O.** This phase produces fixture files used to TDD the adapters in Phase 3.

### Task 2.1: Capture Claude Code headless output

**Files:**
- Create: `fireside/server/tests/fixtures/claude-headless.json`
- Create: `fireside/server/tests/fixtures/claude-resume.json`

- [ ] **Step 1: Run a one-shot Claude invocation**

```bash
mkdir -p server/tests/fixtures
echo '{"prompt":"reply with exactly the word: pong"}' | claude -p --output-format json > server/tests/fixtures/claude-headless.json 2>&1
```

Expected: a JSON document with at minimum a `result` (or `text`/`content`) field containing "pong" and a session identifier. **Open the file and read its actual structure** — the field names may differ from these guesses across versions.

- [ ] **Step 2: Capture the session-resume shape**

```bash
SESSION_ID=$(node -e "console.log(JSON.parse(require('fs').readFileSync('server/tests/fixtures/claude-headless.json','utf8')).session_id || JSON.parse(require('fs').readFileSync('server/tests/fixtures/claude-headless.json','utf8')).sessionId)")
echo "Session: $SESSION_ID"
claude -p "What was the last word you said?" --resume "$SESSION_ID" --output-format json > server/tests/fixtures/claude-resume.json 2>&1
```

Expected: a second JSON document showing the resumed session with the same session id. Verify with `cat` that the response references "pong".

If `--output-format json` is not supported on your installed version, capture plain stdout instead: `claude -p "..." > server/tests/fixtures/claude-headless.txt`. Document the actual flag set in `docs/windows-subprocess-notes.md`.

- [ ] **Step 3: Document Claude observations**

Append to `docs/windows-subprocess-notes.md`:

```markdown
## Claude Code

- Binary: `claude.cmd` (npm-installed shim)
- Headless flag: `-p` / `--print`
- JSON output flag: <copy actual flag from your `claude --help`>
- Session id field name in JSON: <copy from fixture>
- Session resume flag: `--resume <session_id>` or `--continue`
- Auth file: `%USERPROFILE%\.claude\` (typically `auth.json` and `config.json`)
- Tested version: <output of `claude --version`>
```

- [ ] **Step 4: Commit**

```bash
git add server/tests/fixtures/claude-*.json docs/windows-subprocess-notes.md
git commit -m "test: capture Claude Code headless + resume fixtures"
```

---

### Task 2.2: Capture Codex CLI output

- [ ] **Step 1: Run codex exec and capture JSONL**

```bash
codex exec --json "reply with exactly the word: pong" > server/tests/fixtures/codex-exec-jsonl.txt 2>&1
```

Expected: one JSON object per line (JSONL). The final assistant message is in an event with type like `turn.completed` or `item.message`. **Open the file and identify which event carries the assistant text** — record the field path in your notes.

- [ ] **Step 2: Capture session resume**

```bash
SESSION_ID=$(grep -m1 -oE '"session(_)?id"\s*:\s*"[^"]+"' server/tests/fixtures/codex-exec-jsonl.txt | head -1 | sed -E 's/.*"([^"]+)"\s*$/\1/')
echo "Session: $SESSION_ID"
codex exec resume --last --json "What was the last word you said?" > server/tests/fixtures/codex-resume-jsonl.txt 2>&1
```

If `resume --last` is not the right syntax on your version, try `codex exec resume "$SESSION_ID" --json "..."`. Document whichever works.

- [ ] **Step 3: Document Codex observations**

Append to `docs/windows-subprocess-notes.md`:

```markdown
## Codex CLI

- Binary: `codex.cmd` (npm-installed shim)
- Headless command: `codex exec`
- JSON output flag: `--json` (emits JSONL on stdout)
- Final-message event type: <e.g. `turn.completed` — copy from fixture>
- Final-message field path: <e.g. `event.assistant_message.content` — copy from fixture>
- Session id field path: <e.g. `event.session_id` from `thread.started` event>
- Session resume command: `codex exec resume --last <prompt>` OR `codex exec resume <id> <prompt>` (test both)
- Auth file: `%USERPROFILE%\.codex\auth.json`
- ChatGPT-login vs API-key conflict: do NOT set `OPENAI_API_KEY` in the broker's env if user is logged in via `codex login` — issues openai/codex#2733, #3286
- Tested version: <output of `codex --version`>
```

- [ ] **Step 4: Commit**

```bash
git add server/tests/fixtures/codex-*.txt docs/windows-subprocess-notes.md
git commit -m "test: capture Codex CLI exec + resume fixtures"
```

---

### Task 2.3: Capture Gemini CLI output

- [ ] **Step 1: Run gemini headless and capture JSON**

```bash
gemini -p "reply with exactly the word: pong" --output-format json > server/tests/fixtures/gemini-headless.json 2>&1
```

Expected: a single JSON object with `response` (the assistant text) and `stats` (tokens etc). Verify the actual top-level field names against the file.

- [ ] **Step 2: Capture session resume**

Gemini's CLI uses auto-saved sessions; the resume flag is `-r` / `--resume`.

```bash
gemini -p "What was the last word you said?" --resume --output-format json > server/tests/fixtures/gemini-resume.json 2>&1
```

If `--resume` without an argument doesn't work on your version, list sessions interactively (`gemini` then `/chat list`) and use `--resume <name>`.

- [ ] **Step 3: Document Gemini observations**

Append to `docs/windows-subprocess-notes.md`:

```markdown
## Gemini CLI

- Binary: `gemini.cmd` (npm-installed shim)
- Headless flag: `-p` / `--prompt`
- JSON output flag: `--output-format json`
- Response field: <copy from fixture, likely `response` or `result`>
- Session id field: <copy from fixture>
- Session resume flag: `-r` / `--resume`
- Auth file: `%USERPROFILE%\.gemini\` (oauth_creds.json)
- Free tier: 60 req/min, 1000 req/day with personal Google account
- Tested version: <output of `gemini --version`>
```

- [ ] **Step 4: Commit**

```bash
git add server/tests/fixtures/gemini-*.json docs/windows-subprocess-notes.md
git commit -m "test: capture Gemini CLI headless + resume fixtures"
```

---

## Phase 3 — Agent Adapters (TDD against fixtures)

### Task 3.1: Define agent types

**Files:**
- Create: `fireside/server/src/agents/types.ts`

- [ ] **Step 1: Write the type module**

```ts
// server/src/agents/types.ts
export type AgentId = 'claude' | 'codex' | 'gemini' | 'echo';

export interface AgentSpec {
  id: AgentId;
  displayName: string;
  command: string;          // e.g. 'claude'
  /** Builds CLI argv for one turn. Receives the prior session id (if any). */
  buildArgs(prompt: string, sessionId: string | null): string[];
  /** Optional pre-formatted text written to stdin. If undefined, the prompt
   *  goes via the CLI's argv (per the CLI's contract). */
  buildStdin?: (prompt: string, sessionId: string | null) => string;
  /** Parses the stdout (and optionally stderr) into a reply. */
  parseOutput(stdout: string, stderr: string): AgentReply;
  /** Default per-turn timeout in ms. */
  defaultTimeoutMs: number;
}

export interface AgentReply {
  text: string;
  sessionId: string | null;
  raw: { stdout: string; stderr: string };
}

export class AgentParseError extends Error {
  constructor(public agentId: AgentId, message: string, public stdout: string, public stderr: string) {
    super(`[${agentId}] ${message}`);
    this.name = 'AgentParseError';
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add server/src/agents/types.ts
git commit -m "feat(agents): define AgentSpec and AgentReply types"
```

---

### Task 3.2: Claude adapter (TDD)

**Files:**
- Create: `fireside/server/src/agents/claude.ts`
- Test: `fireside/server/tests/unit/claude.test.ts`

> Note: the exact JSON field names below assume `result` and `session_id`. **Replace them with whatever your fixture from Task 2.1 actually shows** before running the tests. The test imports the fixture directly so it stays honest.

- [ ] **Step 1: Write the failing test**

```ts
// server/tests/unit/claude.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { claudeSpec } from '../../src/agents/claude.js';
import { AgentParseError } from '../../src/agents/types.js';

const FIXTURE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');
const headless = readFileSync(path.join(FIXTURE_DIR, 'claude-headless.json'), 'utf8');
const withPreamble = readFileSync(path.join(FIXTURE_DIR, 'claude-with-preamble.txt'), 'utf8');

describe('claude adapter', () => {
  it('builds correct argv for fresh session', () => {
    const argv = claudeSpec.buildArgs('hi', null);
    expect(argv).toContain('-p');
    expect(argv).toContain('hi');
    expect(argv).toContain('--output-format');
    expect(argv).toContain('json');
    expect(argv).not.toContain('--resume');
  });

  it('builds correct argv for resumed session', () => {
    const argv = claudeSpec.buildArgs('again', 'abc-123');
    expect(argv).toContain('--resume');
    expect(argv).toContain('abc-123');
  });

  it('parses headless fixture output into reply', () => {
    const reply = claudeSpec.parseOutput(headless, '');
    expect(reply.text.toLowerCase()).toContain('pong');
    expect(reply.sessionId).toMatch(/.+/);
  });

  it('raises AgentParseError on garbage stdout', () => {
    expect(() => claudeSpec.parseOutput('not json', '')).toThrow(AgentParseError);
  });

  // Real-CLI captures showed Claude can emit a session-startup greeting on
  // stdout BEFORE the JSON object (driven by user-level CLAUDE.md). The
  // adapter must tolerate that preamble.
  it('parses output with preamble before JSON', () => {
    const reply = claudeSpec.parseOutput(withPreamble, '');
    expect(reply.text).toBe('pong');
    expect(reply.sessionId).toBe('abc-preamble');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run server/tests/unit/claude.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `claude.ts`**

Open your `server/tests/fixtures/claude-headless.json` first and confirm field names. Adjust the `result_field` and `session_field` constants below to match.

```ts
// server/src/agents/claude.ts
import type { AgentReply, AgentSpec } from './types.js';
import { AgentParseError } from './types.js';
import { extractTopLevelJsonObject } from './json-extract.js';

// Adjust these to match your fixture (Task 2.1).
const RESULT_FIELD = 'result';
const SESSION_FIELD = 'session_id';

export const claudeSpec: AgentSpec = {
  id: 'claude',
  displayName: 'Claude Code',
  command: 'claude',
  defaultTimeoutMs: 120_000,
  buildArgs(prompt, sessionId) {
    const args = ['-p', prompt, '--output-format', 'json'];
    if (sessionId) args.push('--resume', sessionId);
    return args;
  },
  parseOutput(stdout, stderr): AgentReply {
    if (!stdout.trim()) {
      throw new AgentParseError('claude', 'empty stdout', stdout, stderr);
    }
    // Claude can emit a session-startup greeting (per CLAUDE.md instructions)
    // before the JSON object on stdout. Use a tolerant extractor so the
    // adapter does not crash on that preamble.
    const parsed = extractTopLevelJsonObject(stdout);
    if (!parsed || typeof parsed !== 'object') {
      throw new AgentParseError(
        'claude',
        'no top-level JSON object found in stdout',
        stdout,
        stderr,
      );
    }
    const obj = parsed as Record<string, unknown>;
    const text = typeof obj[RESULT_FIELD] === 'string' ? (obj[RESULT_FIELD] as string) : null;
    const sessionId =
      typeof obj[SESSION_FIELD] === 'string' ? (obj[SESSION_FIELD] as string) : null;
    if (text === null) {
      throw new AgentParseError(
        'claude',
        `missing field "${RESULT_FIELD}" in output`,
        stdout,
        stderr,
      );
    }
    return { text, sessionId, raw: { stdout, stderr } };
  },
};
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run server/tests/unit/claude.test.ts
```

Expected: 4 passed.

If the `parses headless fixture` test fails, your fixture's field names differ from `result`/`session_id`. Update the constants at the top of `claude.ts` and re-run. **Do not edit the test to match buggy parsing** — the test is the spec.

- [ ] **Step 5: Commit**

```bash
git add server/src/agents/claude.ts server/tests/unit/claude.test.ts
git commit -m "feat(agents): add Claude Code adapter"
```

---

### Task 3.3: Codex adapter (TDD)

**Files:**
- Create: `fireside/server/src/agents/codex.ts`
- Test: `fireside/server/tests/unit/codex.test.ts`

Codex emits **JSONL**, not a single JSON object. We need to walk the events to find the session-id event and the final assistant-message event.

- [ ] **Step 1: Write the failing test**

```ts
// server/tests/unit/codex.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { codexSpec } from '../../src/agents/codex.js';
import { AgentParseError } from '../../src/agents/types.js';

const FIXTURE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');
const fresh = readFileSync(path.join(FIXTURE_DIR, 'codex-exec-jsonl.txt'), 'utf8');

describe('codex adapter', () => {
  it('builds argv for fresh session', () => {
    const argv = codexSpec.buildArgs('hi', null);
    expect(argv[0]).toBe('exec');
    expect(argv).toContain('--json');
    expect(argv).toContain('hi');
    expect(argv.includes('resume')).toBe(false);
  });

  it('builds argv for resumed session using explicit thread id (no --last)', () => {
    const argv = codexSpec.buildArgs('again', 'abc-123');
    // codex exec resume <SESSION_ID> [flags] <prompt> — verified against
    // `codex exec resume --help`. --last would risk cross-resuming another
    // room's session in a multi-room/multi-agent system.
    expect(argv.slice(0, 3)).toEqual(['exec', 'resume', 'abc-123']);
    expect(argv).not.toContain('--last');
    expect(argv).toContain('--json');
    expect(argv).toContain('--output-schema');
    expect(argv[argv.length - 1]).toBe('again');
  });

  it('parses fresh JSONL fixture (raw text fallback when text is not JSON)', () => {
    // Pre-schema fixture: agent_message.text is the bare word "pong" — not
    // JSON. Parser falls through and returns raw text (graceful degradation).
    const reply = codexSpec.parseOutput(fresh, '');
    expect(reply.text.toLowerCase()).toContain('pong');
    expect(reply.sessionId).toMatch(/.+/);
  });

  it('extracts message field when agent_message.text is schema-constrained JSON', () => {
    const stream = [
      JSON.stringify({ type: 'thread.started', thread_id: 's1' }),
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'item_0', type: 'agent_message', text: '{"message":"pong"}' },
      }),
    ].join('\n');
    const reply = codexSpec.parseOutput(stream, '');
    expect(reply.text).toBe('pong');
  });

  it('throws when no assistant message event present', () => {
    expect(() =>
      codexSpec.parseOutput(
        '{"type":"thread.started","thread_id":"s1"}\n{"type":"unknown"}',
        '',
      ),
    ).toThrow(AgentParseError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run server/tests/unit/codex.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `codex.ts`**

Inspect your `codex-exec-jsonl.txt` fixture and confirm:
- Which event type carries the session id (likely `thread.started` with field `session_id` or `thread.id`).
- Which event type carries the final assistant text (likely `turn.completed` with `message` or `item.message` with `role: 'assistant'`).

Adjust `findSessionId` and `findAssistantText` below to match your fixture.

```ts
// server/src/agents/codex.ts
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import type { AgentReply, AgentSpec } from './types.js';
import { AgentParseError } from './types.js';

interface JsonlEvent {
  type?: string;
  [k: string]: unknown;
}

function parseJsonl(input: string): JsonlEvent[] {
  const events: JsonlEvent[] = [];
  for (const line of input.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as JsonlEvent);
    } catch {
      // ignore non-JSON lines (some CLIs print plain status text on stderr-like channels)
    }
  }
  return events;
}

// Codex emits the session id as `thread_id` on `thread.started`. We accept
// session_id / sessionId as forward-compat fallbacks.
function findSessionId(events: JsonlEvent[]): string | null {
  for (const e of events) {
    const obj = e as Record<string, unknown>;
    const tid = obj['thread_id'] ?? obj['session_id'] ?? obj['sessionId'];
    if (typeof tid === 'string') return tid;
  }
  return null;
}

// With --output-schema enforced, the model emits a JSON document conforming
// to CODEX_REPLY_SCHEMA — i.e. agent_message.text becomes the JSON-stringified
// `{"message":"..."}` payload. Parse and pull `message`. If the field isn't
// JSON (older codex / schema not enforced), fall back to raw text.
function findAssistantText(events: JsonlEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as Record<string, unknown>;
    if (e['type'] === 'item.completed') {
      const item = e['item'];
      if (item && typeof item === 'object') {
        const itemObj = item as Record<string, unknown>;
        if (itemObj['type'] === 'agent_message' && typeof itemObj['text'] === 'string') {
          const raw = itemObj['text'] as string;
          try {
            const parsed = JSON.parse(raw) as unknown;
            if (
              parsed !== null &&
              typeof parsed === 'object' &&
              'message' in (parsed as Record<string, unknown>) &&
              typeof (parsed as Record<string, unknown>)['message'] === 'string'
            ) {
              return (parsed as Record<string, unknown>)['message'] as string;
            }
          } catch {
            // raw isn't JSON — schema wasn't enforced, fall through to raw.
          }
          return raw;
        }
      }
    }
  }
  return null;
}

const CODEX_REPLY_SCHEMA = {
  type: 'object',
  properties: {
    message: {
      type: 'string',
      description:
        'The text of your next chat message. Do not include role labels, JSON wrappers, markdown, or explanations. Just the literal text of what you would say.',
    },
  },
  required: ['message'],
};

// codex's --output-schema takes a file path. Write the schema once per
// process; reuse on every turn. Re-create if it's been deleted under us.
let schemaPath: string | null = null;
function ensureSchemaFile(): string {
  if (schemaPath !== null && fs.existsSync(schemaPath)) return schemaPath;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fireside-codex-schema-'));
  const filePath = path.join(dir, 'reply-schema.json');
  fs.writeFileSync(filePath, JSON.stringify(CODEX_REPLY_SCHEMA), 'utf8');
  schemaPath = filePath;
  return filePath;
}

export const codexSpec: AgentSpec = {
  id: 'codex',
  displayName: 'Codex',
  command: 'codex',
  defaultTimeoutMs: 120_000,
  buildArgs(prompt, sessionId) {
    const schema = ensureSchemaFile();
    // codex exec resume [SESSION_ID] [PROMPT] — explicit thread id, never
    // --last (multi-room safety).
    if (sessionId) {
      return ['exec', 'resume', sessionId, '--json', '--output-schema', schema, prompt];
    }
    return ['exec', '--json', '--output-schema', schema, prompt];
  },
  parseOutput(stdout, stderr): AgentReply {
    const events = parseJsonl(stdout);
    if (events.length === 0) {
      throw new AgentParseError('codex', 'no JSONL events on stdout', stdout, stderr);
    }
    const text = findAssistantText(events);
    if (text === null) {
      throw new AgentParseError(
        'codex',
        'no assistant message event found in stream',
        stdout,
        stderr,
      );
    }
    const sessionId = findSessionId(events);
    return { text, sessionId, raw: { stdout, stderr } };
  },
};
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run server/tests/unit/codex.test.ts
```

Expected: 4 passed. If `parses fresh JSONL fixture` fails, your fixture uses different event names — update `findAssistantText` and `findSessionId` based on what you saw in Task 2.2.

- [ ] **Step 5: Commit**

```bash
git add server/src/agents/codex.ts server/tests/unit/codex.test.ts
git commit -m "feat(agents): add Codex CLI adapter"
```

---

### Task 3.4: Gemini adapter (TDD)

**Files:**
- Create: `fireside/server/src/agents/gemini.ts`
- Test: `fireside/server/tests/unit/gemini.test.ts`

**Phase 8 update — pure-chat mode via `defaultCwd`.** Real-CLI smoke testing showed gemini-cli auto-detects projects from its working directory (presence of `docs/`, source code, `package.json`) and switches into agentic mode: it narrates intent on stdout, attempts blocked tool calls (`run_shell_command`, file reads) on stderr, and never produces JSON. Gemini 0.39.1's `--help` exposes no `--no-tools` flag, and `--allowed-tools` is deprecated. The cleanest fix is to spawn gemini with a neutral cwd. Concrete changes (already shipped):

- `AgentSpec` gained an optional `defaultCwd?: string` field (`server/src/agents/types.ts`).
- `geminiSpec` sets `defaultCwd: os.tmpdir()` (`server/src/agents/gemini.ts`).
- `runAgentTurn` uses `opts.cwd ?? spec.defaultCwd` and only forwards a `cwd` when one is set (`server/src/agents/runner.ts`), so claude/codex still inherit the broker's cwd unchanged.
- A unit test in `server/tests/unit/runner.test.ts` mocks `runSubprocess` and verifies all three branches: caller cwd wins, spec.defaultCwd is used when caller omits, neither set means cwd is omitted entirely.

- [ ] **Step 1: Write the failing test**

```ts
// server/tests/unit/gemini.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { geminiSpec } from '../../src/agents/gemini.js';
import { AgentParseError } from '../../src/agents/types.js';

const FIXTURE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');
const headless = readFileSync(path.join(FIXTURE_DIR, 'gemini-headless.json'), 'utf8');
const withPreamble = readFileSync(path.join(FIXTURE_DIR, 'gemini-with-preamble.json'), 'utf8');

describe('gemini adapter', () => {
  it('builds argv for fresh session', () => {
    const argv = geminiSpec.buildArgs('hi', null);
    expect(argv).toEqual(expect.arrayContaining(['-p', 'hi', '--output-format', 'json']));
    expect(argv).not.toContain('--resume');
  });

  it('builds argv for resumed session', () => {
    const argv = geminiSpec.buildArgs('again', 'session-abc');
    expect(argv).toContain('--resume');
  });

  it('parses headless fixture', () => {
    const reply = geminiSpec.parseOutput(headless, '');
    expect(reply.text.toLowerCase()).toContain('pong');
  });

  it('throws on garbage stdout', () => {
    expect(() => geminiSpec.parseOutput('not json', '')).toThrow(AgentParseError);
  });

  // Real-CLI captures showed Gemini may emit a preamble line before the JSON
  // object. The adapter must tolerate it.
  it('parses output with preamble before JSON', () => {
    const reply = geminiSpec.parseOutput(withPreamble, '');
    expect(reply.text).toBe('pong');
    expect(reply.sessionId).toBe('def-preamble');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run server/tests/unit/gemini.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement `gemini.ts`**

Adjust the `RESPONSE_FIELDS` and `SESSION_FIELDS` arrays based on your fixture from Task 2.3. The order matters — first match wins.

```ts
// server/src/agents/gemini.ts
import type { AgentReply, AgentSpec } from './types.js';
import { AgentParseError } from './types.js';
import { extractTopLevelJsonObject } from './json-extract.js';

const RESPONSE_FIELDS = ['response', 'result', 'text', 'output'];
const SESSION_FIELDS = ['session_id', 'sessionId', 'session'];

function pickString(obj: Record<string, unknown>, fields: string[]): string | null {
  for (const f of fields) {
    const v = obj[f];
    if (typeof v === 'string') return v;
  }
  return null;
}

export const geminiSpec: AgentSpec = {
  id: 'gemini',
  displayName: 'Gemini',
  command: 'gemini',
  defaultTimeoutMs: 240_000,
  buildArgs(prompt, sessionId) {
    const args = ['-p', prompt, '--output-format', 'json'];
    if (sessionId) args.push('--resume');
    return args;
  },
  parseOutput(stdout, stderr): AgentReply {
    if (!stdout.trim()) throw new AgentParseError('gemini', 'empty stdout', stdout, stderr);
    // Gemini may emit a preamble on stdout before the JSON object. Tolerate it.
    const parsed = extractTopLevelJsonObject(stdout);
    if (!parsed || typeof parsed !== 'object') {
      throw new AgentParseError(
        'gemini',
        'no top-level JSON object found in stdout',
        stdout,
        stderr,
      );
    }
    const obj = parsed as Record<string, unknown>;
    const text = pickString(obj, RESPONSE_FIELDS);
    const sessionId = pickString(obj, SESSION_FIELDS);
    if (text === null) {
      throw new AgentParseError('gemini', 'no response field found', stdout, stderr);
    }
    return { text, sessionId, raw: { stdout, stderr } };
  },
};
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run server/tests/unit/gemini.test.ts
```

Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add server/src/agents/gemini.ts server/tests/unit/gemini.test.ts
git commit -m "feat(agents): add Gemini CLI adapter"
```

---

### Task 3.5: Echo adapter + agent registry

**Files:**
- Create: `fireside/server/src/agents/echo.ts`
- Create: `fireside/server/src/agents/registry.ts`
- Create: `fireside/server/src/agents/runner.ts`

- [ ] **Step 1: Implement `echo.ts`**

The echo adapter is used by every integration test. It does not invoke any external CLI — it processes its prompt synthetically.

```ts
// server/src/agents/echo.ts
import type { AgentSpec } from './types.js';

export const echoSpec: AgentSpec = {
  id: 'echo',
  displayName: 'Echo Bot',
  command: 'node', // will not actually be spawned by tests; the runner handles 'echo' specially.
  defaultTimeoutMs: 5_000,
  buildArgs(prompt) {
    return ['-e', `process.stdout.write(${JSON.stringify('echo: ' + prompt)})`];
  },
  parseOutput(stdout, stderr) {
    return { text: stdout, sessionId: 'echo-static', raw: { stdout, stderr } };
  },
};
```

- [ ] **Step 2: Implement `runner.ts`**

```ts
// server/src/agents/runner.ts
import { runSubprocess } from '../windows/spawn.js';
import type { AgentReply, AgentSpec } from './types.js';

export interface RunAgentOptions {
  spec: AgentSpec;
  prompt: string;
  sessionId: string | null;
  timeoutMs?: number;
  cwd?: string;
}

export async function runAgentTurn(opts: RunAgentOptions): Promise<AgentReply> {
  const { spec, prompt, sessionId } = opts;
  const args = spec.buildArgs(prompt, sessionId);
  const stdin = spec.buildStdin?.(prompt, sessionId);
  const result = await runSubprocess({
    command: spec.command,
    args,
    stdin: stdin ?? '',
    timeoutMs: opts.timeoutMs ?? spec.defaultTimeoutMs,
    cwd: opts.cwd,
  });
  if (result.exitCode !== 0) {
    // Non-zero exit may still produce parseable output (warnings on stderr).
    // We let the parser decide — many CLIs exit non-zero on malformed prompts.
  }
  return spec.parseOutput(result.stdout, result.stderr);
}
```

- [ ] **Step 3: Implement `registry.ts`**

```ts
// server/src/agents/registry.ts
import { claudeSpec } from './claude.js';
import { codexSpec } from './codex.js';
import { geminiSpec } from './gemini.js';
import { echoSpec } from './echo.js';
import type { AgentId, AgentSpec } from './types.js';

const REGISTRY: Record<AgentId, AgentSpec> = {
  claude: claudeSpec,
  codex: codexSpec,
  gemini: geminiSpec,
  echo: echoSpec,
};

export function getAgentSpec(id: AgentId): AgentSpec {
  const spec = REGISTRY[id];
  if (!spec) throw new Error(`unknown agent id: ${id}`);
  return spec;
}

export function listAgentSpecs(): AgentSpec[] {
  return Object.values(REGISTRY);
}
```

- [ ] **Step 4: Verify typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add server/src/agents/echo.ts server/src/agents/runner.ts server/src/agents/registry.ts
git commit -m "feat(agents): add echo adapter, runner, and registry"
```

---

## Phase 4 — Persistence (TDD)

### Task 4.1: SQLite schema + migration

**Files:**
- Create: `fireside/server/src/db.ts`
- Test: `fireside/server/tests/unit/db.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/tests/unit/db.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db.js';

describe('openDatabase', () => {
  it('creates schema on a fresh in-memory db', () => {
    const db = openDatabase(':memory:');
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain('rooms');
    expect(names).toContain('messages');
    expect(names).toContain('sessions');
  });

  it('is idempotent — second open does not error', () => {
    const db = openDatabase(':memory:');
    expect(() => openDatabase(':memory:')).not.toThrow();
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run server/tests/unit/db.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `db.ts`**

```ts
// server/src/db.ts
import Database from 'better-sqlite3';
import type { Database as DbType } from 'better-sqlite3';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  agents_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL,
  author_kind TEXT NOT NULL CHECK (author_kind IN ('human', 'agent', 'system')),
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_room_created ON messages(room_id, created_at);

CREATE TABLE IF NOT EXISTS sessions (
  room_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  cli_session_id TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, agent_id)
);
`;

export function openDatabase(filename: string): DbType {
  const db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run server/tests/unit/db.test.ts
```

Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add server/src/db.ts server/tests/unit/db.test.ts
git commit -m "feat(db): add SQLite open + schema migration"
```

---

### Task 4.2: Rooms repo (TDD)

**Files:**
- Create: `fireside/server/src/repos/rooms.ts`
- Test: `fireside/server/tests/unit/rooms-repo.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/tests/unit/rooms-repo.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db.js';
import { createRoom, getRoom, listRooms, setRoomAgents } from '../../src/repos/rooms.js';

describe('rooms repo', () => {
  let db: ReturnType<typeof openDatabase>;
  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  it('creates and retrieves a room', () => {
    const room = createRoom(db, { name: 'general', agents: ['claude', 'codex'] });
    expect(room.id).toMatch(/.+/);
    expect(room.name).toBe('general');
    expect(room.agents).toEqual(['claude', 'codex']);
    expect(room.createdAt).toBeGreaterThan(0);

    const fetched = getRoom(db, room.id);
    expect(fetched).toEqual(room);
  });

  it('returns null when room not found', () => {
    expect(getRoom(db, 'nonexistent')).toBeNull();
  });

  it('lists rooms in creation order', () => {
    createRoom(db, { name: 'a', agents: [] });
    createRoom(db, { name: 'b', agents: [] });
    const rooms = listRooms(db);
    expect(rooms.map((r) => r.name)).toEqual(['a', 'b']);
  });

  it('updates room agents', () => {
    const room = createRoom(db, { name: 'general', agents: ['claude'] });
    setRoomAgents(db, room.id, ['claude', 'codex', 'gemini']);
    expect(getRoom(db, room.id)!.agents).toEqual(['claude', 'codex', 'gemini']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run server/tests/unit/rooms-repo.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement `rooms.ts`**

```ts
// server/src/repos/rooms.ts
import type { Database } from 'better-sqlite3';
import { nanoid } from 'nanoid';
import type { AgentId } from '../agents/types.js';

export interface Room {
  id: string;
  name: string;
  agents: AgentId[];
  createdAt: number;
}

interface RoomRow {
  id: string;
  name: string;
  agents_json: string;
  created_at: number;
}

function rowToRoom(row: RoomRow): Room {
  return {
    id: row.id,
    name: row.name,
    agents: JSON.parse(row.agents_json) as AgentId[],
    createdAt: row.created_at,
  };
}

export function createRoom(
  db: Database,
  input: { name: string; agents: AgentId[] },
): Room {
  const id = nanoid(12);
  const now = Date.now();
  db.prepare(
    `INSERT INTO rooms (id, name, created_at, agents_json) VALUES (?, ?, ?, ?)`,
  ).run(id, input.name, now, JSON.stringify(input.agents));
  return { id, name: input.name, agents: input.agents, createdAt: now };
}

export function getRoom(db: Database, id: string): Room | null {
  const row = db.prepare(`SELECT * FROM rooms WHERE id = ?`).get(id) as RoomRow | undefined;
  return row ? rowToRoom(row) : null;
}

export function listRooms(db: Database): Room[] {
  const rows = db.prepare(`SELECT * FROM rooms ORDER BY created_at ASC`).all() as RoomRow[];
  return rows.map(rowToRoom);
}

export function setRoomAgents(db: Database, roomId: string, agents: AgentId[]): void {
  db.prepare(`UPDATE rooms SET agents_json = ? WHERE id = ?`).run(JSON.stringify(agents), roomId);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run server/tests/unit/rooms-repo.test.ts
```

Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add server/src/repos/rooms.ts server/tests/unit/rooms-repo.test.ts
git commit -m "feat(repos): add rooms repo with create/get/list/setAgents"
```

---

### Task 4.3: Messages repo (TDD)

**Files:**
- Create: `fireside/server/src/repos/messages.ts`
- Test: `fireside/server/tests/unit/messages-repo.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/tests/unit/messages-repo.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db.js';
import { createRoom } from '../../src/repos/rooms.js';
import { addMessage, listMessages, listMessagesAfter } from '../../src/repos/messages.js';

describe('messages repo', () => {
  let db: ReturnType<typeof openDatabase>;
  let roomId: string;
  beforeEach(() => {
    db = openDatabase(':memory:');
    roomId = createRoom(db, { name: 'general', agents: [] }).id;
  });

  it('adds and lists messages in created order', () => {
    addMessage(db, { roomId, authorId: 'matt', authorKind: 'human', text: 'hi' });
    addMessage(db, { roomId, authorId: 'claude', authorKind: 'agent', text: 'hello' });
    const messages = listMessages(db, roomId);
    expect(messages).toHaveLength(2);
    expect(messages[0].text).toBe('hi');
    expect(messages[1].text).toBe('hello');
    expect(messages[0].id).not.toBe(messages[1].id);
  });

  it('respects limit param on listMessages', () => {
    for (let i = 0; i < 10; i++) {
      addMessage(db, { roomId, authorId: 'x', authorKind: 'human', text: `m${i}` });
    }
    const last3 = listMessages(db, roomId, { limit: 3 });
    expect(last3.map((m) => m.text)).toEqual(['m7', 'm8', 'm9']);
  });

  it('listMessagesAfter returns only messages with id strictly after cursor', () => {
    const a = addMessage(db, { roomId, authorId: 'x', authorKind: 'human', text: 'a' });
    const b = addMessage(db, { roomId, authorId: 'x', authorKind: 'human', text: 'b' });
    const c = addMessage(db, { roomId, authorId: 'x', authorKind: 'human', text: 'c' });
    const after = listMessagesAfter(db, roomId, a.createdAt);
    expect(after.map((m) => m.text)).toEqual(['b', 'c']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run server/tests/unit/messages-repo.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement `messages.ts`**

```ts
// server/src/repos/messages.ts
import type { Database } from 'better-sqlite3';
import { nanoid } from 'nanoid';

export type AuthorKind = 'human' | 'agent' | 'system';

export interface Message {
  id: string;
  roomId: string;
  authorId: string;
  authorKind: AuthorKind;
  text: string;
  createdAt: number;
}

interface MessageRow {
  id: string;
  room_id: string;
  author_id: string;
  author_kind: AuthorKind;
  text: string;
  created_at: number;
}

function rowToMessage(row: MessageRow): Message {
  return {
    id: row.id,
    roomId: row.room_id,
    authorId: row.author_id,
    authorKind: row.author_kind,
    text: row.text,
    createdAt: row.created_at,
  };
}

export function addMessage(
  db: Database,
  input: { roomId: string; authorId: string; authorKind: AuthorKind; text: string },
): Message {
  const id = nanoid(16);
  const now = Date.now();
  db.prepare(
    `INSERT INTO messages (id, room_id, author_id, author_kind, text, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, input.roomId, input.authorId, input.authorKind, input.text, now);
  return { id, ...input, createdAt: now };
}

export function listMessages(
  db: Database,
  roomId: string,
  opts: { limit?: number } = {},
): Message[] {
  if (opts.limit) {
    const rows = db
      .prepare(
        `SELECT * FROM (
           SELECT * FROM messages WHERE room_id = ? ORDER BY created_at DESC LIMIT ?
         ) ORDER BY created_at ASC`,
      )
      .all(roomId, opts.limit) as MessageRow[];
    return rows.map(rowToMessage);
  }
  const rows = db
    .prepare(`SELECT * FROM messages WHERE room_id = ? ORDER BY created_at ASC`)
    .all(roomId) as MessageRow[];
  return rows.map(rowToMessage);
}

export function listMessagesAfter(db: Database, roomId: string, afterMs: number): Message[] {
  const rows = db
    .prepare(
      `SELECT * FROM messages WHERE room_id = ? AND created_at > ? ORDER BY created_at ASC`,
    )
    .all(roomId, afterMs) as MessageRow[];
  return rows.map(rowToMessage);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run server/tests/unit/messages-repo.test.ts
```

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add server/src/repos/messages.ts server/tests/unit/messages-repo.test.ts
git commit -m "feat(repos): add messages repo with insert/list/listAfter"
```

---

### Task 4.4: Sessions repo (TDD)

**Files:**
- Create: `fireside/server/src/repos/sessions.ts`
- Test: `fireside/server/tests/unit/sessions-repo.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/tests/unit/sessions-repo.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db.js';
import { getCliSessionId, upsertCliSessionId } from '../../src/repos/sessions.js';

describe('sessions repo', () => {
  let db: ReturnType<typeof openDatabase>;
  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  it('returns null for missing (room, agent)', () => {
    expect(getCliSessionId(db, 'r1', 'claude')).toBeNull();
  });

  it('upserts a new session id', () => {
    upsertCliSessionId(db, 'r1', 'claude', 'cs-abc');
    expect(getCliSessionId(db, 'r1', 'claude')).toBe('cs-abc');
  });

  it('updates an existing session id (latest wins)', () => {
    upsertCliSessionId(db, 'r1', 'claude', 'cs-old');
    upsertCliSessionId(db, 'r1', 'claude', 'cs-new');
    expect(getCliSessionId(db, 'r1', 'claude')).toBe('cs-new');
  });

  it('isolates sessions per (room, agent)', () => {
    upsertCliSessionId(db, 'r1', 'claude', 'A');
    upsertCliSessionId(db, 'r1', 'codex', 'B');
    upsertCliSessionId(db, 'r2', 'claude', 'C');
    expect(getCliSessionId(db, 'r1', 'claude')).toBe('A');
    expect(getCliSessionId(db, 'r1', 'codex')).toBe('B');
    expect(getCliSessionId(db, 'r2', 'claude')).toBe('C');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run server/tests/unit/sessions-repo.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement `sessions.ts`**

```ts
// server/src/repos/sessions.ts
import type { Database } from 'better-sqlite3';
import type { AgentId } from '../agents/types.js';

export function getCliSessionId(db: Database, roomId: string, agentId: AgentId): string | null {
  const row = db
    .prepare(`SELECT cli_session_id FROM sessions WHERE room_id = ? AND agent_id = ?`)
    .get(roomId, agentId) as { cli_session_id: string | null } | undefined;
  return row?.cli_session_id ?? null;
}

export function upsertCliSessionId(
  db: Database,
  roomId: string,
  agentId: AgentId,
  cliSessionId: string | null,
): void {
  db.prepare(
    `INSERT INTO sessions (room_id, agent_id, cli_session_id, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(room_id, agent_id) DO UPDATE SET
       cli_session_id = excluded.cli_session_id,
       updated_at = excluded.updated_at`,
  ).run(roomId, agentId, cliSessionId, Date.now());
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run server/tests/unit/sessions-repo.test.ts
```

Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add server/src/repos/sessions.ts server/tests/unit/sessions-repo.test.ts
git commit -m "feat(repos): add sessions repo for (room, agent) -> cli_session_id"
```

---

## Phase 5 — Transcript, Mentions, and Broker (TDD)

### Task 5.1: Transcript formatting (TDD)

**Files:**
- Create: `fireside/server/src/transcript.ts`
- Test: `fireside/server/tests/unit/transcript.test.ts`

**Phase 8 update — chat-completion-style prompt with turn cue.** The original transcript template framed history as "Conversation so far:" / "New message just posted:" / "Write your next chat message in response…" During Phase 8 real-CLI smoke tests, Codex (and to a lesser extent Gemini) parsed that framing as historical conversation context and replied with role-acknowledgment ("Understood. I'll participate as `codex`.") instead of obeying the embedded instruction. The fix is to (a) hoist the response instructions to the top so the model treats them as system framing, (b) flatten history + new message into one continuous transcript, and (c) end the prompt with a `<agentId>:` turn cue so the model sees a chat-completion seed and writes a line, not a meta reply.

- [ ] **Step 1: Write the failing test**

```ts
// server/tests/unit/transcript.test.ts
import { describe, it, expect } from 'vitest';
import { buildTurnPrompt } from '../../src/transcript.js';

describe('buildTurnPrompt', () => {
  it('formats empty history with just the new message and ends on a turn cue', () => {
    const prompt = buildTurnPrompt({
      agentId: 'claude',
      roomName: 'general',
      history: [],
      newMessage: { authorId: 'matt', authorKind: 'human', text: 'hi' },
    });
    expect(prompt).toContain('multi-user chat room');
    expect(prompt).toContain('claude');
    expect(prompt).toContain('Reply with the text');
    expect(prompt).toContain('matt: hi');
    expect(prompt.endsWith('claude:')).toBe(true);
  });

  it('includes recent history in chronological order followed by the new message and turn cue', () => {
    const prompt = buildTurnPrompt({
      agentId: 'claude',
      roomName: 'general',
      history: [
        { authorId: 'matt', authorKind: 'human', text: 'first' },
        { authorId: 'codex', authorKind: 'agent', text: 'second' },
      ],
      newMessage: { authorId: 'gemini', authorKind: 'agent', text: 'third' },
    });
    expect(prompt.indexOf('first')).toBeLessThan(prompt.indexOf('second'));
    expect(prompt.indexOf('second')).toBeLessThan(prompt.indexOf('third'));
    expect(prompt.indexOf('third')).toBeLessThan(prompt.lastIndexOf('claude:'));
    expect(prompt.endsWith('claude:')).toBe(true);
  });

  it('marks the agent\'s own previous messages with "(you)"', () => {
    const prompt = buildTurnPrompt({
      agentId: 'claude',
      roomName: 'general',
      history: [{ authorId: 'claude', authorKind: 'agent', text: 'hi' }],
      newMessage: { authorId: 'matt', authorKind: 'human', text: 'whats up' },
    });
    expect(prompt).toContain('claude (you)');
  });

  it('truncates history beyond the configured cap', () => {
    const history = Array.from({ length: 200 }, (_, i) => ({
      authorId: 'matt',
      authorKind: 'human' as const,
      text: `message ${i}`,
    }));
    const prompt = buildTurnPrompt({
      agentId: 'claude',
      roomName: 'general',
      history,
      newMessage: { authorId: 'matt', authorKind: 'human', text: 'final' },
      maxHistory: 50,
    });
    expect(prompt).not.toContain('message 0');
    expect(prompt).toContain('message 199');
    expect(prompt).toContain('final');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run server/tests/unit/transcript.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement `transcript.ts`**

```ts
// server/src/transcript.ts
import type { AgentId } from './agents/types.js';
import type { AuthorKind } from './repos/messages.js';

export interface HistoryEntry {
  authorId: string;
  authorKind: AuthorKind;
  text: string;
}

export interface BuildTurnOptions {
  agentId: AgentId;
  roomName: string;
  history: HistoryEntry[];
  newMessage: HistoryEntry;
  maxHistory?: number;
}

const DEFAULT_MAX_HISTORY = 80;

function formatLine(agentId: AgentId, entry: HistoryEntry): string {
  const isSelf = entry.authorKind === 'agent' && entry.authorId === agentId;
  const author = isSelf ? `${entry.authorId} (you)` : entry.authorId;
  return `${author}: ${entry.text}`;
}

export function buildTurnPrompt(opts: BuildTurnOptions): string {
  const max = opts.maxHistory ?? DEFAULT_MAX_HISTORY;
  const recent = opts.history.slice(-max);
  const transcript = recent.map((e) => formatLine(opts.agentId, e)).join('\n');
  const newLine = formatLine(opts.agentId, opts.newMessage);
  const fullTranscript = transcript ? `${transcript}\n${newLine}` : newLine;

  return [
    `You are "${opts.agentId}" in a multi-user chat room. Other participants are humans and other AI agents.`,
    ``,
    `Reply with the text of your next chat message only — no preface, no role labels, no markdown headers, no explanation. If you have nothing useful to add, reply with an empty string.`,
    ``,
    `--- conversation ---`,
    fullTranscript || '(no prior messages)',
    `${opts.agentId}:`,
  ].join('\n');
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run server/tests/unit/transcript.test.ts
```

Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add server/src/transcript.ts server/tests/unit/transcript.test.ts
git commit -m "feat(transcript): add buildTurnPrompt"
```

---

### Task 5.2: Mention parser (TDD)

**Files:**
- Create: `fireside/server/src/mentions.ts`
- Test: `fireside/server/tests/unit/mentions.test.ts`

Mentions drive turn-taking. `@claude` only addresses Claude. No mention with `mode: 'mentioned-only'` means no agent replies. With `mode: 'all-agents'` everyone replies.

- [ ] **Step 1: Write the failing test**

```ts
// server/tests/unit/mentions.test.ts
import { describe, it, expect } from 'vitest';
import { parseMentions } from '../../src/mentions.js';

describe('parseMentions', () => {
  it('returns empty when no @mentions present', () => {
    expect(parseMentions('hello everyone')).toEqual([]);
  });

  it('parses a single mention', () => {
    expect(parseMentions('hey @claude what do you think?')).toEqual(['claude']);
  });

  it('parses multiple distinct mentions', () => {
    expect(parseMentions('@claude @codex thoughts?')).toEqual(['claude', 'codex']);
  });

  it('deduplicates repeated mentions', () => {
    expect(parseMentions('@claude @claude')).toEqual(['claude']);
  });

  it('only recognizes known agent ids', () => {
    expect(parseMentions('@bogus @claude')).toEqual(['claude']);
  });

  it('ignores email-like @ tokens', () => {
    expect(parseMentions('email me at user@claude.com')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run server/tests/unit/mentions.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement `mentions.ts`**

```ts
// server/src/mentions.ts
import type { AgentId } from './agents/types.js';

const KNOWN: AgentId[] = ['claude', 'codex', 'gemini', 'echo'];

// Match @name only when preceded by start-of-string or whitespace, and followed by
// non-word boundary that is not a `.` (to skip emails like user@claude.com).
const MENTION_RE = /(?:^|\s)@([a-z][a-z0-9-]*)(?![.\w])/gi;

export function parseMentions(text: string): AgentId[] {
  const found = new Set<AgentId>();
  for (const match of text.matchAll(MENTION_RE)) {
    const name = match[1].toLowerCase() as AgentId;
    if (KNOWN.includes(name)) found.add(name);
  }
  return Array.from(found);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run server/tests/unit/mentions.test.ts
```

Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add server/src/mentions.ts server/tests/unit/mentions.test.ts
git commit -m "feat(mentions): add @-mention parser"
```

---

### Task 5.3: Broker — turn-taking policy + dispatch (TDD with echo agent)

**Files:**
- Create: `fireside/server/src/broker.ts`
- Test: `fireside/server/tests/integration/broker-echo.test.ts`

The broker is the heart of fireside. It decides which agents respond to a message and orchestrates their invocation.

Turn-taking rules for v1:
1. If the message contains `@<agent>` mentions, **only** those agents reply.
2. Otherwise, **only the human-addressed agents in the room respond** if the room's `replyMode` is `mentions-only`, or **all agents in the room except the author** respond if `replyMode` is `all`.
3. Agents NEVER reply to their own messages.
4. To prevent runaway loops, a single inbound message produces at most one round of replies — agent replies to a human message do not trigger further agent replies in the same round.

- [ ] **Step 1: Write the failing test**

```ts
// server/tests/integration/broker-echo.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openDatabase } from '../../src/db.js';
import { createRoom } from '../../src/repos/rooms.js';
import { listMessages } from '../../src/repos/messages.js';
import { Broker } from '../../src/broker.js';
import type { AgentId, AgentSpec } from '../../src/agents/types.js';

function fakeSpec(id: AgentId, replyText: string): AgentSpec {
  return {
    id,
    displayName: id,
    command: 'fake',
    defaultTimeoutMs: 1000,
    buildArgs: () => [],
    parseOutput: () => ({ text: replyText, sessionId: `${id}-sess`, raw: { stdout: '', stderr: '' } }),
  };
}

describe('Broker', () => {
  let db: ReturnType<typeof openDatabase>;
  let broker: Broker;
  let runs: Array<{ agentId: AgentId; prompt: string; sessionId: string | null }>;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runs = [];
    broker = new Broker({
      db,
      runAgent: async (spec, prompt, sessionId) => {
        runs.push({ agentId: spec.id, prompt, sessionId });
        return { text: `${spec.id}-says-hello`, sessionId: `${spec.id}-sess`, raw: { stdout: '', stderr: '' } };
      },
      getSpec: (id) => {
        const map: Record<string, AgentSpec> = {
          claude: fakeSpec('claude', 'claude reply'),
          codex: fakeSpec('codex', 'codex reply'),
          gemini: fakeSpec('gemini', 'gemini reply'),
          echo: fakeSpec('echo', 'echo reply'),
        };
        return map[id];
      },
    });
  });

  it('routes a human message with @claude mention to claude only', async () => {
    const room = createRoom(db, { name: 'g', agents: ['claude', 'codex'] });
    await broker.postHumanMessage(room.id, 'matt', '@claude hey');
    const messages = listMessages(db, room.id);
    expect(messages.map((m) => `${m.authorId}:${m.text}`)).toEqual([
      'matt:@claude hey',
      'claude:claude-says-hello',
    ]);
    expect(runs.map((r) => r.agentId)).toEqual(['claude']);
  });

  it('without mentions, all agents in the room reply', async () => {
    const room = createRoom(db, { name: 'g', agents: ['claude', 'codex'] });
    await broker.postHumanMessage(room.id, 'matt', 'hi everyone');
    const messages = listMessages(db, room.id);
    expect(messages).toHaveLength(3);
    expect(runs.map((r) => r.agentId).sort()).toEqual(['claude', 'codex']);
  });

  it('agents do not reply to their own messages (no recursion)', async () => {
    const room = createRoom(db, { name: 'g', agents: ['claude', 'codex'] });
    await broker.postHumanMessage(room.id, 'matt', 'kick it off');
    const before = runs.length;
    // Even though codex's reply lands in the room, it must not trigger another round.
    expect(runs.length).toBe(before);
    expect(runs.length).toBe(2);
  });

  it('persists session id from agent reply', async () => {
    const room = createRoom(db, { name: 'g', agents: ['claude'] });
    await broker.postHumanMessage(room.id, 'matt', '@claude hi');
    // Second message should be invoked with the prior session id.
    await broker.postHumanMessage(room.id, 'matt', '@claude again');
    expect(runs[0].sessionId).toBeNull();
    expect(runs[1].sessionId).toBe('claude-sess');
  });

  it('emits "messageAppended" events for both human and agent messages', async () => {
    const room = createRoom(db, { name: 'g', agents: ['claude'] });
    const events: Array<{ author: string; text: string }> = [];
    broker.on('messageAppended', (msg) => events.push({ author: msg.authorId, text: msg.text }));
    await broker.postHumanMessage(room.id, 'matt', '@claude hi');
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ author: 'matt' });
    expect(events[1]).toMatchObject({ author: 'claude' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run server/tests/integration/broker-echo.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement `broker.ts`**

```ts
// server/src/broker.ts
import { EventEmitter } from 'node:events';
import type { Database } from 'better-sqlite3';
import { addMessage, listMessages, type Message } from './repos/messages.js';
import { getRoom } from './repos/rooms.js';
import { getCliSessionId, upsertCliSessionId } from './repos/sessions.js';
import { buildTurnPrompt } from './transcript.js';
import { parseMentions } from './mentions.js';
import type { AgentId, AgentReply, AgentSpec } from './agents/types.js';

export interface BrokerDeps {
  db: Database;
  runAgent: (spec: AgentSpec, prompt: string, sessionId: string | null) => Promise<AgentReply>;
  getSpec: (id: AgentId) => AgentSpec | undefined;
  maxHistory?: number;
}

export class Broker extends EventEmitter {
  constructor(private deps: BrokerDeps) {
    super();
  }

  async postHumanMessage(roomId: string, authorId: string, text: string): Promise<Message> {
    return this.append(roomId, authorId, 'human', text);
  }

  async postSystemMessage(roomId: string, text: string): Promise<Message> {
    return this.append(roomId, 'system', 'system', text);
  }

  private async append(
    roomId: string,
    authorId: string,
    authorKind: 'human' | 'agent' | 'system',
    text: string,
  ): Promise<Message> {
    const room = getRoom(this.deps.db, roomId);
    if (!room) throw new Error(`unknown room: ${roomId}`);

    const message = addMessage(this.deps.db, { roomId, authorId, authorKind, text });
    this.emit('messageAppended', message);

    // Only inbound human/system messages can trigger agent replies. Agent messages do not.
    if (authorKind === 'agent') return message;

    const responders = this.pickResponders(room.agents, text, authorId);
    await Promise.all(
      responders.map((agentId) => this.runAgentReply(roomId, agentId, message)),
    );
    return message;
  }

  private pickResponders(roomAgents: AgentId[], text: string, authorId: string): AgentId[] {
    const mentions = parseMentions(text);
    if (mentions.length > 0) {
      return mentions.filter((m) => roomAgents.includes(m));
    }
    return roomAgents.filter((a) => a !== authorId);
  }

  private async runAgentReply(roomId: string, agentId: AgentId, trigger: Message): Promise<void> {
    const spec = this.deps.getSpec(agentId);
    if (!spec) {
      await this.append(roomId, 'system', 'system', `(no adapter for agent "${agentId}")`);
      return;
    }
    const room = getRoom(this.deps.db, roomId)!;
    const history = listMessages(this.deps.db, roomId).slice(0, -1); // exclude the trigger
    const prompt = buildTurnPrompt({
      agentId,
      roomName: room.name,
      history: history.map((m) => ({ authorId: m.authorId, authorKind: m.authorKind, text: m.text })),
      newMessage: { authorId: trigger.authorId, authorKind: trigger.authorKind, text: trigger.text },
      maxHistory: this.deps.maxHistory,
    });
    const sessionId = getCliSessionId(this.deps.db, roomId, agentId);

    let reply: AgentReply;
    try {
      reply = await this.deps.runAgent(spec, prompt, sessionId);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.append(roomId, 'system', 'system', `(${agentId} failed: ${errMsg})`);
      return;
    }

    if (reply.sessionId) {
      upsertCliSessionId(this.deps.db, roomId, agentId, reply.sessionId);
    }
    const text = reply.text.trim();
    if (text.length === 0) return; // agent declined to speak
    await this.append(roomId, agentId, 'agent', text);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run server/tests/integration/broker-echo.test.ts
```

Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add server/src/broker.ts server/tests/integration/broker-echo.test.ts
git commit -m "feat(broker): route messages, dispatch agents, persist sessions"
```

---

### Task 5.4: Broker timeout integration test (TDD)

**Files:**
- Test: `fireside/server/tests/integration/timeout.test.ts`

- [ ] **Step 1: Write the test**

```ts
// server/tests/integration/timeout.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db.js';
import { createRoom } from '../../src/repos/rooms.js';
import { listMessages } from '../../src/repos/messages.js';
import { Broker } from '../../src/broker.js';
import { SubprocessTimeoutError } from '../../src/windows/spawn.js';
import type { AgentId, AgentSpec } from '../../src/agents/types.js';

function spec(id: AgentId): AgentSpec {
  return {
    id,
    displayName: id,
    command: 'fake',
    defaultTimeoutMs: 100,
    buildArgs: () => [],
    parseOutput: () => ({ text: '', sessionId: null, raw: { stdout: '', stderr: '' } }),
  };
}

describe('Broker timeout handling', () => {
  it('posts a system message when an agent times out, does not crash', async () => {
    const db = openDatabase(':memory:');
    const broker = new Broker({
      db,
      runAgent: async () => {
        throw new SubprocessTimeoutError('claude', 100);
      },
      getSpec: (id) => spec(id),
    });
    const room = createRoom(db, { name: 'g', agents: ['claude'] });
    await broker.postHumanMessage(room.id, 'matt', '@claude');
    const messages = listMessages(db, room.id);
    expect(messages).toHaveLength(2);
    expect(messages[1].authorKind).toBe('system');
    expect(messages[1].text).toContain('timed out');
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

```bash
npx vitest run server/tests/integration/timeout.test.ts
```

Expected: 1 passed (the broker already swallows errors and posts a system message — Task 5.3 wired this).

- [ ] **Step 3: Commit**

```bash
git add server/tests/integration/timeout.test.ts
git commit -m "test(broker): verify timeout produces system message, not crash"
```

---

## Phase 6 — HTTP + WebSocket Server

### Task 6.1: Config + logger

**Files:**
- Create: `fireside/server/src/config.ts`
- Create: `fireside/server/src/logger.ts`

- [ ] **Step 1: Create `config.ts`**

```ts
// server/src/config.ts
import path from 'node:path';

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  dbFile: string;
  uiDir: string;
}

export function loadConfig(): Config {
  const dataDir = process.env.FIRESIDE_DATA_DIR ?? path.resolve(process.cwd(), 'data');
  return {
    port: Number(process.env.FIRESIDE_PORT ?? '8787'),
    host: process.env.FIRESIDE_HOST ?? '127.0.0.1',
    dataDir,
    dbFile: path.join(dataDir, 'fireside.sqlite'),
    uiDir: path.resolve(process.cwd(), 'ui'),
  };
}
```

- [ ] **Step 2: Create `logger.ts`**

```ts
// server/src/logger.ts
import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport:
    process.env.NODE_ENV === 'production'
      ? undefined
      : { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } },
});
```

- [ ] **Step 3: Commit**

```bash
git add server/src/config.ts server/src/logger.ts
git commit -m "feat(server): add config loader and pino logger"
```

---

### Task 6.2: HTTP server (Fastify) + REST routes

**Files:**
- Create: `fireside/server/src/http-server.ts`

- [ ] **Step 1: Implement `http-server.ts`**

```ts
// server/src/http-server.ts
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { Database } from 'better-sqlite3';
import path from 'node:path';
import { createRoom, getRoom, listRooms } from './repos/rooms.js';
import { listMessages } from './repos/messages.js';
import type { AgentId } from './agents/types.js';
import type { Broker } from './broker.js';
import { logger } from './logger.js';

export interface HttpDeps {
  db: Database;
  broker: Broker;
  uiDir: string;
}

export function buildHttpServer(deps: HttpDeps): FastifyInstance {
  const app = Fastify({ loggerInstance: logger });

  app.register(fastifyStatic, {
    root: path.resolve(deps.uiDir),
    prefix: '/',
    decorateReply: false,
  });

  app.get('/api/rooms', async () => {
    return listRooms(deps.db);
  });

  app.post<{ Body: { name: string; agents: AgentId[] } }>('/api/rooms', async (req, reply) => {
    const { name, agents } = req.body ?? ({} as { name: string; agents: AgentId[] });
    if (!name || !Array.isArray(agents)) {
      return reply.code(400).send({ error: 'name and agents are required' });
    }
    return createRoom(deps.db, { name, agents });
  });

  app.get<{ Params: { id: string } }>('/api/rooms/:id', async (req, reply) => {
    const room = getRoom(deps.db, req.params.id);
    if (!room) return reply.code(404).send({ error: 'not found' });
    return room;
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/api/rooms/:id/messages',
    async (req, reply) => {
      const room = getRoom(deps.db, req.params.id);
      if (!room) return reply.code(404).send({ error: 'not found' });
      const limit = req.query.limit ? Number(req.query.limit) : undefined;
      return listMessages(deps.db, req.params.id, limit ? { limit } : {});
    },
  );

  app.post<{ Params: { id: string }; Body: { authorId: string; text: string } }>(
    '/api/rooms/:id/messages',
    async (req, reply) => {
      const room = getRoom(deps.db, req.params.id);
      if (!room) return reply.code(404).send({ error: 'not found' });
      const { authorId, text } = req.body;
      if (!authorId || typeof text !== 'string') {
        return reply.code(400).send({ error: 'authorId and text required' });
      }
      const message = await deps.broker.postHumanMessage(req.params.id, authorId, text);
      return message;
    },
  );

  return app;
}
```

- [ ] **Step 2: Verify typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add server/src/http-server.ts
git commit -m "feat(server): add Fastify HTTP server with REST routes"
```

---

### Task 6.3: WebSocket server (TDD)

**Files:**
- Create: `fireside/server/src/ws-server.ts`
- Test: `fireside/server/tests/integration/ws-flow.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/tests/integration/ws-flow.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import { WebSocket } from 'ws';
import { AddressInfo } from 'node:net';
import { openDatabase } from '../../src/db.js';
import { createRoom } from '../../src/repos/rooms.js';
import { Broker } from '../../src/broker.js';
import { attachWebSocketServer } from '../../src/ws-server.js';
import type { AgentId, AgentSpec } from '../../src/agents/types.js';

function spec(id: AgentId): AgentSpec {
  return {
    id,
    displayName: id,
    command: 'fake',
    defaultTimeoutMs: 1000,
    buildArgs: () => [],
    parseOutput: () => ({ text: '', sessionId: null, raw: { stdout: '', stderr: '' } }),
  };
}

describe('WebSocket fanout', () => {
  let httpServer: HttpServer;
  let port: number;
  let db: ReturnType<typeof openDatabase>;
  let broker: Broker;

  beforeEach(async () => {
    db = openDatabase(':memory:');
    broker = new Broker({
      db,
      runAgent: async (s) => ({ text: `${s.id}-reply`, sessionId: `${s.id}-sess`, raw: { stdout: '', stderr: '' } }),
      getSpec: (id) => spec(id),
    });
    httpServer = createServer();
    attachWebSocketServer(httpServer, broker);
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    port = (httpServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it('broadcasts new messages to subscribed clients', async () => {
    const room = createRoom(db, { name: 'g', agents: ['claude'] });

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    ws.send(JSON.stringify({ type: 'subscribe', roomId: room.id }));

    const received: Array<{ type: string; message?: { text: string; authorId: string } }> = [];
    ws.on('message', (data) => received.push(JSON.parse(data.toString())));

    await broker.postHumanMessage(room.id, 'matt', 'hi');

    // Wait for 2 messageAppended events to land (matt + claude).
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (received.filter((r) => r.type === 'messageAppended').length >= 2) {
          clearInterval(timer);
          resolve();
        }
      }, 25);
    });

    const appended = received.filter((r) => r.type === 'messageAppended');
    expect(appended.map((r) => r.message!.authorId)).toEqual(['matt', 'claude']);
    ws.close();
  });

  it('only broadcasts to clients subscribed to that room', async () => {
    const a = createRoom(db, { name: 'A', agents: [] });
    const b = createRoom(db, { name: 'B', agents: [] });

    const wsA = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((r) => wsA.once('open', () => r()));
    wsA.send(JSON.stringify({ type: 'subscribe', roomId: a.id }));

    const recvA: any[] = [];
    wsA.on('message', (d) => recvA.push(JSON.parse(d.toString())));

    await broker.postHumanMessage(b.id, 'x', 'in B');
    await new Promise((r) => setTimeout(r, 100));
    expect(recvA.filter((r) => r.type === 'messageAppended')).toHaveLength(0);

    wsA.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run server/tests/integration/ws-flow.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `ws-server.ts`**

```ts
// server/src/ws-server.ts
import { WebSocketServer, type WebSocket } from 'ws';
import type { Server as HttpServer } from 'node:http';
import type { Broker } from './broker.js';
import type { Message } from './repos/messages.js';
import { logger } from './logger.js';

interface ClientState {
  rooms: Set<string>;
}

interface InboundSubscribe {
  type: 'subscribe';
  roomId: string;
}

interface InboundUnsubscribe {
  type: 'unsubscribe';
  roomId: string;
}

interface InboundPostMessage {
  type: 'postMessage';
  roomId: string;
  authorId: string;
  text: string;
}

type Inbound = InboundSubscribe | InboundUnsubscribe | InboundPostMessage;

export function attachWebSocketServer(httpServer: HttpServer, broker: Broker): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  const clients = new Map<WebSocket, ClientState>();

  broker.on('messageAppended', (msg: Message) => {
    const payload = JSON.stringify({ type: 'messageAppended', message: msg });
    for (const [client, state] of clients.entries()) {
      if (client.readyState === client.OPEN && state.rooms.has(msg.roomId)) {
        client.send(payload);
      }
    }
  });

  wss.on('connection', (client) => {
    clients.set(client, { rooms: new Set() });

    client.on('message', async (data) => {
      let parsed: Inbound;
      try {
        parsed = JSON.parse(data.toString()) as Inbound;
      } catch {
        client.send(JSON.stringify({ type: 'error', error: 'invalid json' }));
        return;
      }
      const state = clients.get(client);
      if (!state) return;

      if (parsed.type === 'subscribe') {
        state.rooms.add(parsed.roomId);
        client.send(JSON.stringify({ type: 'subscribed', roomId: parsed.roomId }));
      } else if (parsed.type === 'unsubscribe') {
        state.rooms.delete(parsed.roomId);
      } else if (parsed.type === 'postMessage') {
        try {
          await broker.postHumanMessage(parsed.roomId, parsed.authorId, parsed.text);
        } catch (err) {
          logger.error({ err }, 'broker.postHumanMessage failed');
          client.send(JSON.stringify({ type: 'error', error: (err as Error).message }));
        }
      }
    });

    client.on('close', () => clients.delete(client));
    client.on('error', () => clients.delete(client));
  });

  return wss;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run server/tests/integration/ws-flow.test.ts
```

Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add server/src/ws-server.ts server/tests/integration/ws-flow.test.ts
git commit -m "feat(server): add WebSocket fanout with per-room subscription"
```

---

### Task 6.4: Wire it all together — entry point

**Files:**
- Create: `fireside/server/src/index.ts`

- [ ] **Step 1: Implement `index.ts`**

```ts
// server/src/index.ts
import { mkdirSync } from 'node:fs';
import { loadConfig } from './config.js';
import { logger } from './logger.js';
import { openDatabase } from './db.js';
import { Broker } from './broker.js';
import { buildHttpServer } from './http-server.js';
import { attachWebSocketServer } from './ws-server.js';
import { runAgentTurn } from './agents/runner.js';
import { getAgentSpec } from './agents/registry.js';
import type { AgentId } from './agents/types.js';

async function main() {
  const config = loadConfig();
  mkdirSync(config.dataDir, { recursive: true });
  const db = openDatabase(config.dbFile);

  const broker = new Broker({
    db,
    runAgent: (spec, prompt, sessionId) => runAgentTurn({ spec, prompt, sessionId }),
    getSpec: (id: AgentId) => {
      try {
        return getAgentSpec(id);
      } catch {
        return undefined;
      }
    },
  });

  const app = buildHttpServer({ db, broker, uiDir: config.uiDir });
  await app.ready();
  attachWebSocketServer(app.server, broker);

  await app.listen({ host: config.host, port: config.port });
  logger.info({ host: config.host, port: config.port }, 'fireside listening');

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      logger.info({ sig }, 'shutting down');
      await app.close();
      db.close();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  logger.fatal({ err }, 'failed to start fireside');
  process.exit(1);
});
```

- [ ] **Step 2: Verify typecheck and start manually**

```bash
npm run typecheck
npm run dev
```

Expected: server logs `fireside listening` on `127.0.0.1:8787`. Curl from another shell:

```bash
curl http://127.0.0.1:8787/api/rooms
```

Expected: `[]`

```bash
curl -X POST http://127.0.0.1:8787/api/rooms -H "Content-Type: application/json" -d '{"name":"general","agents":["claude","codex","gemini"]}'
```

Expected: a room object with an `id`. Then `Ctrl+C` to stop.

- [ ] **Step 3: Commit**

```bash
git add server/src/index.ts
git commit -m "feat(server): wire entry point — HTTP + WS + broker"
```

---

## Phase 7 — Frontend (test-after, manual verification)

### Task 7.1: Static UI scaffold

**Files:**
- Create: `fireside/ui/index.html`
- Create: `fireside/ui/styles.css`
- Create: `fireside/ui/app.js`

Per the global rule, UI is not TDD'd — we build it, click through it, then write integration tests for any logic that emerges.

- [ ] **Step 1: Create `ui/index.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>fireside</title>
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>
  <header>
    <h1>fireside</h1>
    <div id="room-controls">
      <select id="room-select"></select>
      <button id="new-room-btn">+ new room</button>
    </div>
  </header>
  <main>
    <ol id="message-list" aria-live="polite"></ol>
    <form id="composer">
      <input id="author-input" type="text" placeholder="your name" autocomplete="off" />
      <input id="message-input" type="text" placeholder="say something… (use @claude / @codex / @gemini to direct)" autocomplete="off" />
      <button type="submit">send</button>
    </form>
  </main>
  <script src="/app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `ui/styles.css`**

```css
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { font-family: system-ui, -apple-system, Segoe UI, sans-serif; margin: 0; height: 100vh; display: flex; flex-direction: column; }
header { padding: .75rem 1rem; border-bottom: 1px solid #8884; display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
h1 { margin: 0; font-size: 1rem; }
main { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
#message-list { flex: 1; list-style: none; margin: 0; padding: 1rem; overflow-y: auto; display: flex; flex-direction: column; gap: .5rem; }
.msg { padding: .4rem .6rem; border-radius: .4rem; max-width: 65ch; line-height: 1.4; white-space: pre-wrap; }
.msg.human { background: #4d8cf83a; align-self: flex-start; }
.msg.agent { background: #50aa6e36; align-self: flex-start; }
.msg.system { background: #aaaaaa36; align-self: center; font-style: italic; font-size: .875rem; }
.msg .author { font-weight: 600; margin-right: .5rem; }
#composer { display: flex; gap: .5rem; padding: .75rem 1rem; border-top: 1px solid #8884; }
#composer input { padding: .5rem; border: 1px solid #8886; border-radius: .35rem; font: inherit; }
#author-input { flex: 0 0 10rem; }
#message-input { flex: 1; }
#composer button { padding: .5rem 1rem; border: none; border-radius: .35rem; background: #2a6cdb; color: white; font: inherit; cursor: pointer; }
#composer button:hover { background: #2056b3; }
select, header button { font: inherit; padding: .35rem .6rem; }
```

- [ ] **Step 3: Create `ui/app.js`**

```js
const $ = (sel) => document.querySelector(sel);
const messageList = $('#message-list');
const roomSelect = $('#room-select');
const composer = $('#composer');
const authorInput = $('#author-input');
const messageInput = $('#message-input');
const newRoomBtn = $('#new-room-btn');

let currentRoomId = null;
let ws = null;

authorInput.value = localStorage.getItem('fireside.author') || 'matt';
authorInput.addEventListener('change', () => localStorage.setItem('fireside.author', authorInput.value));

function appendMessage(msg) {
  const li = document.createElement('li');
  li.className = `msg ${msg.authorKind}`;
  const author = document.createElement('span');
  author.className = 'author';
  author.textContent = msg.authorId + ':';
  li.appendChild(author);
  li.appendChild(document.createTextNode(msg.text));
  messageList.appendChild(li);
  messageList.scrollTop = messageList.scrollHeight;
}

async function loadRooms() {
  const r = await fetch('/api/rooms').then((r) => r.json());
  roomSelect.innerHTML = '';
  for (const room of r) {
    const opt = document.createElement('option');
    opt.value = room.id;
    opt.textContent = `${room.name} (${room.agents.join(', ') || 'no agents'})`;
    roomSelect.appendChild(opt);
  }
  if (r.length > 0) selectRoom(r[0].id);
}

async function selectRoom(roomId) {
  currentRoomId = roomId;
  roomSelect.value = roomId;
  messageList.innerHTML = '';
  const messages = await fetch(`/api/rooms/${roomId}/messages`).then((r) => r.json());
  for (const m of messages) appendMessage(m);
  if (ws) ws.send(JSON.stringify({ type: 'subscribe', roomId }));
}

roomSelect.addEventListener('change', (e) => selectRoom(e.target.value));

newRoomBtn.addEventListener('click', async () => {
  const name = prompt('Room name?');
  if (!name) return;
  const agentsInput = prompt('Agents in this room? (comma-separated: claude,codex,gemini)', 'claude,codex,gemini');
  const agents = agentsInput.split(',').map((s) => s.trim()).filter(Boolean);
  const room = await fetch('/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, agents }),
  }).then((r) => r.json());
  await loadRooms();
  selectRoom(room.id);
});

composer.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!currentRoomId) return;
  const text = messageInput.value.trim();
  if (!text) return;
  ws.send(
    JSON.stringify({
      type: 'postMessage',
      roomId: currentRoomId,
      authorId: authorInput.value || 'human',
      text,
    }),
  );
  messageInput.value = '';
});

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws`);
  ws.addEventListener('open', () => {
    if (currentRoomId) ws.send(JSON.stringify({ type: 'subscribe', roomId: currentRoomId }));
  });
  ws.addEventListener('message', (e) => {
    const evt = JSON.parse(e.data);
    if (evt.type === 'messageAppended' && evt.message.roomId === currentRoomId) {
      appendMessage(evt.message);
    }
  });
  ws.addEventListener('close', () => setTimeout(connectWs, 1000));
}

connectWs();
loadRooms();
```

- [ ] **Step 4: Manually verify the UI**

```bash
npm run dev
```

Open `http://127.0.0.1:8787` in a browser:
1. Click "+ new room" → name "general" → agents `claude,codex,gemini`.
2. Type `hi` and press send. The message should appear immediately and (if your CLIs work) replies from each agent should arrive within ~30s each.
3. Verify `@claude what's 2+2` only triggers a Claude reply.
4. Open the same URL in a second browser tab — both should see new messages in real time.

If the first message hangs, check the server logs. The most common cause is the CLI hanging on missing auth or wrong flags. Re-run `npm run verify:clis`.

- [ ] **Step 5: Commit**

```bash
git add ui/
git commit -m "feat(ui): add minimal vanilla chat UI"
```

---

## Phase 8 — Real Agent End-to-End Verification

### Task 8.1: Real-CLI smoke test (manual, scripted)

**Files:**
- Create: `fireside/scripts/smoke-test.cjs`

This script exercises each adapter against the real CLI, end-to-end. Failures here mean an adapter's parsing assumptions are wrong; do not skip.

- [ ] **Step 1: Create `scripts/smoke-test.cjs`**

```js
#!/usr/bin/env node
// Calls each real CLI through the runner once. Run AFTER `verify-clis` and AFTER fixtures are captured.
(async () => {
  const { runAgentTurn } = await import('../dist/server/src/agents/runner.js');
  const { getAgentSpec } = await import('../dist/server/src/agents/registry.js');

  const cases = [
    { id: 'claude', prompt: 'reply with exactly: pong' },
    { id: 'codex',  prompt: 'reply with exactly: pong' },
    { id: 'gemini', prompt: 'reply with exactly: pong' },
  ];
  for (const c of cases) {
    process.stdout.write(`[${c.id}] running... `);
    try {
      const reply = await runAgentTurn({ spec: getAgentSpec(c.id), prompt: c.prompt, sessionId: null });
      const ok = reply.text.toLowerCase().includes('pong');
      console.log(ok ? `OK (sessionId=${reply.sessionId})` : `WRONG: ${JSON.stringify(reply.text).slice(0,100)}`);
    } catch (err) {
      console.log(`FAIL: ${err.message}`);
    }
  }
})().catch((err) => {
  console.error('smoke-test crashed:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Build and run**

```bash
npm run build
node scripts/smoke-test.cjs
```

Expected: 3 lines, all `OK`. If any line is `WRONG` or `FAIL`, that adapter's `parseOutput` does not match the actual CLI output. Open the corresponding fixture, compare against the failure stdout, and update the adapter constants (e.g. `RESULT_FIELD` in `claude.ts`).

When the smoke test fails for a specific adapter, use `scripts/debug-agent.cjs` to capture the raw CLI output for that agent in isolation: `node scripts/debug-agent.cjs <claude|codex|gemini> "<message>"`. The script invokes the CLI through the same `runSubprocess` + registry path the broker uses, builds the prompt via `buildTurnPrompt` (so it's byte-for-byte what the broker would send), and dumps the exact prompt, argv, raw stdout, raw stderr, exit code, timed-out flag, and parse result. Run it before changing any adapter constants — it's the only way to see what the CLI is actually emitting versus what the parser expects.

- [ ] **Step 3: End-to-end UI verification**

Start the broker (`npm run dev`), open the UI, post `@claude reply with exactly: pong`. Verify Claude replies with `pong` within 60s. Repeat for `@codex` and `@gemini`. Then post `who is here?` (no mention) and verify all three agents reply (the broker fans out to room agents excluding the author).

- [ ] **Step 4: Commit**

```bash
git add scripts/smoke-test.cjs
git commit -m "chore(scripts): add real-CLI smoke test"
```

---

### Task 8.2: Capture and document failure modes

After running the smoke test and the UI verification, document anything surprising in `docs/windows-subprocess-notes.md`.

- [ ] **Step 1: Run a failure-mode probe**

For each agent, intentionally trigger:
- A hang (kill the CLI mid-turn): kill the spawned `node.exe` from Task Manager and verify the broker emits a system message about timeout/failure.
- A malformed prompt (extremely long input — paste 50KB of lorem ipsum): verify the broker either returns the reply or surfaces a clean error message, never crashes.
- A network failure (disable network and post a message): verify the system message accurately states the failure cause.

- [ ] **Step 2: Document each observation**

Append to `docs/windows-subprocess-notes.md` under a new section:

```markdown
## Observed Failure Modes (date: <today>)

### Claude
- Behavior on kill: <describe>
- Behavior on long prompt: <describe>
- Behavior on no network: <describe>

### Codex
- ...

### Gemini
- ...
```

- [ ] **Step 3: Commit**

```bash
git add docs/windows-subprocess-notes.md
git commit -m "docs: record observed failure modes per agent"
```

---

## Phase 9 — Polish, Launchers, Runbook, README

### Task 9.1: Windows launcher scripts

**Files:**
- Create: `fireside/scripts/start.cmd`

- [ ] **Step 1: Create `scripts/start.cmd`**

```bat
@echo off
REM Launches fireside. Use this from File Explorer or pin to taskbar.
cd /d "%~dp0\.."
where node >nul 2>nul
if errorlevel 1 (
  echo node not found on PATH. Install Node.js 20 LTS first.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)
if not exist dist (
  echo Building...
  call npm run build
  if errorlevel 1 (
    echo build failed.
    pause
    exit /b 1
  )
)
echo Starting fireside on http://127.0.0.1:8787 — Ctrl+C to stop.
node --enable-source-maps dist/server/src/index.js
```

- [ ] **Step 2: Verify by double-clicking `scripts/start.cmd`** in File Explorer.

Expected: a console window opens, broker boots, you can navigate to `http://127.0.0.1:8787`. Closing the console kills the broker cleanly.

- [ ] **Step 3: Commit**

```bash
git add scripts/start.cmd
git commit -m "chore: add Windows .cmd launcher"
```

---

### Task 9.2: README + architecture doc + runbook

**Files:**
- Create: `fireside/README.md`
- Create: `fireside/docs/architecture.md`
- Create: `fireside/docs/runbook.md`

- [ ] **Step 1: Create `README.md`**

```markdown
# fireside

Persistent multi-agent chat for Claude Code, OpenAI Codex CLI, Google Gemini CLI, and humans. Runs locally on Windows (no API keys, no cloud).

## Quick start

1. Install Node.js 20 LTS.
2. Install + log in to each CLI you want to use:
   - `npm install -g @anthropic-ai/claude-code` then run `claude` once to log in.
   - `npm install -g @openai/codex` then run `codex login`.
   - `npm install -g @google/gemini-cli` then run `gemini` once to log in.
3. From this directory: `npm install && npm run build`.
4. Verify your setup: `npm run verify:clis`.
5. Start: double-click `scripts\start.cmd` (or `npm run start`).
6. Open `http://127.0.0.1:8787`.

See `docs/runbook.md` for troubleshooting.
```

- [ ] **Step 2: Create `docs/architecture.md`**

```markdown
# Architecture

## Components

- **Broker** (`server/src/broker.ts`): always-on Node process. Owns all routing.
- **HTTP server** (`server/src/http-server.ts`): Fastify; serves `ui/` and REST.
- **WebSocket server** (`server/src/ws-server.ts`): per-room subscription fanout.
- **Agent adapters** (`server/src/agents/{claude,codex,gemini}.ts`): per-CLI buildArgs + parseOutput.
- **Subprocess wrapper** (`server/src/windows/spawn.ts`): single chokepoint for all CLI invocations on Windows.
- **SQLite store** (`server/src/db.ts`, `repos/*`): durable rooms, messages, sessions.
- **UI** (`ui/`): vanilla HTML/JS, served as static assets by Fastify.

## Lifecycle of a message

1. Browser sends `{type:"postMessage", roomId, authorId, text}` over WebSocket.
2. WS handler calls `broker.postHumanMessage(roomId, authorId, text)`.
3. Broker inserts into `messages` table and emits `messageAppended`.
4. WS server fans the event to every client subscribed to that room.
5. Broker computes responders: `parseMentions` if present, else all agents in the room except the author.
6. For each responder in parallel: build prompt via `transcript.buildTurnPrompt`, look up prior `cli_session_id`, call `runAgentTurn` (which calls `runSubprocess`).
7. `runSubprocess` spawns the CLI's `.cmd` shim with `execa shell:true`, pipes stdin (closed for EOF), captures UTF-8 stdout/stderr, hard timeout via `tree-kill`.
8. Adapter `parseOutput` extracts `{text, sessionId}` from the response.
9. Broker `upsertCliSessionId` and inserts the agent message.
10. Each insert emits `messageAppended` → fanned out to all subscribers.

## Why no API keys

Each CLI caches its OAuth tokens in the user's home directory:
- `%USERPROFILE%\.claude\` (Anthropic OAuth)
- `%USERPROFILE%\.codex\` (ChatGPT login or API key)
- `%USERPROFILE%\.gemini\` (Google OAuth)

The broker spawns the CLI as a child process. The child inherits the user's environment, including `USERPROFILE`, and finds these credential files. We do **not** propagate `OPENAI_API_KEY` (it interferes with codex's ChatGPT login).

## Why subprocess-per-turn instead of long-lived

These CLIs do not expose a daemon mode. Trying to keep a single `claude` process alive across many turns would require an interactive TUI driver, which is a large maintenance liability. Spawn-per-turn is simple, stateless, and uses each CLI's `--resume` to maintain conversation continuity. Each spawn is ~500ms of overhead — invisible against the LLM round-trip itself.

## Cross-process state

The broker is single-process. There is no clustering. SQLite WAL mode allows readers from external tools (e.g. `sqlite3` CLI) while the broker holds the writer lock.

If the broker dies, restart it. All state is in `data/fireside.sqlite`.
```

- [ ] **Step 3: Create `docs/runbook.md`**

```markdown
# Runbook

## CLI is missing or unauthenticated

`npm run verify:clis` reports `[MISSING]`.

- Install: `npm install -g @anthropic-ai/claude-code` (or codex / gemini-cli).
- Log in: run the bare `claude`, `codex`, or `gemini` interactively once and complete OAuth.

## Broker logs `EACCES` or `EPERM` opening SQLite

- Verify `data/` directory is writable.
- Check no other process holds `fireside.sqlite` (only one broker can run at once).

## Replies are blank or contain garbage

- Re-run `node scripts/smoke-test.cjs` and inspect the failing adapter's stdout.
- Re-capture the fixture from Task 2.x and update the adapter constants if field names changed.

## A CLI hangs and the broker reports timeout

- Default timeout is 120s per turn. Increase via `agentSpec.defaultTimeoutMs` for that CLI.
- If `tree-kill` is not killing the `.cmd` shim's `node.exe`, run `where taskkill` to confirm it's on PATH (it is in `C:\Windows\System32` by default).

## better-sqlite3 fails to compile on `npm install`

- Install the C++ build tools: `npm install -g windows-build-tools` (deprecated but still works), or install Visual Studio Build Tools 2022 with the Desktop development with C++ workload.
- Alternatively use the prebuilt binary: `npm install better-sqlite3 --build-from-source=false`.

## OPENAI_API_KEY interferes with codex login

- `unset OPENAI_API_KEY` in the broker's environment, OR start the broker from a shell that has never set it.
- See openai/codex GitHub issues #2733 and #3286 for context.

## Multiple console windows flash on Windows

- All `runSubprocess` calls pass `windowsHide: true`. If you still see flashes, your installed `execa` version may be old — `npm install execa@latest`.

## CRLF chaos

- All adapters normalize CRLF→LF before parsing. If you see literal `\r` in messages, you're bypassing the wrapper.

## Switching `--resume` flag semantics

Each CLI's `--resume` syntax has changed across versions. If a release breaks the test, capture new fixtures (Phase 2) and update `buildArgs` in the relevant adapter.
```

- [ ] **Step 4: Commit**

```bash
git add README.md docs/architecture.md docs/runbook.md
git commit -m "docs: add README, architecture overview, runbook"
```

---

### Task 9.3: Final test run + lint clean

- [ ] **Step 1: Run full test suite**

```bash
npm run test
```

Expected: all tests pass.

- [ ] **Step 2: Lint clean**

```bash
npm run lint
```

Expected: 0 errors. Fix any reported issues inline.

- [ ] **Step 3: Typecheck clean**

```bash
npm run typecheck
```

Expected: 0 errors.

- [ ] **Step 4: Final commit if anything was fixed**

```bash
git add -A && git commit -m "chore: final lint and typecheck pass" || echo "nothing to commit"
```

---

## Self-Review

The plan above implements every requirement from the original spec:

| Requirement | Where it's addressed |
|---|---|
| Persistent shared chat space | Tasks 4.1–4.3 (SQLite tables + repos), Task 5.3 (broker append), Task 6.3 (WS fanout) |
| No API keys — CLI tools only | Task 0.5 (verify-clis), Task 1.3 (subprocess wrapper inherits env, no key propagation), Task 9.2 architecture doc explains how |
| Human can join | Task 7.1 (browser UI with author input), Task 6.3 (postMessage WS frame) |
| Respect tool capability differences per agent | Each adapter (Tasks 3.2–3.4) parses only what its CLI emits; the transcript (Task 5.1) does not pass tool-use blocks; agents see only plain `author: text` lines |
| Persistent connection, not polling | Task 6.3 (WebSocket server with `messageAppended` push) |
| Windows-rigorous subprocess management | Phase 1 entirely (encoding, tree-kill, spawn wrapper with timeouts) + Task 8.2 (failure-mode documentation) |
| Multi-CLI: Claude + Codex + Gemini | Tasks 3.2–3.4 |

**Placeholder scan:** No "TBD", "fill in details", or "similar to Task N" patterns — every step contains the exact code or command. Where adapter field names depend on captured fixtures (Tasks 3.2–3.4), the steps explicitly tell the engineer to inspect the fixture and adjust constants, not guess.

**Type consistency:** `AgentSpec`, `AgentReply`, `AgentId`, `Message`, `Room`, `AuthorKind` are defined once and used consistently. `runAgentTurn` signature is reused identically in `broker.ts` and the entry point.

**One known concession:** the exact CLI flag for JSON output and session resumption (`--output-format json`, `--resume`, `codex exec resume --last`) are based on documented behavior at time of writing. Phase 2 (fixture capture) requires the engineer to verify the actual flags on their installed version and adjust the adapters before any tests in Phase 3 can pass. This is intentional — drift in CLI flags is the most likely source of breakage, and the plan surfaces it early rather than burying it.

---

## Execution Handoff

Plan complete and saved to `fireside/docs/2026-04-26-fireside-implementation-plan.md`.

Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
