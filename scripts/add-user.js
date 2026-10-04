// Usage: npm run user:add -- <username> [display name]   (password is prompted, or set KB_PASSWORD)
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { openDb } from '../src/db.js';
import { createUser } from '../src/auth.js';

const [username, ...rest] = process.argv.slice(2);
if (!username) {
  console.error('Usage: npm run user:add -- <username> [display name]');
  process.exit(1);
}
let password = process.env.KB_PASSWORD;
if (!password) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  password = await rl.question(`Password for ${username}: `);
  rl.close();
}
openDb();
try {
  const u = createUser({ username, password, displayName: rest.join(' ') || username });
  console.log(`Created user ${u.username} (id ${u.id})`);
} catch (e) {
  console.error(e.message.includes('UNIQUE') ? `User ${username} already exists` : e.message);
  process.exit(1);
}
