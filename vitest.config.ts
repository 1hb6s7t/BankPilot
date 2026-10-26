import { defineConfig } from 'vitest/config';
export default defineConfig({ test: {
  include: ['tests/**/*.test.ts'], testTimeout: 30_000, hookTimeout: 60_000,
  // Better Auth introspects every visible schema. Concurrent DROP SCHEMA in another
  // integration file can race pg_get_serial_sequence during that introspection.
  // File serialization keeps shared-database DDL deterministic; concurrency cases
  // inside each test still exercise simultaneous requests and user locks.
  fileParallelism: false,
} });
