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
