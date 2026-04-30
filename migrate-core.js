#!/usr/bin/env node
/**
 * migrate-core.js — Shared library for Claude Code migration.
 * All pure business logic used by both migrate-export.js, migrate-import.js,
 * and the Google Drive sync plugin.
 */

import {
  existsSync, mkdirSync, readFileSync, writeFileSync, statSync,
  readdirSync, copyFileSync, cpSync,
} from 'fs';
import { join, relative, dirname, basename, extname } from 'path';
import { homedir, platform } from 'os';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { rmSync } from 'fs';
import { create as tarCreate } from 'tar';
import { extract } from 'tar';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Constants ────────────────────────────────────────────────────────────────

export const HOME = homedir();
export const CLAUDE_DIR = join(HOME, '.claude');
export const CLAUDE_JSON = join(HOME, '.claude.json');
export const HOME_PLACEHOLDER = '__HOME__';

/** Files inside ~/.claude that must never be included in any export bundle. */
export const NEVER_EXPORT_FILES = ['gdrive-token.json', 'gdrive-config.json'];

export const SECRET_PATTERNS = [
  { pattern: /("(?:api[_-]?key|apikey|api[_-]?token|access[_-]?token|secret[_-]?key|secret|password|passwd|credential|auth[_-]?token|bearer[_-]?token|client[_-]?secret|private[_-]?key|webhook[_-]?secret)":\s*)"(?!YOUR_)[^"]{8,}"/, replace: '$1"YOUR_SECRET_HERE"' },
  { pattern: /("ANTHROPIC_AUTH_TOKEN":\s*)"sk-[^"]*"/, replace: '$1"YOUR_ANTHROPIC_AUTH_TOKEN"' },
  { pattern: /("OPENAI_API_KEY":\s*)"sk-[^"]*"/, replace: '$1"YOUR_OPENAI_API_KEY"' },
  { pattern: /("GITHUB_(?:PERSONAL_ACCESS_)?TOKEN":\s*)"(?:ghp_|github_pat_)[^"]*"/, replace: '$1"YOUR_GITHUB_TOKEN"' },
  { pattern: /("(?:[A-Z_]*TOKEN[A-Z_]*)":\s*)"(?:ghp_|gho_|ghs_|ghu_)[^"]*"/, replace: '$1"YOUR_GITHUB_TOKEN"' },
  { pattern: /("JIRA_API_TOKEN":\s*)"[^"]{20,}"/, replace: '$1"YOUR_JIRA_API_TOKEN"' },
  { pattern: /("AWS_(?:SECRET_ACCESS_KEY|SESSION_TOKEN)":\s*)"[^"]{20,}"/, replace: '$1"YOUR_AWS_SECRET"' },
  { pattern: /("(?:SUPABASE_ANON_KEY|SUPABASE_SERVICE_KEY|SUPABASE_SERVICE_ROLE_KEY)":\s*)"[^"]{20,}"/, replace: '$1"YOUR_SUPABASE_KEY"' },
  { pattern: /("Authorization":\s*)"Bearer [^"]*"/, replace: '$1"Bearer YOUR_TOKEN_HERE"' },
  { pattern: /("(?:[A-Z][A-Z0-9_]{4,})":\s*)"(?=[A-Za-z0-9+/]{40,}={0,2}")[A-Za-z0-9+/=]{40,}"/, replace: '$1"YOUR_SECRET_HERE"' },
];

// ─── Export helpers ────────────────────────────────────────────────────────────

/**
 * Builds the list of items to export based on flags.
 * @param {object} flags - { includeSessions, includeHistory, includeProjects, includeTelemetry }
 * @param {string} claudeDir - path to ~/.claude
 */
