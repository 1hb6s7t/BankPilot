import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getMigrations } from 'better-auth/db/migration';
import { Client, Pool } from 'pg';
import { createAuth } from '../apps/api/src/config.js';

// This entry point intentionally never reads .env or calls scripts/setup.ts.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evidenceRoot = join(repoRoot, 'docs', 'evidence');
const defaultAdminUrl = 'postgres://bankpilot:bankpilot-local@127.0.0.1:55432/postgres';
const databasePrefix = 'bp_g9g_test_';
const args = process.argv.slice(2);
const CONNECT_TIMEOUT_MS = 10_000;
const QUERY_TIMEOUT_MS = 15_000;
const MIGRATION_TIMEOUT_MS = 60_000;
const CLOSE_TIMEOUT_MS = 5_000;
const GROUP_TERM_GRACE_MS = 4_000;
const GROUP_KILL_WAIT_MS = 4_000;

type GroupCleanup = { checked: boolean; termSent: boolean; killSent: boolean; gone: boolean; errorCode?: string };
const delay = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
function groupAlive(pid: number): boolean {
  try { process.kill(-pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true;
    throw error;
  }
}
function signalGroup(pid: number, signal: NodeJS.Signals): boolean {
  try { process.kill(-pid, signal); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}
async function waitForGroupGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (!groupAlive(pid)) return true;
    await delay(Math.min(50, Math.max(1, deadline - Date.now())));
  } while (Date.now() < deadline);
  return !groupAlive(pid);
}
async function drainOwnedGroup(pid: number): Promise<GroupCleanup> {
  const outcome: GroupCleanup = { checked: true, termSent: false, killSent: false, gone: false };
  try {
    if (!groupAlive(pid)) { outcome.gone = true; return outcome; }
    outcome.termSent = signalGroup(pid, 'SIGTERM');
    if (await waitForGroupGone(pid, GROUP_TERM_GRACE_MS)) { outcome.gone = true; return outcome; }
    outcome.killSent = signalGroup(pid, 'SIGKILL');
    outcome.gone = await waitForGroupGone(pid, GROUP_KILL_WAIT_MS);
    if (!outcome.gone) outcome.errorCode = 'PROCESS_GROUP_NOT_DRAINED';
  } catch { outcome.errorCode = 'PROCESS_GROUP_CHECK_FAILED'; }
  return outcome;
}
async function bounded<T>(operation: Promise<T>, timeoutMs: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(code), { code })), timeoutMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
function dbClient(url: string): Client {
  return new Client({ connectionString: url, connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS, statement_timeout: QUERY_TIMEOUT_MS, lock_timeout: QUERY_TIMEOUT_MS });
}
const childEnvironmentKeys = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP',
  'LANG', 'TERM', 'COLORTERM', 'FORCE_COLOR', 'NO_COLOR', 'CI', 'TZ',
  'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'LC_TIME', 'LC_NUMERIC', 'LC_COLLATE', 'LC_MONETARY',
  'LC_PAPER', 'LC_NAME', 'LC_ADDRESS', 'LC_TELEPHONE', 'LC_MEASUREMENT', 'LC_IDENTIFICATION']);
function childEnvironment(targetUrl: URL): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (childEnvironmentKeys.has(key) && value !== undefined) env[key] = value;
  }
  env.TEST_DATABASE_URL = targetUrl.toString();
  env.BANKPILOT_TEST_DATABASE_URL = targetUrl.toString();
  env.DATABASE_URL = targetUrl.toString();
  return env;
}

