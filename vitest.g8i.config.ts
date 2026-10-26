import { defineConfig } from 'vitest/config';
/** Opt-in Docker/physical-connection fault suite, excluded by the default *.test.ts glob. */
export default defineConfig({test:{include:['tests/g8i-database-recovery.fault.spec.ts'],fileParallelism:false,testTimeout:45_000,hookTimeout:60_000}});
