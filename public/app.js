/**
 * Muft Captions V2 â€” Frontend Editor
 * Kalakar-style caption editor with word-level timing, hero word emphasis, and MP4 export.
 */

// â”€â”€â”€ Authentication & VPS Protection â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const originalFetch = window.fetch;
window.fetch = async function (url, options = {}) {
  const token = localStorage.getItem('muft_auth_token');
  options.headers = options.headers || {};
  
  if (url.startsWith('/api/')) {
    if (token) {
      options.headers['x-access-token'] = token;
    }
  }
  
  const response = await originalFetch(url, options);
  if (url.startsWith('/api/') && response.status === 401 && url !== '/api/auth') {
    localStorage.removeItem('muft_auth_token');
    showPasswordPrompt();
  }
  return response;
};

/** Transient message in the corner. Used instead of alert() for non-blocking news. */
function showNotice(message, kind = 'info', durationMs = 9000) {
  let host = document.getElementById('noticeStack');
  if (!host) {
    host = document.createElement('div');
    host.id = 'noticeStack';
    host.className = 'notice-stack';
    document.body.appendChild(host);
  }

  const notice = document.createElement('div');
  notice.className = `notice notice-${kind}`;
  notice.textContent = message;

  const dismiss = document.createElement('button');
  dismiss.className = 'notice-close';
  dismiss.setAttribute('aria-label', 'Dismiss');
  dismiss.textContent = '\u00D7';
  dismiss.addEventListener('click', () => notice.remove());
  notice.appendChild(dismiss);

  host.appendChild(notice);
  setTimeout(() => notice.remove(), durationMs);
}

function showPasswordPrompt() {
  const overlay = document.getElementById('passwordOverlay');
  if (overlay) {
    overlay.classList.remove('hidden');
    document.getElementById('passwordInput').value = '';
    document.getElementById('passwordError').classList.add('hidden');
  }
}

// Check auth status on load
document.addEventListener('DOMContentLoaded', () => {
  // Confirm the session before asking for any project data. Fetching the
  // project list first produced a guaranteed 401 on every cold load.
  fetch('/api/auth/status')
    .then(r => r.json())
    .then(data => {
      if (data.authenticated) {
        if (data.token) localStorage.setItem('muft_auth_token', data.token);
        loadProjectsList();
      } else {
        localStorage.removeItem('muft_auth_token');
        showPasswordPrompt();
      }
    })
    .catch(err => {
      console.error('[Auth] Could not reach the server:', err);
      showPasswordPrompt();
    });

  const passwordForm = document.getElementById('passwordForm');
  if (passwordForm) {
    passwordForm.addEventListener('submit', async e => {
      e.preventDefault();
      const password = document.getElementById('passwordInput').value;
      const errorMsg = document.getElementById('passwordError');
      
      try {
        const response = await fetch('/api/auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password })
        });
        const data = await response.json();
        
        if (response.ok && data.token) {
          localStorage.setItem('muft_auth_token', data.token);
          document.getElementById('passwordOverlay').classList.add('hidden');
          loadProjectsList();
        } else {
          errorMsg.classList.remove('hidden');
        }
      } catch (err) {
        errorMsg.textContent = 'Server connection failed.';
        errorMsg.classList.remove('hidden');
      }
    });
  }
});

// â”€â”€â”€ State â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const state = {
  projectId: null,
  tokens: [],
  compositions: [],
  videoUrl: '',
  filename: '',
  videoDuration: 0,
  currentTime: 0,
  isPlaying: false,
  activeCompositionId: null,
  viewMode: 'word', // 'word' | 'line'
  zoomLevel: 100,
  // Undo/Redo stacks
  undoStack: [],
  redoStack: [],
  baseCanvasWidth: 1080,
  baseCanvasHeight: 1920,
  // Which template this project uses, plus the user's tweaks on top of it.
  // `template` is always derived from these two and never edited directly, so
  // it can be rebuilt from a project file at any time.
  templateId: 'muft-default',
  styleOverrides: {},
  template: null,
  templateList: [],
  templateCategory: 'All',
  templateQuery: '',
  // Export
  exporting: false,
  exportJobId: null,
  // Selected tokens for multi-select
  selectedTokenIds: [],
  userHoveringCaptions: false
};

/**
 * Fonts already asked for, so each is only requested once.
 *
 * Drawing to a canvas does not trigger an @font-face download the way DOM text
 * does — the canvas silently falls back to a system face instead. That made the
 * preview measure and lay out with the wrong font while the export used the
 * real one, so the two disagreed on wrapping and size. Each font a template
 * needs is therefore loaded explicitly before it is relied on.
 */
const requestedFonts = new Set();

async function ensureCaptionFont(family, weight) {
  if (!window.CaptionFonts || !document.fonts) return;

  const resolved = window.CaptionFonts.resolveFont(family, weight);
  const specs = [
    `400 40px "${window.CaptionFonts.aliasFor(resolved.family, resolved.weight)}"`,
    `400 40px "${window.CaptionFonts.ARABIC_FALLBACK_ALIAS}"`
  ].filter(spec => !requestedFonts.has(spec));

  if (!specs.length) return;
  for (const spec of specs) requestedFonts.add(spec);

  try {
    await Promise.all(specs.map(spec => document.fonts.load(spec)));
    // Measurements taken with the fallback face are now stale.
    if (window.CaptionRenderer) window.CaptionRenderer.clearLayoutCache();
    renderCaptions();
  } catch (err) {
    console.warn('[fonts] Could not load a caption font:', err);
  }
}

/** Rebuild the resolved template from the template id plus overrides. */
function refreshTemplate() {
  if (!window.CaptionTemplates || !window.applyStyleOverrides) return;
  const base = window.CaptionTemplates.getTemplate(state.templateId);
  state.template = window.applyStyleOverrides(base, state.styleOverrides);
  if (window.CaptionRenderer) window.CaptionRenderer.clearLayoutCache();
  ensureCaptionFont(state.template.font.family, state.template.font.weight);
}

