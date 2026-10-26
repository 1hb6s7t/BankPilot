import { Pool } from 'pg';
import { observePoolErrors } from '../../../packages/core/src/database.js';
import { betterAuth } from 'better-auth';

export const webOrigin = process.env.WEB_ORIGIN ?? 'http://localhost:5178';
export const rpID = process.env.WEBAUTHN_RP_ID ?? 'localhost';
export const sandboxEnabled = process.env.SANDBOX_ENABLED === 'true';
export function createPool() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required. Copy .env.example and run pnpm setup.');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 12 });
  observePoolErrors(pool);
  return pool;
}
export function createAuth(pool: Pool) {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret || secret.length < 32 || secret.startsWith('replace-')) throw new Error('Set a random BETTER_AUTH_SECRET of at least 32 characters.');
  const cookiePrefix = process.env.BETTER_AUTH_COOKIE_PREFIX ?? 'bankpilot';
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(cookiePrefix)) throw new Error('BETTER_AUTH_COOKIE_PREFIX must contain 1-64 lowercase letters, digits or hyphens, starting with a letter.');
  return betterAuth({
    appName: 'BankPilot', database: pool, secret,
    baseURL: process.env.BETTER_AUTH_URL ?? webOrigin,
    trustedOrigins: [webOrigin],
    emailAndPassword: { enabled: true },
    session: { expiresIn: 8 * 60 * 60, cookieCache: { enabled: false } },
    advanced: { cookiePrefix },
  });
}
export type Auth = ReturnType<typeof createAuth>;
