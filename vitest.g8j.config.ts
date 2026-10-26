import { defineConfig } from 'vitest/config';
/** Opt-in real PostgreSQL faults, never part of the default unit/integration glob. */
export default defineConfig({test:{include:['tests/g8j-*.fault.spec.ts'],fileParallelism:false,testTimeout:45_000,hookTimeout:60_000}});