// â”€â”€â”€ Project Database & Autosave API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function saveProjectState() {
  if (!state.projectId) return;
  try {
    const payload = {
      id: state.projectId,
      title: state.filename,
      videoUrl: state.videoUrl,
      createdAt: state.createdAt || Date.now(),
      tokens: state.tokens,
      compositions: state.compositions,
      templateId: state.templateId,
      styleOverrides: state.styleOverrides
    };
    await fetch(`/api/projects/${state.projectId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    console.log('[Autosave] Project state updated.');
  } catch (err) {
    console.error('[Autosave] Failed:', err);
  }
}

// â”€â”€â”€ Undo / Redo Memory Stack â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

let lastPushTime = 0;

function updateUndoRedoButtons() {
  const undoBtn = $('undoBtn');
  const redoBtn = $('redoBtn');
  if (undoBtn) undoBtn.disabled = state.undoStack.length === 0;
  if (redoBtn) redoBtn.disabled = state.redoStack.length === 0;
}

function snapshotState() {
  return JSON.stringify({
    tokens: state.tokens,
    compositions: state.compositions,
    templateId: state.templateId,
    styleOverrides: state.styleOverrides
  });
}

function restoreSnapshot(json) {
  const snapshot = JSON.parse(json);
  state.tokens = snapshot.tokens;
  state.compositions = snapshot.compositions;
  state.templateId = snapshot.templateId || state.templateId;
  state.styleOverrides = snapshot.styleOverrides || {};
  refreshTemplate();
  renderCaptionList();
  renderTimeline();
  renderCaptions();
  syncStyleInspector();
  renderTemplateGallery();
  updateUndoRedoButtons();
  saveProjectState();
}

function pushUndoState() {
  if (!state.projectId) return;
  const now = Date.now();
  if (now - lastPushTime < 300) return;
  lastPushTime = now;

  if (state.undoStack.length >= 50) {
    state.undoStack.shift();
  }
  state.undoStack.push(snapshotState());
  state.redoStack = []; // Clear redo stack on new action
  updateUndoRedoButtons();
}

/**
 * Record a style tweak for this project and re-render.
 *
 * Tweaks are stored as overrides rather than by mutating the template, so the
 * template stays the shared, immutable definition and the project remembers
 * only what the user actually changed. Passing null clears an override and
 * restores the template's own value.
 */
function setStyleOverride(key, value) {
  if (value === null || value === undefined) {
    delete state.styleOverrides[key];
  } else {
    state.styleOverrides[key] = value;
  }
  refreshTemplate();
  renderCaptions();
}

function setStyleOverrides(patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) delete state.styleOverrides[key];
    else state.styleOverrides[key] = value;
  }
  refreshTemplate();
  renderCaptions();
}

/** First editable colour of a fill, whether solid, gradient or depth. */
function fillColorOf(style, fallback) {
  const fill = style && style.fill;
  if (!fill) return fallback;
  if (fill.color) return fill.color;
  if (Array.isArray(fill.stops) && fill.stops.length) return fill.stops[0].color;
  return fallback;
}

function setControl(id, value) {
  const el = $(id);
  if (el && value !== undefined && value !== null) el.value = value;
}

function setOutput(id, value) {
  const el = $(id);
  if (el) el.textContent = value;
}

function setColorControl(id, hexId, value) {
  const el = $(id);
  if (!el || !value) return;
  // <input type="color"> only accepts #rrggbb, so rgba()/short hex is skipped.
  if (/^#[0-9a-f]{6}$/i.test(value)) el.value = value;
  setOutput(hexId, value);
}

/** Push the resolved template's current values into the inspector controls. */
function syncStyleInspector() {
  const t = state.template;
  if (!t) return;

  setControl('soFontFamily', t.font.family);
  populateWeightOptions(t.font.family, t.font.weight);
  setControl('soFontSize', t.font.size);
  setOutput('soFontSizeVal', Math.round(t.font.size));
  setControl('soCasing', t.font.casing);
  setControl('soLetterSpacing', t.font.letterSpacing);
  setOutput('soLetterSpacingVal', t.font.letterSpacing);
  setControl('soLineHeight', t.font.lineHeight);
  setOutput('soLineHeightVal', Number(t.font.lineHeight).toFixed(2));

  setControl('soY', Math.round(t.layout.y * 100));
  setOutput('soYVal', Math.round(t.layout.y * 100));
  setControl('soX', Math.round(t.layout.x * 100));
  setOutput('soXVal', Math.round(t.layout.x * 100));
  setControl('soMaxWidth', Math.round(t.layout.maxWidthPct * 100));
  setOutput('soMaxWidthVal', Math.round(t.layout.maxWidthPct * 100));
  setControl('soMaxLines', String(t.layout.maxLines));
  setControl('soAlign', t.layout.align);
  setControl('soReveal', t.layout.reveal);

  setColorControl('soBaseColor', 'soBaseColorHex', fillColorOf(t.word, '#FFFFFF'));
  setColorControl('soActiveColor', 'soActiveColorHex', fillColorOf(t.active, '#00FFB2'));

  const stroke = t.word.stroke;
  if ($('soStrokeEnabled')) $('soStrokeEnabled').checked = !!(stroke && stroke.width > 0);
  setControl('soStrokeWidth', stroke ? stroke.width : 0);
  setOutput('soStrokeWidthVal', stroke ? stroke.width : 0);
  setColorControl('soStrokeColor', 'soStrokeColorHex', (stroke && stroke.color) || '#000000');

  const shadow = t.word.shadow;
  if ($('soShadowEnabled')) $('soShadowEnabled').checked = !!shadow;
  setControl('soShadowBlur', shadow ? shadow.blur : 0);
  setOutput('soShadowBlurVal', shadow ? shadow.blur : 0);

  const glow = t.active.glow;
  if ($('soGlowEnabled')) $('soGlowEnabled').checked = !!glow;
  setColorControl('soGlowColor', 'soGlowColorHex', (glow && glow.color) || '#00FFB2');

  setControl('soAnimationType', t.animation.type);
  setControl('soAnimationTarget', t.animation.target);
  setControl('soAnimationDuration', t.animation.durationMs);
  setOutput('soAnimationDurationVal', t.animation.durationMs);

  const pop = t.active.pop;
  if ($('soPopEnabled')) $('soPopEnabled').checked = !!pop;
  setControl('soPopScale', pop ? pop.scale : 1.16);
  setOutput('soPopScaleVal', (pop ? pop.scale : 1.16).toFixed(2));

  setControl('soHeroSizeScale', t.heroSizeScale);
  setOutput('soHeroSizeScaleVal', Number(t.heroSizeScale).toFixed(2));

  // Hero sizing only means anything for hero-layout templates.
  const heroControls = $('heroControls');
  if (heroControls) heroControls.classList.toggle('hidden', t.mode !== 'hero');
}

/** Fill the font family list from the installed registry. */
function populateFontOptions() {
  const select = $('soFontFamily');
  if (!select || !window.CaptionFonts) return;
  const families = window.CaptionFonts.listFamilies();
  select.innerHTML = families
    .map(f => `<option value="${f.family}">${f.family}</option>`)
    .join('');
}

/** Only offer weights that actually exist as a font file for this family. */
function populateWeightOptions(family, selected) {
  const select = $('soFontWeight');
  if (!select || !window.CaptionFonts) return;
  const entry = window.CaptionFonts.listFamilies().find(f => f.family === family);
  const weights = entry ? entry.weights : [400];
  const labels = {
    100: 'Thin', 200: 'ExtraLight', 300: 'Light', 400: 'Regular',
    500: 'Medium', 600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black'
  };
  select.innerHTML = weights
    .map(w => `<option value="${w}">${labels[w] || w}</option>`)
    .join('');
  const resolved = weights.includes(Number(selected)) ? Number(selected) : weights[0];
  select.value = String(resolved);
  select.disabled = weights.length <= 1;
}

function undo() {
  if (!state.undoStack.length) return;
  state.redoStack.push(snapshotState());
  restoreSnapshot(state.undoStack.pop());
}

function redo() {
  if (!state.redoStack.length) return;
  state.undoStack.push(snapshotState());
  restoreSnapshot(state.redoStack.pop());
}

window.addEventListener('keydown', e => {
  const activeTag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
  const isEditingText = activeTag === 'input' || activeTag === 'textarea'
    || (document.activeElement && document.activeElement.contentEditable === 'true');

  if (!e.ctrlKey && !e.metaKey) return;
  if (e.altKey) return;

  const key = e.key.toLowerCase();
  if (key === 'z') {
    if (isEditingText) return; // Let the browser's own text undo run.
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
  } else if (key === 'y') {
    if (isEditingText) return;
    e.preventDefault();
    redo();
  }
});

// â”€â”€â”€ Dashboard Portal API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

let allProjects = [];

async function loadProjectsList() {
  try {
    const res = await fetch('/api/projects');
    if (!res.ok) throw new Error('Failed to load projects list');
    const data = await res.json();
    allProjects = data.projects || [];
    renderProjectsGrid(allProjects);
  } catch (err) {
    console.error('[Dashboard] Error:', err);
  }
}

function renderProjectsGrid(projects) {
  const grid = $('projectsGrid');
  if (!grid) return;
  grid.innerHTML = '';
  
  if (projects.length === 0) {
    grid.innerHTML = `<div class="no-projects">No recent projects yet. Upload a video to start!</div>`;
    return;
  }

  projects.forEach(proj => {
    const card = document.createElement('div');
    card.className = 'project-card';
    
    const thumbWrapper = document.createElement('div');
    thumbWrapper.className = 'project-thumbnail-wrapper';
    
    const videoEl = document.createElement('video');
    videoEl.className = 'project-thumbnail-video';
    videoEl.src = proj.videoUrl;
    videoEl.muted = true;
    videoEl.preload = 'metadata';
    thumbWrapper.appendChild(videoEl);
    
    const playOverlay = document.createElement('div');
    playOverlay.className = 'project-play-overlay';
    playOverlay.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
    thumbWrapper.appendChild(playOverlay);
    
    card.appendChild(thumbWrapper);
    
    const details = document.createElement('div');
    details.className = 'project-details';
    
    const title = document.createElement('div');
    title.className = 'project-title';
    title.textContent = proj.title;
    details.appendChild(title);
    
    const dateStr = new Date(proj.createdAt).toLocaleDateString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    });
    const meta = document.createElement('div');
    meta.className = 'project-meta';
    meta.textContent = dateStr;
    details.appendChild(meta);
    
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'project-delete-btn';
    deleteBtn.title = 'Delete project';
    deleteBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>`;
    
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm(`Are you sure you want to delete "${proj.title}"?`)) {
        fetch(`/api/projects/${proj.id}`, { method: 'DELETE' })
          .then(res => {
            if (!res.ok) throw new Error('Delete failed');
            loadProjectsList();
          })
          .catch(err => alert('Failed to delete: ' + err.message));
      }
    });
    details.appendChild(deleteBtn);
    
    card.appendChild(details);
    
    card.addEventListener('click', () => loadProject(proj.id));
    
    grid.appendChild(card);
  });
}

async function loadProject(projectId) {
  try {
    const res = await fetch(`/api/projects/${projectId}`);
    if (!res.ok) throw new Error('Failed to load project details');
    const data = await res.json();
    
    applyProjectData(data);
    showEditor();
  } catch (err) {
    alert('Failed to load project: ' + err.message);
  }
}

/** Load a project payload (from open or from a fresh upload) into state. */
function applyProjectData(data) {
  state.projectId = data.id || data.projectId;
  state.tokens = data.tokens || [];
  state.compositions = data.compositions || [];
  state.videoUrl = data.videoUrl;
  state.filename = data.title || data.filename || 'Untitled';
  state.createdAt = data.createdAt || Date.now();
  state.templateId = data.templateId || state.templateId;
  state.styleOverrides = data.styleOverrides || {};

  state.undoStack = [];
  state.redoStack = [];
  updateUndoRedoButtons();

  refreshTemplate();
  syncStyleInspector();
  renderTemplateGallery();
}

// ─── Template gallery ─────────────────────────────────────────────────────────

async function loadTemplateList() {
  try {
    const res = await fetch('/api/templates');
    if (!res.ok) throw new Error('Failed to load templates');
    const data = await res.json();
    state.templateList = data.templates || [];
    renderTemplateCategories();
    renderTemplateGallery();
  } catch (err) {
    console.error('[Templates] Could not load list:', err);
  }
}

function renderTemplateCategories() {
  const host = $('templateCategories');
  if (!host) return;
  const categories = ['All', ...new Set(state.templateList.map(t => t.category))];
  host.innerHTML = '';
  for (const category of categories) {
    const btn = document.createElement('button');
    btn.className = 'category-chip' + (category === state.templateCategory ? ' active' : '');
    btn.textContent = category;
    btn.addEventListener('click', () => {
      state.templateCategory = category;
      renderTemplateCategories();
      renderTemplateGallery();
    });
    host.appendChild(btn);
  }
}

function renderTemplateGallery() {
  const host = $('templateGallery');
  if (!host) return;

  const query = state.templateQuery.trim().toLowerCase();
  const visible = state.templateList.filter(t => {
    const matchesCategory = state.templateCategory === 'All' || t.category === state.templateCategory;
    const matchesQuery = !query
      || t.name.toLowerCase().includes(query)
      || t.category.toLowerCase().includes(query);
    return matchesCategory && matchesQuery;
  });

  host.innerHTML = '';
  if (!visible.length) {
    host.innerHTML = '<div class="gallery-empty">No templates match that search.</div>';
    return;
  }

  for (const template of visible) {
    const card = document.createElement('button');
    card.className = 'template-card' + (template.id === state.templateId ? ' active' : '');
    card.title = `${template.name} — ${template.category}`;

    // The swatch previews the template's own font and highlight colour so the
    // list is scannable without rendering 35 live canvases.
    const alias = window.CaptionFonts
      ? window.CaptionFonts.aliasFor(
          window.CaptionFonts.resolveFont(template.previewFontFamily, template.previewFontWeight).family,
          window.CaptionFonts.resolveFont(template.previewFontFamily, template.previewFontWeight).weight
        )
      : 'inherit';

    const sample = template.previewCasing === 'upper' ? 'AA BB' : 'Aa Bb';
    const parts = sample.split(' ');

    const swatch = document.createElement('span');
    swatch.className = 'template-swatch';
    swatch.style.fontFamily = `"${alias}", sans-serif`;
    swatch.innerHTML =
      `<span style="color:${template.previewBaseColor}">${parts[0]}</span> ` +
      `<span style="color:${template.previewActiveColor}">${parts[1]}</span>`;

    const label = document.createElement('span');
    label.className = 'template-card-name';
    label.textContent = template.name;

    if (template.mode === 'hero') {
      const badge = document.createElement('span');
      badge.className = 'template-mode-badge';
      badge.textContent = 'HERO';
      card.appendChild(badge);
    }

    card.appendChild(swatch);
    card.appendChild(label);
    card.addEventListener('click', () => selectTemplate(template.id));
    host.appendChild(card);
  }
}

/**
 * Switch template. Style tweaks are cleared, because an override that made
 * sense for one template (a huge font size for a condensed face, say) usually
 * looks wrong on the next one and would hide what the new template really is.
 */
function selectTemplate(templateId) {
  if (templateId === state.templateId) return;
  pushUndoState();
  state.templateId = templateId;
  state.styleOverrides = {};
  refreshTemplate();
  renderTemplateGallery();
  syncStyleInspector();
  renderCaptions();
  saveProjectState();
}

// â”€â”€â”€ DOM Refs â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
const ctx = captionCanvas.getContext('2d');
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

// â”€â”€â”€ Upload Flow â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

['dragenter', 'dragover'].forEach(e => {
  uploadZone.addEventListener(e, ev => { ev.preventDefault(); uploadZone.classList.add('dragover'); }, false);
});
['dragleave', 'drop'].forEach(e => {
  uploadZone.addEventListener(e, ev => { ev.preventDefault(); uploadZone.classList.remove('dragover'); }, false);
});

uploadZone.addEventListener('drop', e => {
  if (e.dataTransfer.files.length) {
    mediaInput.files = e.dataTransfer.files;
    showSelectedFile(e.dataTransfer.files[0]);
  }
});

