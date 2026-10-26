import { lstat, readdir, readFile, writeFile, rename } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, resolve, relative, sep, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const VERSION = 'bankpilot-local-delivery-v1';
export const FILES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', 'README.md', 'THIRD_PARTY_NOTICES.md',
  '.gitignore', '.env.example', 'apps/web/index.html', 'apps/web/vite.config.ts', 'scripts/setup.ts', 'docs/g8i-clean-delivery.md'];
export const TREES = ['apps/api/src', 'apps/web/src', 'apps/worker/src', 'packages/agents/src', 'packages/contracts/src', 'packages/core/src', 'scripts/delivery', 'delivery'];
export const REQUIRED_RUNTIME_FILES = ['apps/api/src/main.ts', 'apps/api/src/app.ts', 'apps/api/src/config.ts', 'apps/worker/src/main.ts',
  'apps/web/src/main.tsx', 'apps/web/src/App.tsx', 'packages/agents/src/index.ts', 'packages/agents/src/provider.ts',
  'packages/contracts/src/index.ts', 'packages/core/src/index.ts', 'packages/core/src/worker.ts',
  'scripts/delivery/export.mjs', 'scripts/delivery/verify.mjs', 'scripts/delivery/prepare.mjs', 'scripts/delivery/start.mjs',
  'scripts/delivery/shared.mjs', 'delivery/compose.yaml', 'delivery/vite.config.ts'];
