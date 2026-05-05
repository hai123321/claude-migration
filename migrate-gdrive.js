#!/usr/bin/env node
/**
 * migrate-gdrive.js — Claude Code × Google Drive Sync
 *
 * Usage:
 *   claude-gdrive-sync <command> [options]
 *
 * Commands:
 *   setup       Interactive setup wizard (first-time install)
 *   push        Export config and upload to Google Drive
 *   pull        Download config from Google Drive and merge
 *   sync        Auto-detect direction based on timestamps
 *   status      Show sync status
 *   uninstall   Remove hooks and skill from Claude Code
 *
 * Options (push/pull/sync):
 *   --force-push          Skip timestamp check, always push
 *   --force-pull          Skip timestamp check, always pull
 *   --quiet               Suppress non-error output (for hooks)
 *   --no-backup           Skip backup before pull
 *   --include-sessions    Include chat sessions in push
 *   --include-history     Include command history in push
 *   --include-projects    Include project data in push
 *   --reauth              Re-authenticate with Google Drive (for setup)
 */

import { join, dirname } from 'path';
import { statSync, existsSync, readdirSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
import { tmpdir, hostname } from 'os';
import { randomBytes } from 'crypto';
import { rmSync } from 'fs';
import { google } from 'googleapis';
import {
  CLAUDE_DIR, buildExportBundle, importBundle,
} from './migrate-core.js';
import {
  getCredentials, createOAuth2Client, ensureAuthenticated,
} from './gdrive-auth.js';
import {
  ensureFolder, uploadFile, uploadJson, downloadFile,
  getFileId, getRemoteMeta,
  DRIVE_FOLDER_NAME, BUNDLE_FILE_NAME, META_FILE_NAME,
  DriveAuthError,
} from './gdrive-client.js';
import { runSetup, runUninstall } from './plugin-setup.js';

// ─── CLI Args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0];

const flags = {
  forcePush: args.includes('--force-push'),
  forcePull: args.includes('--force-pull'),
  quiet: args.includes('--quiet'),
  noBackup: args.includes('--no-backup'),
  reauth: args.includes('--reauth'),
  includeSessions: args.includes('--include-sessions'),
  includeHistory: args.includes('--include-history'),
  includeProjects: args.includes('--include-projects'),
};

function log(...msg) { if (!flags.quiet) console.log(...msg); }
function err(...msg) { console.error(...msg); }

// ─── Drive setup ──────────────────────────────────────────────────────────────

async function getDriveClient() {
  const creds = getCredentials();
  const oauth2Client = createOAuth2Client(creds);
  await ensureAuthenticated(oauth2Client);
  return google.drive({ version: 'v3', auth: oauth2Client });
}

// ─── Local mtime ──────────────────────────────────────────────────────────────

function getLocalMtime() {
  const checkPaths = ['settings.json', 'mcp-configs', 'agents', 'skills', 'commands'];
  let maxMtime = 0;

  for (const rel of checkPaths) {
    const full = join(CLAUDE_DIR, rel);
    if (!existsSync(full)) continue;
    try {
      const st = statSync(full);
      if (st.mtimeMs > maxMtime) maxMtime = st.mtimeMs;

      // Also check direct children of directories
      if (st.isDirectory()) {
        for (const entry of readdirSync(full)) {
          try {
            const childSt = statSync(join(full, entry));
            if (childSt.mtimeMs > maxMtime) maxMtime = childSt.mtimeMs;
          } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
  }
  return maxMtime;
}

// ─── Version ──────────────────────────────────────────────────────────────────

function getVersion() {
  try {
    return JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8')).version;
  } catch { return '1.1.0'; }
}

// ─── Commands ─────────────────────────────────────────────────────────────────

async function cmdPush({ drive, folderId } = {}) {
  if (!drive) {
    drive = await getDriveClient();
    folderId = await ensureFolder(drive, DRIVE_FOLDER_NAME);
  }

  log('  📦  Đang tạo bundle...');
  const tmpPath = join(tmpdir(), `claude-gdrive-push-${randomBytes(6).toString('hex')}.tar.gz`);

  try {
    await buildExportBundle({
      includeSessions: flags.includeSessions,
      includeHistory: flags.includeHistory,
      includeProjects: flags.includeProjects,
      sanitize: true,
    }, tmpPath);

    const bundleSize = statSync(tmpPath).size;
    log('  ☁️   Đang upload lên Google Drive...');

    await uploadFile(drive, folderId, BUNDLE_FILE_NAME, tmpPath, 'application/gzip');

    const meta = {
      pushedAt: new Date().toISOString(),
      machineName: hostname(),
      exportOptions: {
        includeSessions: flags.includeSessions,
        includeHistory: flags.includeHistory,
        includeProjects: flags.includeProjects,
        sanitize: true,
      },
      bundleSizeBytes: bundleSize,
      toolVersion: '1.1.0',
    };
    await uploadJson(drive, folderId, META_FILE_NAME, meta);

    const sizeKB = Math.round(bundleSize / 1024);
    log(`  ✅  Push thành công! (${sizeKB} KB, ${new Date().toLocaleString()})`);
  } finally {
    rmSync(tmpPath, { force: true });
  }
}

async function cmdPull({ drive, folderId } = {}) {
  if (!drive) {
    drive = await getDriveClient();
    folderId = await ensureFolder(drive, DRIVE_FOLDER_NAME);
  }

  const remoteMeta = await getRemoteMeta(drive, folderId);
  if (!remoteMeta) {
    err('  ❌  Không tìm thấy config trên Google Drive.');
    err('  Chạy: claude-gdrive-sync push (lần đầu tiên)');
    process.exit(1);
  }

  const fileId = await getFileId(drive, folderId, BUNDLE_FILE_NAME);
  if (!fileId) {
    err('  ❌  Bundle không tồn tại trên Drive.');
    process.exit(1);
  }

  log(`  ☁️   Đang download từ Drive (đẩy lên: ${remoteMeta.pushedAt} từ ${remoteMeta.machineName})...`);

  const tmpPath = join(tmpdir(), `claude-gdrive-pull-${randomBytes(6).toString('hex')}.tar.gz`);
  try {
    await downloadFile(drive, fileId, tmpPath);

    log('  📥  Đang import và merge config...');
    await importBundle(tmpPath, {
      overwrite: false,
      merge: true,
      backup: !flags.noBackup,
      dryRun: false,
      quiet: flags.quiet,
    });

    log(`  ✅  Pull thành công! Config từ ${remoteMeta.machineName} đã được merge.`);
  } finally {
    rmSync(tmpPath, { force: true });
  }
}

async function cmdSync() {
  const drive = await getDriveClient();
  const folderId = await ensureFolder(drive, DRIVE_FOLDER_NAME);

  // Force flags override everything
  if (flags.forcePush) {
    log('  🔄  Force push...');
    return cmdPush({ drive, folderId });
  }
  if (flags.forcePull) {
    log('  🔄  Force pull...');
    return cmdPull({ drive, folderId });
  }

  const remoteMeta = await getRemoteMeta(drive, folderId);

  // No remote yet — push for the first time
  if (!remoteMeta) {
    log('  ☁️   Chưa có config trên Drive. Đang push lần đầu...');
    return cmdPush({ drive, folderId });
  }

  const remoteTime = new Date(remoteMeta.pushedAt).getTime();
  const localTime = getLocalMtime();
  const THRESHOLD = 60_000; // 1 minute

  log(`  📊  Local:  ${localTime ? new Date(localTime).toLocaleString() : 'unknown'}`);
  log(`  📊  Remote: ${new Date(remoteTime).toLocaleString()} (từ ${remoteMeta.machineName})`);

  if (localTime > remoteTime + THRESHOLD) {
    log('  ⬆️   Local mới hơn — đang push...');
    return cmdPush({ drive, folderId });
  }
  if (remoteTime > localTime + THRESHOLD) {
    log('  ⬇️   Remote mới hơn — đang pull...');
    return cmdPull({ drive, folderId });
  }

  log('  ✅  Đã đồng bộ — không cần thay đổi.');
}

async function cmdStatus() {
  const drive = await getDriveClient();
  const folderId = await ensureFolder(drive, DRIVE_FOLDER_NAME);
  const remoteMeta = await getRemoteMeta(drive, folderId);
  const localTime = getLocalMtime();

  console.log('\n  📊  Trạng thái Google Drive Sync\n');

  if (!remoteMeta) {
    console.log('  Remote : Chưa có config trên Drive');
  } else {
    const sizeKB = Math.round((remoteMeta.bundleSizeBytes || 0) / 1024);
    console.log(`  Remote : ${remoteMeta.pushedAt}`);
    console.log(`           Máy: ${remoteMeta.machineName}  |  Size: ${sizeKB} KB`);
  }

  console.log(`  Local  : ${localTime ? new Date(localTime).toLocaleString() : 'Không tìm thấy ~/.claude'}`);

  if (remoteMeta && localTime) {
    const remoteTime = new Date(remoteMeta.pushedAt).getTime();
    const THRESHOLD = 60_000;
    if (localTime > remoteTime + THRESHOLD) {
      console.log('\n  → Local mới hơn remote. Chạy: claude-gdrive-sync push');
    } else if (remoteTime > localTime + THRESHOLD) {
      console.log('\n  → Remote mới hơn local. Chạy: claude-gdrive-sync pull');
    } else {
      console.log('\n  → Đã đồng bộ ✅');
    }
  }
  console.log();
}

function printHelp() {
  console.log(`
  claude-gdrive-sync — Claude Code × Google Drive Sync

  COMMANDS:
    setup       Wizard cài đặt lần đầu (credentials + auth + hooks + skill)
    push        Export config và upload lên Google Drive
    pull        Download config từ Drive và merge về local
    sync        Tự động sync theo timestamp (push hoặc pull)
    status      Xem trạng thái đồng bộ
    uninstall   Gỡ hooks và skill khỏi Claude Code

  OPTIONS (push/pull/sync):
    --force-push          Luôn push (bỏ qua timestamp)
    --force-pull          Luôn pull (bỏ qua timestamp)
    --quiet               Không in output (dùng cho hooks)
    --no-backup           Bỏ qua backup trước khi pull
    --include-sessions    Thêm lịch sử chat vào bundle
    --include-history     Thêm lịch sử lệnh vào bundle
    --include-projects    Thêm dữ liệu project vào bundle

  SETUP (lần đầu):
    --reauth              Xác thực lại Google Drive

  EXAMPLES:
    claude-gdrive-sync setup
    claude-gdrive-sync push
    claude-gdrive-sync sync --quiet
    GDRIVE_CLIENT_ID=xxx GDRIVE_CLIENT_SECRET=yyy claude-gdrive-sync setup
`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  switch (command) {
    case 'setup':
      await runSetup({ reauth: flags.reauth });
      break;

    case 'push':
      log('\n  ☁️   Claude Code → Google Drive\n');
      await cmdPush();
      log();
      break;

    case 'pull':
      log('\n  ☁️   Google Drive → Claude Code\n');
      await cmdPull();
      log();
      break;

    case 'sync':
      log('\n  🔄  Claude Code ↔ Google Drive Sync\n');
      await cmdSync();
      log();
      break;

    case 'status':
      await cmdStatus();
      break;

    case 'uninstall':
      runUninstall();
      break;

    case '--help':
    case '-h':
    case undefined:
      printHelp();
      break;

    default:
      err(`  ❌  Lệnh không hợp lệ: "${command}"`);
      printHelp();
      process.exit(1);
  }
}

main().catch(e => {
  if (e instanceof DriveAuthError) {
    if (!flags.quiet) err(`\n  ❌  Lỗi xác thực: ${e.message}`);
    if (!flags.quiet) err('  Chạy: claude-gdrive-sync setup (để cấu hình lại)\n');
  } else {
    if (!flags.quiet) err(`\n  ❌  Lỗi: ${e.message}\n`);
  }
  process.exit(1);
});
