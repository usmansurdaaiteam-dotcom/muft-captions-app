const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// 1. Detect V2 directory
let baseDir = '.';
if (fs.existsSync(path.join(baseDir, 'v2', 'public', 'index.html'))) {
  baseDir = path.join(baseDir, 'v2');
} else if (!fs.existsSync(path.join(baseDir, 'public', 'index.html'))) {
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
}

console.log(`Detected active directory: ${path.resolve(baseDir)}`);

// Helper to replace text in a file
function updateFile(filePath, replacements) {
  const fullPath = path.join(baseDir, filePath);
  if (!fs.existsSync(fullPath)) {
     console.warn(`Warning: File not found at ${fullPath}`);
     return;
  }
  let content = fs.readFileSync(fullPath, 'utf8');
  let original = content;
  
  for (const r of replacements) {
     content = content.replace(r.old, r.new);
  }
  
  if (content !== original) {
     fs.writeFileSync(fullPath, content, 'utf8');
     console.log(`Updated: ${filePath}`);
  } else {
     console.log(`No changes needed / Already updated: ${filePath}`);
  }
}

// 2. Update index.html
updateFile('public/index.html', [
  {
    old: '        </div>\n        \n        <!-- Close project/Go Home button: Loaded state only -->',
    new: '        </div>\n        \n        <!-- Undo / Redo controls: Loaded state only -->\n        <button class="topbar-btn secondary loaded-only" id="undoBtn" title="Undo (Ctrl+Z)">\n          ↺ Undo\n        </button>\n        <button class="topbar-btn secondary loaded-only" id="redoBtn" title="Redo (Ctrl+Y)">\n          ↻ Redo\n        </button>\n        \n        <!-- Close project/Go Home button: Loaded state only -->'
  },
  {
    old: '        </div>\r\n        \r\n        <!-- Close project/Go Home button: Loaded state only -->',
    new: '        </div>\r\n        \r\n        <!-- Undo / Redo controls: Loaded state only -->\r\n        <button class="topbar-btn secondary loaded-only" id="undoBtn" title="Undo (Ctrl+Z)">\r\n          ↺ Undo\r\n        </button>\r\n        <button class="topbar-btn secondary loaded-only" id="redoBtn" title="Redo (Ctrl+Y)">\r\n          ↻ Redo\r\n        </button>\r\n        \r\n        <!-- Close project/Go Home button: Loaded state only -->'
  },
  {
    old: '<link rel="stylesheet" href="/style.css" />',
    new: '<link rel="stylesheet" href="/style.css?v=2.0.1" />'
  },
  {
    old: '/template-engine.js',
    new: '/template-engine.js?v=2.0.1'
  },
  {
    old: '/app.js',
    new: '/app.js?v=2.0.1'
  }
]);

// 3. Update style.css
updateFile('public/style.css', [
  {
    old: '  border-radius: var(--radius-sm);\n  transition: all var(--transition);\n}\n.topbar-btn.secondary {',
    new: '  border-radius: var(--radius-sm);\n  transition: all var(--transition);\n}\n.topbar-btn:disabled {\n  opacity: 0.35;\n  pointer-events: none;\n  cursor: not-allowed;\n}\n.topbar-btn.secondary {'
  },
  {
    old: '  border-radius: var(--radius-sm);\r\n  transition: all var(--transition);\r\n}\r\n.topbar-btn.secondary {',
    new: '  border-radius: var(--radius-sm);\r\n  transition: all var(--transition);\r\n}\r\n.topbar-btn:disabled {\r\n  opacity: 0.35;\r\n  pointer-events: none;\r\n  cursor: not-allowed;\r\n}\r\n.topbar-btn.secondary {'
  },
  {
    old: '.word-block-line2 {\n  top: 46px;\n}\n/* Playhead */\n.timeline-playhead {',
    new: '.word-block-line2 {\n  top: 46px;\n}\n.delete-btn {\n  width: 26px;\n  height: 26px;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  background: var(--bg-input);\n  border: 1px solid var(--border);\n  border-radius: 4px;\n  color: var(--text-dim);\n  font-size: 16px;\n  font-weight: bold;\n  transition: all var(--transition);\n  margin-left: 4px;\n  cursor: pointer;\n}\n.delete-btn:hover {\n  background: rgba(239, 68, 68, 0.15);\n  border-color: #ef4444;\n  color: #ef4444;\n}\n/* Playhead */\n.timeline-playhead {'
  },
  {
    old: '.word-block-line2 {\r\n  top: 46px;\r\n}\r\n/* Playhead */\r\n.timeline-playhead {',
    new: '.word-block-line2 {\r\n  top: 46px;\r\n}\r\n.delete-btn {\r\n  width: 26px;\r\n  height: 26px;\r\n  display: flex;\r\n  align-items: center;\r\n  justify-content: center;\r\n  background: var(--bg-input);\r\n  border: 1px solid var(--border);\r\n  border-radius: 4px;\r\n  color: var(--text-dim);\r\n  font-size: 16px;\r\n  font-weight: bold;\r\n  transition: all var(--transition);\r\n  margin-left: 4px;\r\n  cursor: pointer;\r\n}\r\n.delete-btn:hover {\r\n  background: rgba(239, 68, 68, 0.15);\r\n  border-color: #ef4444;\r\n  color: #ef4444;\r\n}\r\n/* Playhead */\r\n.timeline-playhead {'
  }
]);

