/**
 * Standalone helper: obtains a Google refresh token for the service's .env.
 *   GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… npm run google-signin
 * Opens the consent page in your browser and prints the refresh token once.
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import { signInWithGoogle } from '../extension/googleOAuth';

function openBrowser(url: string): Promise<void> {
  console.error(`\nOpen this URL to sign in (opening your browser automatically):\n\n${url}\n`);
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  execFile(cmd, [url], () => undefined);
  return Promise.resolve();
}

async function main(): Promise<void> {
  if (fs.existsSync('.env') && typeof process.loadEnvFile === 'function') {
    process.loadEnvFile('.env');
  }
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (in .env or the environment) first.');
    process.exit(2);
  }
  const refreshToken = await signInWithGoogle({ clientId, clientSecret, openBrowser });
  console.error('\nSigned in. Put this in your .env as GOOGLE_REFRESH_TOKEN (keep it secret):\n');
  process.stdout.write(`${refreshToken}\n`);
}

main().catch((error: unknown) => {
  console.error(`Google sign-in failed: ${(error as Error).message}`);
  process.exit(1);
});