mediaInput.addEventListener('change', () => {
  if (mediaInput.files.length) showSelectedFile(mediaInput.files[0]);
});

function showSelectedFile(file) {
  uploadSelected.textContent = `${file.name} (${formatBytes(file.size)})`;
  uploadSelected.classList.add('visible');
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

uploadForm.addEventListener('submit', async e => {
  e.preventDefault();
  if (!mediaInput.files.length) return;

  uploadForm.classList.add('hidden');
  processingState.classList.remove('hidden');

  const steps = [
    { time: 2000, title: 'Transcribing speech...', detail: 'Soniox is processing bilingual audio...' },
    { time: 8000, title: 'Analyzing words...', detail: 'Preserving word-level timestamps...' },
    { time: 14000, title: 'Detecting emphasis...', detail: 'Gemini is picking hero words and layouts...' },
    { time: 20000, title: 'Building compositions...', detail: 'Creating kinetic typography compositions...' },
  ];
  let stepIdx = 0;
  const progressInterval = setInterval(() => {
    if (stepIdx < steps.length) {
      processingTitle.textContent = steps[stepIdx].title;
      processingDetail.textContent = steps[stepIdx].detail;
      stepIdx++;
    }
  }, 5000);

  try {
    const formData = new FormData(uploadForm);
    const response = await fetch('/api/generate-compositions', { method: 'POST', body: formData });
    clearInterval(progressInterval);
    const data = await response.json();

    if (!response.ok) throw new Error(data.error || 'Pipeline failed.');

    applyProjectData(data);
    showEditor();

    // The fallback grouping picks the longest word as the emphasis and skips
    // Roman-Urdu conversion, so say so instead of leaving the user wondering
    // why the results look worse than usual.
    if (data.compositionSource === 'fallback') {
      showNotice(
        'Captions were grouped without AI. Emphasis words are guessed and Urdu was not ' +
        'converted to Roman Urdu. Set a GEMINI_API_KEY on the server to restore this.',
        'warning'
      );
    }

  } catch (error) {
    clearInterval(progressInterval);
    processingTitle.textContent = 'Failed';
    processingDetail.textContent = error.message;
    processingDetail.style.color = '#ff4444';
    setTimeout(() => {
      uploadForm.classList.remove('hidden');
      processingState.classList.add('hidden');
      processingDetail.style.color = '';
    }, 3000);
  }
});

// â”€â”€â”€ Editor Init â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function showEditor() {
  document.body.classList.remove('project-unloaded');
  document.body.classList.add('project-loaded');

  $('unloadedLeftState').classList.add('hidden');
  $('loadedLeftState').classList.remove('hidden');

  $('unloadedCenterState').classList.add('hidden');
  $('loadedCenterState').classList.remove('hidden');

  $('unloadedRightState').classList.add('hidden');
  $('loadedRightState').classList.remove('hidden');

  $('unloadedTimelineState').classList.add('hidden');
  $('loadedTimelineState').classList.remove('hidden');

  topbarFilename.textContent = state.filename;

  videoPlayer.src = state.videoUrl;
  videoPlayer.load();

  // If the metadata is already available (cached video) the event will not fire.
  if (videoPlayer.duration) {
    state.videoDuration = videoPlayer.duration;
    updateTimeDisplay();
    renderTimeline();
  }

  renderCaptionList();
  syncStyleInspector();
  startRenderLoop();

  // Park the playhead on the first caption. Opening at 0:00 usually lands in
  // the silence before anyone speaks, so the preview looked empty and gave the
  // impression that captions were not working at all.
  const first = state.compositions[0];
  if (first) {
    const seekTo = Math.max(0, (first.start_ms + 60) / 1000);
    const seek = () => { videoPlayer.currentTime = seekTo; };
    if (videoPlayer.readyState >= 1) seek();
    else videoPlayer.addEventListener('loadedmetadata', seek, { once: true });
  }
}

// Registered once at load. Attaching this inside showEditor added another
// listener every time a project was opened.
videoPlayer.addEventListener('loadedmetadata', () => {
  state.videoDuration = videoPlayer.duration;
  updateTimeDisplay();
  renderTimeline();
});

async function closeProject() {
  if (state.projectId) {
    await saveProjectState();
  }

  stopRenderLoop();

  if (state.isPlaying) {
    videoPlayer.pause();
    state.isPlaying = false;
    if (playIcon) playIcon.classList.remove('hidden');
    if (pauseIcon) pauseIcon.classList.add('hidden');
  }

  state.projectId = null;
  state.tokens = [];
  state.compositions = [];
  state.videoUrl = '';
  state.filename = '';
  state.videoDuration = 0;
  state.currentTime = 0;
  state.activeCompositionId = null;
  state.styleOverrides = {};
  state.undoStack = [];
  state.redoStack = [];
  updateUndoRedoButtons();

  videoPlayer.removeAttribute('src');
  videoPlayer.load();
  if (window.CaptionRenderer) window.CaptionRenderer.clearLayoutCache();
  if (topbarFilename) topbarFilename.textContent = '';
  
  document.body.classList.remove('project-loaded');
  document.body.classList.add('project-unloaded');

  $('unloadedLeftState').classList.remove('hidden');
  $('loadedLeftState').classList.add('hidden');

  $('unloadedCenterState').classList.remove('hidden');
  $('loadedCenterState').classList.add('hidden');

  $('unloadedRightState').classList.remove('hidden');
  $('loadedRightState').classList.add('hidden');

  $('unloadedTimelineState').classList.remove('hidden');
  $('loadedTimelineState').classList.add('hidden');

  // Reset file form
  uploadForm.classList.remove('hidden');
  processingState.classList.add('hidden');
  mediaInput.value = '';
  uploadSelected.textContent = '';
  uploadSelected.classList.remove('visible');
  topbarFilename.textContent = '';

  loadProjectsList();
}

$('closeProjectBtn').addEventListener('click', closeProject);