if (args.length === 1 && args[0] === '--probe-owned-group') {
  // A pure process probe: the detached leader exits while its child ignores TERM.
  const grandchild = "process.on('SIGTERM',()=>{});process.stdout.write('READY\\n');setInterval(()=>{},1000)";
  const leader = `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:['ignore','pipe','ignore']});c.stdout.once('data',()=>{process.stdout.write(String(c.pid)+'\\n');process.exit(0)});`;
  const probe = spawn(process.execPath, ['-e', leader], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  let output = '';
  probe.stdout?.on('data', chunk => { output += chunk.toString(); });
  let descendantPid = 0;
  let cleanup: GroupCleanup = { checked: false, termSent: false, killSent: false, gone: false };
  try {
    await bounded(new Promise<void>((done, reject) => {
      probe.once('error', reject);
      probe.once('close', () => done());
    }), 5_000, 'PROBE_LEADER_TIMEOUT');
    descendantPid = Number(output.trim());
  } finally { if (probe.pid) cleanup = await drainOwnedGroup(probe.pid); }
  if (!probe.pid || !Number.isSafeInteger(descendantPid) || descendantPid <= 0) throw new Error('PROBE_DESCENDANT_NOT_READY');
  console.log(JSON.stringify({ probe: 'owned-process-group', leaderExited: true, descendantWasRunning: true,
    termSent: cleanup.termSent, killSent: cleanup.killSent, groupGone: cleanup.gone }));
  if (!cleanup.gone || !cleanup.killSent) process.exitCode = 1;
} else if (args.length === 1 && args[0] === '--probe-child-environment') {
  const env = childEnvironment(new URL('postgres://probe:probe@127.0.0.1:55432/bp_g9g_test_probe'));
  const keys = Object.keys(env).sort();
  const forbidden = keys.filter(key => !childEnvironmentKeys.has(key)
    && !['TEST_DATABASE_URL', 'BANKPILOT_TEST_DATABASE_URL', 'DATABASE_URL'].includes(key));
  const leakedCanaries = ['AWS_SECRET_ACCESS_KEY', 'PGPASSWORD', 'GITHUB_PAT', 'BANKPILOT_MODEL_API_KEY',
    'BANKPILOT_G9F_LIVE', 'LC_API_KEY'].filter(key => key in env);
  console.log(JSON.stringify({ probe: 'child-environment', forbiddenKeys: forbidden,
    leakedCanaries, databaseVariables: ['TEST_DATABASE_URL', 'BANKPILOT_TEST_DATABASE_URL', 'DATABASE_URL'].every(key => key in env) }));
  if (forbidden.length || leakedCanaries.length) process.exitCode = 1;
} else {

if (args.includes('--help')) {
  if (args.length !== 1) throw new Error('Use --help by itself.');
  console.log('Usage: pnpm test:isolated [--browser | --browser-live-subscription] [--dry-run]');
  process.exit(0);
}
if (args.some(arg => !['--dry-run', '--browser', '--browser-live-subscription'].includes(arg)) || new Set(args).size !== args.length) throw new Error('Only registered isolated modes and --dry-run are supported, once each.');
const dryRun = args.includes('--dry-run');
const browserSuite = args.includes('--browser');
const liveSubscriptionSuite = args.includes('--browser-live-subscription');
if (browserSuite && liveSubscriptionSuite) throw new Error('Controlled and live browser modes are mutually exclusive.');
// Only this explicit mode loads the existing cloud config. Default and --browser
// continue to strip model credentials and inherited live flags from their child.
const childArgs = liveSubscriptionSuite ? ['exec', 'playwright', 'test', '--config', 'playwright.g9f-live.config.ts']
  : browserSuite ? ['exec', 'playwright', 'test', '--config', 'playwright.g9h.config.ts'] : ['check'];
const childCommand = ['pnpm', ...childArgs].join(' ');

function localAdminUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('BANKPILOT_TEST_ADMIN_URL must be a PostgreSQL URL.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('The admin URL must use postgres:// or postgresql://.');
  if (url.hostname !== '127.0.0.1' || url.port !== '55432') throw new Error('The admin URL must target 127.0.0.1:55432; external hosts and other local PostgreSQL instances are refused.');
  if (!url.username || !url.pathname || url.pathname === '/' || url.search || url.hash) throw new Error('The admin URL needs a role and database, without query parameters or fragments.');
  if (decodeURIComponent(url.pathname.slice(1)).startsWith(databasePrefix)) throw new Error('The admin URL cannot target an isolated test database.');
  return url;
}

const adminUrl = localAdminUrl(process.env.BANKPILOT_TEST_ADMIN_URL ?? defaultAdminUrl);
const adminDatabase = decodeURIComponent(adminUrl.pathname.slice(1));
const adminRole = decodeURIComponent(adminUrl.username);
if (dryRun) {
  console.log(JSON.stringify({ dryRun: true, databaseCreated: false, databaseConnected: false,
    adminHost: adminUrl.hostname, adminPort: Number(adminUrl.port), adminDatabase, adminRole,
    databaseNamePattern: `${databasePrefix}<random UUID>`, childCommand, cloudModelOptIn: liveSubscriptionSuite,
    childDatabaseVariables: ['TEST_DATABASE_URL', 'BANKPILOT_TEST_DATABASE_URL', 'DATABASE_URL'],
    initialization: 'Better Auth getMigrations/runMigrations only; no demo seed',
    cleanup: 'OID-and-owner-checked DROP DATABASE of this invocation only' }, null, 2));
  process.exit(0);
}

const runId = randomUUID();
const databaseName = `${databasePrefix}${runId.replaceAll('-', '')}`;
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${databaseName}`;
const runDirectory = join(evidenceRoot, `g9g-isolated-test-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}-${runId}`);
mkdirSync(runDirectory, { mode: 0o700 });
chmodSync(runDirectory, 0o700);

function writeJson(name: string, value: unknown): void {
  const target = join(runDirectory, name);
  const temporary = `${target}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
    for (let offset = 0; offset < bytes.length;) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset);
      if (written <= 0) throw new Error('Evidence write did not advance.');
      offset += written;
    }
    fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(temporary, target);
  const directoryFd = openSync(runDirectory, 'r');
  try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
}

