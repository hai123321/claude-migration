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

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'fs';
import { join, relative, dirname, basename } from 'path';
import { homedir, platform } from 'os';
import { create as tarCreate } from 'tar';
import { fileURLToPath } from 'url';
import { readdirSync, copyFileSync } from 'fs';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { rmSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

// ─── Constants ────────────────────────────────────────────────────────────────

const HOME = homedir();
const CLAUDE_DIR = join(HOME, '.claude');
const CLAUDE_JSON = join(HOME, '.claude.json');

/** Regex patterns that identify secrets. Values are replaced with placeholders. */
const SECRET_PATTERNS = [
  // Generic API keys / tokens
  { pattern: /("(?:api[_-]?key|apikey|api[_-]?token|access[_-]?token|secret[_-]?key|secret|password|passwd|credential|auth[_-]?token|bearer[_-]?token|client[_-]?secret|private[_-]?key|webhook[_-]?secret)":\s*)"(?!YOUR_)[^"]{8,}"/, replace: '$1"YOUR_SECRET_HERE"' },
  // ANTHROPIC keys
  { pattern: /("ANTHROPIC_AUTH_TOKEN":\s*)"sk-[^"]*"/, replace: '$1"YOUR_ANTHROPIC_AUTH_TOKEN"' },
  // OpenAI
  { pattern: /("OPENAI_API_KEY":\s*)"sk-[^"]*"/, replace: '$1"YOUR_OPENAI_API_KEY"' },
  // GitHub tokens
  { pattern: /("GITHUB_(?:PERSONAL_ACCESS_)?TOKEN":\s*)"(?:ghp_|github_pat_)[^"]*"/, replace: '$1"YOUR_GITHUB_TOKEN"' },
  // Generic gh_ tokens
  { pattern: /("(?:[A-Z_]*TOKEN[A-Z_]*)":\s*)"(?:ghp_|gho_|ghs_|ghu_)[^"]*"/, replace: '$1"YOUR_GITHUB_TOKEN"' },
  // Jira/Atlassian
  { pattern: /("JIRA_API_TOKEN":\s*)"[^"]{20,}"/, replace: '$1"YOUR_JIRA_API_TOKEN"' },
  // AWS
  { pattern: /("AWS_(?:SECRET_ACCESS_KEY|SESSION_TOKEN)":\s*)"[^"]{20,}"/, replace: '$1"YOUR_AWS_SECRET"' },
  // Supabase
  { pattern: /("(?:SUPABASE_ANON_KEY|SUPABASE_SERVICE_KEY|SUPABASE_SERVICE_ROLE_KEY)":\s*)"[^"]{20,}"/, replace: '$1"YOUR_SUPABASE_KEY"' },
  // Generic bearer tokens
  { pattern: /("Authorization":\s*)"Bearer [^"]*"/, replace: '$1"Bearer YOUR_TOKEN_HERE"' },
  // base64 looking long values in env sections (at least 40 chars, contain = or /)
  { pattern: /("(?:[A-Z][A-Z0-9_]{4,})":\s*)"(?=[A-Za-z0-9+/]{40,}={0,2}")[A-Za-z0-9+/=]{40,}"/, replace: '$1"YOUR_SECRET_HERE"' },
];

/** Absolute paths that should be rewritten to use $HOME placeholder */
const HOME_PLACEHOLDER = '__HOME__';

// ─── Items to export ──────────────────────────────────────────────────────────

function buildExportList() {
  const items = [];

  const add = (relPath, description, condition = true) => {
    if (!condition) return;
    const fullPath = join(CLAUDE_DIR, relPath);
    if (existsSync(fullPath)) {
      items.push({ relPath, fullPath, description });
    } else {
      console.warn(`  ⚠  Skipping (not found): ${relPath}`);
    }
  };

  // Core config
  add('settings.json', 'Global settings, hooks, env vars');
  add('remote-settings.json', 'Remote/team settings');
  add('plugin.json', 'Plugin manifest');

  // MCP configs
  add('mcp-configs', 'MCP server configurations');

  // Agents, skills, commands, rules
  add('agents', 'Custom sub-agents');
  add('skills', 'Skills library');
  add('commands', 'Slash commands');
  add('rules', 'Coding rules');

  // Plugins
  add('plugins/installed_plugins.json', 'Installed plugin list');
  add('plugins/known_marketplaces.json', 'Known marketplaces');
  add('plugins/marketplaces', 'Marketplace configs');
  add('plugins/blocklist.json', 'Plugin blocklist');
  add('ecc', 'ECC (superpowers) data');

  // Scripts (hooks)
  add('scripts', 'Hook scripts');

  // Memory (project memories, not full session data)
  add('memory', 'Global memory files', existsSync(join(CLAUDE_DIR, 'memory')));

  // Optional
  add('sessions', 'Chat sessions', flags.includeSessions);
  add('history.jsonl', 'Command history', flags.includeHistory);
  add('projects', 'Project session data', flags.includeProjects);
  add('telemetry', 'Telemetry data', flags.includeTelemetry);

  return items;
}

// ─── Sanitization ─────────────────────────────────────────────────────────────

function sanitizeContent(content, filePath) {
  if (!flags.sanitize) return content;

  // Replace absolute home paths with placeholder
  const escapedHome = HOME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  content = content.replace(new RegExp(escapedHome, 'g'), HOME_PLACEHOLDER);

  // Apply secret patterns
  for (const { pattern, replace } of SECRET_PATTERNS) {
    content = content.replace(new RegExp(pattern.source, 'gi'), replace);
  }

  return content;
}

// ─── Copy with sanitization ───────────────────────────────────────────────────

function copyToStaging(srcPath, stagingDir, relBase) {
  const stats = statSync(srcPath);

  if (stats.isDirectory()) {
    const entries = readdirSync(srcPath);
    for (const entry of entries) {
      copyToStaging(join(srcPath, entry), stagingDir, relBase);
    }
    return;
  }

  // Compute destination
  const relFromClaude = relative(CLAUDE_DIR, srcPath);
  const destPath = join(stagingDir, 'claude', relFromClaude);
  mkdirSync(dirname(destPath), { recursive: true });

  // Text files: sanitize
  const textExtensions = ['.json', '.jsonl', '.md', '.js', '.ts', '.sh', '.yaml', '.yml', '.toml', '.env', '.txt'];
  const ext = srcPath.match(/\.[^.]+$/) ? srcPath.match(/\.[^.]+$/)[0].toLowerCase() : '';
  const isText = textExtensions.includes(ext) || !ext;

  if (isText && flags.sanitize) {
    try {
      const content = readFileSync(srcPath, 'utf8');
      const sanitized = sanitizeContent(content, srcPath);
      writeFileSync(destPath, sanitized, 'utf8');
    } catch {
      // Binary or unreadable — copy as-is
      copyFileSync(srcPath, destPath);
    }
  } else {
    copyFileSync(srcPath, destPath);
  }
}

// ─── .claude.json ─────────────────────────────────────────────────────────────

function exportClaudeJson(stagingDir) {
  if (!existsSync(CLAUDE_JSON)) return;
  const content = readFileSync(CLAUDE_JSON, 'utf8');
  const sanitized = sanitizeContent(content, '.claude.json');
  const dest = join(stagingDir, 'claude.json');
  writeFileSync(dest, sanitized, 'utf8');
  console.log('  ✓  .claude.json');
}

// ─── Manifest ─────────────────────────────────────────────────────────────────

function writeManifest(stagingDir, items) {
  const manifest = {
    exportedAt: new Date().toISOString(),
    exportedBy: 'claude-migrate',
    version: '1.0.0',
    sourcePlatform: platform(),
    homeDir: HOME_PLACEHOLDER,
    flags: { ...flags, output: undefined },
    items: items.map(i => ({
      path: i.relPath,
      description: i.description,
    })),
    instructions: [
      'Run: node migrate-import.js <path-to-this-bundle>',
      'The import script rewrites ' + HOME_PLACEHOLDER + ' to your actual home directory.',
      'Secrets have been redacted — update YOUR_*_HERE placeholders after import.',
    ],
  };
  writeFileSync(join(stagingDir, 'MANIFEST.json'), JSON.stringify(manifest, null, 2));
}

// ─── Import script (bundled) ──────────────────────────────────────────────────

function writeImportScript(stagingDir) {
  const importScript = readFileSync(join(__dirname, 'migrate-import.js'), 'utf8');
  writeFileSync(join(stagingDir, 'migrate-import.js'), importScript);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n🚀  Claude Code Migration — Export\n');

  const items = buildExportList();

  if (flags.dryRun) {
    console.log('📋  Dry run — would export:');
    items.forEach(i => console.log(`   • ${i.relPath}  (${i.description})`));
    if (existsSync(CLAUDE_JSON)) console.log('   • ~/.claude.json  (top-level config)');
    console.log('\nFlags:', JSON.stringify(flags, null, 2));
    return;
  }

  // Create temp staging directory
  const stagingDir = join(tmpdir(), `claude-migrate-${randomBytes(6).toString('hex')}`);
  mkdirSync(stagingDir, { recursive: true });

  try {
    console.log('📦  Collecting files...');

    // Export each item
    for (const item of items) {
      copyToStaging(item.fullPath, stagingDir, CLAUDE_DIR);
      console.log(`  ✓  ${item.relPath}`);
    }

    // Export .claude.json
    exportClaudeJson(stagingDir);

    // Write manifest
    writeManifest(stagingDir, items);

    // Bundle import script
    if (existsSync(join(__dirname, 'migrate-import.js'))) {
      writeImportScript(stagingDir);
    }

    console.log('\n🗜   Creating archive...');

    // Create tar.gz
    const outputPath = flags.output.startsWith('./') || flags.output.startsWith('/')
      ? flags.output
      : join(process.cwd(), flags.output);

    await tarCreate({ cwd: stagingDir, gzip: true, file: outputPath }, ['.']);

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

  } finally {
    // Clean up staging
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error('❌  Export failed:', err.message);
  process.exit(1);
});