// â”€â”€â”€ Caption List â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function renderCaptionList() {
  const tokenMap = new Map(state.tokens.map(t => [t.id, t]));
  captionList.innerHTML = '';

  state.compositions.forEach((comp, idx) => {
    const line = document.createElement('div');
    line.className = 'caption-line' + (state.activeCompositionId === comp.id ? ' active' : '');
    line.dataset.compId = comp.id;

    // Line number
    const num = document.createElement('span');
    num.className = 'caption-line-num';
    num.textContent = idx + 1;
    line.appendChild(num);

    // Words container
    const wordsDiv = document.createElement('div');
    wordsDiv.className = 'caption-line-words';

    if (state.viewMode === 'line') {
      // LINE VIEW: Single interactive textarea representing the entire sentence
      const textarea = document.createElement('textarea');
      textarea.className = 'caption-line-textarea';
      
      const fullText = comp.token_ids.map(tid => tokenMap.get(tid)?.text || '').join(' ');
      textarea.value = fullText;
      
      // Auto-resize height
      setTimeout(() => {
        textarea.style.height = 'auto';
        textarea.style.height = textarea.scrollHeight + 'px';
      }, 0);

      textarea.addEventListener('input', () => {
        textarea.style.height = 'auto';
        textarea.style.height = textarea.scrollHeight + 'px';
      });

      // Prevent click/mousedown from bubbling up and triggering line click seek/rebuild
      textarea.addEventListener('click', e => {
        e.stopPropagation();
      });
      textarea.addEventListener('mousedown', e => {
        e.stopPropagation();
      });

      // Handle blurring (saving changes + timing interpolation)
      textarea.addEventListener('blur', () => {
        const val = textarea.value.trim();
        const newWords = val.split(/\s+/).filter(Boolean);
        
        const originalTokens = comp.token_ids.map(tid => tokenMap.get(tid)).filter(Boolean);
        
        if (newWords.length === 0) {
          pushUndoState();
          // Delete comp
          state.tokens = state.tokens.filter(t => !comp.token_ids.includes(t.id));
          state.compositions.splice(idx, 1);
          commitEdit();
          return;
        }

        let changed = false;
        if (newWords.length === originalTokens.length) {
          // Push undo state if any text has actually changed
          const textChanged = newWords.some((word, wIdx) => originalTokens[wIdx].text !== word);
          if (textChanged) {
            pushUndoState();
            newWords.forEach((word, wIdx) => {
              originalTokens[wIdx].text = word;
            });
            changed = true;
          }
        } else {
          // Count changed: interpolate timings
          pushUndoState();
          const duration = comp.end_ms - comp.start_ms;
          const wordDuration = Math.round(duration / newWords.length);
          
          state.tokens = state.tokens.filter(t => !comp.token_ids.includes(t.id));
          
          const newTokenIds = [];
          newWords.forEach((word, wIdx) => {
            const tokenId = 'token-' + Math.random().toString(36).substr(2, 9) + '-' + Date.now();
            const start = comp.start_ms + wIdx * wordDuration;
            const end = comp.start_ms + (wIdx + 1) * wordDuration;
            const newToken = { id: tokenId, text: word, start_ms: start, end_ms: end };
            state.tokens.push(newToken);
            newTokenIds.push(tokenId);
          });
          
          comp.token_ids = newTokenIds;
          comp.hero_token_id = newTokenIds[0];
          changed = true;
        }

        if (changed) {
          const freshTokenMap = new Map(state.tokens.map(t => [t.id, t]));
          updateCompTexts(comp, freshTokenMap);
          commitEdit();
        }
      });

      // Split line on enter key
      textarea.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          if (e.shiftKey) return; // Shift + Enter normal break
          e.preventDefault();

          const textVal = textarea.value;
          const caretPos = textarea.selectionStart;
          
          const leftText = textVal.substring(0, caretPos).trim();
          const rightText = textVal.substring(caretPos).trim();
          
          const leftWords = leftText.split(/\s+/).filter(Boolean);
          if (leftWords.length === 0 || rightText.length === 0) return;

          const splitIdx = leftWords.length;
          if (splitIdx > 0 && splitIdx < comp.token_ids.length) {
            const leftTokenIds = comp.token_ids.slice(0, splitIdx);
            const rightTokenIds = comp.token_ids.slice(splitIdx);
            
            const newCompId = 'comp-' + Math.random().toString(36).substr(2, 9) + '-' + Date.now();
            const freshTokenMap = new Map(state.tokens.map(t => [t.id, t]));
            
            const firstRightToken = freshTokenMap.get(rightTokenIds[0]);
            const lastLeftToken = freshTokenMap.get(leftTokenIds[leftTokenIds.length - 1]);
            
            const newComp = {
              id: newCompId,
              token_ids: rightTokenIds,
              layout_id: comp.layout_id,
              comp_type: comp.comp_type,
              hero_token_id: rightTokenIds[0],
              start_ms: firstRightToken ? firstRightToken.start_ms : comp.end_ms,
              end_ms: comp.end_ms
            };
            
            comp.token_ids = leftTokenIds;
            comp.end_ms = lastLeftToken ? lastLeftToken.end_ms : comp.start_ms;
            if (!leftTokenIds.includes(comp.hero_token_id)) {
              comp.hero_token_id = leftTokenIds[0];
            }
            
            updateCompTexts(comp, freshTokenMap);
            updateCompTexts(newComp, freshTokenMap);
            
            state.compositions.splice(idx + 1, 0, newComp);
            
            commitEdit();
          }
        }
      });

      wordsDiv.appendChild(textarea);
    } else {
      // Allow dropping words into the empty space of this line
      wordsDiv.addEventListener('dragover', e => {
        e.preventDefault();
        e.stopPropagation();
        wordsDiv.classList.add('dragover-line');
      });
      wordsDiv.addEventListener('dragleave', e => {
        e.stopPropagation();
        wordsDiv.classList.remove('dragover-line');
      });
      wordsDiv.addEventListener('drop', e => {
        e.preventDefault();
        e.stopPropagation();
        wordsDiv.classList.remove('dragover-line');

        const draggedTokenId = e.dataTransfer.getData('text/plain');
        if (!draggedTokenId) return;

        const sourceComp = state.compositions.find(c => c.token_ids.includes(draggedTokenId));
        if (sourceComp && sourceComp.id === comp.id) return; // Already on this line

        if (comp.token_ids.length > 0) {
          const lastTokenId = comp.token_ids[comp.token_ids.length - 1];
          moveWordToken(draggedTokenId, lastTokenId);
        } else {
          if (sourceComp) {
            sourceComp.token_ids = sourceComp.token_ids.filter(id => id !== draggedTokenId);
            comp.token_ids.push(draggedTokenId);
            commitEdit();
          }
        }
      });

      // WORD VIEW: Render individual chips with click, dblclick, drag-n-drop, and context menu
      comp.token_ids.forEach(tokenId => {
        const token = tokenMap.get(tokenId);
        if (!token) return;
        
        const chip = document.createElement('span');
        const isEmphasis = (comp.comp_type || 'emphasis') === 'emphasis' || (comp.comp_type || 'emphasis') === 'spotlight';
        const isHero = tokenId === comp.hero_token_id && isEmphasis;
        const isSelected = state.selectedTokenIds.includes(tokenId);
        
        chip.className = 'word-chip' + (isHero ? ' hero' : '') + (isSelected ? ' selected' : '');
        chip.textContent = token.text.trim();
        chip.dataset.tokenId = tokenId;
        chip.dataset.compId = comp.id;
        
        // Single click: Normal emphasis toggle OR Multi-select with Ctrl
        chip.addEventListener('click', e => {
          e.stopPropagation();
          if (chip.contentEditable === 'true') return;
          
          if (e.ctrlKey) {
            // Check if other selected tokens are in the same composition
            const sameComp = state.selectedTokenIds.every(id => comp.token_ids.includes(id));
            if (!sameComp) {
              state.selectedTokenIds = [];
            }
            if (state.selectedTokenIds.includes(tokenId)) {
              state.selectedTokenIds = state.selectedTokenIds.filter(id => id !== tokenId);
            } else {
              state.selectedTokenIds.push(tokenId);
            }
            renderCaptionList();
          } else {
            state.selectedTokenIds = [];
            handleWordClick(comp.id, tokenId);
          }
        });

        // Double click: Edit word inline (prevent browser dragging conflict)
        chip.addEventListener('mousedown', e => {
          if (e.detail === 2) {
            e.stopPropagation();
            e.preventDefault();
            chip.draggable = false;
            chip.contentEditable = true;
            chip.classList.add('editing');
            chip.focus();
            
            const range = document.createRange();
            range.selectNodeContents(chip);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
          }
        });

        const saveEdit = () => {
          if (chip.contentEditable !== 'true') return;
          chip.contentEditable = false;
          chip.draggable = true; // Restore draggable
          chip.classList.remove('editing');
          const newText = chip.textContent.trim();
          
          if (!newText) {
            pushUndoState();
            // Delete token completely
            state.tokens = state.tokens.filter(t => t.id !== tokenId);
            comp.token_ids = comp.token_ids.filter(tid => tid !== tokenId);
            if (comp.token_ids.length === 0) {
              state.compositions = state.compositions.filter(c => c.id !== comp.id);
            } else if (comp.hero_token_id === tokenId) {
              comp.hero_token_id = comp.token_ids[0];
            }
            updateCompTexts(comp, tokenMap);
            commitEdit();
            return;
          }

          if (newText !== token.text) {
            pushUndoState();
            token.text = newText;
            updateCompTexts(comp, tokenMap);
            commitEdit();
          } else {
            chip.textContent = token.text;
          }
        };

        chip.addEventListener('blur', saveEdit);
        chip.addEventListener('keydown', e => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (!chip.textContent.trim()) {
              saveEdit();
              return;
            }
            const splitIdx = comp.token_ids.indexOf(tokenId);
            if (splitIdx > 0) {
              saveEdit();
              splitCompositionAtWord(comp.id, tokenId);
            } else {
              saveEdit();
            }
          }
        });

        // Context Menu trigger
        chip.addEventListener('contextmenu', e => {
          e.stopPropagation();
          e.preventDefault();

          if (!state.selectedTokenIds.includes(tokenId)) {
            state.selectedTokenIds = [tokenId];
            renderCaptionList();
          }

          state.contextTokenId = tokenId;
          state.contextCompId = comp.id;

          const menu = $('wordContextMenu');
          menu.style.left = e.pageX + 'px';
          menu.style.top = e.pageY + 'px';
          menu.classList.remove('hidden');

          const combineBtn = $('ctxCombineBtn');
          if (state.selectedTokenIds.length > 1) {
            combineBtn.classList.remove('hidden');
          } else {
            combineBtn.classList.add('hidden');
          }
        });

        // Drag & Drop
        chip.draggable = true;

        chip.addEventListener('dragstart', dragStartEv => {
          dragStartEv.stopPropagation();
          dragStartEv.dataTransfer.setData('text/plain', tokenId);
          dragStartEv.dataTransfer.effectAllowed = 'move';
          chip.classList.add('dragging');
        });

        chip.addEventListener('dragend', () => {
          chip.classList.remove('dragging');
          document.querySelectorAll('.word-chip').forEach(c => c.classList.remove('dragging-over'));
        });

        chip.addEventListener('dragover', dragOverEv => {
          dragOverEv.preventDefault();
          dragOverEv.stopPropagation();
          chip.classList.add('dragging-over');
        });

        chip.addEventListener('dragleave', dragLeaveEv => {
          dragLeaveEv.stopPropagation();
          chip.classList.remove('dragging-over');
        });

        chip.addEventListener('drop', dropEv => {
          dropEv.preventDefault();
          dropEv.stopPropagation();
          chip.classList.remove('dragging-over');

          const draggedTokenId = dropEv.dataTransfer.getData('text/plain');
          if (!draggedTokenId || draggedTokenId === tokenId) return;

          moveWordToken(draggedTokenId, tokenId);
        });

        wordsDiv.appendChild(chip);
      });
    }

    line.appendChild(wordsDiv);

    // Layout button
    const layoutDiv = document.createElement('div');
    layoutDiv.className = 'caption-line-layout';
    const compType = comp.comp_type || 'emphasis';
    const layoutBtn = document.createElement('button');
    layoutBtn.className = 'layout-btn';
    layoutBtn.textContent = COMP_TYPE_ICONS[compType] || '\u229E';
    layoutBtn.title = `Emphasis: ${COMP_TYPE_LABELS[compType]} (click to change)`;
    layoutBtn.addEventListener('click', e => {
      e.stopPropagation();
      cycleCompType(comp.id);
    });
    layoutDiv.appendChild(layoutBtn);
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'delete-btn';
    deleteBtn.textContent = '\u00D7';
    deleteBtn.title = 'Delete line';
    deleteBtn.addEventListener('click', e => {
      e.stopPropagation();
      pushUndoState();
      state.tokens = state.tokens.filter(t => !comp.token_ids.includes(t.id));
      state.compositions.splice(idx, 1);
      commitEdit();
    });
    layoutDiv.appendChild(deleteBtn);
    line.appendChild(layoutDiv);

    // Click line to seek
    line.addEventListener('click', () => {
      const startSec = comp.start_ms / 1000;
      videoPlayer.currentTime = startSec;
      state.activeCompositionId = comp.id;
      renderCaptionList();
    });

    captionList.appendChild(line);
  });
}

/**
 * Recompute everything a composition derives from its token list.
 *
 * The id arrays matter as much as the text: the renderer draws from
 * before_token_ids / after_token_ids, so any edit that changes a composition's
 * words (split, combine, delete, reorder, retype) has to refresh them here or
 * the canvas and the exported video keep showing the old words.
 */
function updateCompTexts(comp, tokenMap) {
  const map = tokenMap || new Map(state.tokens.map(t => [t.id, t]));

  // Drop ids whose tokens no longer exist, so a deleted word cannot linger.
  comp.token_ids = (comp.token_ids || []).filter(id => map.has(id));

  const compTokens = comp.token_ids.map(id => map.get(id));
  if (!compTokens.length) {
    comp.hero_token_id = null;
    comp.before_token_ids = [];
    comp.after_token_ids = [];
    comp.hero_text = '';
    comp.before_text = '';
    comp.after_text = '';
    return;
  }

  let heroIdx = compTokens.findIndex(t => t.id === comp.hero_token_id);
  if (heroIdx < 0) heroIdx = 0;

  const beforeTokens = compTokens.slice(0, heroIdx);
  const heroToken = compTokens[heroIdx];
  const afterTokens = compTokens.slice(heroIdx + 1);

  comp.hero_token_id = heroToken.id;
  comp.before_token_ids = beforeTokens.map(t => t.id);
  comp.after_token_ids = afterTokens.map(t => t.id);
  comp.hero_text = heroToken.text.trim();
  comp.before_text = beforeTokens.map(t => t.text.trim()).join(' ');
  comp.after_text = afterTokens.map(t => t.text.trim()).join(' ');

  // Timing follows the tokens too, so a composition never outlives its words.
  comp.start_ms = Math.min(...compTokens.map(t => t.start_ms));
  comp.end_ms = Math.max(...compTokens.map(t => t.end_ms));
}

/**
 * Re-derive every composition and drop any that no longer has words.
 * Called after edits that can affect more than one composition.
 */
function reconcileCompositions() {
  const map = new Map(state.tokens.map(t => [t.id, t]));
  for (const comp of state.compositions) updateCompTexts(comp, map);
  state.compositions = state.compositions.filter(c => c.token_ids.length);
  state.compositions.sort((a, b) => a.start_ms - b.start_ms);
  if (window.CaptionRenderer) window.CaptionRenderer.clearLayoutCache();
}

/**
 * The single commit point for a caption edit: bring derived data back in sync,
 * persist, then redraw everything. Every edit path goes through here so none of
 * them can forget a step.
 */
function commitEdit() {
  reconcileCompositions();
  commitEdit();
}

