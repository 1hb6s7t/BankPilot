import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runG9D } from './evaluate-g9d';

/** The 12-case cohort uses the same frozen G9D engine and provider pair. */
export async function runG9DQuality(args = process.argv.slice(2)) {
  if (args.includes('--cohort')) throw new Error('G9D_QUALITY_COHORT_IS_FIXED');
  if (args.includes('--preflight')) return runG9D(args);
  return runG9D(['--cohort','development-supplemental',...args]);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  runG9DQuality().then(report => { if (report && !report.validRun) process.exitCode = 1; })
    .catch(() => { console.error('G9D supplemental configuration or execution failed; case content and credentials remain sealed.'); process.exitCode = 1; });
