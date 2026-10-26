import { EventEmitter } from 'node:events';
import type { Pool } from 'pg';
import type { InvestmentActionStatus } from '../packages/contracts/src/index.js';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { beforeEach, expect, it, vi } from 'vitest';
import { createPasskeys } from '../apps/api/src/webauthn.js';

const verifier = vi.hoisted(() => vi.fn());
vi.mock('@simplewebauthn/server', () => ({
  verifyAuthenticationResponse: verifier,
  generateRegistrationOptions: vi.fn(), verifyRegistrationResponse: vi.fn(), generateAuthenticationOptions: vi.fn(),
}));

// Transaction/control-flow tests only: signature and user verification are mocked.
// Real WebAuthn cryptography, authenticators, PostgreSQL and browser flows are not exercised.
const actor = { userId: 'g8j-passkey-owner' };
const action: { id: string; actionHash: string; status: InvestmentActionStatus } = { id: 'action-1', actionHash: 'bound-action-hash', status: 'AWAITING_VERIFICATION' };
const challenge = { id: 'challenge-proof-1', challenge: 'server-challenge', action_hash: action.actionHash };
const response = {
  id: 'credential-1', rawId: 'credential-1', type: 'public-key', clientExtensionResults: {},
  response: { clientDataJSON: Buffer.from(JSON.stringify({ challenge: challenge.challenge })).toString('base64url'), authenticatorData: 'mock', signature: 'mock' },
} satisfies AuthenticationResponseJSON;
const credential = { id: response.id, public_key: Buffer.from([1, 2, 3]), counter: '4', transports: ['internal'] };

function fixture(scope: 'transfer' | 'management' | 'investment' = 'transfer') {
  const events: string[] = [];
  const client = Object.assign(new EventEmitter(), {
    query: vi.fn(async (sql: string, _values?: unknown[]) => {
      events.push(sql);
      return { rows: sql.startsWith('SELECT * FROM bp_credentials') ? [credential] : [] };
    }),
    release: vi.fn(),
  });
  const pool = {
    connect: vi.fn(async () => client),
    query: vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [challenge] })),
  };
  const core = {
    getAction: vi.fn(async () => action),
    authorize: vi.fn(async () => { events.push('AUTHORIZE'); return { ...action, status: 'AUTHORIZED' as const }; }),
  };
  return { client, pool, core, events, passkeys: createPasskeys(pool as unknown as Pool, core, 'http://localhost:5178', 'localhost', scope) };
}
beforeEach(() => { verifier.mockReset(); verifier.mockResolvedValue({ verified: true, authenticationInfo: { userVerified: true, newCounter: 5 } }); });

for (const scope of ['transfer', 'management', 'investment'] as const) {
  it(`${scope}: commits the verified counter before issuing the action-bound STRONG proof`, async () => {
    const { client, pool, core, passkeys, events } = fixture(scope);
    let releaseCommit!: () => void, enteredCommit!: () => void;
    const entered = new Promise<void>(resolve => { enteredCommit = resolve; });
    const gate = new Promise<void>(resolve => { releaseCommit = resolve; });
    const normal = client.query.getMockImplementation()!;
    client.query.mockImplementation(async (sql, values) => {
      if (sql === 'COMMIT') { enteredCommit(); await gate; }
      return normal(sql, values);
    });
    const pending = passkeys.authenticate(actor, action.id, response);
    await entered;
    expect(verifier).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenCalledWith('UPDATE bp_credentials SET counter=$2 WHERE id=$1', [credential.id, 5]);
    expect(core.authorize).not.toHaveBeenCalled();
    releaseCommit();
    await expect(pending).resolves.toMatchObject({ id: action.id, status: 'AUTHORIZED' });
    expect(events.at(-2)).toBe('COMMIT'); expect(events.at(-1)).toBe('AUTHORIZE');
    expect(core.authorize).toHaveBeenCalledExactlyOnceWith(actor, action.id, { level: 'STRONG', proofId: challenge.id, actionHash: action.actionHash });
    expect(pool.query.mock.calls[0][1]).toEqual([actor.userId, scope === 'transfer' ? 'authenticate' : `${scope}-authenticate`, challenge.challenge, action.id]);
    expect(verifier).toHaveBeenCalledWith(expect.objectContaining({ expectedChallenge: challenge.challenge, expectedOrigin: 'http://localhost:5178', expectedRPID: 'localhost', requireUserVerification: true, credential: expect.objectContaining({ id: credential.id, counter: 4 }) }));
    expect(client.release).toHaveBeenCalledExactlyOnceWith(undefined); expect(client.listenerCount('error')).toBe(0);
  });
}