function handleWordClick(compId, tokenId) {
  const comp = state.compositions.find(c => c.id === compId);
  if (!comp) return;

  const tokenMap = new Map(state.tokens.map(t => [t.id, t]));

  // Check if currently emphasized
  const isCurrentlyEmphasis = (comp.comp_type || 'emphasis') === 'emphasis' || (comp.comp_type || 'emphasis') === 'spotlight';

  if (isCurrentlyEmphasis && comp.hero_token_id === tokenId) {
    // Toggle OFF emphasis -> make plain white
    comp.comp_type = 'plain';
  } else {
    // Toggle ON emphasis / change emphasis word
    comp.comp_type = 'emphasis';
    comp.hero_token_id = tokenId;
    
    // Re-split before/after words
    const compTokens = comp.token_ids.map(id => tokenMap.get(id)).filter(Boolean);
    const heroIdx = compTokens.findIndex(t => t.id === tokenId);
    if (heroIdx >= 0) {
      const beforeTokens = compTokens.slice(0, heroIdx);
      const heroToken = compTokens[heroIdx];
      const afterTokens = compTokens.slice(heroIdx + 1);
      
      comp.before_token_ids = beforeTokens.map(t => t.id);
      comp.after_token_ids = afterTokens.map(t => t.id);
      comp.hero_text = heroToken.text.trim();
      comp.before_text = beforeTokens.map(t => t.text.trim()).join(' ');
      comp.after_text = afterTokens.map(t => t.text.trim()).join(' ');
    }
  }

  renderCaptionList();
}

// How each line is treated: one highlighted word, no highlight at all, or the
// chosen word alone on screen. The renderer reads comp_type directly.
const COMP_TYPE_ORDER = ['emphasis', 'plain', 'spotlight'];
const COMP_TYPE_LABELS = {
  emphasis: 'highlight one word',
  plain: 'no highlight',
  spotlight: 'single word only'
};
const COMP_TYPE_ICONS = { emphasis: '\u25C9', plain: '\u25CB', spotlight: '\u2605' };

function cycleCompType(compId) {
  const comp = state.compositions.find(c => c.id === compId);
  if (!comp) return;
  pushUndoState();
  const idx = COMP_TYPE_ORDER.indexOf(comp.comp_type || 'emphasis');
  comp.comp_type = COMP_TYPE_ORDER[(idx + 1) % COMP_TYPE_ORDER.length];
  commitEdit();
}

// â”€â”€â”€ View Toggle â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

$('wordViewBtn').addEventListener('click', () => {
  state.viewMode = 'word';
  $('wordViewBtn').classList.add('active');
  $('lineViewBtn').classList.remove('active');
  renderCaptionList();
});

$('lineViewBtn').addEventListener('click', () => {
  state.viewMode = 'line';
  $('lineViewBtn').classList.add('active');
  $('wordViewBtn').classList.remove('active');
  renderCaptionList();
});

// â”€â”€â”€ Video Player â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

playPauseBtn.addEventListener('click', () => {
  if (videoPlayer.paused) {
    videoPlayer.play();
  } else {
    videoPlayer.pause();
  }
});

videoPlayer.addEventListener('play', () => {
  state.isPlaying = true;
  playIcon.classList.add('hidden');
  pauseIcon.classList.remove('hidden');
});

videoPlayer.addEventListener('pause', () => {
  state.isPlaying = false;
  playIcon.classList.remove('hidden');
  pauseIcon.classList.add('hidden');
});

videoPlayer.addEventListener('timeupdate', () => {
  state.currentTime = videoPlayer.currentTime;
  updateTimeDisplay();
  updatePlayhead();

  // Highlight active composition in list
  const ms = state.currentTime * 1000;
  const active = state.compositions.find(c => ms >= c.start_ms && ms <= c.end_ms);
  if (active && active.id !== state.activeCompositionId) {
    state.activeCompositionId = active.id;
    highlightActiveCaption();
  }
});

