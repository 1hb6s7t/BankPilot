import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, verifyBundle, flag, cliError } from './shared.mjs';
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) verifyBundle(resolve(flag(process.argv.slice(2), '--directory') ?? ROOT), { allowGenerated: process.argv.includes('--installed') }).then(value => console.log(JSON.stringify(value))).catch(cliError);