it('a checked-out COMMIT disconnect preserves its error and never authorizes or retries', async () => {
  const { client, pool, core, passkeys } = fixture();
  const original = Object.assign(new Error('COMMIT_RESPONSE_UNKNOWN'), { code: '08006' });
  const normal = client.query.getMockImplementation()!;
  client.query.mockImplementation(async (sql, values) => {
    if (sql === 'COMMIT') { expect(client.listenerCount('error')).toBe(1); client.emit('error', original); throw original; }
    return normal(sql, values);
  });
  await expect(passkeys.authenticate(actor, action.id, response)).rejects.toBe(original);
  expect(verifier).toHaveBeenCalledTimes(1); expect(core.authorize).not.toHaveBeenCalled();
  expect(client.query).not.toHaveBeenCalledWith('ROLLBACK'); expect(client.release).toHaveBeenCalledExactlyOnceWith(original);
  expect(pool.connect).toHaveBeenCalledTimes(1); expect(pool.query).toHaveBeenCalledTimes(1); expect(client.listenerCount('error')).toBe(0);
});

it('a failed COMMIT followed by failed ROLLBACK retains the original error and never authorizes', async () => {
  const { client, core, passkeys } = fixture();
  const original = new Error('ORIGINAL_COMMIT_RESPONSE_UNKNOWN'), rollback = new Error('SECONDARY_ROLLBACK_FAILURE');
  const normal = client.query.getMockImplementation()!;
  client.query.mockImplementation(async (sql, values) => {
    if (sql === 'COMMIT') throw original;
    if (sql === 'ROLLBACK') throw rollback;
    return normal(sql, values);
  });
  await expect(passkeys.authenticate(actor, action.id, response)).rejects.toBe(original);
  expect(verifier).toHaveBeenCalledTimes(1); expect(core.authorize).not.toHaveBeenCalled();
  expect(client.query).toHaveBeenCalledWith('ROLLBACK'); expect(client.release).toHaveBeenCalledExactlyOnceWith(rollback); expect(client.listenerCount('error')).toBe(0);
});

it('checkout failure propagates without verification, counter writes or authorization', async () => {
  const { client, pool, core, passkeys } = fixture();
  const original = new Error('CHECKOUT_UNAVAILABLE'); pool.connect.mockRejectedValueOnce(original);
  await expect(passkeys.authenticate(actor, action.id, response)).rejects.toBe(original);
  expect(pool.query).toHaveBeenCalledTimes(1); // The one-time challenge was consumed before checkout; it is not silently restored.
  expect(verifier).not.toHaveBeenCalled(); expect(client.query).not.toHaveBeenCalled(); expect(client.release).not.toHaveBeenCalled(); expect(core.authorize).not.toHaveBeenCalled();
});

it('signature verifier rejection rolls back without counter update, COMMIT or authorization', async () => {
  const { client, core, passkeys } = fixture(); verifier.mockRejectedValueOnce(new Error('MOCK_SIGNATURE_INVALID'));
  await expect(passkeys.authenticate(actor, action.id, response)).rejects.toMatchObject({ code: 'WEBAUTHN_REJECTED' });
  expect(client.query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'SELECT * FROM bp_credentials WHERE id=$1 AND user_id=$2 FOR UPDATE', 'ROLLBACK']);
  expect(core.authorize).not.toHaveBeenCalled(); expect(client.release).toHaveBeenCalledExactlyOnceWith(undefined);
});

it('a verified response without required user verification cannot commit or authorize', async () => {
  const { client, core, passkeys } = fixture(); verifier.mockResolvedValueOnce({ verified: true, authenticationInfo: { userVerified: false, newCounter: 5 } });
  await expect(passkeys.authenticate(actor, action.id, response)).rejects.toMatchObject({ code: 'WEBAUTHN_REJECTED' });
  expect(client.query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'SELECT * FROM bp_credentials WHERE id=$1 AND user_id=$2 FOR UPDATE', 'ROLLBACK']);
  expect(core.authorize).not.toHaveBeenCalled(); expect(client.listenerCount('error')).toBe(0);
});