function highlightActiveCaption() {
  document.querySelectorAll('.caption-line').forEach(el => {
    el.classList.toggle('active', el.dataset.compId === state.activeCompositionId);
  });

  if (state.userHoveringCaptions) return; // Do not auto-scroll if user is hovering/interacting!

  // Scroll into view
  const activeLine = document.querySelector('.caption-line.active');
  if (activeLine) activeLine.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// Track hover on captions panel to prevent auto-scrolling fight
const captionPanel = $('captionPanel');
if (captionPanel) {
  captionPanel.addEventListener('mouseenter', () => {
    state.userHoveringCaptions = true;
  });
  captionPanel.addEventListener('mouseleave', () => {
    state.userHoveringCaptions = false;
  });
}

function updateTimeDisplay() {
  timeDisplay.textContent = `${formatTime(state.currentTime)} / ${formatTime(state.videoDuration)}`;
}

function formatTime(seconds) {
  const s = Math.max(0, seconds || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

// â”€â”€â”€ Canvas Caption Overlay (Live Preview) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Drawn by the same renderer module the server uses for the final export.

// The preview loop only runs while a project is open. It used to be started
// again on every project open and never stopped, so loops accumulated and kept
// burning CPU on the dashboard with nothing to draw.
let renderLoopHandle = null;

function renderLoop() {
  renderCaptions();
  renderLoopHandle = requestAnimationFrame(renderLoop);
}

function startRenderLoop() {
  if (renderLoopHandle !== null) return;
  renderLoopHandle = requestAnimationFrame(renderLoop);
}

function stopRenderLoop() {
  if (renderLoopHandle === null) return;
  cancelAnimationFrame(renderLoopHandle);
  renderLoopHandle = null;
}

// Bounding box state for dragging
let dragBox = null; // { x, y, w, h } in 1080x1920 canvas coordinates
let activeDrag = null; // null | { type: 'move'|'scale', startX, startY, startCenterX, startCenterY, startHeroSize, startSupportSize }

/**
 * Box around the caption currently on screen, in canvas pixels.
 *
 * Delegates to the renderer's own layout rather than recomputing it here — the
 * previous local copy of the layout maths drifted from what was actually drawn
 * and referenced a helper that was never in scope, so it threw on every frame
 * while the video was paused.
 */
function getActiveCaptionBox(ctx) {
  if (!state.template || !state.compositions.length || !window.CaptionRenderer) return null;

  const tokenMap = new Map(state.tokens.map(t => [t.id, t]));
  const bounds = window.CaptionRenderer.getCaptionBounds(
    ctx, state.currentTime * 1000, state.compositions, tokenMap,
    state.template, captionCanvas.width
  );
  if (!bounds) return null;

  // Convert to the fixed 1080x1920 space the drag handlers work in, and pad a
  // little so the outline sits clear of the glyphs.
  const toBase = state.baseCanvasWidth / captionCanvas.width;
  const pad = 18;
  return {
    x: bounds.x * toBase - pad,
    y: bounds.y * toBase - pad,
    w: bounds.width * toBase + pad * 2,
    h: bounds.height * toBase + pad * 2
  };
}

function initCanvasInteraction() {
  const outline = $('canvasSelectOutline');
  if (!outline) return;

  // Dragging outline to reposition or resize
  outline.addEventListener('mousedown', e => {
    if (!dragBox || !state.template) return;
    e.stopPropagation();
    e.preventDefault();

    // Push undo state before we begin dragging
    pushUndoState();

    const rect = captionCanvas.getBoundingClientRect();
    const scaleX = state.baseCanvasWidth / rect.width;
    const scaleY = state.baseCanvasHeight / rect.height;

    const handle = e.target.closest('.handle');
    if (handle) {
      // Corner handle: scale by how far the pointer moves from the box centre.
      const centerX = dragBox.x + dragBox.w / 2;
      const centerY = dragBox.y + dragBox.h / 2;

      const mouseCanvasX = (e.clientX - rect.left) * scaleX;
      const mouseCanvasY = (e.clientY - rect.top) * scaleY;
      const startDist = Math.hypot(mouseCanvasX - centerX, mouseCanvasY - centerY);

      activeDrag = {
        type: 'scale',
        startX: e.clientX,
        startY: e.clientY,
        startFontSize: state.template.font.size,
        startDist: Math.max(10, startDist) // Avoid division by zero
      };
    } else {
      activeDrag = {
        type: 'move',
        startX: e.clientX,
        startY: e.clientY,
        startCenterX: state.template.layout.x,
        startCenterY: state.template.layout.y
      };
    }
  });

  // Mouse move at document level
  document.addEventListener('mousemove', e => {
    if (!activeDrag || !state.template) return;

    const canvas = captionCanvas;
    const rect = canvas.getBoundingClientRect();
    const scaleX = 1080 / rect.width;
    const scaleY = 1920 / rect.height;

    const deltaX = (e.clientX - activeDrag.startX) * scaleX;
    const deltaY = (e.clientY - activeDrag.startY) * scaleY;

    if (activeDrag.type === 'move') {
      const newX = Math.max(0.1, Math.min(0.9, activeDrag.startCenterX + deltaX / state.baseCanvasWidth));
      const newY = Math.max(0.08, Math.min(0.94, activeDrag.startCenterY + deltaY / state.baseCanvasHeight));
      setStyleOverrides({ x: newX, y: newY });
      setControl('soX', Math.round(newX * 100));
      setOutput('soXVal', Math.round(newX * 100));
      setControl('soY', Math.round(newY * 100));
      setOutput('soYVal', Math.round(newY * 100));
    } else if (activeDrag.type === 'scale') {
      const centerX = dragBox.x + dragBox.w / 2;
      const centerY = dragBox.y + dragBox.h / 2;

      const mouseCanvasX = (e.clientX - rect.left) * scaleX;
      const mouseCanvasY = (e.clientY - rect.top) * scaleY;
      const currentDist = Math.hypot(mouseCanvasX - centerX, mouseCanvasY - centerY);
      const ratio = currentDist / activeDrag.startDist;

      const newSize = Math.round(Math.max(28, Math.min(160, activeDrag.startFontSize * ratio)));
      setStyleOverride('fontSize', newSize);
      setControl('soFontSize', newSize);
      setOutput('soFontSizeVal', newSize);
    }
  });

  document.addEventListener('mouseup', () => {
    if (activeDrag) {
      activeDrag = null;
      saveProjectState();
    }
  });
}

// Call on startup
initCanvasInteraction();

function renderCaptions() {
  if (!state.template || !window.CaptionRenderer) return;

  const canvas = captionCanvas;
  const cw = canvas.width;
  const ch = canvas.height;
  ctx.clearRect(0, 0, cw, ch);

  const ms = state.currentTime * 1000;
  const tokenMap = new Map(state.tokens.map(t => [t.id, t]));

  window.CaptionRenderer.renderCaptionFrame(
    ctx, ms, state.compositions, tokenMap, state.template, cw, ch
  );
  
  const outline = $('canvasSelectOutline');
  if (videoPlayer.paused) {
    const box = getActiveCaptionBox(ctx);
    if (box) {
      dragBox = box;
      
      // Reposition HTML select box
      const rect = canvas.getBoundingClientRect();
      const ratioX = rect.width / 1080;
      const ratioY = rect.height / 1920;
      if (outline) {
        outline.style.left = (box.x * ratioX) + 'px';
        outline.style.top = (box.y * ratioY) + 'px';
        outline.style.width = (box.w * ratioX) + 'px';
        outline.style.height = (box.h * ratioY) + 'px';
        outline.classList.remove('hidden');
      }
    } else {
      dragBox = null;
      if (outline) outline.classList.add('hidden');
    }
  } else {
    dragBox = null;
    if (outline) outline.classList.add('hidden');
  }
}

// â”€â”€â”€ Timeline â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function renderTimeline() {
  const duration = state.videoDuration;
  if (!duration) return;

  const pxPerSec = (state.zoomLevel / 100) * 150; // 150px per second at 100%
  const totalWidth = Math.max(duration * pxPerSec, timelineViewport.clientWidth);
  timelineContent.style.width = totalWidth + 'px';

  // Ruler marks
  timeRuler.innerHTML = '';
  const interval = pxPerSec >= 8 ? 5 : pxPerSec >= 4 ? 10 : 30;
  for (let t = 0; t <= duration; t += interval) {
    const mark = document.createElement('div');
    mark.className = 'time-ruler-mark';
    mark.style.left = (t * pxPerSec) + 'px';
    mark.textContent = formatTime(t);
    timeRuler.appendChild(mark);
  }

  // Word blocks
  wordTrack.innerHTML = '';
  const tokenMap = new Map(state.tokens.map(t => [t.id, t]));

  state.compositions.forEach(comp => {
    comp.token_ids.forEach(tokenId => {
      const token = tokenMap.get(tokenId);
      if (!token) return;

      const block = document.createElement('div');
      const left = (token.start_ms / 1000) * pxPerSec;
      const width = Math.max(((token.end_ms - token.start_ms) / 1000) * pxPerSec, 4);
      const isEmp = (comp.comp_type || 'emphasis') === 'emphasis' || (comp.comp_type || 'emphasis') === 'spotlight';
      block.className = 'word-block' + (tokenId === comp.hero_token_id && isEmp ? ' hero' : '');
      block.style.left = left + 'px';
      block.style.width = width + 'px';
      const span = document.createElement('span');
      span.textContent = token.text.trim();
      span.style.pointerEvents = 'none';
      block.appendChild(span);
      
      block.title = `${token.text.trim()} (${(token.start_ms / 1000).toFixed(2)}s - ${(token.end_ms / 1000).toFixed(2)}s)`;
      block.style.cursor = 'grab';

      // Create and append resize handles
      const leftHandle = document.createElement('div');
      leftHandle.className = 'word-block-handle left';
      leftHandle.dataset.handle = 'left';
      block.appendChild(leftHandle);

      const rightHandle = document.createElement('div');
      rightHandle.className = 'word-block-handle right';
      rightHandle.dataset.handle = 'right';
      block.appendChild(rightHandle);

      block.addEventListener('click', (clickEv) => {
        // Only seek if we didn't drag
        if (block.dataset.dragged === 'true') return;
        videoPlayer.currentTime = token.start_ms / 1000;
      });

      block.addEventListener('mousedown', dragEvent => {
        dragEvent.stopPropagation();
        dragEvent.preventDefault();
        
        const handleType = dragEvent.target.dataset.handle || 'move';
        block.dataset.dragged = 'false';
        
        if (handleType === 'move') {
          block.style.cursor = 'grabbing';
        } else {
          document.body.style.cursor = 'ew-resize';
        }
        
        const startX = dragEvent.clientX;
        const initialStartMs = token.start_ms;
        const initialEndMs = token.end_ms;
        const durationMs = initialEndMs - initialStartMs;
        
        // Find neighbors in state.tokens
        const tokenIdx = state.tokens.findIndex(t => t.id === token.id);
        const prevToken = tokenIdx > 0 ? state.tokens[tokenIdx - 1] : null;
        const nextToken = tokenIdx < state.tokens.length - 1 ? state.tokens[tokenIdx + 1] : null;
        
        const minStartMs = prevToken ? prevToken.end_ms : 0;
        const maxEndMs = nextToken ? nextToken.start_ms : (state.videoDuration * 1000);
        
        function onMouseMove(moveEvent) {
          block.dataset.dragged = 'true';
          const deltaX = moveEvent.clientX - startX;
          const deltaSec = deltaX / pxPerSec;
          const deltaMs = Math.round(deltaSec * 1000);
          
          let newStartMs = initialStartMs;
          let newEndMs = initialEndMs;
          
          if (handleType === 'move') {
            newStartMs = initialStartMs + deltaMs;
            newEndMs = initialEndMs + deltaMs;
            
            // Clamp start_ms and end_ms to neighbors
            if (newStartMs < minStartMs) {
              newStartMs = minStartMs;
              newEndMs = newStartMs + durationMs;
            }
            if (newEndMs > maxEndMs) {
              newEndMs = maxEndMs;
              newStartMs = newEndMs - durationMs;
            }
          } else if (handleType === 'left') {
            newStartMs = Math.max(minStartMs, Math.min(initialEndMs - 100, initialStartMs + deltaMs));
            newEndMs = initialEndMs;
          } else if (handleType === 'right') {
            newStartMs = initialStartMs;
            newEndMs = Math.min(maxEndMs, Math.max(initialStartMs + 100, initialEndMs + deltaMs));
          }
          
          // Live state update
          token.start_ms = newStartMs;
          token.end_ms = newEndMs;
          
          // Live position update
          const newLeft = (newStartMs / 1000) * pxPerSec;
          const newWidth = Math.max(((newEndMs - newStartMs) / 1000) * pxPerSec, 4);
          block.style.left = newLeft + 'px';
          block.style.width = newWidth + 'px';
          
          // Update parent composition start/end bounds
          if (comp.token_ids[0] === token.id) {
            comp.start_ms = newStartMs;
          }
          if (comp.token_ids[comp.token_ids.length - 1] === token.id) {
            comp.end_ms = newEndMs;
          }
          
          renderCaptions();
        }
        
        function onMouseUp() {
          block.style.cursor = 'grab';
          document.body.style.cursor = 'default';
          document.removeEventListener('mousemove', onMouseMove);
          document.removeEventListener('mouseup', onMouseUp);
          saveProjectState();
          renderTimeline();
        }
        
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
      });

      wordTrack.appendChild(block);
    });
  });
}

function updatePlayhead() {
  if (!state.videoDuration) return;
  const pxPerSec = (state.zoomLevel / 100) * 150;
  const left = state.currentTime * pxPerSec;
  timelinePlayhead.style.left = left + 'px';

  // Auto-scroll timeline to keep playhead visible
  const viewport = timelineViewport;
  const viewLeft = viewport.scrollLeft;
  const viewRight = viewLeft + viewport.clientWidth;
  if (left < viewLeft + 50 || left > viewRight - 50) {
    viewport.scrollLeft = Math.max(0, left - viewport.clientWidth / 2);
  }
}

// Timeline zoom
$('zoomInBtn').addEventListener('click', () => {
  state.zoomLevel = Math.min(500, state.zoomLevel + 50);
  $('zoomLevel').textContent = state.zoomLevel + '%';
  renderTimeline();
});

$('zoomOutBtn').addEventListener('click', () => {
  state.zoomLevel = Math.max(50, state.zoomLevel - 50);
  $('zoomLevel').textContent = state.zoomLevel + '%';
  renderTimeline();
});

// Click on timeline content (or ruler/track) to seek
timelineContent.addEventListener('click', e => {
  // Ignore if clicking on a word block or the playhead handle itself
  if (e.target.closest('.word-block') || e.target.closest('.playhead-head')) return;

  const rect = timelineContent.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const pxPerSec = (state.zoomLevel / 100) * 150;
  const time = Math.max(0, Math.min(state.videoDuration, x / pxPerSec));
  videoPlayer.currentTime = time;
  state.currentTime = time;
  updatePlayhead();
  updateTimeDisplay();
});

// Playhead Dragging & Ruler Scrubbing
let isDraggingPlayhead = false;
let isScrubbingRuler = false;
let wasPlayingBeforeDrag = false;

const playheadHead = timelinePlayhead ? timelinePlayhead.querySelector('.playhead-head') : null;
if (playheadHead) {
  playheadHead.style.cursor = 'ew-resize';
  
  playheadHead.addEventListener('mousedown', e => {
    e.preventDefault();
    e.stopPropagation();
    isDraggingPlayhead = true;
    wasPlayingBeforeDrag = !videoPlayer.paused;
    if (wasPlayingBeforeDrag) {
      videoPlayer.pause();
    }
    
    document.addEventListener('mousemove', onPlayheadMouseMove);
    document.addEventListener('mouseup', onPlayheadMouseUp);
  });
}

if (timeRuler) {
  timeRuler.addEventListener('mousedown', e => {
    e.preventDefault();
    isScrubbingRuler = true;
    wasPlayingBeforeDrag = !videoPlayer.paused;
    if (wasPlayingBeforeDrag) {
      videoPlayer.pause();
    }
    
    scrub(e);
    
    document.addEventListener('mousemove', onRulerMouseMove);
    document.addEventListener('mouseup', onRulerMouseUp);
  });
}

function scrub(e) {
  const rect = timelineContent.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const pxPerSec = (state.zoomLevel / 100) * 150;
  const time = Math.max(0, Math.min(state.videoDuration, x / pxPerSec));
  
  videoPlayer.currentTime = time;
  state.currentTime = time;
  updatePlayhead();
  updateTimeDisplay();
}

function onPlayheadMouseMove(e) {
  if (!isDraggingPlayhead) return;
  scrub(e);
}

function onPlayheadMouseUp(e) {
  if (!isDraggingPlayhead) return;
  isDraggingPlayhead = false;
  document.removeEventListener('mousemove', onPlayheadMouseMove);
  document.removeEventListener('mouseup', onPlayheadMouseUp);
  
  if (wasPlayingBeforeDrag) {
    videoPlayer.play();
  }
}

function onRulerMouseMove(e) {
  if (!isScrubbingRuler) return;
  scrub(e);
}

function onRulerMouseUp(e) {
  if (!isScrubbingRuler) return;
  isScrubbingRuler = false;
  document.removeEventListener('mousemove', onRulerMouseMove);
  document.removeEventListener('mouseup', onRulerMouseUp);
  
  if (wasPlayingBeforeDrag) {
    videoPlayer.play();
  }
}

// â”€â”€â”€ Style Controls â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// These modify the loaded template in-memory for live preview.

/**
 * Wire one inspector control to a style override key.
 *
 * `transform` maps the control's raw value to the override value, and
 * `readout` renders the label shown next to the control.
 */
function bindStyleControl(id, key, { event = 'input', transform = v => v, readout = null } = {}) {
  const el = $(id);
  if (!el) return;

  el.addEventListener('mousedown', () => pushUndoState());
  el.addEventListener('keydown', () => pushUndoState());

  el.addEventListener(event, e => {
    const raw = el.type === 'checkbox' ? el.checked : e.target.value;
    const value = transform(raw);
    setStyleOverride(key, value);
    if (readout) setOutput(readout.id, readout.format(value, raw));
  });

  // Persist once the interaction settles rather than on every pixel of a drag.
  el.addEventListener('change', () => saveProjectState());
}

const num = v => Number(v);
const pct = v => Number(v) / 100;

bindStyleControl('soFontFamily', 'fontFamily', { event: 'change' });
bindStyleControl('soFontWeight', 'fontWeight', { event: 'change', transform: num });
bindStyleControl('soFontSize', 'fontSize', {
  transform: num, readout: { id: 'soFontSizeVal', format: v => Math.round(v) }
});
bindStyleControl('soCasing', 'casing', { event: 'change' });
bindStyleControl('soLetterSpacing', 'letterSpacing', {
  transform: num, readout: { id: 'soLetterSpacingVal', format: v => v }
});
bindStyleControl('soLineHeight', 'lineHeight', {
  transform: num, readout: { id: 'soLineHeightVal', format: v => v.toFixed(2) }
});

bindStyleControl('soY', 'y', { transform: pct, readout: { id: 'soYVal', format: (v, raw) => raw } });
bindStyleControl('soX', 'x', { transform: pct, readout: { id: 'soXVal', format: (v, raw) => raw } });
bindStyleControl('soMaxWidth', 'maxWidthPct', {
  transform: pct, readout: { id: 'soMaxWidthVal', format: (v, raw) => raw }
});
bindStyleControl('soMaxLines', 'maxLines', { event: 'change', transform: num });
bindStyleControl('soAlign', 'align', { event: 'change' });
bindStyleControl('soReveal', 'reveal', { event: 'change' });

bindStyleControl('soBaseColor', 'baseColor', { readout: { id: 'soBaseColorHex', format: v => v } });
bindStyleControl('soActiveColor', 'activeColor', { readout: { id: 'soActiveColorHex', format: v => v } });

bindStyleControl('soStrokeEnabled', 'strokeEnabled', { event: 'change' });
bindStyleControl('soStrokeWidth', 'strokeWidth', {
  transform: num, readout: { id: 'soStrokeWidthVal', format: v => v }
});
bindStyleControl('soStrokeColor', 'strokeColor', { readout: { id: 'soStrokeColorHex', format: v => v } });

bindStyleControl('soShadowEnabled', 'shadowEnabled', { event: 'change' });
bindStyleControl('soShadowBlur', 'shadowBlur', {
  transform: num, readout: { id: 'soShadowBlurVal', format: v => v }
});

bindStyleControl('soGlowEnabled', 'glowEnabled', { event: 'change' });
bindStyleControl('soGlowColor', 'glowColor', { readout: { id: 'soGlowColorHex', format: v => v } });

bindStyleControl('soAnimationType', 'animationType', { event: 'change' });
bindStyleControl('soAnimationTarget', 'animationTarget', { event: 'change' });
bindStyleControl('soAnimationDuration', 'animationDurationMs', {
  transform: num, readout: { id: 'soAnimationDurationVal', format: v => v }
});

bindStyleControl('soPopEnabled', 'popEnabled', { event: 'change' });
bindStyleControl('soPopScale', 'popScale', {
  transform: num, readout: { id: 'soPopScaleVal', format: v => v.toFixed(2) }
});

bindStyleControl('soHeroSizeScale', 'heroSizeScale', {
  transform: num, readout: { id: 'soHeroSizeScaleVal', format: v => v.toFixed(2) }
});

// Changing family can invalidate the selected weight, so re-offer the weights
// that actually exist for the new family.
if ($('soFontFamily')) {
  $('soFontFamily').addEventListener('change', e => {
    populateWeightOptions(e.target.value, state.template ? state.template.font.weight : 700);
    setStyleOverride('fontWeight', Number($('soFontWeight').value));
    saveProjectState();
  });
}

if ($('resetStyleBtn')) {
  $('resetStyleBtn').addEventListener('click', () => {
    if (!Object.keys(state.styleOverrides).length) return;
    pushUndoState();
    state.styleOverrides = {};
    refreshTemplate();
    syncStyleInspector();
    renderCaptions();
    saveProjectState();
  });
}

// Inspector tabs
document.querySelectorAll('.inspector-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.tab;
    document.querySelectorAll('.inspector-tab').forEach(t => {
      const active = t === tab;
      t.classList.toggle('active', active);
      t.setAttribute('aria-selected', String(active));
    });
    document.querySelectorAll('.inspector-panel').forEach(panel => {
      panel.classList.toggle('hidden', panel.dataset.panel !== target);
    });
  });
});

