#!/usr/bin/env node
/**
 * Claude Code Migration — Import Script
 * Imports a bundle exported by migrate-export.js into ~/.claude/
 *
 * Usage:
 *   node migrate-import.js <bundle.tar.gz> [options]
 *
 * Options:
 *   --overwrite         Overwrite existing files (default: skip conflicts)
 *   --merge             Merge JSON arrays/objects instead of overwriting
 *   --exclude <path>    Comma-separated list of paths to skip (e.g. sessions,history.jsonl)
 *   --dry-run           Show what would be imported without writing
 *   --backup            Backup existing ~/.claude before importing (default: true)
 *   --no-backup         Skip backup
 */

import { execSync } from 'child_process';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
  readdirSync, statSync, cpSync, copyFileSync, renameSync,
} from 'fs';
import { join, dirname, basename, extname } from 'path';
import { homedir, platform } from 'os';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { rmSync } from 'fs';
import { createReadStream } from 'fs';
import { extract } from 'tar';

// ─── CLI Args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const bundlePath = args[0];

if (!bundlePath || bundlePath.startsWith('--')) {
  console.error('Usage: node migrate-import.js <bundle.tar.gz> [options]');
  process.exit(1);
}

function getArg(name) {
  const idx = args.indexOf(name);
  return idx !== -1 ? args[idx + 1] : undefined;
}

const excludeArg = getArg('--exclude');
const flags = {
  overwrite: args.includes('--overwrite'),
  merge: args.includes('--merge'),
  dryRun: args.includes('--dry-run'),
  backup: !args.includes('--no-backup'),
  exclude: excludeArg ? excludeArg.split(',').map(s => s.trim()) : [],
};

// ─── Constants ────────────────────────────────────────────────────────────────

const HOME = homedir();
const CLAUDE_DIR = join(HOME, '.claude');
const CLAUDE_JSON = join(HOME, '.claude.json');
const HOME_PLACEHOLDER = '__HOME__';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function log(msg) { console.log(msg); }
function warn(msg) { console.warn('  ⚠  ' + msg); }
function ok(msg) { console.log('  ✓  ' + msg); }

function rewritePaths(content) {
  return content.replace(new RegExp(HOME_PLACEHOLDER, 'g'), HOME);
}

function isExcluded(relPath) {
  return flags.exclude.some(excl => relPath === excl || relPath.startsWith(excl + '/'));
}

// ─── JSON merge ───────────────────────────────────────────────────────────────

function mergeJson(existing, incoming) {
  if (Array.isArray(existing) && Array.isArray(incoming)) {
    // Deduplicate by JSON equality
    const seen = new Set(existing.map(JSON.stringify));
    const merged = [...existing];
    for (const item of incoming) {
      const key = JSON.stringify(item);
      if (!seen.has(key)) {
        merged.push(item);
        seen.add(key);
      }
    }
    return merged;
  }
  if (typeof existing === 'object' && typeof incoming === 'object'
      && existing !== null && incoming !== null) {
    const result = { ...existing };
    for (const [k, v] of Object.entries(incoming)) {
      if (k in result && typeof result[k] === 'object' && result[k] !== null) {
        result[k] = mergeJson(result[k], v);
      } else if (!(k in result)) {
        result[k] = v;
      }
      // If key exists and is scalar, keep existing (don't overwrite)
    }
    return result;
  }
  return existing; // scalar: keep existing
}

// ─── Write file ───────────────────────────────────────────────────────────────

function writeFile(destPath, content, isText) {
  if (flags.dryRun) {
    log(`  [dry-run] would write: ${destPath}`);
    return;
  }
  mkdirSync(dirname(destPath), { recursive: true });

  if (flags.merge && isText && extname(destPath) === '.json' && existsSync(destPath)) {
    try {
      const existing = JSON.parse(readFileSync(destPath, 'utf8'));
      const incoming = JSON.parse(content);
      const merged = mergeJson(existing, incoming);
      writeFileSync(destPath, JSON.stringify(merged, null, 2), 'utf8');
      return;
    } catch {
      // Fall through to normal write if JSON parse fails
    }
  }

  writeFileSync(destPath, content, isText ? 'utf8' : undefined);
}

// ─── Import a single file ─────────────────────────────────────────────────────

