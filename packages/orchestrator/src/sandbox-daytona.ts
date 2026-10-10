import { Daytona } from '@daytonaio/sdk';
import type { SandboxJob, SandboxResult, SandboxRunner } from './sandbox.js';

export interface DaytonaOptions {
  apiKey: string;
  /** Minutes of inactivity before Daytona stops the box. Keep small: these are throwaway. */
  autoStopInterval?: number;
  /** Reuse one sandbox for a whole batch instead of one per job. */
  reuse?: boolean;
}

/**
 * Daytona runner: one throwaway sandbox per job by default.
 *
 * Verified against the live API: `process.executeCommand` is the working exec
 * path and the default image already has Node. `codeRun` is deliberately NOT
 * used -- it demands a language enum and buys nothing here, since we hand the
 * sandbox a script path and a JSON payload on stdin.
 *
 * Every sandbox is deleted in a finally block. A leaked sandbox costs money and
 * holds a runner slot, and an hours-long demo build can leak a lot of them.
 */
export class DaytonaSandboxRunner implements SandboxRunner {
  readonly kind = 'daytona' as const;
  private readonly daytona: Daytona;
  private readonly opts: DaytonaOptions;
  private shared: Awaited<ReturnType<Daytona['create']>> | null = null;

  constructor(opts: DaytonaOptions) {
    this.opts = opts;
    this.daytona = new Daytona({ apiKey: opts.apiKey });
  }

  async run(job: SandboxJob): Promise<SandboxResult> {
    const sandbox = this.opts.reuse
      ? (this.shared ??= await this.create())
      : await this.create();
    const sandbox_id = sandbox.id;

    try {
      // Pass the payload through an env var rather than argv: a company name or
      // a URL can contain anything, and quoting it into a shell command is how
      // injection happens.
      const envPairs = Object.entries({
        ...job.env,
        DONNA_JOB_INPUT: JSON.stringify(job.input),
      })
        .map(([k, v]) => `${k}=${shellQuote(v)}`)
        .join(' ');

      const result = await sandbox.process.executeCommand(
        `${envPairs} node ${shellQuote(job.entry)}`,
      );

      return {
        sandbox_id,
        stdout: result.result ?? '',
        stderr: '',
        exit_code: result.exitCode ?? -1,
        timed_out: false,
      };
    } catch (error) {
      // A sandbox failure is a failed run, never a thrown exception that stops
      // the loop: one broken source must not halt collection for every company.
      return {
        sandbox_id,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        exit_code: -1,
        timed_out: /timeout|timed out/i.test(String(error)),
      };
    } finally {
      if (!this.opts.reuse) await this.destroy(sandbox);
    }
  }

  async dispose(): Promise<void> {
    if (this.shared) {
      await this.destroy(this.shared);
      this.shared = null;
    }
  }

  private async create() {
    return await this.daytona.create({
      autoStopInterval: this.opts.autoStopInterval ?? 5,
    });
  }

  private async destroy(sandbox: { delete: () => Promise<unknown> }): Promise<void> {
    // Never let cleanup failure mask the job's own result.
    try { await sandbox.delete(); } catch { /* best effort */ }
  }
}

/** Single-quote for POSIX sh, escaping embedded single quotes. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
