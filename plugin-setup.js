/**
 * plugin-setup.js — Interactive setup wizard for claude-gdrive-sync.
 * Installs the plugin into Claude Code: credentials, OAuth, hooks, skill.
 */

import { createInterface } from 'readline';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  CLAUDE_DIR, HOME, mergeJson,
} from './migrate-core.js';
import { saveCredentials, createOAuth2Client, runAuthFlow } from './gdrive-auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SETTINGS_FILE = join(CLAUDE_DIR, 'settings.json');
const SKILLS_DIR = join(CLAUDE_DIR, 'skills');
const SKILL_FILE = join(SKILLS_DIR, 'gdrive-sync.md');

const BOX_WIDTH = 54;
function box(title) {
  const pad = Math.floor((BOX_WIDTH - 2 - title.length) / 2);
  const line = '═'.repeat(BOX_WIDTH);
  console.log(`\n╔${line}╗`);
  console.log(`║${' '.repeat(pad)}${title}${' '.repeat(BOX_WIDTH - pad - title.length)}║`);
  console.log(`╚${line}╝\n`);
}

function divider() {
  console.log('─'.repeat(BOX_WIDTH + 2));
}

// ─── Readline helper ──────────────────────────────────────────────────────────

function createRl() {
  return createInterface({ input: process.stdin, output: process.stdout });
}

function ask(rl, question) {
  return new Promise(resolve => rl.question(question, resolve));
}

function askSecret(question) {
  return new Promise(resolve => {
    process.stdout.write(question);
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    let input = '';
    const onData = (char) => {
      char = char.toString();
      if (char === '\r' || char === '\n') {
        process.stdin.setRawMode?.(false);
        process.stdin.pause();
        process.stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(input);
      } else if (char === '') {
        process.exit();
      } else if (char === '' || char === '\b') {
        if (input.length > 0) { input = input.slice(0, -1); process.stdout.write('\b \b'); }
      } else {
        input += char;
        process.stdout.write('*');
      }
    };
    process.stdin.on('data', onData);
  });
}

async function confirm(rl, question, defaultYes = true) {
  const hint = defaultYes ? '[Y/n]' : '[y/N]';
  const answer = await ask(rl, `${question} ${hint}: `);
  if (!answer.trim()) return defaultYes;
  return answer.trim().toLowerCase() === 'y';
}

// ─── Step 1: Google Cloud credentials ────────────────────────────────────────

async function stepCredentials(rl) {
  console.log('\n  Bạn cần OAuth2 Client ID và Client Secret từ Google Cloud.');
  console.log('  Hướng dẫn nhanh:');
  console.log('  1. Mở: https://console.cloud.google.com/apis/credentials');
  console.log('  2. Tạo "OAuth 2.0 Client ID" loại "Desktop app"');
  console.log('  3. Bật Google Drive API tại: https://console.cloud.google.com/apis/library');
  console.log('  4. Thêm scope: https://www.googleapis.com/auth/drive.file\n');

  // Check if already configured
  const credPath = join(CLAUDE_DIR, 'gdrive-config.json');
  if (existsSync(credPath)) {
    try {
      const cfg = JSON.parse(readFileSync(credPath, 'utf8'));
      if (cfg.clientId && cfg.clientSecret) {
        const reuse = await confirm(rl, '  Đã tìm thấy credentials cũ. Dùng lại?');
        if (reuse) { console.log('  ✓ Dùng credentials hiện có'); return; }
      }
    } catch { /* ignore */ }
  }

  const clientId = await ask(rl, '  Client ID: ');
  const clientSecret = await askSecret('  Client Secret: ');

  if (!clientId.trim() || !clientSecret.trim()) {
    throw new Error('Client ID và Client Secret không được để trống');
  }

  saveCredentials(clientId.trim(), clientSecret.trim());
  console.log('  ✓ Credentials đã lưu tại ~/.claude/gdrive-config.json');
}

// ─── Step 2: OAuth2 authentication ───────────────────────────────────────────

async function stepAuth() {
  console.log('\n  Đang khởi động xác thực Google Drive...');

  const { getCredentials } = await import('./gdrive-auth.js');
  const creds = getCredentials();
  const oauth2Client = createOAuth2Client(creds);
  await runAuthFlow(oauth2Client);

  console.log('  ✓ Xác thực thành công! Token lưu tại ~/.claude/gdrive-token.json');
}

// ─── Step 3: Install hooks ────────────────────────────────────────────────────

async function stepHooks(rl) {
  console.log('\n  Sẽ thêm vào ~/.claude/settings.json:');
  console.log('    • SessionStart — tự động pull khi bắt đầu session Claude');
  console.log('    • Stop        — tự động push khi kết thúc session Claude\n');

  const ok = await confirm(rl, '  Cài hooks tự động?');
  if (!ok) { console.log('  ↷ Bỏ qua cài hooks'); return; }

  mkdirSync(CLAUDE_DIR, { recursive: true });

  let settings = {};
  if (existsSync(SETTINGS_FILE)) {
    try { settings = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')); } catch { /* ignore */ }
  }

  const newHooks = {
    hooks: {
      SessionStart: [{
        hooks: [{
          type: 'command',
          command: 'claude-gdrive-sync pull --quiet 2>/dev/null || true',
        }],
      }],
      Stop: [{
        hooks: [{
          type: 'command',
          command: 'claude-gdrive-sync push --quiet 2>/dev/null || true',
        }],
      }],
    },
  };

  const merged = mergeJson(settings, newHooks);
  writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2), 'utf8');
  console.log('  ✓ Hooks đã cài đặt trong ~/.claude/settings.json');
}

