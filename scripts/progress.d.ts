// Type shim for the global heartbeat helper (user CLAUDE.md:97). The helper is untyped plain
// JavaScript at an absolute path outside this repo, so without this file strict tsc raises TS7016.
// tsconfig.json maps that absolute specifier to this file through compilerOptions.paths.
// The absolute path exists only on the author's machine; scripts that import it will not run
// elsewhere. Source of truth for the signature: /Users/graham/.claude/lib/progress.mjs:15.
export interface ProgressOptions {
  dir?: string;
  total?: number | null;
  everyMs?: number;
  everyN?: number | null;
}

export interface Progress {
  tick(done: number, extra?: Record<string, unknown>): void;
  done(extra?: Record<string, unknown>): void;
}

export function progress(job: string, opts?: ProgressOptions): Progress;
