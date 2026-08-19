/**
 * maintenance.js
 *
 * Disk housekeeping.
 *
 * Nothing previously removed anything: source videos stayed after their project
 * was deleted, finished exports stayed if the server restarted before their
 * cleanup timer fired, and derived waveforms and filmstrips accumulated for
 * every video ever uploaded. On a small VPS that fills the disk and the app
 * simply stops working.
 */

import { readdir, stat, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

/** Exports are disposable; anything older than this is safe to remove. */
const EXPORT_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * An upload with no project pointing at it is only kept briefly, because a file
 * that has just been uploaded may not have a project saved for it yet.
 */
const ORPHAN_GRACE_MS = 60 * 60 * 1000;

async function directorySize(dir) {
  let bytes = 0;
  let files = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return { bytes, files };
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await directorySize(full);
      bytes += nested.bytes;
      files += nested.files;
    } else {
      try {
        const info = await stat(full);
        bytes += info.size;
        files++;
      } catch { /* vanished mid-scan */ }
    }
  }
  return { bytes, files };
}

/** Filenames in uploads/ that a saved project still refers to. */
async function referencedUploads(projectsDir) {
  const referenced = new Set();
  let entries;
  try {
    entries = await readdir(projectsDir);
  } catch {
    return referenced;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    try {
      const project = JSON.parse(await readFile(path.join(projectsDir, entry), 'utf-8'));
      if (project.videoUrl) {
        referenced.add(path.basename(String(project.videoUrl).replace(/^\/uploads\//, '')));
      }
    } catch { /* skip unreadable project */ }
  }
  return referenced;
}

export async function getStorageReport({ uploadsDir, projectsDir, cacheDir }) {
  const [uploads, cache, projectEntries] = await Promise.all([
    directorySize(uploadsDir),
    directorySize(cacheDir),
    readdir(projectsDir).catch(() => [])
  ]);

  const referenced = await referencedUploads(projectsDir);
  let orphanBytes = 0;
  let orphanFiles = 0;
  let exportBytes = 0;
  let exportFiles = 0;

  const now = Date.now();
  for (const name of await readdir(uploadsDir).catch(() => [])) {
    const full = path.join(uploadsDir, name);
    let info;
    try {
      info = await stat(full);
    } catch {
      continue;
    }
    if (!info.isFile()) continue;

    if (name.startsWith('export-')) {
      exportBytes += info.size;
      exportFiles++;
    } else if (!referenced.has(name) && now - info.mtimeMs > ORPHAN_GRACE_MS) {
      orphanBytes += info.size;
      orphanFiles++;
    }
  }

  return {
    projects: projectEntries.filter(f => f.endsWith('.json')).length,
    uploads,
    cache,
    reclaimable: {
      bytes: orphanBytes + exportBytes,
      orphanFiles,
      orphanBytes,
      exportFiles,
      exportBytes
    },
    totalBytes: uploads.bytes + cache.bytes
  };
}

/**
 * Remove finished exports, uploads no project refers to, and stale cache files.
 *
 * `manual` is set when a person asked for this. In that case finished exports go
 * regardless of age: they have already been downloaded and are trivial to
 * regenerate, and holding them back would mean the button frees less than the
 * amount it offered, or nothing at all.
 */
export async function runCleanup({ uploadsDir, projectsDir, cacheDir, manual = false }) {
  const referenced = await referencedUploads(projectsDir);
  const removed = { exports: 0, orphans: 0, cache: 0, bytes: 0 };
  const now = Date.now();
  const exportAgeLimit = manual ? 0 : EXPORT_MAX_AGE_MS;

  for (const name of await readdir(uploadsDir).catch(() => [])) {
    const full = path.join(uploadsDir, name);
    let info;
    try {
      info = await stat(full);
    } catch {
      continue;
    }
    if (!info.isFile()) continue;

    const isStaleExport = name.startsWith('export-') && now - info.mtimeMs >= exportAgeLimit;
    const isOrphan = !name.startsWith('export-')
      && !referenced.has(name)
      && now - info.mtimeMs > ORPHAN_GRACE_MS;

    if (isStaleExport || isOrphan) {
      await rm(full, { force: true }).catch(() => {});
      removed.bytes += info.size;
      if (isStaleExport) removed.exports++;
      else removed.orphans++;
    }
  }

  // Cache entries are named after a hash of the source file, so an entry whose
  // source is gone can be identified by no upload still hashing to it. Rather
  // than recompute every hash, drop cache files older than the newest upload
  // they could belong to only when no uploads remain at all; otherwise prune by
  // age, which is safe because they regenerate on demand.
  const uploadNames = await readdir(uploadsDir).catch(() => []);
  const cacheAgeLimit = uploadNames.length ? 30 * 24 * 60 * 60 * 1000 : 0;
  for (const name of await readdir(cacheDir).catch(() => [])) {
    const full = path.join(cacheDir, name);
    try {
      const info = await stat(full);
      if (now - info.mtimeMs > cacheAgeLimit) {
        await rm(full, { force: true }).catch(() => {});
        removed.cache++;
        removed.bytes += info.size;
      }
    } catch { /* vanished */ }
  }

  return removed;
}

export { EXPORT_MAX_AGE_MS, ORPHAN_GRACE_MS };
