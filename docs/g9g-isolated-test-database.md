# G9G isolated full-test database

`pnpm test:isolated` creates one randomly named PostgreSQL database for a single `pnpm check` run. It replaces `TEST_DATABASE_URL`, `BANKPILOT_TEST_DATABASE_URL`, and `DATABASE_URL` in the child process so tests with legacy fallback URLs do not touch the `bankpilot` demo database. The test command remains the existing typecheck, Vitest, and build sequence. The runner does not read `.env`, invoke `scripts/setup.ts`, or seed any demo user, account, balance, or merchant.

The runner accepts only the local Docker PostgreSQL endpoint `127.0.0.1:55432`. By default it connects as the existing `bankpilot` role to the `postgres` maintenance database. `BANKPILOT_TEST_ADMIN_URL` can select another database or role on that same endpoint; the URL and its password are never written to evidence. The connected role must have `CREATEDB` and own its newly created database. External hosts and other local ports are rejected before any connection. The admin database is only used for `CREATE DATABASE`, identity lookup, and `DROP DATABASE` of the generated database.

Before running tests, the runner calls the existing `createAuth` and Better Auth `getMigrations(...).runMigrations()` mechanism in the new database. It does not run API, core, or demo migrations in advance. Integration suites must install the application tables they use through their own setup. In particular, `tests/api.integration.test.ts` calls `migrateApi` itself, now against the isolated database.

## Commands

```sh
pnpm test:isolated --dry-run
pnpm test:isolated
pnpm exec tsx scripts/test-isolated.ts --probe-child-environment
pnpm exec tsx scripts/test-isolated.ts --probe-owned-group
```

The dry run validates arguments and the admin URL and prints only the planned local target and behavior. It creates no files and does not connect to PostgreSQL. The two probes are pure local process checks: one prints only the child environment key allowlist result, and the other spawns an owned process group whose leader exits while a descendant ignores TERM, then verifies KILL and disappearance. They do not connect to PostgreSQL. The full command requires an exclusive test window because it runs the repository's complete check and may use ports or other non-database fixtures.

The runner builds the check subprocess environment from a small allowlist: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, temporary-directory variables, locale variables, terminal/color variables, `CI`, and `TZ`. It explicitly adds only the three temporary database URLs. Other inherited environment variables, including `AWS_SECRET_ACCESS_KEY`, `PGPASSWORD`, `GITHUB_PAT`, model settings, and live flags, are absent. It does not ask the test process to load `.env` or log the temporary URL or credentials. If tests need a new environment variable, inspect that test's fixture before adding it to the runner; do not point it at the demo database.

## Evidence and cleanup

Each real run creates a new `docs/evidence/g9g-isolated-test-<timestamp>-<run-id>/` directory with a `manifest.json` and `cleanup.json`. The manifest records the generated name, database OID and owner, stage transitions, child exit code, interruption, and cleanup result. Both files are written with mode `0600` in a mode `0700` directory. The runner emits the evidence directory path and final exit code. Child test output remains on the terminal; the runner does not copy potentially sensitive test logs into evidence.

After the check leader exits, including nonzero test results, the runner checks its owned process group. Any descendants receive TERM, then KILL after a bounded grace period; the runner verifies the group has disappeared even when the leader exited earlier. It closes its pool and compares the database name, OID, and owner against its recorded creation identity. Only after the process group and database work are confirmed settled, and `pg_stat_activity` shows no remaining sessions, does it issue a plain `DROP DATABASE` for that exact generated database and verify its absence. It will not force-terminate an unexplained database session or drop a name it did not confirm creating. `SIGINT` and `SIGTERM` initiate group termination and return codes 130 and 143. Connection, SQL, migration, pool-close, and process-group waits are bounded. If creation remains unconfirmed, a group cannot be confirmed gone, work remains unsettled, sessions remain, or cleanup cannot verify ownership, the database is retained for manual inspection and the manifest says `cleanup_incomplete`; do not run a broad database cleanup command.

The child exit code is preserved when tests fail. A cleanup failure also makes an otherwise passing run fail. A clean typecheck/test/build result only describes that isolated run; it does not change earlier evidence or imply a cloud-model acceptance result.

## G9H controlled browser extension

`pnpm test:isolated --browser` runs only `pnpm exec playwright test --config playwright.g9h.config.ts` in a fresh owned database. `--dry-run` may be combined with `--browser`; duplicate or unknown flags, arbitrary config paths and live switches are rejected. The default remains `pnpm check`. The controlled suite includes the existing six-domain paths, reviewer refusal coverage and G9H domain refusal coverage.

The child receives a runner-created `BANKPILOT_G9H_EVIDENCE_DIR` beneath this invocation's private evidence directory. This value is not inherited from the caller, and no cloud credentials or live flags are passed. The manifest records the exact child command. All original OID/owner/session/process-group cleanup gates remain in effect. The historical `g9g-isolated-test-` directory/database naming prefix is retained for this reused runner; the recorded child command and browser report identify which suite actually ran.