// 4. Update template-engine.js
updateFile('public/template-engine.js', [
  {
    old: 'function resolvePositions(template, comp, scaleX = 1, scaleY = 1) {\n  const layout = template.layout;\n  const captionX = Math.round(CANVAS_W * (layout.captionCenterX || 0.5));\n  const captionY = Math.round(CANVAS_H * (layout.captionCenterY || 0.52));',
    new: 'function resolvePositions(template, comp, scaleX = 1, scaleY = 1) {\n  const layout = template.layout;\n  const canvasW = template.canvasWidth || 1080;\n  const canvasH = template.canvasHeight || 1920;\n  const captionX = Math.round(canvasW * (layout.captionCenterX || 0.5));\n  const captionY = Math.round(canvasH * (layout.captionCenterY || 0.52));'
  },
  {
    old: 'function resolvePositions(template, comp, scaleX = 1, scaleY = 1) {\r\n  const layout = template.layout;\r\n  const captionX = Math.round(CANVAS_W * (layout.captionCenterX || 0.5));\r\n  const captionY = Math.round(CANVAS_H * (layout.captionCenterY || 0.52));',
    new: 'function resolvePositions(template, comp, scaleX = 1, scaleY = 1) {\r\n  const layout = template.layout;\r\n  const canvasW = template.canvasWidth || 1080;\r\n  const canvasH = template.canvasHeight || 1920;\r\n  const captionX = Math.round(canvasW * (layout.captionCenterX || 0.5));\r\n  const captionY = Math.round(canvasH * (layout.captionCenterY || 0.52));'
  },
  {
    old: 'function renderComposition(ctx, timestampMs, compositions, tokenMap, template, width, height, animationConfig) {\n  const scaleX = width / CANVAS_W;\n  const scaleY = height / CANVAS_H;\n  const scale = scaleX;',
    new: 'function renderComposition(ctx, timestampMs, compositions, tokenMap, template, width, height, animationConfig) {\n  const canvasW = template.canvasWidth || 1080;\n  const canvasH = template.canvasHeight || 1920;\n  const scaleX = width / canvasW;\n  const scaleY = height / canvasH;\n  const scale = scaleX;'
  },
  {
    old: 'function renderComposition(ctx, timestampMs, compositions, tokenMap, template, width, height, animationConfig) {\r\n  const scaleX = width / CANVAS_W;\r\n  const scaleY = height / CANVAS_H;\r\n  const scale = scaleX;',
    new: 'function renderComposition(ctx, timestampMs, compositions, tokenMap, template, width, height, animationConfig) {\r\n  const canvasW = template.canvasWidth || 1080;\r\n  const canvasH = template.canvasHeight || 1920;\r\n  const scaleX = width / canvasW;\r\n  const scaleY = height / canvasH;\r\n  const scale = scaleX;'
  }
]);