if ($('templateSearch')) {
  $('templateSearch').addEventListener('input', e => {
    state.templateQuery = e.target.value;
    renderTemplateGallery();
  });
}

function applyLowResMode() {
  const isLowRes = $('lowResToggle') ? $('lowResToggle').checked : false;
  const factor = isLowRes ? 0.5 : 1.0;
  captionCanvas.width = state.baseCanvasWidth * factor;
  captionCanvas.height = state.baseCanvasHeight * factor;
  if (window.CaptionRenderer) window.CaptionRenderer.clearLayoutCache();
  renderCaptions();
}

if ($('lowResToggle')) $('lowResToggle').addEventListener('change', applyLowResMode);
applyLowResMode();

// â”€â”€â”€ Export: MP4 (Server-side frame-by-frame) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const STATUS_LABELS = {
  queued: 'Waiting for a free render slot...',
  probing: 'Reading the source video...',
  rendering: 'Rendering caption frames...',
  completed: 'Done — starting download...',
  failed: 'Export failed',
  cancelled: 'Export cancelled'
};

function setExportProgress(percent, label) {
  exportProgressFill.style.width = `${percent}%`;
  exportPercent.textContent = `${Math.round(percent)}%`;
  if (label) exportStatus.textContent = label;
}

/**
 * Render on the server as a tracked job.
 *
 * Progress comes from the job's real frame counter rather than a timer, and
 * cancelling actually stops the render instead of only hiding the dialog.
 */
async function exportMP4() {
  if (state.exporting) return;
  if (!state.compositions.length) {
    alert('There are no captions to render yet.');
    return;
  }

  state.exporting = true;
  state.exportJobId = null;
  exportModal.classList.remove('hidden');
  setExportProgress(0, 'Queueing export...');

  try {
    const response = await fetch('/api/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        compositions: state.compositions,
        tokens: state.tokens,
        templateId: state.templateId,
        styleOverrides: state.styleOverrides,
        videoUrl: state.videoUrl,
        title: state.filename.replace(/\.[^/.]+$/, '')
      })
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Could not start export (HTTP ${response.status})`);
    state.exportJobId = data.jobId;

    const job = await pollExportJob(data.jobId);

    if (job.status === 'cancelled') {
      setExportProgress(0, STATUS_LABELS.cancelled);
      setTimeout(() => exportModal.classList.add('hidden'), 1200);
      return;
    }
    if (job.status !== 'completed') {
      throw new Error(job.error || 'Rendering failed.');
    }

    setExportProgress(100, STATUS_LABELS.completed);
    triggerDownload(job.downloadUrl);
    setTimeout(() => exportModal.classList.add('hidden'), 900);
  } catch (error) {
    console.error('Export error:', error);
    exportStatus.textContent = 'Export failed: ' + error.message;
    setTimeout(() => exportModal.classList.add('hidden'), 5000);
  } finally {
    state.exporting = false;
    state.exportJobId = null;
  }
}

async function pollExportJob(jobId) {
  while (true) {
    await new Promise(r => setTimeout(r, 500));
    const res = await fetch(`/api/export/${jobId}`);
    if (!res.ok) throw new Error('Lost track of the export job.');
    const job = await res.json();

    const label = job.status === 'rendering' && job.totalFrames
      ? `Rendering frame ${job.frame} of ${job.totalFrames}...`
      : STATUS_LABELS[job.status] || job.status;
    setExportProgress(job.progress || 0, label);

    if (['completed', 'failed', 'cancelled'].includes(job.status)) return job;
  }
}

function triggerDownload(url) {
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

$('exportBtn').addEventListener('click', exportMP4);
if ($('exportMainBtn')) $('exportMainBtn').addEventListener('click', exportMP4);
$('cancelExportBtn').addEventListener('click', async () => {
  if (!state.exportJobId) {
    exportModal.classList.add('hidden');
    return;
  }
  exportStatus.textContent = 'Cancelling...';
  await fetch(`/api/export/${state.exportJobId}/cancel`, { method: 'POST' }).catch(() => {});
});

// â”€â”€â”€ Export: SRT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

$('exportSrtBtn').addEventListener('click', async () => {
  try {
    const response = await fetch('/api/export-srt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ compositions: state.compositions, tokens: state.tokens })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);

    const blob = new Blob([data.srt], { type: 'application/x-subrip;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const baseName = state.filename.replace(/\.[^/.]+$/, '');
    a.download = `${baseName}-captions.srt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert('SRT export failed: ' + err.message);
  }
});

// Search Projects Filter
const projectSearchInput = $('projectSearchInput');
if (projectSearchInput) {
  projectSearchInput.addEventListener('input', e => {
    const query = e.target.value.toLowerCase();
    const filtered = allProjects.filter(p => p.title.toLowerCase().includes(query));
    renderProjectsGrid(filtered);
  });
}

// â”€â”€â”€ Workspace Resize Splitter dragging â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function splitCompositionAtWord(compId, tokenId) {
  pushUndoState();
  const comp = state.compositions.find(c => c.id === compId);
  if (!comp) return;

  const splitIdx = comp.token_ids.indexOf(tokenId);
  if (splitIdx <= 0) return; // Can't split at first word

  const tokenMap = new Map(state.tokens.map(t => [t.id, t]));
  const leftTokenIds = comp.token_ids.slice(0, splitIdx);
  const rightTokenIds = comp.token_ids.slice(splitIdx);

  const firstRightToken = tokenMap.get(rightTokenIds[0]);
  const lastLeftToken = tokenMap.get(leftTokenIds[leftTokenIds.length - 1]);

  const newCompId = 'comp-' + Math.random().toString(36).substr(2, 9) + '-' + Date.now();
  const newComp = {
    id: newCompId,
    token_ids: rightTokenIds,
    layout_id: comp.layout_id,
    comp_type: comp.comp_type,
    hero_token_id: rightTokenIds[0],
    start_ms: firstRightToken ? firstRightToken.start_ms : comp.end_ms,
    end_ms: comp.end_ms
  };

  comp.token_ids = leftTokenIds;
  comp.end_ms = lastLeftToken ? lastLeftToken.end_ms : comp.start_ms;
  if (!leftTokenIds.includes(comp.hero_token_id)) {
    comp.hero_token_id = leftTokenIds[0];
  }

  updateCompTexts(comp, tokenMap);
  updateCompTexts(newComp, tokenMap);

  const idx = state.compositions.findIndex(c => c.id === compId);
  state.compositions.splice(idx + 1, 0, newComp);

  commitEdit();
}