const extensions = new Set(['.ts', '.tsx', '.css', '.html', '.svg', '.mjs', '.yaml']);
export function fail(code) { throw Object.assign(new Error(code), { code }); }
export function flag(args, name) { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; }
export const sha256 = value => createHash('sha256').update(value).digest('hex');
async function plainPath(root, path) {
  let current = resolve(root);
  for (const part of path.split('/')) { current = join(current, part); if ((await lstat(current)).isSymbolicLink()) fail('DELIVERY_SYMLINK_REJECTED'); }
}
export async function walk(directory, root = directory) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) fail('DELIVERY_SYMLINK_REJECTED');
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name), stat = await lstat(path);
    if (stat.isSymbolicLink()) fail('DELIVERY_SYMLINK_REJECTED');
    if (stat.isDirectory()) files.push(...await walk(path, root));
    else if (stat.isFile()) files.push(relative(root, path).split(sep).join('/'));
    else fail('DELIVERY_SPECIAL_FILE_REJECTED');
  }
  return files.sort();
}
export function allowed(path) {
  if (path.includes('\\') || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..')) return false;
  if (FILES.includes(path)) return true;
  return TREES.some(tree => path.startsWith(tree + '/')) && !path.split('/').some(part => part.startsWith('.') || ['node_modules', 'dist', 'test-results', 'coverage'].includes(part))
    && extensions.has('.' + path.split('.').pop());
}
export async function sourceFiles(root = ROOT) {
  const paths = [...FILES];
  for (const tree of TREES) for (const file of await walk(resolve(root, tree))) paths.push(`${tree}/${file}`);
  const unique = [...new Set(paths)].sort();
  for (const path of unique) {
    await plainPath(root, path);
    const info = await lstat(resolve(root, path));
    if (!allowed(path) || !info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024) fail('DELIVERY_SOURCE_NOT_ALLOWED');
  }
  return unique;
}
export async function json(path) { return JSON.parse(await readFile(path, 'utf8')); }
export async function save(path, value, mode = 0o600) {
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode });
  await rename(temporary, path);
}
export async function verifyBundle(root, { allowGenerated = false } = {}) {
  const manifest = await json(resolve(root, 'delivery-manifest.json'));
  if (manifest.protocolVersion !== VERSION || !Array.isArray(manifest.files) || !manifest.files.length) fail('DELIVERY_MANIFEST_INVALID');
  const seen = new Set();
  for (const item of manifest.files) {
    if (!allowed(item.path) || seen.has(item.path) || !/^[a-f0-9]{64}$/.test(item.sha256)) fail('DELIVERY_MANIFEST_INVALID');
    await plainPath(root, item.path);
    seen.add(item.path);
    const info = await lstat(resolve(root, item.path));
    if (!info.isFile() || info.isSymbolicLink() || info.size !== item.bytes || sha256(await readFile(resolve(root, item.path))) !== item.sha256) fail('DELIVERY_SOURCE_DRIFT');
  }
  for (const required of [...FILES, ...REQUIRED_RUNTIME_FILES]) if (!seen.has(required)) fail('DELIVERY_MANIFEST_INCOMPLETE');
  // Dependencies/build/state are created only after export; they are not distributable source.
  const inspect = async (directory, prefix = '') => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix + entry.name;
      const info = await lstat(join(directory, entry.name));
      if (info.isSymbolicLink()) fail('DELIVERY_SYMLINK_REJECTED');
      if (allowGenerated && ['node_modules', '.local', 'apps/web/dist'].includes(path)) {
        if (!info.isDirectory()) fail('DELIVERY_GENERATED_DIRECTORY_INVALID');
        continue;
      }
      if (info.isDirectory()) await inspect(join(directory, entry.name), path + '/');
      else if (path !== 'delivery-manifest.json' && !seen.has(path)) fail('DELIVERY_UNEXPECTED_FILE');
    }
  };
  await inspect(root);
  return { protocolVersion: VERSION, fileCount: seen.size, manifestSha256: sha256(await readFile(resolve(root, 'delivery-manifest.json'))), sourceVerified: true, pristineExport: !allowGenerated };
}
export function validatePrivate(config) {
  if (config.protocolVersion !== VERSION || !/^[a-f0-9]{16}$/.test(config.instanceId)) fail('DELIVERY_INSTANCE_INVALID');
  const id = config.instanceId;
  if (config.projectName !== `bankpilot-g8i-${id}` || config.volumeName !== `${config.projectName}-data` || config.cookiePrefix !== `bankpilot-g8i-${id}`) fail('DELIVERY_RESOURCE_BINDING_INVALID');
  const ports = Object.values(config.ports ?? {});
  if (ports.length !== 4 || new Set(ports).size !== 4 || ports.some(port => !Number.isSafeInteger(port) || port < 1024 || port > 65535 || [55432, 8787, 5178].includes(port))) fail('DELIVERY_PORT_INVALID');
  if (!/^[a-f0-9]{96}$/.test(config.authSecret) || !/^[a-f0-9]{48}$/.test(config.postgresPassword) || !/^[a-f0-9]{64}$/.test(config.controlToken)) fail('DELIVERY_SECRET_INVALID');
  if (config.connectionString !== `postgres://bankpilot_delivery:${config.postgresPassword}@127.0.0.1:${config.ports.db}/bankpilot_delivery`
    || config.webUrl !== `http://localhost:${config.ports.web}` || config.apiUrl !== `http://127.0.0.1:${config.ports.api}`) fail('DELIVERY_ORIGIN_BINDING_INVALID');
  if (!['scripted', 'model'].includes(config.mode)) fail('DELIVERY_MODE_INVALID');
  if (config.mode === 'model') {
    const model = config.model;
    if (!model || ![model.baseURL, model.name, model.apiKey].every(value => typeof value === 'string' && value.trim())) fail('DELIVERY_MODEL_CONFIG_INCOMPLETE');
    let url; try { url = new URL(model.baseURL); } catch { fail('DELIVERY_MODEL_CONFIG_INVALID'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || !['json_object', 'tools'].includes(model.outputMode)
      || !Number.isSafeInteger(model.timeoutMs) || model.timeoutMs < 1 || model.timeoutMs > 60000 || ![1, 2, 3].includes(model.maxAttempts)) fail('DELIVERY_MODEL_CONFIG_INVALID');
  }
  if (typeof config.dockerCommand !== 'string' || !config.dockerCommand.trim()) fail('DELIVERY_DOCKER_COMMAND_INVALID');
  return config;
}
export function environment(config, stateDir, inherited = process.env) {
  validatePrivate(config);
  const env = { ...inherited };
  for (const key of Object.keys(env)) if (key.startsWith('BANKPILOT_MODEL_') || key.startsWith('COMPOSE_') || key.startsWith('DOTENV_') || ['NODE_OPTIONS', 'NODE_PATH'].includes(key)) delete env[key];
  Object.assign(env, { DATABASE_URL: config.connectionString, BETTER_AUTH_SECRET: config.authSecret, BETTER_AUTH_URL: config.webUrl,
    BETTER_AUTH_COOKIE_PREFIX: config.cookiePrefix, WEB_ORIGIN: config.webUrl, WEBAUTHN_RP_ID: 'localhost', API_PORT: String(config.ports.api), SANDBOX_ENABLED: 'true',
    BANKPILOT_CHECKPOINT_SCHEMA: 'bankpilot_checkpoints', BANKPILOT_CHECKPOINT_RECOVERY: 'false',
    BANKPILOT_DELIVERY_INSTANCE: config.instanceId, BANKPILOT_DELIVERY_PASSWORD: config.postgresPassword, BANKPILOT_DELIVERY_VOLUME: config.volumeName,
    BANKPILOT_DELIVERY_DB_PORT: String(config.ports.db), BANKPILOT_DELIVERY_API_PORT: String(config.ports.api), BANKPILOT_DELIVERY_WEB_PORT: String(config.ports.web),
    BANKPILOT_DELIVERY_ENV_DIR: resolve(stateDir, 'empty-env'), BANKPILOT_DELIVERY_COMPOSE_ENV: resolve(stateDir, 'compose.env'), NODE_ENV: 'development' });
  if (config.mode === 'model') Object.assign(env, { BANKPILOT_MODEL_BASE_URL: config.model.baseURL, BANKPILOT_MODEL_NAME: config.model.name,
    BANKPILOT_MODEL_API_KEY: config.model.apiKey, BANKPILOT_MODEL_OUTPUT_MODE: config.model.outputMode, BANKPILOT_MODEL_TIMEOUT_MS: String(config.model.timeoutMs), BANKPILOT_MODEL_MAX_ATTEMPTS: String(config.model.maxAttempts) });
  return env;
}
export function publicState(config, extra = {}) {
  return { protocolVersion: VERSION, instanceId: config.instanceId, projectName: config.projectName, volumeName: config.volumeName,
    mode: config.mode, webUrl: config.webUrl, apiUrl: config.apiUrl, ports: config.ports, ready: false, ...extra };
}
export function cliError(error) { console.error(JSON.stringify({ type: 'error', code: typeof error?.code === 'string' && /^DELIVERY_[A-Z_]+$/.test(error.code) ? error.code : 'DELIVERY_OPERATION_FAILED' })); process.exitCode = 1; }