// 5. Update src/template-engine.js
updateFile('src/template-engine.js', [
  {
    old: 'function resolvePositions(template, comp, scaleX = 1, scaleY = 1) {\n  const layout = template.layout;\n  const captionY = Math.round(CANVAS_H * (layout.captionCenterY || 0.52));',
    new: 'function resolvePositions(template, comp, scaleX = 1, scaleY = 1) {\n  const layout = template.layout;\n  const canvasW = template.canvasWidth || 1080;\n  const canvasH = template.canvasHeight || 1920;\n  const captionX = Math.round(canvasW * (layout.captionCenterX || 0.5));\n  const captionY = Math.round(canvasH * (layout.captionCenterY || 0.52));'
  },
  {
    old: 'x: CENTER_X * scaleX,\n        y: captionY * scaleY,',
    new: 'x: captionX * scaleX,\n        y: captionY * scaleY,'
  },
  {
    old: 'x: CENTER_X * scaleX,\r\n        y: captionY * scaleY,',
    new: 'x: captionX * scaleX,\r\n        y: captionY * scaleY,'
  },
  {
    old: 'beforeY * scaleY,\n      textAlign: \'left\'\n    } : null,\n    hero: {\n      x: CENTER_X * scaleX,\n      y: heroY * scaleY,\n      textAlign: \'center\'\n    },\n    after: comp.after_text ? {\n      x: CENTER_X * scaleX,\n      y: afterY * scaleY,',
    new: 'beforeY * scaleY,\n      textAlign: \'left\'\n    } : null,\n    hero: {\n      x: captionX * scaleX,\n      y: heroY * scaleY,\n      textAlign: \'center\'\n    },\n    after: comp.after_text ? {\n      x: captionX * scaleX,\n      y: afterY * scaleY,'
  },
  {
    old: 'beforeY * scaleY,\r\n      textAlign: \'left\'\r\n    } : null,\r\n    hero: {\r\n      x: CENTER_X * scaleX,\r\n      y: heroY * scaleY,\r\n      textAlign: \'center\'\r\n    },\r\n    after: comp.after_text ? {\r\n      x: CENTER_X * scaleX,\r\n      y: afterY * scaleY,',
    new: 'beforeY * scaleY,\r\n      textAlign: \'left\'\r\n    } : null,\r\n    hero: {\r\n      x: captionX * scaleX,\r\n      y: heroY * scaleY,\r\n      textAlign: \'center\'\r\n    },\r\n    after: comp.after_text ? {\r\n      x: captionX * scaleX,\r\n      y: afterY * scaleY,'
  },
  {
    old: 'function renderComposition(ctx, timestampMs, compositions, tokenMap, template, width, height, animationConfig) {\n  const scaleX = width / CANVAS_W;\n  const scaleY = height / CANVAS_H;',
    new: 'function renderComposition(ctx, timestampMs, compositions, tokenMap, template, width, height, animationConfig) {\n  const canvasW = template.canvasWidth || 1080;\n  const canvasH = template.canvasHeight || 1920;\n  const scaleX = width / canvasW;\n  const scaleY = height / canvasH;'
  }
]);

