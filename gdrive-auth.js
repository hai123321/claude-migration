/**
 * gdrive-auth.js — Google Drive OAuth2 PKCE authentication for CLI.
 * Implements RFC 8252 (OAuth 2.0 for Native Apps) loopback redirect flow.
 */

import { createServer } from 'http';
import { createHash, randomBytes } from 'crypto';
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'fs';
import { join } from 'path';
import { exec } from 'child_process';
import { google } from 'googleapis';
import { CLAUDE_DIR } from './migrate-core.js';

const TOKEN_FILE = join(CLAUDE_DIR, 'gdrive-token.json');
const CONFIG_FILE = join(CLAUDE_DIR, 'gdrive-config.json');

const SCOPES = ['https://www.googleapis.com/auth/drive.file'];
const REDIRECT_PORT_CANDIDATES = [9876, 9877, 9878, 9879, 0];

// ─── Credentials ──────────────────────────────────────────────────────────────

/**
 * Reads GCP OAuth2 client credentials.
 * Priority: env vars → ~/.claude/gdrive-config.json
 */
export function getCredentials() {
  const fromEnv = {
    clientId: process.env.GDRIVE_CLIENT_ID,
    clientSecret: process.env.GDRIVE_CLIENT_SECRET,
  };
  if (fromEnv.clientId && fromEnv.clientSecret) return fromEnv;

  if (existsSync(CONFIG_FILE)) {
    try {
      const cfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
      if (cfg.clientId && cfg.clientSecret) return cfg;
    } catch { /* ignore */ }
  }

  throw new Error(
    'Google Drive credentials not found.\n' +
    'Run: claude-gdrive-sync setup\n' +
    'Or set env vars: GDRIVE_CLIENT_ID and GDRIVE_CLIENT_SECRET',
  );
}

/**
 * Saves client credentials to ~/.claude/gdrive-config.json (chmod 0o600).
 */
export function saveCredentials(clientId, clientSecret) {
  const cfg = { clientId, clientSecret, installedAt: new Date().toISOString() };
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
  try { chmodSync(CONFIG_FILE, 0o600); } catch { /* Windows — best effort */ }
}

// ─── OAuth2 client ────────────────────────────────────────────────────────────

export function createOAuth2Client({ clientId, clientSecret }) {
  return new google.auth.OAuth2(clientId, clientSecret);
}

// ─── Token lifecycle ──────────────────────────────────────────────────────────

/**
 * Loads token from disk onto the OAuth2 client.
 * Returns true if loaded and still valid (or successfully refreshed).
 */
export async function loadToken(oauth2Client) {
  if (!existsSync(TOKEN_FILE)) return false;

  try {
    const token = JSON.parse(readFileSync(TOKEN_FILE, 'utf8'));
    oauth2Client.setCredentials(token);

    // If expired, attempt silent refresh
    if (token.expiry_date && token.expiry_date < Date.now() + 60_000) {
      const { credentials } = await oauth2Client.refreshAccessToken();
      oauth2Client.setCredentials(credentials);
      await saveToken(oauth2Client);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Persists current credentials to disk (chmod 0o600).
 */
export async function saveToken(oauth2Client) {
  const creds = oauth2Client.credentials;
  writeFileSync(TOKEN_FILE, JSON.stringify(creds, null, 2), 'utf8');
  try { chmodSync(TOKEN_FILE, 0o600); } catch { /* Windows */ }
}

// ─── PKCE helpers ─────────────────────────────────────────────────────────────

function generateCodeVerifier() {
  return randomBytes(64).toString('base64url');
}

function generateCodeChallenge(verifier) {
  return createHash('sha256').update(verifier).digest('base64url');
}

// ─── Local callback server ────────────────────────────────────────────────────

function findAvailablePort() {
  return new Promise((resolve, reject) => {
    let idx = 0;
    const tryNext = () => {
      if (idx >= REDIRECT_PORT_CANDIDATES.length) {
        reject(new Error('No available port for OAuth callback server'));
        return;
      }
      const port = REDIRECT_PORT_CANDIDATES[idx++];
      const server = createServer();
      server.listen(port, '127.0.0.1', () => {
        const actualPort = server.address().port;
        server.close(() => resolve(actualPort));
      });
      server.on('error', tryNext);
    };
    tryNext();
  });
}

function startCallbackServer(port) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${port}`);
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      if (code) {
        res.end(`<html><body style="font-family:sans-serif;padding:2em">
          <h2>✅ Xác thực thành công!</h2>
          <p>Bạn có thể đóng tab này và quay lại terminal.</p>
        </body></html>`);
        server.close();
        resolve(code);
      } else {
        res.end(`<html><body style="font-family:sans-serif;padding:2em">
          <h2>❌ Xác thực thất bại</h2>
          <p>Lỗi: ${error || 'unknown'}</p>
        </body></html>`);
        server.close();
        reject(new Error(`OAuth error: ${error || 'unknown'}`));
      }
    });

    server.listen(port, '127.0.0.1');
    server.on('error', reject);
  });
}

// ─── Open browser ─────────────────────────────────────────────────────────────

function openBrowser(url) {
  const { platform } = process;
  let cmd;
  if (platform === 'darwin') cmd = `open "${url}"`;
  else if (platform === 'win32') cmd = `start "" "${url}"`;
  else cmd = `xdg-open "${url}"`;

  exec(cmd, err => {
    if (err) console.log(`\n  Không thể mở browser tự động. Mở URL sau thủ công:\n  ${url}\n`);
  });
}

// ─── Full auth flow ───────────────────────────────────────────────────────────

/**
 * Runs the full PKCE loopback OAuth2 flow.
 * Opens the browser, waits for callback, exchanges code, saves token.
 */
export async function runAuthFlow(oauth2Client) {
  const port = await findAvailablePort();
  const redirectUri = `http://localhost:${port}`;
  oauth2Client.redirectUri = redirectUri;

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    redirect_uri: redirectUri,
    code_challenge_method: 'S256',
    code_challenge: codeChallenge,
  });

  console.log('\n  Đang mở browser để xác thực Google Drive...');
  console.log(`  Nếu browser không mở, truy cập URL:\n  ${authUrl}\n`);

  // Start callback server before opening browser
  const codePromise = startCallbackServer(port);
  openBrowser(authUrl);

  const code = await codePromise;

  const { tokens } = await oauth2Client.getToken({
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });
  oauth2Client.setCredentials(tokens);
  await saveToken(oauth2Client);
}

/**
 * Ensures the client is authenticated — loads from disk or runs auth flow.
 */
export async function ensureAuthenticated(oauth2Client) {
  const loaded = await loadToken(oauth2Client);
  if (!loaded) await runAuthFlow(oauth2Client);
}