// ─── Step 4: Install skill file ───────────────────────────────────────────────

async function stepSkill(rl) {
  console.log('\n  Sẽ tạo ~/.claude/skills/gdrive-sync.md');
  console.log('  Cho phép gõ /gdrive-sync, /gdrive-push, /gdrive-pull trong chat Claude\n');

  const ok = await confirm(rl, '  Cài skill (slash commands)?');
  if (!ok) { console.log('  ↷ Bỏ qua cài skill'); return; }

  mkdirSync(SKILLS_DIR, { recursive: true });

  // Copy from assets if available, otherwise write inline
  const assetPath = join(__dirname, 'assets', 'gdrive-sync.md');
  if (existsSync(assetPath)) {
    writeFileSync(SKILL_FILE, readFileSync(assetPath, 'utf8'), 'utf8');
  } else {
    writeFileSync(SKILL_FILE, getSkillContent(), 'utf8');
  }
  console.log('  ✓ Skill đã cài đặt tại ~/.claude/skills/gdrive-sync.md');
}

function getSkillContent() {
  return `# gdrive-sync

Đồng bộ cấu hình Claude Code với Google Drive.

## Slash Commands

- \`/gdrive-push\` — Upload config lên Google Drive ngay bây giờ
- \`/gdrive-pull\` — Download và merge config từ Google Drive
- \`/gdrive-sync\` — Tự động sync theo timestamp
- \`/gdrive-status\` — Xem trạng thái đồng bộ
- \`/gdrive-uninstall\` — Gỡ cài đặt plugin

## Mô tả

Plugin này tích hợp Claude Code với Google Drive để tự động đồng bộ:
- Khi bắt đầu session: tự động pull config mới nhất từ Drive
- Khi kết thúc session: tự động push config lên Drive

Dữ liệu nhạy cảm (API keys, tokens) được redact tự động trước khi upload.
`;
}

// ─── Main setup wizard ────────────────────────────────────────────────────────

export async function runSetup({ reauth = false } = {}) {
  box('Claude Code × Google Drive Sync — Setup');

  const rl = createRl();

  try {
    console.log('  Wizard này sẽ hướng dẫn bạn qua 4 bước cài đặt.\n');

    // Step 1
    console.log('  Bước 1/4: Google Cloud Credentials');
    divider();
    await stepCredentials(rl);

    // Step 2
    console.log('\n  Bước 2/4: Xác thực Google Drive');
    divider();
    if (reauth || !existsSync(join(CLAUDE_DIR, 'gdrive-token.json'))) {
      await stepAuth();
    } else {
      console.log('  ✓ Đã có token. Bỏ qua (dùng --reauth để xác thực lại)');
    }

    // Step 3
    console.log('\n  Bước 3/4: Cài hooks tự động');
    divider();
    await stepHooks(rl);

    // Step 4
    console.log('\n  Bước 4/4: Cài skill (slash commands)');
    divider();
    await stepSkill(rl);

    // Done
    console.log('\n' + '═'.repeat(BOX_WIDTH + 2));
    console.log('✅  Setup hoàn tất!');
    console.log('\n   Từ bây giờ config Claude Code sẽ tự động sync');
    console.log('   với Google Drive sau mỗi session.\n');
    console.log('   Push lần đầu tiên:');
    console.log('     claude-gdrive-sync push\n');
    console.log('   Xem trạng thái:');
    console.log('     claude-gdrive-sync status');
    console.log('═'.repeat(BOX_WIDTH + 2) + '\n');

  } finally {
    rl.close();
  }
}

// ─── Uninstall ────────────────────────────────────────────────────────────────

export function runUninstall() {
  console.log('\n  Đang gỡ cài đặt claude-gdrive-sync hooks...\n');

  let changed = false;

  if (existsSync(SETTINGS_FILE)) {
    try {
      const settings = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'));
      const marker = 'claude-gdrive-sync';

      if (settings.hooks?.SessionStart) {
        settings.hooks.SessionStart = settings.hooks.SessionStart
          .map(group => ({
            ...group,
            hooks: (group.hooks || []).filter(h => !h.command?.includes(marker)),
          }))
          .filter(group => (group.hooks || []).length > 0);
        changed = true;
      }

      if (settings.hooks?.Stop) {
        settings.hooks.Stop = settings.hooks.Stop
          .map(group => ({
            ...group,
            hooks: (group.hooks || []).filter(h => !h.command?.includes(marker)),
          }))
          .filter(group => (group.hooks || []).length > 0);
        changed = true;
      }

      if (changed) {
        writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
        console.log('  ✓ Hooks đã được gỡ khỏi settings.json');
      }
    } catch (err) {
      console.warn(`  ⚠  Không thể cập nhật settings.json: ${err.message}`);
    }
  }

  if (existsSync(SKILL_FILE)) {
    import('fs').then(({ rmSync }) => {
      rmSync(SKILL_FILE, { force: true });
      console.log('  ✓ Skill file đã xóa');
    });
  }

  console.log('\n  Plugin đã gỡ cài đặt. Token và credentials vẫn còn tại:');
  console.log('    ~/.claude/gdrive-token.json');
  console.log('    ~/.claude/gdrive-config.json');
  console.log('  Xóa thủ công nếu muốn.\n');
}
