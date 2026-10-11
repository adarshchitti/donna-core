import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Daytona } from '@daytonaio/sdk';
import { collectorEnvelopeSchema, type CollectorEnvelope, type Source } from '@donna/contracts';
import type { CollectorRunner } from './run-batch.js';

/** The bundle produced by sandbox-entry/build.mjs. No runtime deps but Node builtins. */
export const BUNDLE_PATH = fileURLToPath(
  new URL('../sandbox-entry/dist/collector-job.cjs', import.meta.url),
);

export interface SandboxCollectorOptions {
  apiKey: string;
  env: Record<string, string>;
  /** Minutes of inactivity before Daytona reclaims the box. These are throwaway. */
  autoStopInterval?: number;
  /** Reuse one sandbox for a whole company batch instead of one per source. */
  reusePerBatch?: boolean;
  bundlePath?: string;
}

/**
 * Runs each collector inside a throwaway Daytona sandbox.
 *
 * Scraping arbitrary pages is exactly the code that should not run next to the
 * database, so the sandbox gets the collector bundle, the Bright Data key and
 * nothing else -- no MongoDB URI, no Anthropic key, no book id. The returned
 * `sandbox_id` is recorded on the run so the evidence page can name the box a
 * claim was fetched in.
 *
 * Verified against the live API: `process.executeCommand` is the working exec
 * path and the default image already has Node, so the bundle needs no install
 * step. Job input travels in an env var rather than argv, because a company
 * name or URL can contain anything and quoting it into a shell command is how
 * injection happens.
 */
export class SandboxCollectorRunner implements CollectorRunner {
  private readonly daytona: Daytona;
  private readonly opts: SandboxCollectorOptions;
  private readonly bundle: string;
  private shared: Sandbox | null = null;
  private uploadedTo = new Set<string>();

  constructor(opts: SandboxCollectorOptions) {
    this.opts = opts;
    this.daytona = new Daytona({ apiKey: opts.apiKey });
    const path = opts.bundlePath ?? BUNDLE_PATH;
    if (!existsSync(path)) {
      throw new Error(
        `collector bundle missing at ${path}. Run: node packages/orchestrator/sandbox-entry/build.mjs`,
      );
    }
    this.bundle = readFileSync(path, 'utf8');
  }

  async collect(input: {
    company: { company_id: string; canonical_name: string; jurisdiction: string; registry_id: string; aliases: string[]; domains: string[] };
    source: Source;
    runId: string;
  }): Promise<{ envelope: CollectorEnvelope; sandbox_id: string | null }> {
    const sandbox = this.opts.reusePerBatch
      ? (this.shared ??= await this.create())
      : await this.create();
    const sandbox_id = sandbox.id;

    try {
      if (!this.uploadedTo.has(sandbox_id)) {
        await sandbox.fs.uploadFile(Buffer.from(this.bundle, 'utf8'), 'collector-job.cjs');
        this.uploadedTo.add(sandbox_id);
      }

      const env = { ...this.opts.env, DONNA_JOB_INPUT: JSON.stringify(input) };
      const prefix = Object.entries(env).map(([k, v]) => `${k}=${sq(v)}`).join(' ');
      const result = await sandbox.process.executeCommand(`${prefix} node collector-job.cjs`);

      const stdout = (result.result ?? '').trim();
      const parsed = parseJobOutput(stdout);
      if (!parsed.ok) {
        throw new Error(`sandbox job failed: ${parsed.error} (exit ${result.exitCode ?? '?'})`);
      }
      // Validate at the boundary: the collectors are a separate repo, so this is
      // where their output is checked rather than trusted.
      return { envelope: collectorEnvelopeSchema.parse(parsed.envelope), sandbox_id };
    } finally {
      if (!this.opts.reusePerBatch) await destroy(sandbox, this.uploadedTo);
    }
  }

  async dispose(): Promise<void> {
    if (this.shared) {
      await destroy(this.shared, this.uploadedTo);
      this.shared = null;
    }
  }

  private async create(): Promise<Sandbox> {
    return (await this.daytona.create({
      autoStopInterval: this.opts.autoStopInterval ?? 5,
    })) as unknown as Sandbox;
  }
}

interface Sandbox {
  id: string;
  fs: { uploadFile(content: Buffer, path: string): Promise<unknown> };
  process: { executeCommand(cmd: string): Promise<{ result?: string; exitCode?: number }> };
  delete(): Promise<unknown>;
}

/** A leaked sandbox costs money and holds a runner slot, so cleanup is best-effort but always attempted. */
async function destroy(sandbox: Sandbox, seen: Set<string>): Promise<void> {
  seen.delete(sandbox.id);
  try { await sandbox.delete(); } catch { /* never let cleanup mask the job's result */ }
}

export function parseJobOutput(
  stdout: string,
): { ok: true; envelope: unknown } | { ok: false; error: string } {
  if (stdout.length === 0) return { ok: false, error: 'sandbox produced no output' };
  // The entry point writes one JSON object and nothing else, but a shell can
  // prepend a banner, so take the last JSON object on the stream.
  const start = stdout.lastIndexOf('{"ok"');
  const slice = start >= 0 ? stdout.slice(start) : stdout;
  try {
    const parsed = JSON.parse(slice) as { ok?: boolean; envelope?: unknown; error?: string };
    if (parsed.ok === true && parsed.envelope) return { ok: true, envelope: parsed.envelope };
    return { ok: false, error: parsed.error ?? 'job reported failure without an error' };
  } catch {
    return { ok: false, error: `unparseable job output: ${stdout.slice(0, 200)}` };
  }
}

/** Single-quote for POSIX sh, escaping embedded single quotes. */
function sq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
