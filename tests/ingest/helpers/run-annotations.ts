import { main } from '../../../scripts/ingest/annotations';

/** Child-process entry for tests: the real CLI path (argument parsing, exit codes, stderr) with a fixed commit, so no git state is needed. */
process.exitCode = await main(process.argv.slice(2), { resolveCommit: () => 'd'.repeat(40) });
