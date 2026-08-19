/**
 * load-env.js
 *
 * Loads a .env file from the project root if one exists.
 *
 * Imported for its side effect, and imported first, so that every module that
 * reads process.env at import time sees the file's values.
 *
 * Node can do this natively with --env-file, but that flag makes the process
 * exit when the file is absent, which would break a checkout that has not been
 * configured yet. Credentials are optional here: without them the app still
 * runs, it just cannot transcribe or compose.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = path.join(ROOT, '.env');

export const envFileLoaded = (() => {
  if (!existsSync(ENV_PATH)) return false;
  try {
    // Available from Node 20.12 / 21.7. Values already in the environment win,
    // which keeps `PORT=3111 npm start` working over whatever the file says.
    process.loadEnvFile(ENV_PATH);
    return true;
  } catch (err) {
    console.warn(`[env] Could not read .env: ${err.message}`);
    return false;
  }
})();

export { ENV_PATH };
