#!/usr/bin/env bash
#
# Prepares a Codespace (or any devcontainer) to run Muft Captions.
#
# FFmpeg and FFprobe do all the video work — transcode, waveform, filmstrip,
# thumbnails and the final burn-in — so they are the one hard requirement beyond
# Node. The caption fonts are committed to the repository, so no font download is
# needed for a first run.

set -euo pipefail

echo "Installing FFmpeg..."
sudo apt-get update -qq
sudo apt-get install -y -qq --no-install-recommends ffmpeg

# Only needed to regenerate the fonts (npm run fonts); the committed ones are
# enough to start. Installed anyway so that path works if it is ever needed.
echo "Installing fonttools (for regenerating fonts)..."
python3 -m pip install --quiet --user fonttools brotli 2>/dev/null || \
  echo "  (skipped — 'npm run fonts' will need it, but the committed fonts are fine)"

echo "Installing dependencies..."
npm install --no-audit --no-fund

# Sample projects so the editor has something to open immediately, rather than
# an empty dashboard that gives no sense of what the app does.
echo "Creating sample projects..."
npm run fixtures

if [ ! -f .env ]; then
  cp .env.example .env
  echo
  echo "Created .env from the example. Captions will not generate until it has"
  echo "credentials in it — see the README. The editor, templates, timeline and"
  echo "export all work on the sample projects without them."
fi

echo
echo "Ready. Start it with:  npm start"
echo "Then open the forwarded port 3000."