type Manifest = {
  version: 1; runId: string; createdAtUtc: string; updatedAtUtc: string; stage: string;
  admin: { host: string; port: number; database: string; role: string };
  database: { name: string; createIssued: boolean; created: boolean; oid?: number; owner?: string };
  initialization: string; child: { command: string; startedAtUtc?: string; endedAtUtc?: string; exitCode?: number | null; signal?: string | null; group?: GroupCleanup };
  interruptedBy?: string; failure?: { stage: string; name: string; code?: string }; cleanup?: { attempted: boolean; dropped: boolean; verifiedAbsent: boolean; identityMatched: boolean; errorCode?: string }; exitCode?: number;
};
const manifest: Manifest = {
  version: 1, runId, createdAtUtc: new Date().toISOString(), updatedAtUtc: new Date().toISOString(), stage: 'prepared',
  admin: { host: adminUrl.hostname, port: Number(adminUrl.port), database: adminDatabase, role: adminRole },
  database: { name: databaseName, createIssued: false, created: false },
  initialization: 'Better Auth getMigrations/runMigrations; no setup.ts, API migration, user, account, or demo seed',
  child: { command: childCommand },
};
function persist(stage: string): void { manifest.stage = stage; manifest.updatedAtUtc = new Date().toISOString(); writeJson('manifest.json', manifest); }
persist('prepared');

let child: ChildProcess | undefined;
let admin: Client | undefined;
let adminClosed = true;
let testPool: Pool | undefined;
let testPoolClosed = true;
let migrationSettled = true;
let interruptedBy: 'SIGINT' | 'SIGTERM' | undefined;
let killTimer: ReturnType<typeof setTimeout> | undefined;
const stopChild = () => {
  if (child?.pid) {
    try { signalGroup(child.pid, 'SIGTERM'); } catch { /* final group verification decides whether cleanup is safe */ }
    killTimer = setTimeout(() => {
      if (child?.pid) try { if (groupAlive(child.pid)) signalGroup(child.pid, 'SIGKILL'); } catch { /* final verification records failure */ }
    }, GROUP_TERM_GRACE_MS);
  }
};
const interrupt = (signal: 'SIGINT' | 'SIGTERM') => {
  if (interruptedBy) return;
  interruptedBy = signal;
  manifest.interruptedBy = signal;
  stopChild();
};
process.on('SIGINT', () => interrupt('SIGINT'));
process.on('SIGTERM', () => interrupt('SIGTERM'));

function failureCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? code : undefined;
}

async function runCheck(): Promise<{ exitCode: number | null; signal: string | null }> {
  manifest.child.startedAtUtc = new Date().toISOString();
  persist('check_running');
  return new Promise((resolvePromise, rejectPromise) => {
    const env = childEnvironment(testUrl);
    if (browserSuite) env.BANKPILOT_G9H_EVIDENCE_DIR = join(runDirectory, 'browser');
    if (liveSubscriptionSuite) env.BANKPILOT_G9F_LIVE_EVIDENCE_DIR = join(runDirectory, 'browser');
    child = spawn('pnpm', childArgs, { cwd: repoRoot, env, stdio: 'inherit', detached: true, shell: false });
    child.once('error', rejectPromise);
    child.once('close', (exitCode, signal) => resolvePromise({ exitCode, signal }));
    if (interruptedBy) stopChild();
  });
}