function moveWordToken(draggedId, targetId) {
  pushUndoState();
  const sourceComp = state.compositions.find(c => c.token_ids.includes(draggedId));
  const targetComp = state.compositions.find(c => c.token_ids.includes(targetId));
  if (!sourceComp || !targetComp) return;

  const tokenMap = new Map(state.tokens.map(t => [t.id, t]));
  const draggedToken = tokenMap.get(draggedId);
  const targetToken = tokenMap.get(targetId);
  if (!draggedToken || !targetToken) return;

  // Remove from source
  sourceComp.token_ids = sourceComp.token_ids.filter(id => id !== draggedId);

  // Insert into target
  const targetIdx = targetComp.token_ids.indexOf(targetId);
  targetComp.token_ids.splice(targetIdx, 0, draggedId);

  // Adjust timing chronologically
  const sortedTokens = targetComp.token_ids.map(id => tokenMap.get(id)).filter(Boolean);
  const selfIdx = sortedTokens.findIndex(t => t.id === draggedId);
  const prevToken = selfIdx > 0 ? sortedTokens[selfIdx - 1] : null;
  const nextToken = selfIdx < sortedTokens.length - 1 ? sortedTokens[selfIdx + 1] : null;

  if (prevToken && nextToken) {
    const avg = Math.round((prevToken.end_ms + nextToken.start_ms) / 2);
    draggedToken.start_ms = Math.max(prevToken.end_ms + 10, avg - 50);
    draggedToken.end_ms = Math.min(nextToken.start_ms - 10, avg + 50);
  } else if (prevToken) {
    draggedToken.start_ms = prevToken.end_ms + 10;
    draggedToken.end_ms = prevToken.end_ms + 200;
  } else if (nextToken) {
    draggedToken.start_ms = Math.max(0, nextToken.start_ms - 200);
    draggedToken.end_ms = nextToken.start_ms - 10;
  }

  // Sort Target Compositions token_ids based on start_ms
  targetComp.token_ids.sort((a, b) => tokenMap.get(a).start_ms - tokenMap.get(b).start_ms);

  // Source Comp clean up
  if (sourceComp.token_ids.length === 0) {
    state.compositions = state.compositions.filter(c => c.id !== sourceComp.id);
  } else {
    sourceComp.start_ms = tokenMap.get(sourceComp.token_ids[0]).start_ms;
    sourceComp.end_ms = tokenMap.get(sourceComp.token_ids[sourceComp.token_ids.length - 1]).end_ms;
    if (sourceComp.hero_token_id === draggedId) {
      sourceComp.hero_token_id = sourceComp.token_ids[0];
    }
    updateCompTexts(sourceComp, tokenMap);
  }

  // Target Comp boundaries
  targetComp.start_ms = tokenMap.get(targetComp.token_ids[0]).start_ms;
  targetComp.end_ms = tokenMap.get(targetComp.token_ids[targetComp.token_ids.length - 1]).end_ms;
  updateCompTexts(targetComp, tokenMap);

  commitEdit();
}

function initWordContextMenu() {
  const menu = $('wordContextMenu');
  if (!menu) return;

  // Toggle Spotlight option
  $('ctxSpotlightBtn').addEventListener('click', () => {
    pushUndoState();
    const compId = state.contextCompId;
    const tokenId = state.contextTokenId;
    const comp = state.compositions.find(c => c.id === compId);
    if (!comp) return;

    if (comp.comp_type === 'spotlight' && comp.hero_token_id === tokenId) {
      comp.comp_type = 'emphasis';
    } else {
      comp.comp_type = 'spotlight';
      comp.hero_token_id = tokenId;
    }
    const tokenMap = new Map(state.tokens.map(t => [t.id, t]));
    updateCompTexts(comp, tokenMap);
    commitEdit();
  });

  // Toggle Emphasis option
  $('ctxEmphasisBtn').addEventListener('click', () => {
    pushUndoState();
    const compId = state.contextCompId;
    const tokenId = state.contextTokenId;
    const comp = state.compositions.find(c => c.id === compId);
    if (!comp) return;

    if (comp.comp_type === 'emphasis' && comp.hero_token_id === tokenId) {
      comp.comp_type = 'plain';
    } else {
      comp.comp_type = 'emphasis';
      comp.hero_token_id = tokenId;
    }
    const tokenMap = new Map(state.tokens.map(t => [t.id, t]));
    updateCompTexts(comp, tokenMap);
    commitEdit();
  });

  // Split option
  $('ctxSplitBtn').addEventListener('click', () => {
    const compId = state.contextCompId;
    const tokenId = state.contextTokenId;
    splitCompositionAtWord(compId, tokenId);
  });

  // Combine option
  $('ctxCombineBtn').addEventListener('click', () => {
    if (state.selectedTokenIds.length < 2) return;
    pushUndoState();
    const tokenMap = new Map(state.tokens.map(t => [t.id, t]));
    const selectedTokens = state.selectedTokenIds.map(tid => tokenMap.get(tid)).filter(Boolean).sort((a, b) => a.start_ms - b.start_ms);
    const comp = state.compositions.find(c => c.token_ids.includes(selectedTokens[0].id));
    if (!comp) return;

    const combinedText = selectedTokens.map(t => t.text).join(' ');
    const combinedStart = selectedTokens[0].start_ms;
    const combinedEnd = selectedTokens[selectedTokens.length - 1].end_ms;

    const targetToken = selectedTokens[0];
    targetToken.text = combinedText;
    targetToken.start_ms = combinedStart;
    targetToken.end_ms = combinedEnd;

    const otherTokenIds = selectedTokens.slice(1).map(t => t.id);
    comp.token_ids = comp.token_ids.filter(tid => !otherTokenIds.includes(tid));
    state.tokens = state.tokens.filter(t => !otherTokenIds.includes(t.id));

    if (otherTokenIds.includes(comp.hero_token_id)) {
      comp.hero_token_id = targetToken.id;
    }

    state.selectedTokenIds = [];
    updateCompTexts(comp, tokenMap);
    commitEdit();
  });

  // Add Word After option
  $('ctxAddBtn').addEventListener('click', () => {
    const compId = state.contextCompId;
    const tokenId = state.contextTokenId;
    const comp = state.compositions.find(c => c.id === compId);
    if (!comp) return;

    const tokenMap = new Map(state.tokens.map(t => [t.id, t]));
    const clickedToken = tokenMap.get(tokenId);
    if (!clickedToken) return;

    const newText = prompt("Enter new word text:");
    if (!newText || !newText.trim()) return;

    pushUndoState();

    // Create new token
    const newTokenId = 'token-' + Math.random().toString(36).substr(2, 9) + '-' + Date.now();
    const start = clickedToken.end_ms + 10;
    const end = start + 300;
    
    const newToken = {
      id: newTokenId,
      text: newText.trim(),
      start_ms: start,
      end_ms: end
    };
    state.tokens.push(newToken);

    // Insert token ID immediately after the clickedToken ID in composition
    const idx = comp.token_ids.indexOf(tokenId);
    comp.token_ids.splice(idx + 1, 0, newTokenId);

    // Update composition boundaries
    const freshTokenMap = new Map(state.tokens.map(t => [t.id, t]));
    comp.token_ids.sort((a, b) => freshTokenMap.get(a).start_ms - freshTokenMap.get(b).start_ms);
    comp.start_ms = freshTokenMap.get(comp.token_ids[0]).start_ms;
    comp.end_ms = freshTokenMap.get(comp.token_ids[comp.token_ids.length - 1]).end_ms;

    updateCompTexts(comp, freshTokenMap);
    commitEdit();
  });

  // Delete option
  $('ctxDeleteBtn').addEventListener('click', () => {
    pushUndoState();
    const toDeleteIds = state.selectedTokenIds.length > 0 ? [...state.selectedTokenIds] : [state.contextTokenId];
    
    state.tokens = state.tokens.filter(t => !toDeleteIds.includes(t.id));
    state.compositions.forEach(comp => {
      comp.token_ids = comp.token_ids.filter(tid => !toDeleteIds.includes(tid));
    });

    state.compositions.forEach(comp => {
      if (comp.token_ids.length > 0 && !comp.token_ids.includes(comp.hero_token_id)) {
        comp.hero_token_id = comp.token_ids[0];
      }
    });
    state.compositions = state.compositions.filter(c => c.token_ids.length > 0);

    const tokenMap = new Map(state.tokens.map(t => [t.id, t]));
    state.compositions.forEach(comp => updateCompTexts(comp, tokenMap));

    state.selectedTokenIds = [];
    commitEdit();
  });

  // Global dismiss context menu
  document.addEventListener('click', () => {
    menu.classList.add('hidden');
  });
}

// â”€â”€â”€ Keyboard Shortcuts â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

document.addEventListener('keydown', e => {
  if (e.code === 'Space' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'SELECT' && !e.target.isContentEditable) {
    e.preventDefault();
    if (videoPlayer.paused) videoPlayer.play();
    else videoPlayer.pause();
  }
});

// Blur focused buttons on click to preserve spacebar play/pause focus behavior
document.addEventListener('click', e => {
  if (e.target && e.target.closest && e.target.closest('button')) {
    e.target.closest('button').blur();
  }
});

// â”€â”€â”€ Caption Tools Dropdown Menu & Filters â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const captionToolsBtn = $('captionToolsBtn');
const captionToolsMenu = $('captionToolsMenu');

if (captionToolsBtn && captionToolsMenu) {
  captionToolsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    captionToolsMenu.classList.toggle('hidden');
  });

  // Close dropdown on click outside
  document.addEventListener('click', () => {
    captionToolsMenu.classList.add('hidden');
  });

  // 1. Strip Punctuation
  $('stripPunctuationBtn').addEventListener('click', () => {
    if (!state.tokens.length) return;
    
    // Strip punctuation marks from token text
    state.tokens.forEach(token => {
      token.text = token.text.replace(/[,.?!:;\-"]/g, '').trim();
    });

    // Re-build text fields for compositions
    const tokenMap = new Map(state.tokens.map(t => [t.id, t]));
    state.compositions.forEach(comp => {
      updateCompTexts(comp, tokenMap);
    });

    commitEdit();
  });

  // 2. Strip Emphasis
  $('stripEmphasisBtn').addEventListener('click', () => {
    if (!state.compositions.length) return;
    
    state.compositions.forEach(comp => {
      comp.comp_type = 'plain';
    });

    commitEdit();
  });

  // 3. Remove Gaps
  $('removeGapsBtn').addEventListener('click', () => {
    if (!state.compositions.length || !state.tokens.length) return;
    
    const tokenMap = new Map(state.tokens.map(t => [t.id, t]));
    
    for (let i = 0; i < state.compositions.length - 1; i++) {
      const curr = state.compositions[i];
      const next = state.compositions[i + 1];
      
      // If there is silence/gap between compositions
      if (next.start_ms - curr.end_ms > 0) {
        curr.end_ms = next.start_ms;
        
        // Extend the last token of current composition to bridge the silence
        const lastTokenId = curr.token_ids[curr.token_ids.length - 1];
        const lastToken = tokenMap.get(lastTokenId);
        if (lastToken) {
          lastToken.end_ms = next.start_ms;
        }
      }
    }

    commitEdit();
  });
}

// â”€â”€â”€ Initialization on Boot â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

initWordContextMenu();

// Exposed for debugging and for the headless UI test to inspect editor state.
window.__muft = { state, refreshTemplate, renderCaptions, commitEdit };

if ($('undoBtn')) $('undoBtn').addEventListener('click', undo);
if ($('redoBtn')) $('redoBtn').addEventListener('click', redo);
updateUndoRedoButtons();

/**
 * The renderer is an ES module, so it finishes loading after this classic
 * script. Everything that depends on it is set up once it announces itself.
 */
function onRendererReady() {
  populateFontOptions();
  refreshTemplate();
  syncStyleInspector();
  loadTemplateList();
  renderCaptions();
}

if (window.CaptionRenderer) onRendererReady();
else window.addEventListener('caption-renderer-ready', onRendererReady, { once: true });


