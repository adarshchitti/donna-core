import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { SandboxJob, SandboxResult, SandboxRunner } from './sandbox.js';

/**
 * Local child-process runner. Weaker isolation than Daytona -- it shares the
 * filesystem -- so it exists for development and as the demo fallback on a
 * machine without Docker. It still enforces the timeout and still reports a
 * sandbox id, so the run record and the evidence page behave identically and
 * nothing downstream has to care which runner produced a snapshot.
 */
export class LocalSandboxRunner implements SandboxRunner {
  readonly kind = 'local' as const;

  async run(job: SandboxJob): Promise<SandboxResult> {
    const sandbox_id = `local-${job.label}-${randomUUID().slice(0, 8)}`;
    return await new Promise<SandboxResult>((resolve) => {
      const child = spawn(process.execPath, [job.entry], {
        // Only what this job needs. The orchestrator holds every secret and
        // hands each sandbox the minimum.
        env: { PATH: process.env.PATH ?? '', ...job.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, job.timeoutMs);

      child.stdout.on('data', (d) => { stdout += String(d); });
      child.stderr.on('data', (d) => { stderr += String(d); });

      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ sandbox_id, stdout, stderr: `${stderr}${err.message}`, exit_code: -1, timed_out: timedOut });
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ sandbox_id, stdout, stderr, exit_code: code ?? -1, timed_out: timedOut });
      });

      child.stdin.write(JSON.stringify(job.input));
      child.stdin.end();
    });
  }

  async dispose(): Promise<void> {}
}
