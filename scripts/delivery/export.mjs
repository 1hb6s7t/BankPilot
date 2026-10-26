import { mkdir, copyFile, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, VERSION, FILES, TREES, sourceFiles, sha256, save, flag, fail, cliError } from './shared.mjs';

export async function exportDelivery(destination, root = ROOT) {
  if (!destination) fail('DELIVERY_DESTINATION_REQUIRED');
  const target = resolve(destination);
  if (target === resolve(root) || TREES.some(tree => target.startsWith(resolve(root, tree) + '/'))) fail('DELIVERY_DESTINATION_INVALID');
  const paths = await sourceFiles(root);
  // A new directory is mandatory: never overwrite a previous artifact or private config.
  await mkdir(target, { recursive: false, mode: 0o700 });
  const files = [];
  for (const path of paths) {
    await mkdir(dirname(resolve(target, path)), { recursive: true });
    const origin = path === 'README.md' ? 'docs/g8i-clean-delivery.md' : path;
    await copyFile(resolve(root, origin), resolve(target, path));
    const bytes = await readFile(resolve(target, path));
    files.push({ path, ...(origin !== path ? { origin } : {}), bytes: bytes.length, sha256: sha256(bytes) });
  }
  const manifest = { protocolVersion: VERSION, createdAtUtc: new Date().toISOString(), profile: 'runtime-source-only', nodeRequirement: '>=24', packageManager: 'pnpm@11.25.0',
    roots: { files: FILES, trees: TREES }, excludes: ['.env and private state', 'node_modules', 'evals and historical reports', 'docs/evidence', 'test-results and traces', 'database/user/session exports', 'tests and non-runtime evaluation scripts'], files };
  await save(resolve(target, 'delivery-manifest.json'), manifest, 0o644);
  return { directory: target, manifestPath: resolve(target, 'delivery-manifest.json'), files: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0) };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) exportDelivery(flag(process.argv.slice(2), '--out')).then(value => console.log(JSON.stringify(value))).catch(cliError);
