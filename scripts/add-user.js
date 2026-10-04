// Usage: npm run user:add -- [--admin] [--random] <username> [display name]
// Password is prompted, taken from KB_PASSWORD, or generated with --random (printed once).
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { openDb } from '../src/db.js';
import { createUser, generatePassword } from '../src/auth.js';

const args = process.argv.slice(2);
const isAdmin = args.includes('--admin');
const random = args.includes('--random');
const [username, ...rest] = args.filter((a) => !a.startsWith('--'));
if (!username) {
  console.error('Usage: npm run user:add -- [--admin] [--random] <username> [display name]');
  process.exit(1);
}
let password = process.env.KB_PASSWORD;
if (random) password = generatePassword();
if (!password) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  password = await rl.question(`Password for ${username}: `);
  rl.close();
}
openDb();
try {
  const u = createUser({ username, password, displayName: rest.join(' ') || username, isAdmin });
  console.log(`Created user ${u.username} (id ${u.id})${isAdmin ? ' [admin]' : ''}`);
  if (random) console.log(`Password: ${password}`);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
