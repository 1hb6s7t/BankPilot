import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildG9HManifest, executeG9HStage, hashG9HEvaluatorFiles,
  runEvaluationWithProfile, validateG9HManifestMetadata, validateG9HPriorReport, verifyG9HFrozenFiles,
  type EvaluationRunnerProfile, type G9HManifest } from './evaluate-g9h';
import { G9I_EVALUATOR_FILES, G9I_PROFILE } from './evaluate-g9i';

export const G9K_RUNNER_VERSION = 'bankpilot-g9k-default-triple-score-v1';
export const G9K_MANIFEST_PATH = 'evals/g9k-manifest.json';
export const G9K_PROTOCOL_PATH = 'docs/g9k-validation-protocol.md';
export const G9K_EVALUATOR_FILES = [...new Set([
  ...G9I_EVALUATOR_FILES,
  'scripts/evaluate-g9k.ts', 'tests/g9k-runner.test.ts', G9K_PROTOCOL_PATH,
])].sort();
export const G9K_PROFILE: EvaluationRunnerProfile = Object.freeze({
  ...G9I_PROFILE,id:'g9k',runnerVersion:G9K_RUNNER_VERSION,
  manifestPath:G9K_MANIFEST_PATH,protocolPath:G9K_PROTOCOL_PATH,
  resultsDir:'evals/results/g9k',sourcePrefix:'g9k',requestEvidence:'required',evaluatorFiles:G9K_EVALUATOR_FILES,
  boundaries:'Known 36 and development-informed 12 are exposed, never blind. This run rechecks Planner quality at the current service time using the G9I formal source ancestor and exact G9J product snapshot; the presentation API is validated separately. The controlled code difference is the presentation path; the G9J eight-call synthetic provider diagnostic is not business quality evidence. G9, G9E, and current G9G scores, labels, fixtures, order, provider settings, budgets, repair limits, and semantic, bills and request evidence gates stay separate and fixed. First default-known then default-quality, once each, without whole-run retry. A complete valid report proves evidence closure; business failures or unavailable cases remain failures under the current G9G contract and cannot establish release acceptance.',
});
type G9KManifestOptions = Omit<Parameters<typeof buildG9HManifest>[0], 'profile' | 'candidateLineage'> & {
  candidateLineage: NonNullable<G9HManifest['candidateLineage']>;
};
export const buildG9KManifest = (options:G9KManifestOptions) => buildG9HManifest({...options,profile:G9K_PROFILE});
export const hashG9KEvaluatorFiles = (root='.') => hashG9HEvaluatorFiles(root,G9K_PROFILE);
export const validateG9KManifestMetadata = (manifest:G9HManifest,inputs:Parameters<typeof validateG9HManifestMetadata>[1],hashes:Record<string,string>,now?:string) =>
  validateG9HManifestMetadata(manifest,inputs,hashes,now,G9K_PROFILE);
export const verifyG9KFrozenFiles = (manifest:G9HManifest,manifestHash:string,manifestPath=G9K_MANIFEST_PATH,root='.') =>
  verifyG9HFrozenFiles(manifest,manifestHash,manifestPath,root,G9K_PROFILE);
export const validateG9KPriorReport = (report:any,expected:Omit<Parameters<typeof validateG9HPriorReport>[1],'profile'>) =>
  validateG9HPriorReport(report,{...expected,profile:G9K_PROFILE});
export const executeG9KStage = (options:Omit<Parameters<typeof executeG9HStage>[0],'profile'>) =>
  executeG9HStage({...options,profile:G9K_PROFILE});
export const runG9K = (args=process.argv.slice(2)) => runEvaluationWithProfile(args,G9K_PROFILE);
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
  runG9K().then(report=>{if(report&&!report.validRun)process.exitCode=1;}).catch(()=>{console.error('G9K configuration or execution failed; case content and credentials remain sealed.');process.exitCode=1;});