export function buildExportList(flags, claudeDir = CLAUDE_DIR) {
  const items = [];

  const add = (relPath, description, condition = true) => {
    if (!condition) return;
    const fullPath = join(claudeDir, relPath);
    if (existsSync(fullPath)) {
      items.push({ relPath, fullPath, description });
    } else {
      console.warn(`  ⚠  Skipping (not found): ${relPath}`);
    }
  };

  add('settings.json', 'Global settings, hooks, env vars');
  add('remote-settings.json', 'Remote/team settings');
  add('plugin.json', 'Plugin manifest');
  add('mcp-configs', 'MCP server configurations');
  add('agents', 'Custom sub-agents');
  add('skills', 'Skills library');
  add('commands', 'Slash commands');
  add('rules', 'Coding rules');
  add('plugins/installed_plugins.json', 'Installed plugin list');
  add('plugins/known_marketplaces.json', 'Known marketplaces');
  add('plugins/marketplaces', 'Marketplace configs');
  add('plugins/blocklist.json', 'Plugin blocklist');
  add('ecc', 'ECC (superpowers) data');
  add('scripts', 'Hook scripts');
  add('memory', 'Global memory files', existsSync(join(claudeDir, 'memory')));
  add('sessions', 'Chat sessions', flags.includeSessions);
  add('history.jsonl', 'Command history', flags.includeHistory);
  add('projects', 'Project session data', flags.includeProjects);
  add('telemetry', 'Telemetry data', flags.includeTelemetry);

  return items;
}

/**
 * Replaces secrets and absolute home paths in text content.
 * @param {string} content
 * @param {object} flags - { sanitize }
 * @param {string} home - home directory path
 */
export function sanitizeContent(content, flags, home = HOME) {
  if (!flags.sanitize) return content;

  const escapedHome = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  content = content.replace(new RegExp(escapedHome, 'g'), HOME_PLACEHOLDER);

  for (const { pattern, replace } of SECRET_PATTERNS) {
    content = content.replace(new RegExp(pattern.source, 'gi'), replace);
  }

  return content;
}

/**
 * Copies a file/directory to the staging area with sanitization.
 */
export function copyToStaging(srcPath, stagingDir, claudeDir, flags, home = HOME) {
  const stats = statSync(srcPath);

  if (stats.isDirectory()) {
    const entries = readdirSync(srcPath);
    for (const entry of entries) {
      // Skip protected files
      if (NEVER_EXPORT_FILES.includes(entry)) continue;
      copyToStaging(join(srcPath, entry), stagingDir, claudeDir, flags, home);
    }
    return;
  }

  // Skip protected files by basename
  if (NEVER_EXPORT_FILES.includes(basename(srcPath))) return;

  const relFromClaude = relative(claudeDir, srcPath);
  const destPath = join(stagingDir, 'claude', relFromClaude);
  mkdirSync(dirname(destPath), { recursive: true });

  const textExtensions = ['.json', '.jsonl', '.md', '.js', '.ts', '.sh', '.yaml', '.yml', '.toml', '.env', '.txt'];
  const ext = srcPath.match(/\.[^.]+$/) ? srcPath.match(/\.[^.]+$/)[0].toLowerCase() : '';
  const isText = textExtensions.includes(ext) || !ext;

  if (isText && flags.sanitize) {
    try {
      const content = readFileSync(srcPath, 'utf8');
      const sanitized = sanitizeContent(content, flags, home);
      writeFileSync(destPath, sanitized, 'utf8');
    } catch {
      copyFileSync(srcPath, destPath);
    }
  } else {
    copyFileSync(srcPath, destPath);
  }
}

/**
 * Exports and sanitizes ~/.claude.json into the staging dir.
 */
export function exportClaudeJson(stagingDir, flags, home = HOME) {
  const claudeJson = join(home, '.claude.json');
  if (!existsSync(claudeJson)) return;
  const content = readFileSync(claudeJson, 'utf8');
  const sanitized = sanitizeContent(content, flags, home);
  writeFileSync(join(stagingDir, 'claude.json'), sanitized, 'utf8');
  console.log('  ✓  .claude.json');
}

/**
 * Writes MANIFEST.json into the staging directory.
 */
