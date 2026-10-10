/**
 * Where untrusted work runs.
 *
 * Scraping arbitrary pages is exactly the code that should not run next to the
 * database, which is why collectors and the differ execute in throwaway
 * sandboxes rather than in the orchestrator process. The sandbox id is recorded
 * on every run so the evidence page can name the box a claim came from.
 *
 * Two implementations behind one interface: Daytona for real isolation, and a
 * local child process for development and for the demo machine, which has no
 * Docker. The orchestrator cannot tell them apart, and the run record looks the
 * same either way.
 */

export interface SandboxJob {
  /** Identifies the work, for logs and for the run record. */
  label: string;
  /** Module path to execute inside the sandbox. */
  entry: string;
  /** Serialised job input. Never contains a credential. */
  input: unknown;
  /** Only the variables this job actually needs. */
  env: Record<string, string>;
  timeoutMs: number;
}

export interface SandboxResult {
  sandbox_id: string;
  stdout: string;
  stderr: string;
  exit_code: number;
  timed_out: boolean;
}

export interface SandboxRunner {
  readonly kind: 'daytona' | 'local';
  run(job: SandboxJob): Promise<SandboxResult>;
  dispose(): Promise<void>;
}
