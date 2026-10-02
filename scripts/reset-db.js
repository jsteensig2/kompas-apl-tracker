// Deletes the local database so it is recreated with example data on next start.
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const file = process.env.DB_FILE || fileURLToPath(new URL('../data/kompas-apl.db', import.meta.url));
rmSync(file, { force: true });
console.log(`Removed ${file}. Start the server to recreate it with example data.`);
