import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
  type RegistrationResponseJSON, type AuthenticationResponseJSON,
} from '@simplewebauthn/server';
import { CoreError } from '../../../packages/core/src/index.js';
import { withTransaction } from '../../../packages/core/src/database.js';
import type { Actor, InvestmentActionStatus, AuthorizationProof } from '../../../packages/contracts/src/index.js';

export async function migrateWebAuthn(pool: Pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS bp_credentials (
    id text PRIMARY KEY, user_id text NOT NULL, public_key bytea NOT NULL,
    counter bigint NOT NULL, transports jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS bp_challenges (
    id uuid PRIMARY KEY, user_id text NOT NULL, kind text NOT NULL,
    challenge text NOT NULL UNIQUE, action_id text, action_hash text,
    expires_at timestamptz NOT NULL, consumed_at timestamptz
  );
  CREATE INDEX IF NOT EXISTS bp_challenges_user_idx ON bp_challenges(user_id);
  CREATE INDEX IF NOT EXISTS bp_credentials_user_idx ON bp_credentials(user_id);`);
}

type Authorizable = { id: string; actionHash: string; status: InvestmentActionStatus };
type AuthorizationTarget<T extends Authorizable> = {
  getAction(actor: Actor, id: string): Promise<T>;
  authorize(actor: Actor, id: string, proof: AuthorizationProof): Promise<T>;
};
export function createPasskeys<T extends Authorizable>(pool: Pool, core: AuthorizationTarget<T>, origin: string, rpID: string, scope: 'transfer' | 'management' | 'investment' = 'transfer') {
  const authenticationKind = scope === 'transfer' ? 'authenticate' : `${scope}-authenticate`;
  const credentials = async (actor: Actor) => (await pool.query('SELECT * FROM bp_credentials WHERE user_id=$1', [actor.userId])).rows;
  const saveChallenge = async (actor: Actor, kind: string, challenge: string, action?: { id: string; actionHash: string }) => {
    await pool.query(`INSERT INTO bp_challenges(id,user_id,kind,challenge,action_id,action_hash,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,now()+interval '3 minutes')`,
    [randomUUID(), actor.userId, kind, challenge, action?.id ?? null, action?.actionHash ?? null]);
  };
  // Extracting the challenge only selects a server record. The library then verifies the entire signed response.
  const consume = async (actor: Actor, kind: string, response: RegistrationResponseJSON | AuthenticationResponseJSON, actionId?: string) => {
    let challenge: unknown;
    try { challenge = JSON.parse(Buffer.from(response.response.clientDataJSON, 'base64url').toString('utf8')).challenge; }
    catch { throw new CoreError('INVALID_WEBAUTHN', '通行密钥响应格式无效', 400); }
    if (typeof challenge !== 'string') throw new CoreError('INVALID_CHALLENGE', '验证挑战无效', 400);
    const result = await pool.query(`UPDATE bp_challenges SET consumed_at=now()
      WHERE user_id=$1 AND kind=$2 AND challenge=$3 AND action_id IS NOT DISTINCT FROM $4
      AND consumed_at IS NULL AND expires_at>now() RETURNING *`, [actor.userId, kind, challenge, actionId ?? null]);
    if (!result.rows[0]) throw new CoreError('CHALLENGE_EXPIRED_OR_USED', '验证已过期或已使用，请重新发起', 409);
    return result.rows[0];
  };
  return {
    async count(actor: Actor) { return (await credentials(actor)).length; },
    async registrationOptions(actor: Actor, email: string) {
      const saved = await credentials(actor);
      const options = await generateRegistrationOptions({
        rpName: 'BankPilot 合成资金沙箱', rpID, userName: email,
        userID: new TextEncoder().encode(actor.userId),
        attestationType: 'none', supportedAlgorithmIDs: [-7, -257],
        excludeCredentials: saved.map(c => ({ id: c.id, transports: c.transports })),
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
      });
      await saveChallenge(actor, 'register', options.challenge);
      return options;
    },
    async register(actor: Actor, response: RegistrationResponseJSON) {
      const challenge = await consume(actor, 'register', response);
      let result;
      try { result = await verifyRegistrationResponse({ response, expectedChallenge: challenge.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true }); }
      catch { throw new CoreError('WEBAUTHN_REJECTED', '通行密钥签名或用户验证未通过', 403); }
      if (!result.verified || !result.registrationInfo) throw new CoreError('WEBAUTHN_REJECTED', '注册验证未通过', 403);
      const credential = result.registrationInfo.credential;
      await pool.query(`INSERT INTO bp_credentials(id,user_id,public_key,counter,transports) VALUES($1,$2,$3,$4,$5)`,
        [credential.id, actor.userId, Buffer.from(credential.publicKey), credential.counter, JSON.stringify(credential.transports ?? [])]);
      return { verified: true };
    },
    async authenticationOptions(actor: Actor, actionId: string) {
      const action = await core.getAction(actor, actionId);
      if (!['AWAITING_CONFIRMATION', 'AWAITING_VERIFICATION'].includes(action.status)) throw new CoreError('ACTION_NOT_PENDING', '该动作不再等待授权');
      const saved = await credentials(actor);
      if (!saved.length) throw new CoreError('PASSKEY_REQUIRED', '请先注册通行密钥', 409);
      const options = await generateAuthenticationOptions({ rpID, userVerification: 'required', allowCredentials: saved.map(c => ({ id: c.id, transports: c.transports })) });
      await saveChallenge(actor, authenticationKind, options.challenge, action);
      return options;
    },
    async authenticate(actor: Actor, actionId: string, response: AuthenticationResponseJSON) {
      const challenge = await consume(actor, authenticationKind, response, actionId);
      const action = await core.getAction(actor, actionId);
      if (action.actionHash !== challenge.action_hash) throw new CoreError('STALE_ACTION', '动作已发生变化，请重新确认并验证');
      // Credential counter updates serialize per credential, including simultaneous verification attempts.
      await withTransaction(pool, async tx => {
        const row = (await tx.query('SELECT * FROM bp_credentials WHERE id=$1 AND user_id=$2 FOR UPDATE', [response.id, actor.userId])).rows[0];
        if (!row) throw new CoreError('CREDENTIAL_NOT_FOUND', '此通行密钥不属于当前用户', 403);
        let result;
        try { result = await verifyAuthenticationResponse({
          response, expectedChallenge: challenge.challenge, expectedOrigin: origin, expectedRPID: rpID,
          credential: { id: row.id, publicKey: new Uint8Array(row.public_key), counter: Number(row.counter), transports: row.transports },
          requireUserVerification: true,
        }); } catch { throw new CoreError('WEBAUTHN_REJECTED', '通行密钥签名或用户验证未通过', 403); }
        if (!result.verified || !result.authenticationInfo.userVerified) throw new CoreError('WEBAUTHN_REJECTED', '强验证未通过', 403);
        await tx.query('UPDATE bp_credentials SET counter=$2 WHERE id=$1', [row.id, result.authenticationInfo.newCounter]);
      });
      return core.authorize(actor, actionId, { level: 'STRONG', proofId: challenge.id, actionHash: challenge.action_hash });
    },
  };
}
