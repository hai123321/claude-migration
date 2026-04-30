/**
 * gdrive-client.js — Google Drive API v3 wrapper.
 * All Drive HTTP calls live here. No business logic.
 */

import { createReadStream, createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { google } from 'googleapis';

export const DRIVE_FOLDER_NAME = 'ClaudeCodeMigration';
export const BUNDLE_FILE_NAME = 'claude-config.tar.gz';
export const META_FILE_NAME = 'claude-config-meta.json';

// ─── Typed errors ─────────────────────────────────────────────────────────────

export class DriveAuthError extends Error {
  constructor(msg) { super(msg); this.name = 'DriveAuthError'; }
}
export class DriveNetworkError extends Error {
  constructor(msg) { super(msg); this.name = 'DriveNetworkError'; }
}
export class DriveNotFoundError extends Error {
  constructor(msg) { super(msg); this.name = 'DriveNotFoundError'; }
}

// ─── Retry helper ─────────────────────────────────────────────────────────────

async function withRetry(fn, retries = 3, delayMs = 1000) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isNetwork = err.code === 'ENOTFOUND' || err.code === 'ETIMEDOUT'
        || err.code === 'ECONNRESET' || err.message?.includes('fetch failed');
      const isAuth = err.status === 401 || err.status === 403;

      if (isAuth) throw new DriveAuthError(`Google Drive auth error: ${err.message}`);
      if (attempt === retries) {
        if (isNetwork) throw new DriveNetworkError(`Network error after ${retries + 1} attempts: ${err.message}`);
        throw err;
      }
      if (isNetwork) {
        await new Promise(r => setTimeout(r, delayMs * Math.pow(2, attempt)));
      } else {
        throw err;
      }
    }
  }
}

// ─── Folder management ────────────────────────────────────────────────────────

/**
 * Finds or creates the ClaudeCodeMigration folder in Drive root.
 * Returns the folder ID.
 */
export async function ensureFolder(drive, folderName = DRIVE_FOLDER_NAME) {
  return withRetry(async () => {
    const res = await drive.files.list({
      q: `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id,name)',
      spaces: 'drive',
    });

    if (res.data.files.length > 0) return res.data.files[0].id;

    const folder = await drive.files.create({
      requestBody: {
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder',
        description: 'Claude Code config sync — managed by claude-gdrive-sync',
      },
      fields: 'id',
    });
    return folder.data.id;
  });
}

// ─── File lookup ──────────────────────────────────────────────────────────────

/**
 * Returns the file ID if the named file exists in the folder, else null.
 */
export async function getFileId(drive, folderId, fileName) {
  return withRetry(async () => {
    const res = await drive.files.list({
      q: `name='${fileName}' and '${folderId}' in parents and trashed=false`,
      fields: 'files(id,name)',
      spaces: 'drive',
    });
    return res.data.files.length > 0 ? res.data.files[0].id : null;
  });
}

// ─── Upload ───────────────────────────────────────────────────────────────────

/**
 * Uploads a local file to the Drive folder (creates or updates).
 * Returns the file ID.
 */
export async function uploadFile(drive, folderId, fileName, localPath, mimeType = 'application/octet-stream') {
  return withRetry(async () => {
    const existingId = await getFileId(drive, folderId, fileName);
    const media = { mimeType, body: createReadStream(localPath) };

    if (existingId) {
      const res = await drive.files.update({
        fileId: existingId,
        media,
        fields: 'id',
      });
      return res.data.id;
    }

    const res = await drive.files.create({
      requestBody: { name: fileName, parents: [folderId] },
      media,
      fields: 'id',
    });
    return res.data.id;
  });
}

/**
 * Uploads a JSON object as a Drive file (creates or updates).
 */
export async function uploadJson(drive, folderId, fileName, jsonObj) {
  return withRetry(async () => {
    const existingId = await getFileId(drive, folderId, fileName);
    const body = JSON.stringify(jsonObj, null, 2);
    const { Readable } = await import('stream');
    const stream = Readable.from([body]);
    const media = { mimeType: 'application/json', body: stream };

    if (existingId) {
      const res = await drive.files.update({ fileId: existingId, media, fields: 'id' });
      return res.data.id;
    }

    const res = await drive.files.create({
      requestBody: { name: fileName, parents: [folderId] },
      media,
      fields: 'id',
    });
    return res.data.id;
  });
}

// ─── Download ─────────────────────────────────────────────────────────────────

/**
 * Downloads a Drive file to a local path.
 */
export async function downloadFile(drive, fileId, destPath) {
  return withRetry(async () => {
    const res = await drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'stream' },
    );
    const writer = createWriteStream(destPath);
    await pipeline(res.data, writer);
  });
}

// ─── Metadata ─────────────────────────────────────────────────────────────────

/**
 * Downloads and parses claude-config-meta.json from Drive.
 * Returns the parsed object, or null if the file doesn't exist.
 */
export async function getRemoteMeta(drive, folderId) {
  return withRetry(async () => {
    const fileId = await getFileId(drive, folderId, META_FILE_NAME);
    if (!fileId) return null;

    const res = await drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'text' },
    );
    return JSON.parse(res.data);
  });
}
