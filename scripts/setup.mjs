/**
 * Cross-platform project setup (Windows, macOS, Linux).
 * Installs dependencies, seeds .env from the template without clobbering an
 * existing one, ensures the local data directory exists, and runs migrations.
 */
import { existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';

const run = (cmd) => execSync(cmd, { stdio: 'inherit' });

run('npm install');

if (existsSync('.env')) {
  console.log('.env already exists; leaving it untouched.');
} else {
  copyFileSync('.env.example', '.env');
  console.log('Created .env from .env.example.');
}

mkdirSync('data', { recursive: true });

run('npm run migration:run');
