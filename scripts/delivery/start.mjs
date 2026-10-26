import { spawn } from 'node:child_process';
import { access, lstat, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, json, save, fail, flag, validatePrivate, environment, publicState, verifyBundle, cliError } from './shared.mjs';

const sleep = milliseconds => new Promise(done => setTimeout(done, milliseconds));
async function until(check, milliseconds, code) {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) { if (await check()) return; await sleep(200); }
  fail(code);
}
function command(binary, args, env, capture = false) {
  return new Promise((done, reject) => {
    const child = spawn(binary, args, { cwd: ROOT, env, stdio: capture ? ['ignore', 'pipe', 'ignore'] : 'inherit' });
    let output = ''; if (capture) child.stdout.on('data', value => { output += value; });
    child.once('error', () => reject(Object.assign(new Error(), { code: 'DELIVERY_COMMAND_FAILED' })));
    child.once('exit', code => code === 0 ? done(output.trim()) : reject(Object.assign(new Error(), { code: 'DELIVERY_COMMAND_FAILED' })));
  });
}
function operations(config, env) {
  const composeArgs = ['compose', '--env-file', env.BANKPILOT_DELIVERY_COMPOSE_ENV, '--project-name', config.projectName, '--file', resolve(ROOT, 'delivery/compose.yaml')];
  const docker = (args, capture = true) => command(config.dockerCommand, args, env, capture);
  const compose = (...args) => command(config.dockerCommand, [...composeArgs, ...args], env);
  async function owned() {
    const ids = await docker(['ps', '--all', '--quiet', '--filter', `label=com.docker.compose.project=${config.projectName}`]);
    for (const id of ids.split(/\s+/).filter(Boolean)) {
      const label = await docker(['inspect', '--format', '{{ index .Config.Labels "bankpilot.delivery.instance" }}', id]);
      if (label !== config.instanceId) fail('DELIVERY_CONTAINER_OWNER_MISMATCH');
    }
    const volumes = await docker(['volume', 'ls', '--quiet', '--filter', `name=^${config.volumeName}$`]);
    if (volumes) {
      const label = await docker(['volume', 'inspect', '--format', '{{ index .Labels "bankpilot.delivery.instance" }}', config.volumeName]);
      if (label !== config.instanceId) fail('DELIVERY_VOLUME_OWNER_MISMATCH');
    }
  }
  async function cleaned(destroy) {
    const ids = await docker(['ps', '--all', '--quiet', '--filter', `label=com.docker.compose.project=${config.projectName}`]);
    if (ids) fail('DELIVERY_CONTAINER_CLEANUP_INCOMPLETE');
    const volumes = await docker(['volume', 'ls', '--quiet', '--filter', `name=^${config.volumeName}$`]);
    if (destroy && volumes) fail('DELIVERY_VOLUME_CLEANUP_INCOMPLETE');
    return { containersRemoved: true, volumeRemoved: destroy ? !volumes : false, volumeRetained: Boolean(volumes) };
  }
  return { docker, compose, owned, cleaned };
}
async function load(directory) {
  if (!directory) fail('DELIVERY_STATE_DIRECTORY_REQUIRED');
  const stateDir = resolve(directory), privatePath = resolve(stateDir, 'private.json');
  const directoryInfo = await lstat(stateDir);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) fail('DELIVERY_STATE_DIRECTORY_INVALID');
  const info = await lstat(privatePath);
  if (!info.isFile() || info.isSymbolicLink() || (process.platform !== 'win32' && (info.mode & 0o077))) fail('DELIVERY_PRIVATE_FILE_PERMISSIONS');
  const config = validatePrivate(await json(privatePath));
  const composeEnv = resolve(stateDir, 'compose.env'), envDirectory = resolve(stateDir, 'empty-env');
  const [composeInfo, envInfo] = await Promise.all([lstat(composeEnv), lstat(envDirectory)]);
  if (!composeInfo.isFile() || composeInfo.isSymbolicLink() || composeInfo.size !== 0 || !envInfo.isDirectory() || envInfo.isSymbolicLink()
    || (await readdir(envDirectory)).length) fail('DELIVERY_ENV_DIRECTORY_NOT_EMPTY');
  return { stateDir, config, env: environment(config, stateDir), statePath: resolve(stateDir, 'state.json') };
}
export async function stopDelivery(directory, destroy = false) {
  const { stateDir, config, env, statePath } = await load(directory);
  const state = await json(statePath);
  if (state.instanceId !== config.instanceId) fail('DELIVERY_STATE_BINDING_INVALID');
  const ops = operations(config, env);
  if (state.ready) {
    let response;
    try { response = await fetch(`http://127.0.0.1:${config.ports.control}/stop`, { method: 'POST', signal: AbortSignal.timeout(5000),
      headers: { Authorization: `Bearer ${config.controlToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ destroy }) }); }
    catch { fail('DELIVERY_CONTROL_UNAVAILABLE'); }
    if (!response.ok) fail('DELIVERY_CONTROL_REJECTED');
    await until(async () => (await json(statePath)).lifecycle === 'stopped', 200000, 'DELIVERY_STOP_TIMEOUT');
    const stopped = await json(statePath);
    if (stopped.cleanup?.success !== true) fail('DELIVERY_STOP_INCOMPLETE');
    return { type: destroy ? 'destroyed' : 'stopped', stateDir, statePath, volumeRetained: !destroy };
  }
  if (state.lifecycle === 'starting' || state.lifecycle === 'stopping') fail('DELIVERY_NOT_READY');
  await ops.owned(); await ops.compose('down', ...(destroy ? ['--volumes'] : []));
  const resources = await ops.cleaned(destroy);
  await save(statePath, publicState(config, { lifecycle: 'stopped', cleanup: { success: true, ...resources }, stoppedAtUtc: new Date().toISOString() }));
  return { type: destroy ? 'destroyed' : 'stopped', stateDir, statePath, volumeRetained: !destroy };
}
export async function startDelivery(directory) {
  const { stateDir, config, env, statePath } = await load(directory);
  if (Number(process.versions.node.split('.')[0]) < 24) fail('DELIVERY_NODE_VERSION_UNSUPPORTED');
  // Only a real local install qualifies; never resolve packages from an ancestor checkout.
  const dependencyDirectory = await lstat(resolve(ROOT, 'node_modules'));
  if (!dependencyDirectory.isDirectory() || dependencyDirectory.isSymbolicLink()) fail('DELIVERY_LOCAL_DEPENDENCIES_REQUIRED');
  for (const file of ['node_modules/tsx/package.json', 'node_modules/vite/package.json', 'node_modules/pg/package.json']) await access(resolve(ROOT, file));
  const manifest = await verifyBundle(ROOT, { allowGenerated: true });
  const previous = await json(statePath);
  if (['starting', 'stopping'].includes(previous.lifecycle) || previous.ready) fail('DELIVERY_ALREADY_RUNNING');
  const ops = operations(config, env); await ops.owned();
  const children = []; let stopping = false, shutdownPromise, provisioning, control;
  const liveState = extra => publicState(config, { lifecycle: 'starting', pid: process.pid, nodeVersion: process.version,
    source: manifest, childPids: children.map(entry => ({ role: entry.role, pid: entry.child.pid })), ...extra });
  const writeState = extra => save(statePath, liveState(extra));
  async function shutdown(destroy = false) {
    if (shutdownPromise) return shutdownPromise;
    stopping = true;
    shutdownPromise = (async () => {
      const errors = [];
      await writeState({ lifecycle: 'stopping' });
      for (const entry of children) if (!entry.exited) entry.child.kill('SIGTERM');
      const exits = children.map(async entry => {
        if (!entry.exited) {
          let timer;
          await Promise.race([entry.exit, new Promise(done => { timer = setTimeout(() => { errors.push('DELIVERY_CHILD_STOP_TIMEOUT'); entry.child.kill('SIGKILL'); done(); }, 190000); })]);
          clearTimeout(timer); await entry.exit;
        }
      });
      await Promise.allSettled(exits); await provisioning?.catch(() => {});
      if (control?.listening) await new Promise(done => control.close(done));
      let resources;
      try { await ops.owned(); await ops.compose('down', ...(destroy ? ['--volumes'] : [])); resources = await ops.cleaned(destroy); }
      catch { errors.push('DELIVERY_COMPOSE_CLEANUP_FAILED'); }
      await writeState({ lifecycle: 'stopped', ready: false, stoppedAtUtc: new Date().toISOString(), cleanup: { success: errors.length === 0, childrenStopped: children.every(entry => entry.exited), ...resources, errors } });
      console.log(JSON.stringify({ type: 'stopped', statePath, volumeRetained: !destroy, errors }));
    })();
    return shutdownPromise;
  }
  const signal = () => { void shutdown().catch(cliError); };
  const launch = (role, args) => {
    if (stopping) fail('DELIVERY_START_CANCELLED');
    const child = spawn(process.execPath, args, { cwd: ROOT, env, stdio: 'inherit' });
    const entry = { child, role, exited: false, exit: undefined };
    entry.exit = new Promise(done => {
      child.once('error', () => { entry.exited = true; done({ code: 1 }); });
      child.once('exit', (code, exitSignal) => { entry.exited = true; done({ code, signal: exitSignal }); });
    });
    children.push(entry); return entry;
  };
  process.once('SIGINT', signal); process.once('SIGTERM', signal);
  try {
    await writeState();
    provisioning = ops.compose('up', '-d', '--wait'); await provisioning;
    if (stopping) fail('DELIVERY_START_CANCELLED');
    const setup = launch('setup', ['--import', 'tsx', 'scripts/setup.ts']);
    if ((await setup.exit).code !== 0) fail('DELIVERY_SETUP_FAILED');
    const api = launch('api', ['--import', 'tsx', 'apps/api/src/main.ts']);
    const worker = launch('worker', ['--import', 'tsx', 'apps/worker/src/main.ts']);
    const web = launch('web', ['node_modules/vite/bin/vite.js', '--config', 'delivery/vite.config.ts']);
    await until(async () => {
      if (stopping || [api, worker, web].some(entry => entry.exited)) fail('DELIVERY_SERVICE_START_FAILED');
      try {
        const response = await fetch(config.webUrl + '/api/health', { signal: AbortSignal.timeout(1500) });
        const health = await response.json(); return response.ok && health.status === 'ok' && health.mode === config.mode;
      } catch { return false; }
    }, 60000, 'DELIVERY_READINESS_TIMEOUT');
    control = createServer(async (request, response) => {
      if (request.method !== 'POST' || request.url !== '/stop' || request.headers.authorization !== `Bearer ${config.controlToken}`) { response.writeHead(403).end(); return; }
      let body = ''; for await (const chunk of request) { body += chunk; if (body.length > 1000) { response.writeHead(400).end(); return; } }
      let destroy; try { destroy = JSON.parse(body).destroy === true; } catch { response.writeHead(400).end(); return; }
      response.writeHead(202, { 'Content-Type': 'application/json' }).end('{"accepted":true}');
      void shutdown(destroy).catch(cliError);
    });
    await new Promise((done, reject) => { control.once('error', reject); control.listen(config.ports.control, '127.0.0.1', done); });
    await writeState({ ready: true, lifecycle: 'ready', startedAtUtc: new Date().toISOString() });
    console.log(JSON.stringify({ type: 'ready', statePath, webUrl: config.webUrl, apiUrl: config.apiUrl, mode: config.mode }));
    await Promise.race([api.exit, worker.exit, web.exit]);
    if (!stopping) { process.exitCode = 1; console.error('{"type":"error","code":"DELIVERY_SERVICE_EXITED"}'); }
    await shutdown();
  } catch (error) { await shutdown(); throw error; }
  finally { process.removeListener('SIGINT', signal); process.removeListener('SIGTERM', signal); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), directory = flag(args, '--state-dir');
  (args.includes('--stop') || args.includes('--destroy') ? stopDelivery(directory, args.includes('--destroy')).then(value => console.log(JSON.stringify(value))) : startDelivery(directory)).catch(cliError);
}
