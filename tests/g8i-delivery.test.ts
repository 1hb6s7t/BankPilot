import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cp, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

// Native ESM tooling has no application/DB imports. Exercise the actual exporter and config validator.
const shared = await import(new URL('../scripts/delivery/shared.mjs', import.meta.url).href);
const exporter = await import(new URL('../scripts/delivery/export.mjs', import.meta.url).href);
const preparer = await import(new URL('../scripts/delivery/prepare.mjs', import.meta.url).href);
let temporary: string, pristine: string, privateConfig: any;
let sequence = 0;
async function copy() {
  const destination = resolve(temporary, `copy-${sequence++}`);
  await cp(pristine, destination, { recursive: true });
  return destination;
}
beforeAll(async () => {
  temporary = await mkdtemp(resolve(tmpdir(), 'bankpilot-delivery-unit-'));
  pristine = resolve(temporary, 'pristine');
  await exporter.exportDelivery(pristine);
  const prepared = await preparer.prepareDelivery(resolve(temporary, 'state'));
  privateConfig = await shared.json(prepared.privateConfigPath);
});
afterAll(async () => { if (temporary) await rm(temporary, { recursive: true, force: true }); });

describe('G8I runtime source delivery and private instance configuration', () => {
  it('exports only runtime allowlist, binds README origin, and verifies its pristine directory', async () => {
    const result = await shared.verifyBundle(pristine);
    expect(result).toMatchObject({ sourceVerified: true, pristineExport: true });
    const manifest = await shared.json(resolve(pristine, 'delivery-manifest.json'));
    expect(manifest.files.find((file: any) => file.path === 'README.md').origin).toBe('docs/g8i-clean-delivery.md');
    expect(await readFile(resolve(pristine, 'README.md'), 'utf8')).toBe(await readFile(resolve(pristine, 'docs/g8i-clean-delivery.md'), 'utf8'));
    expect(manifest.files.every((file: any) => shared.allowed(file.path))).toBe(true);
    expect(manifest.files.some((file: any) => /^(evals|tests|node_modules|docs\/evidence)\//.test(file.path) || file.path === '.env')).toBe(false);
    for (const path of shared.REQUIRED_RUNTIME_FILES) expect(manifest.files.some((file: any) => file.path === path)).toBe(true);
  });

  it('detects changed runtime source against its manifest', async () => {
    const directory = await copy();
    await writeFile(resolve(directory, 'apps/api/src/main.ts'), '// changed runtime source\n');
    await expect(shared.verifyBundle(directory)).rejects.toMatchObject({ code: 'DELIVERY_SOURCE_DRIFT' });
  });

  it('rejects a manifest and directory that both omit a required runtime entry', async () => {
    const directory = await copy(), path = resolve(directory, 'delivery-manifest.json');
    const manifest = await shared.json(path);
    manifest.files = manifest.files.filter((file: any) => file.path !== 'apps/api/src/main.ts');
    await shared.save(path, manifest);
    await rm(resolve(directory, 'apps/api/src/main.ts'));
    await expect(shared.verifyBundle(directory)).rejects.toMatchObject({ code: 'DELIVERY_MANIFEST_INCOMPLETE' });
  });

  it('rejects unexpected files including .env without reading their contents', async () => {
    const directory = await copy();
    await writeFile(resolve(directory, '.env'), 'DELIVERY_TEST_CANARY=not-a-real-secret\n');
    await expect(shared.verifyBundle(directory)).rejects.toMatchObject({ code: 'DELIVERY_UNEXPECTED_FILE' });
  });

  it('rejects runtime symlinks during verification and a subsequent export', async () => {
    const directory = await copy();
    await rm(resolve(directory, 'apps/api/src/main.ts'));
    await symlink(resolve(pristine, 'apps/api/src/main.ts'), resolve(directory, 'apps/api/src/main.ts'));
    await expect(shared.verifyBundle(directory)).rejects.toMatchObject({ code: 'DELIVERY_SYMLINK_REJECTED' });
    await expect(exporter.exportDelivery(resolve(temporary, 'symlink-export'), directory)).rejects.toMatchObject({ code: 'DELIVERY_SYMLINK_REJECTED' });
  });

  it('never overwrites an existing delivery or private state directory', async () => {
    await expect(exporter.exportDelivery(pristine)).rejects.toMatchObject({ code: 'EEXIST' });
    await expect(preparer.prepareDelivery(resolve(temporary, 'state'))).rejects.toMatchObject({ code: 'EEXIST' });
    expect((await shared.json(resolve(temporary, 'state/private.json'))).instanceId).toBe(privateConfig.instanceId);
  });

  it.each(['node_modules', '.local', 'apps/web/dist'])('installed verification rejects a symlink at %s', async path => {
    const directory = await copy();
    await symlink(temporary, resolve(directory, path));
    await expect(shared.verifyBundle(directory, { allowGenerated: true })).rejects.toMatchObject({ code: 'DELIVERY_SYMLINK_REJECTED' });
  });

  it('installed verification permits only real generated directories', async () => {
    const directory = await copy();
    await writeFile(resolve(directory, '.local'), 'not a directory');
    await expect(shared.verifyBundle(directory, { allowGenerated: true })).rejects.toMatchObject({ code: 'DELIVERY_GENERATED_DIRECTORY_INVALID' });
    await rm(resolve(directory, '.local'));
    for (const path of ['node_modules', '.local', 'apps/web/dist']) await mkdir(resolve(directory, path));
    expect(await shared.verifyBundle(directory, { allowGenerated: true })).toMatchObject({ sourceVerified: true, pristineExport: false });
  });

  it('generates private random resource bindings and leaves public state free of credentials', async () => {
    expect(shared.validatePrivate(privateConfig)).toBe(privateConfig);
    expect(privateConfig.mode).toBe('scripted');
    expect(privateConfig.model).toMatchObject({ baseURL: '', name: '', apiKey: '' });
    expect(new Set(Object.values(privateConfig.ports)).size).toBe(4);
    expect(Object.values(privateConfig.ports).some(port => [55432, 8787, 5178].includes(port as number))).toBe(false);
    if (process.platform !== 'win32') expect((await lstat(resolve(temporary, 'state/private.json'))).mode & 0o077).toBe(0);
    const state = await readFile(resolve(temporary, 'state/state.json'), 'utf8');
    for (const secret of [privateConfig.connectionString, privateConfig.authSecret, privateConfig.postgresPassword, privateConfig.controlToken]) expect(state).not.toContain(secret);
  });

  it('rejects main-instance cookie prefix, old ports, URL reuse and mismatched volume', () => {
    for (const changed of [
      { ...privateConfig, cookiePrefix: 'bankpilot' },
      { ...privateConfig, ports: { ...privateConfig.ports, db: 55432 } },
      { ...privateConfig, webUrl: 'http://localhost:5178' },
      { ...privateConfig, volumeName: 'bankpilot-data' },
    ]) expect(() => shared.validatePrivate(changed)).toThrow();
  });

  it('scripted ignores host model/loader/Compose configuration and selects its own resources', () => {
    const env = shared.environment(privateConfig, resolve(temporary, 'state'), {
      PATH: '/test/path', BANKPILOT_MODEL_BASE_URL: 'https://host.invalid', BANKPILOT_MODEL_NAME: 'host-model', BANKPILOT_MODEL_API_KEY: 'canary',
      DATABASE_URL: 'host-db-canary', BETTER_AUTH_SECRET: 'host-auth-canary', COMPOSE_FILE: 'host-compose.yaml', COMPOSE_PROJECT_NAME: 'bankpilot',
      DOTENV_CONFIG_PATH: 'host.env', NODE_OPTIONS: '--env-file=host.env', NODE_PATH: '/host/modules',
    });
    expect(env.PATH).toBe('/test/path');
    for (const key of ['BANKPILOT_MODEL_BASE_URL', 'BANKPILOT_MODEL_NAME', 'BANKPILOT_MODEL_API_KEY', 'COMPOSE_FILE', 'COMPOSE_PROJECT_NAME', 'DOTENV_CONFIG_PATH', 'NODE_OPTIONS', 'NODE_PATH']) expect(env).not.toHaveProperty(key);
    expect(env.DATABASE_URL).toBe(privateConfig.connectionString);
    expect(env.BETTER_AUTH_COOKIE_PREFIX).toBe(privateConfig.cookiePrefix);
    expect(env.BANKPILOT_DELIVERY_COMPOSE_ENV).toBe(resolve(temporary, 'state/compose.env'));
    expect(env.BANKPILOT_DELIVERY_ENV_DIR).toBe(resolve(temporary, 'state/empty-env'));
  });

  it('explicit model mode fails closed for incomplete config and uses only the private model selection', () => {
    expect(() => shared.environment({ ...privateConfig, mode: 'model' }, temporary, {})).toThrow('DELIVERY_MODEL_CONFIG_INCOMPLETE');
    const selected = { ...privateConfig, mode: 'model', model: { ...privateConfig.model, baseURL: 'https://explicit.invalid/v1', name: 'explicit-model', apiKey: 'explicit-test-key' } };
    const env = shared.environment(selected, temporary, { BANKPILOT_MODEL_NAME: 'host-model' });
    expect(env.BANKPILOT_MODEL_NAME).toBe('explicit-model');
    expect(env.BANKPILOT_MODEL_BASE_URL).toBe('https://explicit.invalid/v1');
    expect(env.BANKPILOT_MODEL_API_KEY).toBe('explicit-test-key');
    expect(() => shared.validatePrivate({ ...selected, model: { ...selected.model, baseURL: 'https://user:password@explicit.invalid' } })).toThrow('DELIVERY_MODEL_CONFIG_INVALID');
  });
});
