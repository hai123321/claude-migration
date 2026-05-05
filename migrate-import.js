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

import { existsSync } from 'fs';
import { importBundle, CLAUDE_JSON } from './migrate-core.js';

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

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n📥  Claude Code Migration — Import\n');

  await importBundle(bundlePath, flags);

  console.log('\n✅  Import complete!\n');

  console.log('📝  Next steps:');
  console.log('   1. Update YOUR_*_HERE placeholders in:');
  console.log('      ~/.claude/mcp-configs/mcp-servers.json   (API keys)');
  console.log('      ~/.claude/settings.json                  (env vars / hooks)');
  if (existsSync(CLAUDE_JSON)) {
    console.log('      ~/.claude.json                           (auth tokens)');
  }
  console.log('   2. Restart Claude Code to apply changes.');
  console.log('   3. Run: claude mcp list  — to verify MCP servers.\n');

  if (flags.backup) {
    console.log(`💾  A backup of your previous config was saved as ~/.claude.backup.*`);
    console.log('    Delete it once you\'ve verified the import.\n');
  }
}

main().catch(err => {
  console.error('❌  Import failed:', err.message);
  process.exit(1);
});
