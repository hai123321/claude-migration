#!/usr/bin/env node
/**
 * Claude Code Migration - Export Script
 * Exports Claude Code configuration to a portable bundle.
 *
 * Usage:
 *   node migrate-export.js [options]
 *
 * Options:
 *   --output <path>       Output bundle path (default: ./claude-migration-<timestamp>.tar.gz)
 *   --include-sessions    Include chat sessions (default: false — can be large & sensitive)
 *   --include-history     Include command history (default: false)
 *   --include-projects    Include project session data (default: false)
 *   --include-telemetry   Include telemetry data (default: false)
 *   --no-sanitize        Skip secret sanitization (NOT recommended)
 *   --dry-run            Show what would be exported without writing
 */

import { existsSync, statSync } from 'fs';
import { join, basename } from 'path';
import { buildExportList, buildExportBundle, CLAUDE_DIR, CLAUDE_JSON } from './migrate-core.js';

// ─── CLI Args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flags = {
  output: getArg('--output') ?? `./claude-migration-${Date.now()}.tar.gz`,
  includeSessions: args.includes('--include-sessions'),
  includeHistory: args.includes('--include-history'),
  includeProjects: args.includes('--include-projects'),
  includeTelemetry: args.includes('--include-telemetry'),
  sanitize: !args.includes('--no-sanitize'),
  dryRun: args.includes('--dry-run'),
};

function getArg(name) {
  const idx = args.indexOf(name);
  return idx !== -1 ? args[idx + 1] : undefined;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n🚀  Claude Code Migration — Export\n');

  const items = buildExportList(flags, CLAUDE_DIR);

  if (flags.dryRun) {
    console.log('📋  Dry run — would export:');
    items.forEach(i => console.log(`   • ${i.relPath}  (${i.description})`));
    if (existsSync(CLAUDE_JSON)) console.log('   • ~/.claude.json  (top-level config)');
    console.log('\nFlags:', JSON.stringify(flags, null, 2));
    return;
  }

  console.log('📦  Collecting files...');
  items.forEach(i => console.log(`  ✓  ${i.relPath}`));

  const outputPath = flags.output.startsWith('./') || flags.output.startsWith('/')
    ? flags.output
    : join(process.cwd(), flags.output);

  console.log('\n🗜   Creating archive...');
  await buildExportBundle(flags, outputPath);

  const sizeKB = Math.round(statSync(outputPath).size / 1024);
  console.log(`\n✅  Export complete!`);
  console.log(`   Output : ${outputPath}`);
  console.log(`   Size   : ${sizeKB} KB`);
  console.log(`   Items  : ${items.length} components\n`);
  console.log('👉  To import on another machine:');
  console.log(`   node migrate-import.js ${basename(outputPath)}\n`);

  if (flags.sanitize) {
    console.log('ℹ️   Secrets were redacted. After import, update YOUR_*_HERE placeholders');
    console.log('    in ~/.claude/mcp-configs/mcp-servers.json and ~/.claude/settings.json\n');
  }
}

main().catch(err => {
  console.error('❌  Export failed:', err.message);
  process.exit(1);
});
