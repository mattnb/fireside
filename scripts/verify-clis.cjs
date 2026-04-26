#!/usr/bin/env node
// Verifies claude / codex / gemini are installed, on PATH, and authenticated.
// Designed to run on Windows; uses execa for PATHEXT-aware spawn.

const { execa } = require('execa');

async function probe(name, args, expectedSubstring) {
  try {
    // TODO(phase1): Once windows/tree-kill.ts exists, use it to ensure orphaned
    // node.exe grandchildren are killed if a CLI hangs during --version probing.
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