async function verifiedDrop(): Promise<NonNullable<Manifest['cleanup']>> {
  const result: NonNullable<Manifest['cleanup']> = { attempted: false, dropped: false, verifiedAbsent: false, identityMatched: false };
  if (!manifest.database.created || !manifest.database.oid || !manifest.database.owner) return result;
  if (manifest.child.group?.gone === false) { result.errorCode = 'PROCESS_GROUP_NOT_DRAINED'; return result; }
  if (!testPoolClosed || !migrationSettled) { result.errorCode = 'DB_WORK_UNSETTLED'; return result; }
  result.attempted = true;
  let dropClient: Client | undefined;
  try {
    dropClient = dbClient(adminUrl.toString());
    await bounded(dropClient.connect(), CONNECT_TIMEOUT_MS, 'CLEANUP_CONNECT_TIMEOUT');
    const identity = await bounded(dropClient.query<{ oid: number; owner: string }>('SELECT oid, pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=$1', [databaseName]), QUERY_TIMEOUT_MS, 'CLEANUP_QUERY_TIMEOUT');
    const row = identity.rows[0];
    if (!row || Number(row.oid) !== manifest.database.oid || row.owner !== manifest.database.owner) {
      result.errorCode = 'DB_IDENTITY_MISMATCH';
      return result;
    }
    result.identityMatched = true;
    const sessions = await bounded(dropClient.query<{ active: string }>('SELECT count(*)::text AS active FROM pg_stat_activity WHERE datname=$1', [databaseName]), QUERY_TIMEOUT_MS, 'CLEANUP_SESSIONS_TIMEOUT');
    if (Number(sessions.rows[0]?.active ?? -1) !== 0) { result.errorCode = 'DB_CONNECTIONS_REMAIN'; return result; }
    await bounded(dropClient.query(`DROP DATABASE "${databaseName}"`), QUERY_TIMEOUT_MS, 'CLEANUP_DROP_TIMEOUT');
    result.dropped = true;
    const after = await bounded(dropClient.query('SELECT oid FROM pg_database WHERE datname=$1', [databaseName]), QUERY_TIMEOUT_MS, 'CLEANUP_VERIFY_TIMEOUT');
    result.verifiedAbsent = after.rowCount === 0;
    if (!result.verifiedAbsent) result.errorCode = 'DROP_NOT_VERIFIED';
  } catch (error) { result.errorCode = failureCode(error) ?? 'CLEANUP_FAILED'; }
  finally {
    if (dropClient) await bounded(dropClient.end(), CLOSE_TIMEOUT_MS, 'CLEANUP_CLOSE_TIMEOUT')
      .catch(() => { result.errorCode ??= 'CLEANUP_CLOSE_TIMEOUT'; });
  }
  return result;
}

