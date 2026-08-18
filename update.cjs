const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

let baseDir = '.';
const paths = [
  'C:\\Users\\Administrator\\Desktop\\muft-captions-mvp\\v2',
  'C:\\muft-captions-v2\\v2',
  'C:\\Users\\Administrator\\Desktop\\muft-captions-mvp',
  'C:\\muft-captions-v2'
];
for (const p of paths) {
  if (fs.existsSync(path.join(p, 'public', 'index.html'))) {
    baseDir = p;
    break;
  }
}

console.log(`Detected active directory: ${path.resolve(baseDir)}`);

// 1. Update public/app.js (Escape unicode layout/delete characters)
const appPath = path.join(baseDir, 'public', 'app.js');
if (fs.existsSync(appPath)) {
  let code = fs.readFileSync(appPath, 'utf8');
  
  // Replace layoutBtn textContent with escaped unicode (⊞)
  code = code.replace(/layoutBtn\.textContent\s*=\s*['"][^'"]+['"];/g, "layoutBtn.textContent = '\\u229E';");
  
  // Replace deleteBtn textContent with escaped unicode (×)
  code = code.replace(/deleteBtn\.textContent\s*=\s*['"][^'"]+['"];/g, "deleteBtn.textContent = '\\u00D7';");
  
  fs.writeFileSync(appPath, code, 'utf8');
  console.log('Fixed public/app.js button symbols!');
}

// 2. Update public/style.css (Align layout & delete buttons horizontally)
const cssPath = path.join(baseDir, 'public', 'style.css');
if (fs.existsSync(cssPath)) {
  let css = fs.readFileSync(cssPath, 'utf8');
  
  // Replace layout class body to enable flex row layout
  css = css.replace(/\.caption-line-layout\s*\{[^}]*\}/g, '.caption-line-layout {\n  display: flex !important;\n  flex-direction: row !important;\n  align-items: center !important;\n  gap: 6px !important;\n  flex-shrink: 0 !important;\n}');
  
  // Append delete-btn styling if not already present
  if (!css.includes('.delete-btn')) {
    css += `
.delete-btn {
  width: 26px;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text-dim);
  font-size: 16px;
  font-weight: bold;
  transition: all var(--transition);
  cursor: pointer;
}
.delete-btn:hover {
  background: rgba(239, 68, 68, 0.15) !important;
  border-color: #ef4444 !important;
  color: #ef4444 !important;
}
`;
  }
  
  fs.writeFileSync(cssPath, css, 'utf8');
  console.log('Fixed public/style.css layout & delete styling!');
}

// 3. Restart PM2
try {
  execSync('pm2 restart muft-captions', { stdio: 'inherit' });
  console.log('PM2 restarted successfully!');
} catch (err) {
  console.warn('Could not restart PM2 automatically.');
}
