import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runAblation, type EvaluationSuite } from './evaluate-ablation';
import { g6HoldoutFixtures, g6HoldoutVersion } from '../evals/g6-holdout-fixtures';
import { holdoutFixtures, holdoutVersion } from '../evals/holdout-fixtures';

export async function runG6(args = process.argv.slice(2)) {
  const known = args.includes('--known-regression');
  const suite: EvaluationSuite = known ? {
    fixtures: holdoutFixtures, version: holdoutVersion, fixtureFile: 'evals/holdout-fixtures.ts',
    manifestFile: 'evals/holdout-manifest.json', caseCount: 40, liveCaseCount: 12, phase: 'g6-known-regression',
  } : {
    fixtures: g6HoldoutFixtures, version: g6HoldoutVersion, fixtureFile: 'evals/g6-holdout-fixtures.ts',
    manifestFile: 'evals/g6-holdout-manifest.json', caseCount: 24, liveCaseCount: 12, phase: 'g6-unseen',
  };
  if (args.includes('--postfix')) suite.phase += '-postfix-regression';
  suite.extraSourceFiles = ['scripts/evaluate-g6.ts', 'apps/api/src/app.ts'];
  return runAblation(args, suite);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runG6().then(report => { if (!report.validRun || report.records.some(record => !record.passed)) process.exitCode = 1; })
    .catch(() => { console.error('G6 evaluation configuration or execution failed; no credentials logged.'); process.exitCode = 1; });
}
