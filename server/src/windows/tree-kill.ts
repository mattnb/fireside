// server/src/windows/tree-kill.ts
import treeKill from 'tree-kill';
import { execa } from 'execa';

export function killTree(pid: number, signal: string = 'SIGTERM'): Promise<void> {
  return new Promise((resolve, reject) => {
    treeKill(pid, signal, (err) => {
      if (err) {
        // ESRCH (no such process) is fine — already dead.
        if ((err as NodeJS.ErrnoException).code === 'ESRCH') resolve();
        else reject(err);
        return;
      }
      resolve();
    });
  });
}

export async function isPidAlive(pid: number): Promise<boolean> {
  if (!pid || pid <= 0) return false;
  if (process.platform === 'win32') {
    const r = await execa('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], {
      reject: false,
      windowsHide: true,
    });
    // tasklist prints "INFO: No tasks are running..." when not found.
    return r.stdout.includes(String(pid));
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