export function writeManifest(stagingDir, items, flags) {
  const manifest = {
    exportedAt: new Date().toISOString(),
    exportedBy: 'claude-migrate',
    version: '1.1.0',
    sourcePlatform: platform(),
    homeDir: HOME_PLACEHOLDER,
    flags: { ...flags, output: undefined },
    items: items.map(i => ({ path: i.relPath, description: i.description })),
    instructions: [
      'Run: node migrate-import.js <path-to-this-bundle>',
      'The import script rewrites ' + HOME_PLACEHOLDER + ' to your actual home directory.',
      'Secrets have been redacted — update YOUR_*_HERE placeholders after import.',
    ],
  };
  writeFileSync(join(stagingDir, 'MANIFEST.json'), JSON.stringify(manifest, null, 2));
}

// ─── Import helpers ────────────────────────────────────────────────────────────

/**
 * Replaces __HOME__ placeholders with actual home directory.
 */
export function rewritePaths(content, home = HOME) {
  return content.replace(new RegExp(HOME_PLACEHOLDER, 'g'), home);
}

/**
 * Deep merge of two JSON values:
 * - Arrays: deduplicate by JSON equality, append new items
 * - Objects: recursive merge, keep existing scalars
 */
export function mergeJson(existing, incoming) {
  if (Array.isArray(existing) && Array.isArray(incoming)) {
    const seen = new Set(existing.map(JSON.stringify));
    const merged = [...existing];
    for (const item of incoming) {
      const key = JSON.stringify(item);
      if (!seen.has(key)) { merged.push(item); seen.add(key); }
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
    }
    return result;
  }
  return existing;
}

/**
 * Writes a file to destPath, applying merge logic if flags.merge is set.
 */
export function writeImportFile(destPath, content, isText, flags) {
  if (flags.dryRun) {
    console.log(`  [dry-run] would write: ${destPath}`);
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
    } catch { /* fall through */ }
  }

  writeFileSync(destPath, content, isText ? 'utf8' : undefined);
}

/**
 * Imports a single file from srcPath to destPath.
 */
export function importFile(srcPath, destPath, flags, home = HOME) {
  const relDest = destPath.replace(home + '/', '~/');

  if (existsSync(destPath) && !flags.overwrite && !flags.merge) {
    console.warn(`  ⚠  Skipping (exists): ${relDest}  — use --overwrite or --merge`);
    return;
  }

  const textExtensions = ['.json', '.jsonl', '.md', '.js', '.ts', '.sh', '.yaml', '.yml', '.toml', '.env', '.txt'];
  const ext = extname(srcPath).toLowerCase();
  const isText = textExtensions.includes(ext) || !ext;

  if (isText) {
    try {
      let content = readFileSync(srcPath, 'utf8');
      content = rewritePaths(content, home);
      writeImportFile(destPath, content, true, flags);
      console.log(`  ✓  ${relDest}`);
    } catch {
      if (!flags.dryRun) { mkdirSync(dirname(destPath), { recursive: true }); copyFileSync(srcPath, destPath); }
      console.log(`  ✓  ${relDest} (binary)`);
    }
  } else {
    if (!flags.dryRun) { mkdirSync(dirname(destPath), { recursive: true }); copyFileSync(srcPath, destPath); }
    console.log(`  ✓  ${relDest}`);
  }
}

/**
 * Recursively imports a directory from srcDir into destDir.
 */
export function importDir(srcDir, destDir, flags, home = HOME, prefix = '') {
  const entries = readdirSync(srcDir);
  for (const entry of entries) {
    const srcPath = join(srcDir, entry);
    const destPath = join(destDir, entry);
    const relPath = prefix ? `${prefix}/${entry}` : entry;

    const excluded = flags.exclude || [];
    if (excluded.some(excl => relPath === excl || relPath.startsWith(excl + '/'))) {
      console.warn(`  ⚠  Excluded: ${relPath}`);
      continue;
    }

    const stats = statSync(srcPath);
    if (stats.isDirectory()) {
      if (!flags.dryRun) mkdirSync(destPath, { recursive: true });
      importDir(srcPath, destPath, flags, home, relPath);
    } else {
      importFile(srcPath, destPath, flags, home);
    }
  }
}