// 6. Update public/app.js
const appPath = path.join(baseDir, 'public', 'app.js');
if (fs.existsSync(appPath)) {
  let appCode = fs.readFileSync(appPath, 'utf8');
  
  appCode = appCode.replace('  undoStack: [],\n  redoStack: [],\n  // Template', '  undoStack: [],\n  redoStack: [],\n  baseCanvasWidth: 1080,\n  baseCanvasHeight: 1920,\n  // Template');
  appCode = appCode.replace('  undoStack: [],\r\n  redoStack: [],\r\n  // Template', '  undoStack: [],\r\n  redoStack: [],\r\n  baseCanvasWidth: 1080,\r\n  baseCanvasHeight: 1920,\r\n  // Template');

  const pushStateOld = 'let lastPushTime = 0;\nfunction pushUndoState() {\n  if (!state.template) return;\n  const now = Date.now();\n  if (now - lastPushTime < 300) return;\n  lastPushTime = now;\n  if (state.undoStack.length >= 50) {\n    state.undoStack.shift();\n  }\n  state.undoStack.push(JSON.stringify({\n    tokens: state.tokens,\n    compositions: state.compositions,\n    template: state.template\n  }));\n  state.redoStack = []; // Clear redo stack on new action\n}';
  const pushStateNew = 'let lastPushTime = 0;\nfunction updateUndoRedoButtons() {\n  const undoBtn = $(\'undoBtn\');\n  const redoBtn = $(\'redoBtn\');\n  if (undoBtn) undoBtn.disabled = state.undoStack.length === 0;\n  if (redoBtn) redoBtn.disabled = state.redoStack.length === 0;\n}\nfunction pushUndoState() {\n  if (!state.template) return;\n  const now = Date.now();\n  if (now - lastPushTime < 300) return;\n  lastPushTime = now;\n  if (state.undoStack.length >= 50) {\n    state.undoStack.shift();\n  }\n  state.undoStack.push(JSON.stringify({\n    tokens: state.tokens,\n    compositions: state.compositions,\n    template: state.template\n  }));\n  state.redoStack = [];\n  updateUndoRedoButtons();\n}';
  appCode = appCode.replace(pushStateOld, pushStateNew);
  appCode = appCode.replace(pushStateOld.replace(/\n/g, '\r\n'), pushStateNew.replace(/\n/g, '\r\n'));

  appCode = appCode.replace('    state.template = data.template;\n    \n    if (state.template) {', '    state.template = data.template;\n    \n    state.undoStack = [];\n    state.redoStack = [];\n    updateUndoRedoButtons();\n    \n    if (state.template) {');
  appCode = appCode.replace('    state.template = data.template;\r\n    \r\n    if (state.template) {', '    state.template = data.template;\r\n    \r\n    state.undoStack = [];\r\n    state.redoStack = [];\r\n    updateUndoRedoButtons();\r\n    \r\n    if (state.template) {');

  const metadataOld = '  const onMetadataLoaded = () => {\n    state.videoDuration = videoPlayer.duration;\n    updateTimeDisplay();\n    renderTimeline();\n  };\n  videoPlayer.addEventListener(\'loadedmetadata\', onMetadataLoaded);\n  \n  videoPlayer.src = state.videoUrl;\n  videoPlayer.load();\n  // If already loaded / cached\n  if (videoPlayer.duration) {\n    state.videoDuration = videoPlayer.duration;\n    updateTimeDisplay();\n    renderTimeline();\n  }';
  const metadataNew = '  const onMetadataLoaded = () => {\n    state.videoDuration = videoPlayer.duration;\n    const isLandscape = videoPlayer.videoWidth > videoPlayer.videoHeight;\n    const w = isLandscape ? 1920 : 1080;\n    const h = isLandscape ? 1080 : 1920;\n    state.baseCanvasWidth = w;\n    state.baseCanvasHeight = h;\n    const container = $(\'videoContainer\');\n    if (container) {\n      container.style.aspectRatio = `${videoPlayer.videoWidth} / ${videoPlayer.videoHeight}`;\n    }\n    applyLowResMode();\n    if (state.template) {\n      if (state.template.canvasWidth !== w || state.template.canvasHeight !== h) {\n        state.template.canvasWidth = w;\n        state.template.canvasHeight = h;\n        saveProjectState();\n      }\n    }\n    updateTimeDisplay();\n    renderTimeline();\n  };\n  videoPlayer.addEventListener(\'loadedmetadata\', onMetadataLoaded);\n  \n  videoPlayer.src = state.videoUrl;\n  videoPlayer.load();\n  if (videoPlayer.duration) {\n    state.videoDuration = videoPlayer.duration;\n    const isLandscape = videoPlayer.videoWidth > videoPlayer.videoHeight;\n    const w = isLandscape ? 1920 : 1080;\n    const h = isLandscape ? 1080 : 1920;\n    state.baseCanvasWidth = w;\n    state.baseCanvasHeight = h;\n    const container = $(\'videoContainer\');\n    if (container) {\n      container.style.aspectRatio = `${videoPlayer.videoWidth} / ${videoPlayer.videoHeight}`;\n    }\n    applyLowResMode();\n    if (state.template) {\n      if (state.template.canvasWidth !== w || state.template.canvasHeight !== h) {\n        state.template.canvasWidth = w;\n        state.template.canvasHeight = h;\n        saveProjectState();\n      }\n    }\n    updateTimeDisplay();\n    renderTimeline();\n  }';
  appCode = appCode.replace(metadataOld, metadataNew);
  appCode = appCode.replace(metadataOld.replace(/\n/g, '\r\n'), metadataNew.replace(/\n/g, '\r\n'));

  appCode = appCode.replace('  state.videoDuration = 0;\n  state.currentTime = 0;\n  \n  videoPlayer.src = \'\';', '  state.videoDuration = 0;\n  state.currentTime = 0;\n  state.undoStack = [];\n  state.redoStack = [];\n  updateUndoRedoButtons();\n  \n  videoPlayer.src = \'\';');

  const layoutOld = '    layoutDiv.appendChild(layoutBtn);\n    line.appendChild(layoutDiv);';
  const layoutNew = '    layoutDiv.appendChild(layoutBtn);\n    const deleteBtn = document.createElement(\'button\');\n    deleteBtn.className = \'delete-btn\';\n    deleteBtn.textContent = \'×\';\n    deleteBtn.title = \'Delete line\';\n    deleteBtn.addEventListener(\'click\', e => {\n      e.stopPropagation();\n      pushUndoState();\n      state.tokens = state.tokens.filter(t => !comp.token_ids.includes(t.id));\n      state.compositions.splice(idx, 1);\n      saveProjectState();\n      renderCaptionList();\n      renderTimeline();\n      renderCaptions();\n    });\n    layoutDiv.appendChild(deleteBtn);\n    line.appendChild(layoutDiv);';
  appCode = appCode.replace(layoutOld, layoutNew);
  appCode = appCode.replace(layoutOld.replace(/\n/g, '\r\n'), layoutNew.replace(/\n/g, '\r\n'));

  appCode = appCode.replace('  const centerX = 1080 * layout.captionCenterX;', '  const centerX = state.baseCanvasWidth * layout.captionCenterX;');
  appCode = appCode.replace('  const centerY = 1920 * layout.captionCenterY;', '  const centerY = state.baseCanvasHeight * layout.captionCenterY;');
  appCode = appCode.replace('    const scaleX = 1080 / rect.width;', '    const scaleX = state.baseCanvasWidth / rect.width;');
  appCode = appCode.replace('    const scaleY = 1920 / rect.height;', '    const scaleY = state.baseCanvasHeight / rect.height;');

  const lowResOld = 'function applyLowResMode() {\n  const isLowRes = $(\'lowResToggle\').checked;\n  if (isLowRes) {\n    captionCanvas.width = 540;\n    captionCanvas.height = 960;\n  } else {\n    captionCanvas.width = 1080;\n    captionCanvas.height = 1920;\n  }\n  renderCaptions();\n}';
  const lowResNew = 'function applyLowResMode() {\n  const isLowRes = $(\'lowResToggle\').checked;\n  const factor = isLowRes ? 0.5 : 1.0;\n  captionCanvas.width = state.baseCanvasWidth * factor;\n  captionCanvas.height = state.baseCanvasHeight * factor;\n  renderCaptions();\n}';
  appCode = appCode.replace(lowResOld, lowResNew);
  appCode = appCode.replace(lowResOld.replace(/\n/g, '\r\n'), lowResNew.replace(/\n/g, '\r\n'));

  const keyHandlerOld = 'window.addEventListener(\'keydown\', e => {\n  const activeTag = document.activeElement ? document.activeElement.tagName.toLowerCase() : \'\';\n  const isEditingText = activeTag === \'input\' || activeTag === \'textarea\' || (document.activeElement && document.activeElement.contentEditable === \'true\');\n  \n  if (e.ctrlKey && !e.altKey) {\n    if (e.key.toLowerCase() === \'z\') {\n      if (isEditingText) return;\n      e.preventDefault();\n      \n      if (state.undoStack.length > 0) {\n        state.redoStack.push(JSON.stringify({\n          tokens: state.tokens,\n          compositions: state.compositions,\n          template: state.template\n        }));\n        \n        const popped = JSON.parse(state.undoStack.pop());\n        state.tokens = popped.tokens;\n        state.compositions = popped.compositions;\n        state.template = popped.template;\n        \n        if (state.template) {\n          if ($(\'heroSizeSlider\')) {\n            $(\'heroSizeSlider\').value = state.template.hero.fontSize;\n            $(\'heroSizeVal\').textContent = state.template.hero.fontSize;\n          }\n          if ($(\'supportSizeSlider\')) {\n            $(\'supportSizeSlider\').value = state.template.support.fontSize;\n            $(\'supportSizeVal\').textContent = state.template.support.fontSize;\n          }\n          if ($(\'heroColorPicker\')) $(\'heroColorPicker\').value = state.template.hero.color;\n          if ($(\'supportColorPicker\')) $(\'supportColorPicker\').value = state.template.support.color;\n          if ($(\'fontSelect\')) {\n            const match = Array.from($(\'fontSelect\').options).find(opt => opt.value.includes(state.template.hero.fontFamily));\n            if (match) $(\'fontSelect\').value = match.value;\n          }\n        }\n        \n        saveProjectState();\n        renderCaptionList();\n        renderTimeline();\n        renderCaptions();\n      }\n    } else if (e.key.toLowerCase() === \'y\') {\n      if (isEditingText) return;\n      e.preventDefault();\n      \n      if (state.redoStack.length > 0) {\n        state.undoStack.push(JSON.stringify({\n          tokens: state.tokens,\n          compositions: state.compositions,\n          template: state.template\n        }));\n        \n        const popped = JSON.parse(state.redoStack.pop());\n        state.tokens = popped.tokens;\n        state.compositions = popped.compositions;\n        state.template = popped.template;\n        \n        if (state.template) {\n          if ($(\'heroSizeSlider\')) {\n            $(\'heroSizeSlider\').value = state.template.hero.fontSize;\n          }\n          if ($(\'supportSizeSlider\')) {\n            $(\'supportSizeSlider\').value = state.template.support.fontSize;\n          }\n          if ($(\'heroColorPicker\')) $(\'heroColorPicker\').value = state.template.hero.color;\n          if ($(\'supportColorPicker\')) $(\'supportColorPicker\').value = state.template.support.color;\n        }\n        \n        saveProjectState();\n        renderCaptionList();\n        renderTimeline();\n        renderCaptions();\n      }\n    }\n  }\n});';
  const keyHandlerNew = 'function triggerUndo() {\n  if (state.undoStack.length > 0) {\n    state.redoStack.push(JSON.stringify({\n      tokens: state.tokens,\n      compositions: state.compositions,\n      template: state.template\n    }));\n    const popped = JSON.parse(state.undoStack.pop());\n    state.tokens = popped.tokens;\n    state.compositions = popped.compositions;\n    state.template = popped.template;\n    if (state.template) {\n      if ($(\'heroSizeSlider\')) {\n        $(\'heroSizeSlider\').value = state.template.hero.fontSize;\n        $(\'heroSizeVal\').textContent = state.template.hero.fontSize;\n      }\n      if ($(\'supportSizeSlider\')) {\n        $(\'supportSizeSlider\').value = state.template.support.fontSize;\n        $(\'supportSizeVal\').textContent = state.template.support.fontSize;\n      }\n      if ($(\'heroColorPicker\')) $(\'heroColorPicker\').value = state.template.hero.color;\n      if ($(\'supportColorPicker\')) $(\'supportColorPicker\').value = state.template.support.color;\n      if ($(\'fontSelect\')) {\n        const match = Array.from($(\'fontSelect\').options).find(opt => opt.value.includes(state.template.hero.fontFamily));\n        if (match) $(\'fontSelect\').value = match.value;\n      }\n    }\n    updateUndoRedoButtons();\n    saveProjectState();\n    renderCaptionList();\n    renderTimeline();\n    renderCaptions();\n  }\n}\nfunction triggerRedo() {\n  if (state.redoStack.length > 0) {\n    state.undoStack.push(JSON.stringify({\n      tokens: state.tokens,\n      compositions: state.compositions,\n      template: state.template\n    }));\n    const popped = JSON.parse(state.redoStack.pop());\n    state.tokens = popped.tokens;\n    state.compositions = popped.compositions;\n    state.template = popped.template;\n    if (state.template) {\n      if ($(\'heroSizeSlider\')) {\n        $(\'heroSizeSlider\').value = state.template.hero.fontSize;\n        $(\'heroSizeVal\').textContent = state.template.hero.fontSize;\n      }\n      if ($(\'supportSizeSlider\')) {\n        $(\'supportSizeSlider\').value = state.template.support.fontSize;\n        $(\'supportSizeVal\').textContent = state.template.support.fontSize;\n      }\n      if ($(\'heroColorPicker\')) $(\'heroColorPicker\').value = state.template.hero.color;\n      if ($(\'supportColorPicker\')) $(\'supportColorPicker\').value = state.template.support.color;\n      if ($(\'fontSelect\')) {\n        const match = Array.from($(\'fontSelect\').options).find(opt => opt.value.includes(state.template.hero.fontFamily));\n        if (match) $(\'fontSelect\').value = match.value;\n      }\n    }\n    updateUndoRedoButtons();\n    saveProjectState();\n    renderCaptionList();\n    renderTimeline();\n    renderCaptions();\n  }\n}\nwindow.addEventListener(\'keydown\', e => {\n  const activeTag = document.activeElement ? document.activeElement.tagName.toLowerCase() : \'\';\n  const isEditingText = activeTag === \'input\' || activeTag === \'textarea\' || (document.activeElement && document.activeElement.contentEditable === \'true\');\n  if (e.ctrlKey && !e.altKey) {\n    if (e.key.toLowerCase() === \'z\') {\n      if (isEditingText) return;\n      e.preventDefault();\n      triggerUndo();\n    } else if (e.key.toLowerCase() === \'y\') {\n      if (isEditingText) return;\n      e.preventDefault();\n      triggerRedo();\n    }\n  }\n});\n$(\'undoBtn\').addEventListener(\'click\', () => { triggerUndo(); });\n$(\'redoBtn\').addEventListener(\'click\', () => { triggerRedo(); });';
  appCode = appCode.replace(keyHandlerOld, keyHandlerNew);
  appCode = appCode.replace(keyHandlerOld.replace(/\n/g, '\r\n'), keyHandlerNew.replace(/\n/g, '\r\n'));

  // Move DOM Refs to top
  const domRefsBlock = `
// ─── DOM Refs ───────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const uploadForm = $('uploadForm');
const mediaInput = $('mediaInput');
const uploadZone = $('uploadZone');
const uploadSelected = $('uploadSelected');
const uploadBtn = $('uploadBtn');
const processingState = $('processingState');
const processingTitle = $('processingTitle');
const processingDetail = $('processingDetail');
const captionList = $('captionList');
const videoPlayer = $('videoPlayer');
const captionCanvas = $('captionCanvas');
const ctx = captionCanvas ? captionCanvas.getContext('2d') : null;
const playPauseBtn = $('playPauseBtn');
const playIcon = $('playIcon');
const pauseIcon = $('pauseIcon');
const timeDisplay = $('timeDisplay');
const topbarFilename = $('topbarFilename');
const timelineContent = $('timelineContent');
const timelineViewport = $('timelineViewport');
const timeRuler = $('timeRuler');
const wordTrack = $('wordTrack');
const timelinePlayhead = $('timelinePlayhead');
const exportModal = $('exportModal');
const exportProgressFill = $('exportProgressFill');
const exportStatus = $('exportStatus');
const exportPercent = $('exportPercent');
`;

  // Remove the old duplicate DOM Refs block (both CR+LF and LF formats)
  const oldDomBlockLF = /\/\/ ─── DOM Refs ───[\s\S]*?exportPercent = \$\('exportPercent'\);/g;
  appCode = appCode.replace(oldDomBlockLF, '');

  appCode = appCode.replace('// ─── State ───', domRefsBlock + '\n\n// ─── State ───');
  appCode = appCode.replace('// ─── State ───'.replace(/\n/g, '\r\n'), domRefsBlock.replace(/\n/g, '\r\n') + '\r\n\r\n// ─── State ───');

  fs.writeFileSync(appPath, appCode, 'utf8');
  console.log('Updated: public/app.js');
}

// 7. Restart PM2
try {
  console.log('Restarting PM2 process...');
  execSync('pm2 restart muft-captions', { stdio: 'inherit' });
  console.log('Successfully restarted PM2!');
} catch (err) {
  console.warn('Could not restart PM2 automatically. Please run: pm2 restart muft-captions');
}
