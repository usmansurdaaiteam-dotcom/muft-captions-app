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
  const token = localStorage.getItem('muft_auth_token');
  if (!token) {
    showPasswordPrompt();
  } else {
    // Validate token status
    fetch('/api/auth/status')
      .then(r => r.json())
      .then(data => {
        if (!data.authenticated) {
          localStorage.removeItem('muft_auth_token');
          showPasswordPrompt();
        }
      })
      .catch(() => {});
  }

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
  // Template (loaded from JSON)
  template: null,
  templateId: 'kalakar-glow',
  // Animation config (separate from template)
  animation: {
    type: 'pop_bounce',
    scaleFrom: 0.82,
    scalePeak: 1.15,
    durationMs: 220,
    peakAtMs: 130
  },
  // Export
  exporting: false,
  exportCancelled: false,
  // Selected tokens for multi-select
  selectedTokenIds: [],
  userHoveringCaptions: false
};

// â”€â”€â”€ Project Database & Autosave API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function saveProjectState() {
  if (!state.projectId) return;
  try {
    const payload = {
      id: state.projectId,
      title: state.filename,
      videoUrl: state.videoUrl,
      createdAt: Date.now(),
      tokens: state.tokens,
      compositions: state.compositions,
      template: state.template
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

function pushUndoState() {
  if (!state.template) return;
  const now = Date.now();
  if (now - lastPushTime < 300) return;
  lastPushTime = now;

  if (state.undoStack.length >= 50) {
    state.undoStack.shift();
  }
  state.undoStack.push(JSON.stringify({
    tokens: state.tokens,
    compositions: state.compositions,
    template: state.template
  }));
  state.redoStack = []; // Clear redo stack on new action
}

function updateStyleProperty(updater) {
  if (!state.template) return;

  const applyToAll = $('applyToAllToggle') ? $('applyToAllToggle').checked : true;
  
  if (applyToAll) {
    // Apply globally
    updater(state.template);
    
    // Clear overrides on the active composition if any
    const ms = state.currentTime * 1000;
    const comp = state.compositions.find(c => ms >= c.start_ms && ms <= c.end_ms);
    if (comp) {
      delete comp.override_hero_size;
      delete comp.override_support_size;
      delete comp.override_hero_color;
      delete comp.override_support_color;
      delete comp.override_font_family;
      delete comp.override_center_x;
      delete comp.override_center_y;
    }
  } else {
    // Apply only to the active composition
    const ms = state.currentTime * 1000;
    const comp = state.compositions.find(c => ms >= c.start_ms && ms <= c.end_ms);
    if (comp) {
      const mockTemplate = {
        hero: {
          fontSize: comp.override_hero_size !== undefined ? comp.override_hero_size : state.template.hero.fontSize,
          color: comp.override_hero_color !== undefined ? comp.override_hero_color : state.template.hero.color,
          fontFamily: comp.override_font_family !== undefined ? comp.override_font_family : state.template.hero.fontFamily,
          uppercase: state.template.hero.uppercase,
          letterSpacing: state.template.hero.letterSpacing,
          stroke: state.template.hero.stroke
        },
        support: {
          fontSize: comp.override_support_size !== undefined ? comp.override_support_size : state.template.support.fontSize,
          color: comp.override_support_color !== undefined ? comp.override_support_color : state.template.support.color,
          fontFamily: comp.override_font_family !== undefined ? comp.override_font_family : state.template.support.fontFamily,
          uppercase: state.template.support.uppercase,
          letterSpacing: state.template.support.letterSpacing,
          stroke: state.template.support.stroke
        },
        layout: {
          captionCenterX: comp.override_center_x !== undefined ? comp.override_center_x : state.template.layout.captionCenterX,
          captionCenterY: comp.override_center_y !== undefined ? comp.override_center_y : state.template.layout.captionCenterY
        }
      };

      updater(mockTemplate);

      // Save overrides back to comp
      comp.override_hero_size = mockTemplate.hero.fontSize;
      comp.override_support_size = mockTemplate.support.fontSize;
      comp.override_hero_color = mockTemplate.hero.color;
      comp.override_support_color = mockTemplate.support.color;
      comp.override_font_family = mockTemplate.hero.fontFamily;
      comp.override_center_x = mockTemplate.layout.captionCenterX;
      comp.override_center_y = mockTemplate.layout.captionCenterY;
    }
  }

  renderCaptions();
}

function syncStyleInspectorToActive() {
  if (!state.template) return;
  const ms = state.currentTime * 1000;
  const comp = state.compositions.find(c => ms >= c.start_ms && ms <= c.end_ms);
  if (!comp) return;

  const effective = TemplateEngine.getEffectiveTemplate(state.template, comp);
  
  if ($('heroSizeSlider')) {
    $('heroSizeSlider').value = effective.hero.fontSize;
    $('heroSizeVal').textContent = effective.hero.fontSize;
  }
  if ($('supportSizeSlider')) {
    $('supportSizeSlider').value = effective.support.fontSize;
    $('supportSizeVal').textContent = effective.support.fontSize;
  }
  if ($('heroColorPicker')) $('heroColorPicker').value = effective.hero.color;
  if ($('supportColorPicker')) $('supportColorPicker').value = effective.support.color;
  if ($('fontSelect')) {
    const match = Array.from($('fontSelect').options).find(opt => opt.value.includes(effective.hero.fontFamily));
    if (match) $('fontSelect').value = match.value;
  }
}

window.addEventListener('keydown', e => {
  const activeTag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
  const isEditingText = activeTag === 'input' || activeTag === 'textarea' || (document.activeElement && document.activeElement.contentEditable === 'true');
  
  if (e.ctrlKey && !e.altKey) {
    if (e.key.toLowerCase() === 'z') {
      if (isEditingText) return; // Let default browser undo run for text fields
      e.preventDefault();
      
      if (state.undoStack.length > 0) {
        state.redoStack.push(JSON.stringify({
          tokens: state.tokens,
          compositions: state.compositions,
          template: state.template
        }));
        
        const popped = JSON.parse(state.undoStack.pop());
        state.tokens = popped.tokens;
        state.compositions = popped.compositions;
        state.template = popped.template;
        
        // Sync style inspector UI elements
        if (state.template) {
          if ($('heroSizeSlider')) {
            $('heroSizeSlider').value = state.template.hero.fontSize;
            $('heroSizeVal').textContent = state.template.hero.fontSize;
          }
          if ($('supportSizeSlider')) {
            $('supportSizeSlider').value = state.template.support.fontSize;
            $('supportSizeVal').textContent = state.template.support.fontSize;
          }
          if ($('heroColorPicker')) $('heroColorPicker').value = state.template.hero.color;
          if ($('supportColorPicker')) $('supportColorPicker').value = state.template.support.color;
          if ($('fontSelect')) {
            const match = Array.from($('fontSelect').options).find(opt => opt.value.includes(state.template.hero.fontFamily));
            if (match) $('fontSelect').value = match.value;
          }
        }
        
        saveProjectState();
        renderCaptionList();
        renderTimeline();
        renderCaptions();
      }
    } else if (e.key.toLowerCase() === 'y') {
      if (isEditingText) return;
      e.preventDefault();
      
      if (state.redoStack.length > 0) {
        state.undoStack.push(JSON.stringify({
          tokens: state.tokens,
          compositions: state.compositions,
          template: state.template
        }));
        
        const popped = JSON.parse(state.redoStack.pop());
        state.tokens = popped.tokens;
        state.compositions = popped.compositions;
        state.template = popped.template;
        
        // Sync style inspector UI elements
        if (state.template) {
          if ($('heroSizeSlider')) {
            $('heroSizeSlider').value = state.template.hero.fontSize;
            $('heroSizeVal').textContent = state.template.hero.fontSize;
          }
          if ($('supportSizeSlider')) {
            $('supportSizeSlider').value = state.template.support.fontSize;
            $('supportSizeVal').textContent = state.template.support.fontSize;
          }
          if ($('heroColorPicker')) $('heroColorPicker').value = state.template.hero.color;
          if ($('supportColorPicker')) $('supportColorPicker').value = state.template.support.color;
          if ($('fontSelect')) {
            const match = Array.from($('fontSelect').options).find(opt => opt.value.includes(state.template.hero.fontFamily));
            if (match) $('fontSelect').value = match.value;
          }
        }
        
        saveProjectState();
        renderCaptionList();
        renderTimeline();
        renderCaptions();
      }
    }
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
    
    state.projectId = data.id;
    state.tokens = data.tokens;
    state.compositions = data.compositions;
    state.videoUrl = data.videoUrl;
    state.filename = data.title;
    state.template = data.template;
    
    state.undoStack = [];
    state.redoStack = [];
    updateUndoRedoButtons();
    
    if (state.template) {
      if ($('heroColorPicker')) {
        $('heroColorPicker').value = state.template.hero.color;
        $('heroColorHex').textContent = state.template.hero.color;
      }
      if ($('supportColorPicker')) {
        $('supportColorPicker').value = state.template.support.color;
        $('supportColorHex').textContent = state.template.support.color;
      }
      if ($('heroSizeSlider')) {
        $('heroSizeSlider').value = state.template.hero.fontSize;
        $('heroSizeVal').textContent = state.template.hero.fontSize;
      }
      if ($('supportSizeSlider')) {
        $('supportSizeSlider').value = state.template.support.fontSize;
        $('supportSizeVal').textContent = state.template.support.fontSize;
      }
      if ($('fontSelect')) {
        for (const opt of $('fontSelect').options) {
          if (opt.value.includes(state.template.hero.fontFamily)) {
            opt.selected = true;
            break;
          }
        }
      }
    }
    
    showEditor();
  } catch (err) {
    alert('Failed to load project: ' + err.message);
  }
}

// Load default template immediately
async function loadTemplate(templateId) {
  const res = await fetch(`/templates/${templateId}.json`);
  if (!res.ok) throw new Error(`Failed to load template: ${templateId}`);
  state.template = await res.json();
  state.templateId = templateId;
  console.log(`[Template] Loaded: ${state.template.name}`);
  return state.template;
}

loadTemplate('kalakar-glow').catch(err => console.error('Template load failed:', err));

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

    // Load state
    state.projectId = data.projectId;
    state.tokens = data.tokens;
    state.compositions = data.compositions;
    state.videoUrl = data.videoUrl;
    state.filename = data.filename;

    // Transition to editor
    showEditor();

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

  // Load video
  const onMetadataLoaded = () => {
    state.videoDuration = videoPlayer.duration;
    updateTimeDisplay();
    renderTimeline();
  };
  videoPlayer.addEventListener('loadedmetadata', onMetadataLoaded);
  
  videoPlayer.src = state.videoUrl;
  videoPlayer.load();

  // If already loaded / cached
  if (videoPlayer.duration) {
    state.videoDuration = videoPlayer.duration;
    updateTimeDisplay();
    renderTimeline();
  }

  // Render caption list
  renderCaptionList();

  // Start render loop for canvas overlay
  requestAnimationFrame(renderLoop);
}

async function closeProject() {
  if (state.projectId) {
    await saveProjectState();
  }
  state.projectId = null;
  state.tokens = [];
  state.compositions = [];
  state.videoUrl = '';
  state.filename = '';
  state.videoDuration = 0;
  state.currentTime = 0;
  state.undoStack = [];
  state.redoStack = [];
  updateUndoRedoButtons();
  
  videoPlayer.src = '';
  
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
          saveProjectState();
          renderCaptionList();
          renderTimeline();
          renderCaptions();
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
          saveProjectState();
          renderCaptionList();
          renderTimeline();
          renderCaptions();
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
            
            saveProjectState();
            renderCaptionList();
            renderTimeline();
            renderCaptions();
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
            saveProjectState();
            renderCaptionList();
            renderTimeline();
            renderCaptions();
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
            saveProjectState();
            renderCaptionList();
            renderTimeline();
            renderCaptions();
            return;
          }

          if (newText !== token.text) {
            pushUndoState();
            token.text = newText;
            updateCompTexts(comp, tokenMap);
            saveProjectState();
            renderCaptionList();
            renderTimeline();
            renderCaptions();
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
    const layoutBtn = document.createElement('button');
    layoutBtn.className = 'layout-btn';
    layoutBtn.textContent = '\u229E';
    layoutBtn.title = 'Change layout: ' + comp.layout_id;
    layoutBtn.addEventListener('click', e => {
      e.stopPropagation();
      cycleLayout(comp.id);
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
      saveProjectState();
      renderCaptionList();
      renderTimeline();
      renderCaptions();
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

function updateCompTexts(comp, tokenMap) {
  const compTokens = comp.token_ids.map(id => tokenMap.get(id)).filter(Boolean);
  const heroIdx = compTokens.findIndex(t => t.id === comp.hero_token_id);
  const validHeroIdx = heroIdx >= 0 ? heroIdx : 0;
  
  const beforeTokens = compTokens.slice(0, validHeroIdx);
  const heroToken = compTokens[validHeroIdx];
  const afterTokens = compTokens.slice(validHeroIdx + 1);

  comp.hero_text = heroToken ? heroToken.text.trim() : '';
  comp.before_text = beforeTokens.map(t => t.text.trim()).join(' ');
  comp.after_text = afterTokens.map(t => t.text.trim()).join(' ');
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

const LAYOUT_ORDER = ['stack_center', 'before_left_after_right', 'hero_left_support_right', 'hero_only'];

function cycleLayout(compId) {
  pushUndoState();
  const comp = state.compositions.find(c => c.id === compId);
  if (!comp) return;
  const idx = LAYOUT_ORDER.indexOf(comp.layout_id);
  comp.layout_id = LAYOUT_ORDER[(idx + 1) % LAYOUT_ORDER.length];
  renderCaptionList();
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
  
  syncStyleInspectorToActive();

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
// Uses the shared TemplateEngine (loaded from template-engine.js)

function renderLoop() {
  renderCaptions();
  requestAnimationFrame(renderLoop);
}

// Bounding box state for dragging
let dragBox = null; // { x, y, w, h } in 1080x1920 canvas coordinates
let activeDrag = null; // null | { type: 'move'|'scale', startX, startY, startCenterX, startCenterY, startHeroSize, startSupportSize }

function getActiveCaptionBox(ctx) {
  if (!state.template || !state.compositions.length) return null;
  const ms = state.currentTime * 1000;
  const comp = state.compositions.find(c => ms >= c.start_ms && ms <= c.end_ms);
  if (!comp) return null;

  const layout = state.template.layout;
  if (!layout.captionCenterX) layout.captionCenterX = 0.5;
  if (!layout.captionCenterY) layout.captionCenterY = 0.52;

  const centerX = state.baseCanvasWidth * layout.captionCenterX;
  const centerY = state.baseCanvasHeight * layout.captionCenterY;
  
  const compType = comp.comp_type || 'emphasis';
  const heroFontSize = state.template.hero.fontSize;
  const supportFontSize = state.template.support.fontSize;
  const lineGap = Math.round(supportFontSize * 0.15);

  let w = 0, h = 0, y = 0;

  if (compType === 'plain') {
    const allText = comp.token_ids
      .map(id => state.tokens.find(t => t.id === id))
      .filter(Boolean)
      .map(t => t.text.trim())
      .join(' ');
    
    ctx.font = `${state.template.support.fontWeight} ${supportFontSize}px ${getFontFamilyString(state.template.support.fontFamily)}`;
    const textWidth = ctx.measureText(allText).width;
    w = Math.max(300, textWidth + 60);
    h = supportFontSize * 1.5;
    y = centerY - h / 2;
  } else if (compType === 'spotlight') {
    const heroText = comp.token_ids
      .map(id => state.tokens.find(t => t.id === id))
      .filter(Boolean)
      .map(t => t.text.trim())
      .join(' ');
    
    ctx.font = `${state.template.hero.fontWeight} ${heroFontSize}px ${getFontFamilyString(state.template.hero.fontFamily)}`;
    const textWidth = ctx.measureText(heroText).width;
    w = Math.max(300, textWidth + 60);
    h = heroFontSize * 1.5;
    y = centerY - h / 2;
  } else {
    const tokenMap = new Map(state.tokens.map(t => [t.id, t]));
    const beforeText = comp.before_text || '';
    const heroText = (tokenMap.get(comp.hero_token_id)?.text || '').trim();
    const afterText = comp.after_text || '';
    
    ctx.font = `${state.template.support.fontWeight} ${supportFontSize}px ${getFontFamilyString(state.template.support.fontFamily)}`;
    const beforeWidth = beforeText ? ctx.measureText(beforeText).width : 0;
    const afterWidth = afterText ? ctx.measureText(afterText).width : 0;
    
    ctx.font = `${state.template.hero.fontWeight} ${heroFontSize}px ${getFontFamilyString(state.template.hero.fontFamily)}`;
    const heroWidth = heroText ? ctx.measureText(heroText).width : 0;
    
    const beforeY = centerY - Math.round(heroFontSize * 0.5) - Math.round(supportFontSize * 0.5) - lineGap;
    const afterY = centerY + Math.round(heroFontSize * 0.5) + Math.round(supportFontSize * 0.5) + lineGap;
    
    const topY = beforeText ? (beforeY - supportFontSize / 2) : (centerY - heroFontSize / 2);
    const bottomY = afterText ? (afterY + supportFontSize / 2) : (centerY + heroFontSize / 2);
    
    h = bottomY - topY + 40;
    w = Math.max(beforeWidth, heroWidth, afterWidth) + 80;
    y = topY - 20;
  }

  return { x: centerX - w / 2, y, w, h };
}

function drawBoundingBox() {}

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

    const ms = state.currentTime * 1000;
    const comp = state.compositions.find(c => ms >= c.start_ms && ms <= c.end_ms);
    const effective = comp ? TemplateEngine.getEffectiveTemplate(state.template, comp) : state.template;

    const handle = e.target.closest('.handle');
    if (handle) {
      // Corner handle dragging to scale based on distance from center
      const centerX = dragBox.x + dragBox.w / 2;
      const centerY = dragBox.y + dragBox.h / 2;

      const mouseCanvasX = (e.clientX - rect.left) * scaleX;
      const mouseCanvasY = (e.clientY - rect.top) * scaleY;
      const startDist = Math.hypot(mouseCanvasX - centerX, mouseCanvasY - centerY);

      activeDrag = {
        type: 'scale',
        startX: e.clientX,
        startY: e.clientY,
        startHeroSize: effective.hero.fontSize,
        startSupportSize: effective.support.fontSize,
        startDist: Math.max(10, startDist) // Avoid division by zero
      };
    } else {
      // Repositioning drag
      activeDrag = {
        type: 'move',
        startX: e.clientX,
        startY: e.clientY,
        startCenterX: effective.layout.captionCenterX || 0.5,
        startCenterY: effective.layout.captionCenterY || 0.52
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

    const ms = state.currentTime * 1000;
    const comp = state.compositions.find(c => ms >= c.start_ms && ms <= c.end_ms);

    if (activeDrag.type === 'move') {
      const newX = Math.max(0.1, Math.min(0.9, activeDrag.startCenterX + deltaX / 1080));
      const newY = Math.max(0.1, Math.min(0.9, activeDrag.startCenterY + deltaY / 1920));

      const applyToAll = $('applyToAllToggle') ? $('applyToAllToggle').checked : true;
      if (applyToAll) {
        state.template.layout.captionCenterX = newX;
        state.template.layout.captionCenterY = newY;
        if (comp) {
          delete comp.override_center_x;
          delete comp.override_center_y;
        }
      } else {
        if (comp) {
          comp.override_center_x = newX;
          comp.override_center_y = newY;
        }
      }
      renderCaptions();
    } else if (activeDrag.type === 'scale') {
      // Distance-from-center scale calculation (radial scaling)
      const centerX = dragBox.x + dragBox.w / 2;
      const centerY = dragBox.y + dragBox.h / 2;

      const mouseCanvasX = (e.clientX - rect.left) * scaleX;
      const mouseCanvasY = (e.clientY - rect.top) * scaleY;
      const currentDist = Math.hypot(mouseCanvasX - centerX, mouseCanvasY - centerY);

      const ratio = currentDist / activeDrag.startDist;

      const newHero = Math.max(40, Math.min(300, activeDrag.startHeroSize * ratio));
      const newSupport = Math.max(15, Math.min(150, activeDrag.startSupportSize * ratio));

      const applyToAll = $('applyToAllToggle') ? $('applyToAllToggle').checked : true;
      if (applyToAll) {
        state.template.hero.fontSize = Math.round(newHero);
        state.template.support.fontSize = Math.round(newSupport);
        if (comp) {
          delete comp.override_hero_size;
          delete comp.override_support_size;
        }
      } else {
        if (comp) {
          comp.override_hero_size = Math.round(newHero);
          comp.override_support_size = Math.round(newSupport);
        }
      }

      // Sync style inspector sliders with current values
      if ($('heroSizeSlider')) {
        $('heroSizeSlider').value = Math.round(newHero);
        $('heroSizeVal').textContent = Math.round(newHero);
      }
      if ($('supportSizeSlider')) {
        $('supportSizeSlider').value = Math.round(newSupport);
        $('supportSizeVal').textContent = Math.round(newSupport);
      }
      renderCaptions();
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
  if (!state.template) return;

  const canvas = captionCanvas;
  const cw = canvas.width;
  const ch = canvas.height;
  ctx.clearRect(0, 0, cw, ch);

  const ms = state.currentTime * 1000;
  const tokenMap = new Map(state.tokens.map(t => [t.id, t]));

  TemplateEngine.renderComposition(
    ctx, ms, state.compositions, tokenMap,
    state.template, cw, ch, state.animation
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

$('heroColorPicker').addEventListener('input', e => {
  updateStyleProperty(t => {
    t.hero.color = e.target.value;
    $('heroColorHex').textContent = e.target.value;
    document.documentElement.style.setProperty('--hero-color', e.target.value);
  });
});

$('supportColorPicker').addEventListener('input', e => {
  updateStyleProperty(t => {
    t.support.color = e.target.value;
    $('supportColorHex').textContent = e.target.value;
  });
});

$('heroSizeSlider').addEventListener('input', e => {
  updateStyleProperty(t => {
    t.hero.fontSize = Number(e.target.value);
    $('heroSizeVal').textContent = e.target.value;
  });
});

$('supportSizeSlider').addEventListener('input', e => {
  updateStyleProperty(t => {
    t.support.fontSize = Number(e.target.value);
    $('supportSizeVal').textContent = e.target.value;
  });
});

$('fontSelect').addEventListener('change', e => {
  updateStyleProperty(t => {
    t.hero.fontFamily = e.target.value;
    t.support.fontFamily = e.target.value;
  });
  saveProjectState();
});

// Accordion Control Listeners
$('heroUppercaseToggle').addEventListener('change', e => {
  updateStyleProperty(t => {
    t.hero.uppercase = e.target.checked;
  });
  saveProjectState();
});

$('supportUppercaseToggle').addEventListener('change', e => {
  updateStyleProperty(t => {
    t.support.uppercase = e.target.checked;
  });
  saveProjectState();
});

$('captionYSlider').addEventListener('input', e => {
  updateStyleProperty(t => {
    t.layout.captionCenterY = Number(e.target.value) / 100;
    $('captionYVal').textContent = e.target.value;
  });
});
$('captionYSlider').addEventListener('change', saveProjectState);

$('captionXSlider').addEventListener('input', e => {
  updateStyleProperty(t => {
    t.layout.captionCenterX = Number(e.target.value) / 100;
    $('captionXVal').textContent = e.target.value;
  });
});
$('captionXSlider').addEventListener('change', saveProjectState);

$('letterSpacingSlider').addEventListener('input', e => {
  updateStyleProperty(t => {
    t.hero.letterSpacing = Number(e.target.value);
    t.support.letterSpacing = Number(e.target.value);
    $('letterSpacingVal').textContent = e.target.value;
  });
});
$('letterSpacingSlider').addEventListener('change', saveProjectState);

$('strokeToggle').addEventListener('change', e => {
  updateStyleProperty(t => {
    if (!t.hero.stroke) t.hero.stroke = { enabled: false, color: '#000000', width: 0 };
    if (!t.support.stroke) t.support.stroke = { enabled: false, color: '#000000', width: 0 };
    t.hero.stroke.enabled = e.target.checked;
    t.support.stroke.enabled = e.target.checked;
  });
  saveProjectState();
});

$('strokeColorPicker').addEventListener('input', e => {
  updateStyleProperty(t => {
    if (!t.hero.stroke) t.hero.stroke = { enabled: false, color: '#000000', width: 0 };
    if (!t.support.stroke) t.support.stroke = { enabled: false, color: '#000000', width: 0 };
    t.hero.stroke.color = e.target.value;
    t.support.stroke.color = e.target.value;
    $('strokeColorHex').textContent = e.target.value;
  });
});
$('strokeColorPicker').addEventListener('change', saveProjectState);

$('strokeWidthSlider').addEventListener('input', e => {
  updateStyleProperty(t => {
    if (!t.hero.stroke) t.hero.stroke = { enabled: false, color: '#000000', width: 0 };
    if (!t.support.stroke) t.support.stroke = { enabled: false, color: '#000000', width: 0 };
    t.hero.stroke.width = Number(e.target.value);
    t.support.stroke.width = Math.round(Number(e.target.value) * 0.4);
    $('strokeWidthVal').textContent = e.target.value;
  });
});
$('strokeWidthSlider').addEventListener('change', saveProjectState);

$('shadowToggle').addEventListener('change', e => {
  updateStyleProperty(t => {
    t.hero.dropShadow.enabled = e.target.checked;
    t.support.dropShadow.enabled = e.target.checked;
  });
  saveProjectState();
});

$('shadowBlurSlider').addEventListener('input', e => {
  updateStyleProperty(t => {
    t.hero.dropShadow.blur = Number(e.target.value);
    t.support.dropShadow.blur = Math.round(Number(e.target.value) * 0.7);
    $('shadowBlurVal').textContent = e.target.value;
  });
});
$('shadowBlurSlider').addEventListener('change', saveProjectState);

// Track mousedown on all style controls to push undo states
const slidersToTrack = [
  'heroSizeSlider', 'supportSizeSlider', 'captionYSlider', 'captionXSlider',
  'letterSpacingSlider', 'strokeWidthSlider', 'shadowBlurSlider',
  'heroColorPicker', 'supportColorPicker', 'strokeColorPicker',
  'fontSelect', 'heroUppercaseToggle', 'supportUppercaseToggle',
  'strokeToggle', 'shadowToggle'
];
slidersToTrack.forEach(id => {
  const el = $(id);
  if (el) {
    el.addEventListener('mousedown', () => pushUndoState());
    el.addEventListener('change', () => pushUndoState());
  }
});

// Canvas bulk tools action handlers
$('applyAllCoordsBtn').addEventListener('click', () => {
  if (!state.projectId) return;
  // State coordinates are global anyway, but we explicitly persist and alert
  saveProjectState().then(() => {
    alert('âœ“ Coordinates and sizes successfully locked and applied to all compositions!');
  });
});

function applyLowResMode() {
  const isLowRes = $('lowResToggle').checked;
  const factor = isLowRes ? 0.5 : 1.0;
  captionCanvas.width = state.baseCanvasWidth * factor;
  captionCanvas.height = state.baseCanvasHeight * factor;
  renderCaptions();
}

$('lowResToggle').addEventListener('change', applyLowResMode);

// Initialize low res canvas scaling on boot
applyLowResMode();

// Autosave project state upon layout adjustments
$('heroColorPicker').addEventListener('change', saveProjectState);
$('supportColorPicker').addEventListener('change', saveProjectState);
$('heroSizeSlider').addEventListener('change', saveProjectState);
$('supportSizeSlider').addEventListener('change', saveProjectState);
$('fontSelect').addEventListener('change', saveProjectState);

// â”€â”€â”€ Export: MP4 (Server-side frame-by-frame) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function exportMP4() {
  if (state.exporting) return;
  state.exporting = true;
  state.exportCancelled = false;

  exportModal.classList.remove('hidden');
  exportProgressFill.style.width = '0%';
  exportStatus.textContent = 'Sending to server for HD export...';
  exportPercent.textContent = '0%';

  try {
    // Start a progress poller â€” the server logs progress but we simulate it client-side
    let fakeProgress = 0;
    const progressInterval = setInterval(() => {
      if (state.exportCancelled) {
        clearInterval(progressInterval);
        return;
      }
      // Slowly increment progress to give feedback
      fakeProgress = Math.min(fakeProgress + 0.5, 95);
      exportProgressFill.style.width = fakeProgress + '%';
      exportPercent.textContent = Math.round(fakeProgress) + '%';

      if (fakeProgress < 20) {
        exportStatus.textContent = 'Analyzing video...';
      } else if (fakeProgress < 70) {
        exportStatus.textContent = 'Rendering caption frames...';
      } else {
        exportStatus.textContent = 'Encoding H.264 MP4...';
      }
    }, 500);

    const response = await fetch('/api/export-mp4', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        compositions: state.compositions,
        tokens: state.tokens,
        templateId: state.templateId,
        template: state.template, // Pass custom template overrides!
        animation: state.animation,
        videoUrl: state.videoUrl
      })
    });

    clearInterval(progressInterval);

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || `Export failed (HTTP ${response.status})`);
    }

    // Download the MP4
    exportStatus.textContent = 'Download starting...';
    exportProgressFill.style.width = '100%';
    exportPercent.textContent = '100%';

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const baseName = state.filename.replace(/\.[^/.]+$/, '');
    a.download = `${baseName}-captioned.mp4`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    state.exporting = false;
    exportModal.classList.add('hidden');

  } catch (error) {
    console.error('Export error:', error);
    exportStatus.textContent = 'Export failed: ' + error.message;
    setTimeout(() => {
      exportModal.classList.add('hidden');
      state.exporting = false;
    }, 4000);
  }
}

$('exportBtn').addEventListener('click', exportMP4);
$('exportMainBtn').addEventListener('click', exportMP4);
$('cancelExportBtn').addEventListener('click', () => {
  state.exportCancelled = true;
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

// â”€â”€â”€ Close / Unload Project â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function closeProject() {
  if (state.isPlaying) {
    videoPlayer.pause();
    state.isPlaying = false;
    if (playIcon) playIcon.classList.remove('hidden');
    if (pauseIcon) pauseIcon.classList.add('hidden');
  }

  // Clear video source
  videoPlayer.src = '';
  videoPlayer.load();

  // Reset state
  state.projectId = null;
  state.tokens = [];
  state.compositions = [];
  state.videoUrl = '';
  state.filename = '';
  state.videoDuration = 0;
  state.currentTime = 0;
  state.activeCompositionId = null;

  // Toggle body classes
  document.body.classList.add('project-unloaded');
  document.body.classList.remove('project-loaded');

  // Toggle state panels
  if ($('unloadedLeftState')) $('unloadedLeftState').classList.remove('hidden');
  if ($('loadedLeftState')) $('loadedLeftState').classList.add('hidden');

  if ($('unloadedCenterState')) $('unloadedCenterState').classList.remove('hidden');
  if ($('loadedCenterState')) $('loadedCenterState').classList.add('hidden');

  if ($('unloadedRightState')) $('unloadedRightState').classList.remove('hidden');
  if ($('loadedRightState')) $('loadedRightState').classList.add('hidden');

  if ($('unloadedTimelineState')) $('unloadedTimelineState').classList.remove('hidden');
  if ($('loadedTimelineState')) $('loadedTimelineState').classList.add('hidden');

  // Show upload form, hide processing state
  if ($('uploadForm')) $('uploadForm').classList.remove('hidden');
  if ($('processingState')) $('processingState').classList.add('hidden');
  if ($('uploadSelected')) $('uploadSelected').classList.remove('visible');
  if ($('mediaInput')) $('mediaInput').value = '';

  if (topbarFilename) topbarFilename.textContent = '';

  loadProjectsList();
}

const closeProjectBtn = $('closeProjectBtn');
if (closeProjectBtn) {
  closeProjectBtn.addEventListener('click', closeProject);
}

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

  saveProjectState();
  renderCaptionList();
  renderTimeline();
  renderCaptions();
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

  saveProjectState();
  renderCaptionList();
  renderTimeline();
  renderCaptions();
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
    saveProjectState();
    renderCaptionList();
    renderTimeline();
    renderCaptions();
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
    saveProjectState();
    renderCaptionList();
    renderTimeline();
    renderCaptions();
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
    saveProjectState();
    renderCaptionList();
    renderTimeline();
    renderCaptions();
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
    saveProjectState();
    renderCaptionList();
    renderTimeline();
    renderCaptions();
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
    saveProjectState();
    renderCaptionList();
    renderTimeline();
    renderCaptions();
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

    saveProjectState();
    renderCaptionList();
    renderTimeline();
    renderCaptions();
  });

  // 2. Strip Emphasis
  $('stripEmphasisBtn').addEventListener('click', () => {
    if (!state.compositions.length) return;
    
    state.compositions.forEach(comp => {
      comp.comp_type = 'plain';
    });

    saveProjectState();
    renderCaptionList();
    renderTimeline();
    renderCaptions();
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

    saveProjectState();
    renderCaptionList();
    renderTimeline();
    renderCaptions();
  });
}

// â”€â”€â”€ Initialization on Boot â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

initWordContextMenu();
loadProjectsList();