/**
 * Backs up the existing ~/.claude directory before import.
 */
export function backupExisting(claudeDir, home, flags) {
  if (!existsSync(claudeDir)) return;
  const backupPath = join(home, `.claude.backup.${Date.now()}`);
  if (flags.dryRun) {
    console.log(`[dry-run] would backup ~/.claude to ${backupPath}`);
    return;
  }
  cpSync(claudeDir, backupPath, { recursive: true });
  console.log(`💾  Backed up ~/.claude → ${basename(backupPath)}`);
}

// ─── High-level wrappers ───────────────────────────────────────────────────────

/**
 * Full export pipeline: collect → stage → sanitize → tar.gz
 * @param {object} options - { includeSessions, includeHistory, includeProjects, includeTelemetry, sanitize }
 * @param {string} outputPath - path for the output .tar.gz file
 * @returns {Promise<string>} resolved output path
 */
export async function buildExportBundle(options, outputPath) {
  const flags = {
    includeSessions: options.includeSessions ?? false,
    includeHistory: options.includeHistory ?? false,
    includeProjects: options.includeProjects ?? false,
    includeTelemetry: options.includeTelemetry ?? false,
    sanitize: options.sanitize !== false,
  };

  const items = buildExportList(flags, CLAUDE_DIR);
  const stagingDir = join(tmpdir(), `claude-migrate-${randomBytes(6).toString('hex')}`);
  mkdirSync(stagingDir, { recursive: true });

  try {
    for (const item of items) {
      copyToStaging(item.fullPath, stagingDir, CLAUDE_DIR, flags, HOME);
    }
    exportClaudeJson(stagingDir, flags, HOME);
    writeManifest(stagingDir, items, flags);

    // Bundle import script if available
    const importScriptPath = join(__dirname, 'migrate-import.js');
    if (existsSync(importScriptPath)) {
      writeFileSync(
        join(stagingDir, 'migrate-import.js'),
        readFileSync(importScriptPath, 'utf8'),
      );
    }

    await tarCreate({ cwd: stagingDir, gzip: true, file: outputPath }, ['.']);
    return outputPath;
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

/**
 * Full import pipeline: extract → validate → backup → write files
 * @param {string} bundlePath - path to .tar.gz bundle
 * @param {object} options - { overwrite, merge, backup, exclude, dryRun, quiet }
 */
export async function importBundle(bundlePath, options = {}) {
  const flags = {
    overwrite: options.overwrite ?? false,
    merge: options.merge !== false,  // default true for programmatic use
    dryRun: options.dryRun ?? false,
    backup: options.backup !== false,
    exclude: options.exclude ?? [],
  };

  if (!existsSync(bundlePath)) throw new Error(`Bundle not found: ${bundlePath}`);

  const stagingDir = join(tmpdir(), `claude-migrate-import-${randomBytes(6).toString('hex')}`);
  mkdirSync(stagingDir, { recursive: true });

  try {
    await extract({ file: bundlePath, cwd: stagingDir });

    const manifestPath = join(stagingDir, 'MANIFEST.json');
    if (!existsSync(manifestPath)) throw new Error('Invalid bundle: missing MANIFEST.json');

    if (flags.backup) backupExisting(CLAUDE_DIR, HOME, flags);
    if (!flags.dryRun) mkdirSync(CLAUDE_DIR, { recursive: true });

    const claudeSrcDir = join(stagingDir, 'claude');
    if (existsSync(claudeSrcDir)) importDir(claudeSrcDir, CLAUDE_DIR, flags, HOME);

    const claudeJsonSrc = join(stagingDir, 'claude.json');
    if (existsSync(claudeJsonSrc)) importFile(claudeJsonSrc, CLAUDE_JSON, flags, HOME);
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}
