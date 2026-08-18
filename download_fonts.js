import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const fontsDir = path.join(__dirname, 'fonts');

const downloads = [
  {
    url: 'https://raw.githubusercontent.com/google/fonts/main/ofl/inter/static/Inter-Black.ttf',
    dest: path.join(fontsDir, 'Inter-Black.ttf')
  },
  {
    url: 'https://raw.githubusercontent.com/google/fonts/main/ofl/inter/static/Inter-ExtraBold.ttf',
    dest: path.join(fontsDir, 'Inter-ExtraBold.ttf')
  }
];

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        // Follow redirect
        downloadFile(res.headers.location, dest).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`Failed to download ${url}: HTTP ${res.statusCode}`));
        return;
      }
      const fileStream = fs.createWriteStream(dest);
      res.pipe(fileStream);
      fileStream.on('finish', () => {
        fileStream.close();
        console.log(`Successfully downloaded: ${path.basename(dest)}`);
        resolve();
      });
    }).on('error', (err) => {
      reject(err);
    });
  });
}

async function run() {
  try {
    for (const item of downloads) {
      console.log(`Downloading ${item.url}...`);
      await downloadFile(item.url, item.dest);
    }
    console.log('All downloads completed successfully!');
  } catch (err) {
    console.error('Download failed:', err);
  }
}

run();
