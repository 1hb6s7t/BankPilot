import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildG9HManifest, executeG9HStage, G9H_EVALUATOR_FILES, G9H_PROFILE, hashG9HEvaluatorFiles,
  runEvaluationWithProfile, validateG9HManifestMetadata, validateG9HPriorReport, verifyG9HFrozenFiles,
  type EvaluationRunnerProfile } from './evaluate-g9h';

export const G9I_RUNNER_VERSION = 'bankpilot-g9i-default-triple-score-v1';
export const G9I_MANIFEST_PATH = 'evals/g9i-manifest.json';
export const G9I_PROTOCOL_PATH = 'docs/g9i-validation-protocol.md';
export const G9I_EVALUATOR_FILES = [...new Set([
  ...G9H_EVALUATOR_FILES,
  'scripts/evaluate-g9i.ts', 'scripts/g9i-request-validation.ts', 'scripts/diagnose-provider-contract.ts',
  'tests/g9i-runner.test.ts', 'tests/g9i-provider-contract-diagnostic.test.ts',
  'tests/g9i-card-apposition.test.ts', 'tests/g9i-card-apposition-review.test.ts',
  G9I_PROTOCOL_PATH,
])].sort();
export const G9I_PROFILE: EvaluationRunnerProfile = Object.freeze({
  ...G9H_PROFILE, id: 'g9i', runnerVersion: G9I_RUNNER_VERSION,
  requestEvidence: 'required',
  manifestPath: G9I_MANIFEST_PATH, protocolPath: G9I_PROTOCOL_PATH,
  resultsDir: 'evals/results/g9i', sourcePrefix: 'g9i', evaluatorFiles: G9I_EVALUATOR_FILES,
  boundaries: 'Previously exposed 36 known and 12 development-informed cases, not blind. G9I repairs card-apposition scope handling and requires its controlled-browser assertions; the G9I provider diagnostic is a small synthetic sample and does not show endpoint stability. Original G9, G9E and G9G scores remain separate. Provider configuration, budget, attempts, data, order and semantic and bills sidecar contracts remain fixed. One complete known run precedes one complete quality run; no automatic full-run retry. HTTP success does not establish semantic correctness or safe business output.',
});
export const buildG9IManifest = (options: Omit<Parameters<typeof buildG9HManifest>[0], 'profile'>) => buildG9HManifest({ ...options, profile: G9I_PROFILE });
export const hashG9IEvaluatorFiles = (root = '.') => hashG9HEvaluatorFiles(root,G9I_PROFILE);
export const validateG9IManifestMetadata = (manifest: Parameters<typeof validateG9HManifestMetadata>[0], inputs: Parameters<typeof validateG9HManifestMetadata>[1], hashes: Record<string,string>, now?: string) =>
  validateG9HManifestMetadata(manifest,inputs,hashes,now,G9I_PROFILE);
export const verifyG9IFrozenFiles = (manifest: Parameters<typeof verifyG9HFrozenFiles>[0], manifestHash: string, manifestPath = G9I_MANIFEST_PATH, root = '.') =>
  verifyG9HFrozenFiles(manifest,manifestHash,manifestPath,root,G9I_PROFILE);
export const validateG9IPriorReport = (report: any, expected: Omit<Parameters<typeof validateG9HPriorReport>[1], 'profile'>) =>
  validateG9HPriorReport(report,{...expected,profile:G9I_PROFILE});
export const executeG9IStage = (options: Omit<Parameters<typeof executeG9HStage>[0], 'profile'>) =>
  executeG9HStage({...options,profile:G9I_PROFILE});
export const runG9I = (args=process.argv.slice(2)) => runEvaluationWithProfile(args,G9I_PROFILE);
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
  runG9I().then(report=>{if(report&&!report.validRun)process.exitCode=1;}).catch(()=>{console.error('G9I configuration or execution failed; case content and credentials remain sealed.');process.exitCode=1;});