function importFile(srcPath, destPath) {
  const relDest = destPath.replace(HOME + '/', '~/');

  if (existsSync(destPath) && !flags.overwrite && !flags.merge) {
    warn(`Skipping (exists): ${relDest}  — use --overwrite or --merge`);
    return;
  }

  const textExtensions = ['.json', '.jsonl', '.md', '.js', '.ts', '.sh', '.yaml', '.yml', '.toml', '.env', '.txt'];
  const ext = extname(srcPath).toLowerCase();
  const isText = textExtensions.includes(ext) || !ext;

  if (isText) {
    try {
      let content = readFileSync(srcPath, 'utf8');
      content = rewritePaths(content);
      writeFile(destPath, content, true);
      ok(relDest);
    } catch {
      // Binary fallback
      if (!flags.dryRun) {
        mkdirSync(dirname(destPath), { recursive: true });
        copyFileSync(srcPath, destPath);
      }
      ok(relDest + ' (binary)');
    }
  } else {
    if (!flags.dryRun) {
      mkdirSync(dirname(destPath), { recursive: true });
      copyFileSync(srcPath, destPath);
    }
    ok(relDest);
  }
}

// ─── Walk and import directory ────────────────────────────────────────────────

function importDir(srcDir, destDir, prefix = '') {
  const entries = readdirSync(srcDir);
  for (const entry of entries) {
    const srcPath = join(srcDir, entry);
    const destPath = join(destDir, entry);
    const relPath = prefix ? `${prefix}/${entry}` : entry;

    if (isExcluded(relPath)) {
      warn(`Excluded: ${relPath}`);
      continue;
    }

    const stats = statSync(srcPath);
    if (stats.isDirectory()) {
      if (!flags.dryRun) mkdirSync(destPath, { recursive: true });
      importDir(srcPath, destPath, relPath);
    } else {
      importFile(srcPath, destPath);
    }
  }
}

// ─── Backup ───────────────────────────────────────────────────────────────────

function backupExisting() {
  if (!existsSync(CLAUDE_DIR)) return;
  const backupPath = join(HOME, `.claude.backup.${Date.now()}`);
  if (flags.dryRun) {
    log(`[dry-run] would backup ~/.claude to ${backupPath}`);
    return;
  }
  cpSync(CLAUDE_DIR, backupPath, { recursive: true });
  log(`💾  Backed up ~/.claude → ${basename(backupPath)}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  log('\n📥  Claude Code Migration — Import\n');

  if (!existsSync(bundlePath)) {
    console.error(`❌  Bundle not found: ${bundlePath}`);
    process.exit(1);
  }

  // Extract to temp dir
  const stagingDir = join(tmpdir(), `claude-migrate-import-${randomBytes(6).toString('hex')}`);
  mkdirSync(stagingDir, { recursive: true });

  try {
    log('📦  Extracting bundle...');
    await extract({ file: bundlePath, cwd: stagingDir });

    // Read manifest
    const manifestPath = join(stagingDir, 'MANIFEST.json');
    if (!existsSync(manifestPath)) {
      console.error('❌  Invalid bundle: missing MANIFEST.json');
      process.exit(1);
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    log(`📋  Bundle from: ${manifest.exportedAt} (${manifest.sourcePlatform})`);
    log(`    Components : ${manifest.items.length}\n`);

    // Backup
    if (flags.backup) backupExisting();

    // Ensure ~/.claude exists
    if (!flags.dryRun) mkdirSync(CLAUDE_DIR, { recursive: true });

    log('📂  Importing files...\n');

    // Import ~/.claude contents
    const claudeSrcDir = join(stagingDir, 'claude');
    if (existsSync(claudeSrcDir)) {
      importDir(claudeSrcDir, CLAUDE_DIR);
    }

    // Import .claude.json (top-level)
    const claudeJsonSrc = join(stagingDir, 'claude.json');
    if (existsSync(claudeJsonSrc)) {
      log('\n📄  Importing .claude.json...');
      importFile(claudeJsonSrc, CLAUDE_JSON);
    }

    log('\n✅  Import complete!\n');

    // Post-import reminders
    log('📝  Next steps:');
    log('   1. Update YOUR_*_HERE placeholders in:');
    log('      ~/.claude/mcp-configs/mcp-servers.json   (API keys)');
    log('      ~/.claude/settings.json                  (env vars / hooks)');
    if (existsSync(CLAUDE_JSON)) {
      log('      ~/.claude.json                           (auth tokens)');
    }
    log('   2. Restart Claude Code to apply changes.');
    log('   3. Run: claude mcp list  — to verify MCP servers.\n');

    if (flags.backup) {
      log(`💾  A backup of your previous config was saved as ~/.claude.backup.*`);
      log('    Delete it once you\'ve verified the import.\n');
    }

  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error('❌  Import failed:', err.message);
  process.exit(1);
});
