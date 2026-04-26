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
        // line. Treat "process not found" the same as ESRCH — the goal of
        // killTree is "ensure dead", and "already dead" satisfies it.
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
    // /FO CSV gives a stable, parseable shape: "image","pid","session","sessionnum","memory".
    // /NH suppresses the header row. When tasklist finds nothing it writes
    // `INFO: No tasks are running…` to STDERR (not stdout) and stdout is empty,
    // so a substring check on `,"<pid>",` (the unambiguous quoted PID column)
    // is robust against PIDs that happen to appear inside image names or memory
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
