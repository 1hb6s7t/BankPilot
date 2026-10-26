import { mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, VERSION, save, flag, fail, publicState, cliError } from './shared.mjs';

async function ports() {
  const servers = Array.from({ length: 4 }, () => createServer());
  try {
    await Promise.all(servers.map(server => new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); })));
    const selected = servers.map(server => server.address().port);
    if (selected.some(port => [55432, 8787, 5178].includes(port))) fail('DELIVERY_PORT_INVALID');
    return { db: selected[0], api: selected[1], web: selected[2], control: selected[3] };
  } finally { await Promise.all(servers.map(server => new Promise(done => server.close(done)))); }
}
export async function prepareDelivery(directory, dockerCommand = 'docker') {
  const instanceId = randomBytes(8).toString('hex'), stateDir = resolve(directory ?? resolve(ROOT, '.local', `delivery-${instanceId}`));
  await mkdir(dirname(stateDir), { recursive: true });
  await mkdir(stateDir, { recursive: false, mode: 0o700 }); await mkdir(resolve(stateDir, 'empty-env'), { mode: 0o700 });
  await writeFile(resolve(stateDir, 'compose.env'), '', { mode: 0o600 });
  const selected = await ports(), postgresPassword = randomBytes(24).toString('hex'), projectName = `bankpilot-g8i-${instanceId}`;
  const config = { protocolVersion: VERSION, instanceId, projectName, volumeName: `${projectName}-data`, cookiePrefix: projectName,
    ports: selected, connectionString: `postgres://bankpilot_delivery:${postgresPassword}@127.0.0.1:${selected.db}/bankpilot_delivery`, postgresPassword,
    authSecret: randomBytes(48).toString('hex'), controlToken: randomBytes(32).toString('hex'), webUrl: `http://localhost:${selected.web}`, apiUrl: `http://127.0.0.1:${selected.api}`,
    dockerCommand, mode: 'scripted', model: { baseURL: '', name: '', apiKey: '', outputMode: 'json_object', timeoutMs: 45000, maxAttempts: 2 } };
  const privateConfigPath = resolve(stateDir, 'private.json'), statePath = resolve(stateDir, 'state.json');
  await save(privateConfigPath, config); await save(statePath, publicState(config));
  return { stateDir, statePath, privateConfigPath, webUrl: config.webUrl, apiUrl: config.apiUrl, mode: config.mode };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) prepareDelivery(flag(process.argv.slice(2), '--state-dir'), flag(process.argv.slice(2), '--docker')).then(value => console.log(JSON.stringify(value))).catch(cliError);