let exitCode = 1;
try {
  admin = dbClient(adminUrl.toString());
  adminClosed = false;
  await bounded(admin.connect(), CONNECT_TIMEOUT_MS, 'ADMIN_CONNECT_TIMEOUT');
  const session = await bounded(admin.query<{ current_database: string; current_user: string }>('SELECT current_database(), current_user'), QUERY_TIMEOUT_MS, 'ADMIN_QUERY_TIMEOUT');
  if (session.rows[0]?.current_database !== adminDatabase || session.rows[0]?.current_user !== adminRole) throw new Error('Admin connection identity mismatch.');
  if (interruptedBy) throw new Error('Interrupted before database creation.');
  const existing = await bounded(admin.query('SELECT oid FROM pg_database WHERE datname=$1', [databaseName]), QUERY_TIMEOUT_MS, 'ADMIN_QUERY_TIMEOUT');
  if (existing.rowCount !== 0) throw new Error('Generated database name already exists.');
  manifest.database.createIssued = true;
  persist('database_create_issued');
  await bounded(admin.query(`CREATE DATABASE "${databaseName}"`), QUERY_TIMEOUT_MS, 'DATABASE_CREATE_TIMEOUT');
  manifest.database.created = true;
  const identity = await bounded(admin.query<{ oid: number; owner: string }>('SELECT oid, pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=$1', [databaseName]), QUERY_TIMEOUT_MS, 'ADMIN_QUERY_TIMEOUT');
  if (!identity.rows[0] || identity.rows[0].owner !== adminRole) throw new Error('Created database ownership mismatch.');
  manifest.database.oid = Number(identity.rows[0].oid);
  manifest.database.owner = identity.rows[0].owner;
  persist('database_created');
  if (interruptedBy) throw new Error('Interrupted before migrations.');

  testPool = new Pool({ connectionString: testUrl.toString(), max: 4,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS, query_timeout: QUERY_TIMEOUT_MS,
    statement_timeout: QUERY_TIMEOUT_MS, lock_timeout: QUERY_TIMEOUT_MS });
  testPoolClosed = false;
  const previousSecret = process.env.BETTER_AUTH_SECRET;
  process.env.BETTER_AUTH_SECRET = `g9g-isolated-${randomBytes(32).toString('hex')}`;
  try {
    const auth = createAuth(testPool);
    const migration = await bounded(getMigrations(auth.options), QUERY_TIMEOUT_MS, 'AUTH_MIGRATION_PLAN_TIMEOUT');
    migrationSettled = false;
    const migrationRun = migration.runMigrations();
    void migrationRun.finally(() => { migrationSettled = true; }).catch(() => undefined);
    await bounded(migrationRun, MIGRATION_TIMEOUT_MS, 'AUTH_MIGRATION_TIMEOUT');
  } finally {
    if (previousSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = previousSecret;
  }
  await bounded(testPool.end(), CLOSE_TIMEOUT_MS, 'AUTH_POOL_CLOSE_TIMEOUT');
  testPoolClosed = true;
  testPool = undefined;
  persist('auth_tables_ready');
  if (interruptedBy) throw new Error('Interrupted before check.');

  const result = await runCheck();
  manifest.child.endedAtUtc = new Date().toISOString();
  manifest.child.exitCode = result.exitCode;
  manifest.child.signal = result.signal;
  exitCode = interruptedBy === 'SIGINT' ? 130 : interruptedBy === 'SIGTERM' ? 143 : result.exitCode ?? 1;
  persist('check_finished');
} catch (error) {
  manifest.failure = { stage: manifest.stage, name: error instanceof Error ? error.name : 'UnknownError', ...(failureCode(error) ? { code: failureCode(error) } : {}) };
  exitCode = interruptedBy === 'SIGINT' ? 130 : interruptedBy === 'SIGTERM' ? 143 : 1;
  console.error(`Isolated check failed during ${manifest.stage}${manifest.failure.code ? ` (${manifest.failure.code})` : ''}.`);
} finally {
  if (child?.pid) manifest.child.group = await drainOwnedGroup(child.pid);
  if (killTimer) clearTimeout(killTimer);
  if (testPool) {
    try { await bounded(testPool.end(), CLOSE_TIMEOUT_MS, 'AUTH_POOL_CLOSE_TIMEOUT'); testPoolClosed = true; }
    catch { testPoolClosed = false; }
  }
  if (admin) {
    try { await bounded(admin.end(), CLOSE_TIMEOUT_MS, 'ADMIN_CLOSE_TIMEOUT'); adminClosed = true; }
    catch { adminClosed = false; }
  }
  const cleanup = await verifiedDrop();
  manifest.cleanup = cleanup;
  writeJson('cleanup.json', { runId, databaseName, processGroup: manifest.child.group ?? null,
    testPoolClosed, migrationSettled, adminClosed, ...cleanup, completedAtUtc: new Date().toISOString() });
  if (interruptedBy) exitCode = interruptedBy === 'SIGINT' ? 130 : 143;
  if ((!adminClosed || cleanup.errorCode || manifest.database.created && !cleanup.verifiedAbsent) && exitCode === 0) exitCode = 1;
  manifest.exitCode = exitCode;
  persist(cleanup.verifiedAbsent ? 'cleaned' : manifest.database.createIssued ? 'cleanup_incomplete' : 'no_database_created');
  console.log(`Isolated test evidence: ${runDirectory}`);
  console.log(`Isolated test exit code: ${exitCode}; database cleanup verified: ${cleanup.verifiedAbsent}`);
  process.exitCode = exitCode;
  if (!testPoolClosed || !migrationSettled || !adminClosed || cleanup.errorCode === 'CLEANUP_CLOSE_TIMEOUT')
    setTimeout(() => process.exit(exitCode), 1000).unref();
}
}
