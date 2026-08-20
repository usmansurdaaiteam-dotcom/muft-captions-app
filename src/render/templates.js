/**
 * templates.js
 *
 * The caption template catalogue. Every entry is pure data — the renderer has
 * no per-template code — so a new look is a new object here and nothing else.
 *
 * Schema
 * ------
 * id                    stable identifier, used in saved projects
 * name                  label shown in the picker
 * category              grouping for the picker
 * mode                  'karaoke' (whole phrase visible, spoken word styled)
 *                       or 'hero'  (one word large, others stacked around it)
 * font                  { family, weight, size, casing, letterSpacing, lineHeight }
 * layout                { x, y, maxWidthPct, maxLines, align, reveal }
 *                       x/y are fractions of the frame; reveal is 'all' or
 *                       'progressive' (words appear as they are spoken)
 * word                  base style for every word
 * active                style for the spoken word (karaoke) / hero word (hero)
 * pending               optional style for words not yet spoken
 * spoken                optional style for words already spoken
 * lineBackground        optional bar drawn behind each whole line
 *                       { color, opacity, padX, padY, radius }
 * animation             { target: 'word'|'line', type, durationMs, ... }
 * heroSizeScale         hero mode only: hero word size multiplier
 * heroSupportSizeScale  hero mode only: surrounding word size multiplier
 * heroCasing            hero mode only: casing for the hero word alone, so it
 *                       can shout in caps while support text stays as spoken
 * heroSupportAlign      hero mode only: 'left' (both support lines align to the
 *                       hero's left edge), 'edges' (before-text left, after-text
 *                       right, for a diagonal look) or 'center'
 * heroGapEm             hero mode only: gap between hero and support lines, in
 *                       hero-em units
 *
 * Style block fields: fill, stroke, shadow, glow, background, extrude,
 * underline, sizeScale, pop, opacity, blur, offsetY.
 *
 * Sizes are authored against a 1080x1920 design canvas. Authoring generously is
 * safe: the renderer shrinks a phrase that would overflow its line budget, so a
 * large size simply means "as big as this phrase allows".
 */

// ─── Shorthand builders ─────────────────────────────────────────────────────────

const solid = color => ({ type: 'solid', color });
const gradient = (stops, angle = 90) => ({ type: 'gradient', stops, angle });

const stroke = (width, color = '#000000') => ({ width, color });

const shadow = (blur, offsetY = 0, opacity = 0.8, color = '#000000', offsetX = 0) =>
  ({ blur, offsetX, offsetY, opacity, color });

const glow = (color, passes = [{ blur: 28, opacity: 0.55 }, { blur: 12, opacity: 0.8 }]) =>
  ({ color, passes });

const pill = (color, opacity = 1) => ({ type: 'pill', color, padX: 24, padY: 12, opacity });
const box = (color, radius = 6, opacity = 1) => ({ type: 'box', color, padX: 18, padY: 10, radius, opacity });
const marker = (color, opacity = 0.9) => ({ type: 'marker', color, padX: 12, thickness: 1.08, opacity });

/** Transient scale kick on the spoken word. */
const pop = (scale = 1.16, durationMs = 190) => ({ scale, durationMs });

// Reusable layout anchors.
const CENTER = { x: 0.5, y: 0.72, maxWidthPct: 0.88, maxLines: 2, align: 'center', reveal: 'all' };
const LOWER = { ...CENTER, y: 0.82 };
const MIDDLE = { ...CENTER, y: 0.55 };

// Reusable entry animations.
const ENTER_POP = { target: 'word', type: 'pop', durationMs: 240, from: 0.6, staggerMs: 40 };
const ENTER_UP = { target: 'word', type: 'slide_up', durationMs: 260, distance: 34, staggerMs: 50 };
const LINE_FADE = { target: 'line', type: 'fade', durationMs: 220 };
const LINE_POP = { target: 'line', type: 'pop', durationMs: 260, from: 0.78 };

// ─── Catalogue ──────────────────────────────────────────────────────────────────

export const TEMPLATES = [
  // ── Signature ────────────────────────────────────────────────────────────────
  {
    id: 'muft-default',
    name: 'Muft Default',
    category: 'Signature',
    mode: 'karaoke',
    font: { family: 'Inter', weight: 800, size: 88, casing: 'none', lineHeight: 1.18 },
    layout: CENTER,
    word: { fill: solid('#FFFFFF'), stroke: stroke(3), shadow: shadow(14, 4, 0.75) },
    active: { fill: solid('#00FFB2'), pop: pop(1.14), glow: glow('#00FFB2') },
    animation: ENTER_POP
  },
  {
    // Geometry and colour here are measured off the reference style frame by
    // frame rather than guessed: hero cap height is a constant 8.0% of the frame
    // height (so 211px against this 1920-tall design canvas), support text sits
    // at 0.37x the hero, the stack is centred at 45% of the frame height, and
    // the hero green reads #9FD83A across every hero word in the reference.
    id: 'muft-glow-hero',
    name: 'Muft Glow (Hero)',
    category: 'Signature',
    mode: 'hero',
    font: { family: 'Inter', weight: 900, size: 78, casing: 'none' },
    layout: { x: 0.5, y: 0.45, maxWidthPct: 0.92, maxLines: 2, align: 'center', reveal: 'progressive' },
    heroSizeScale: 2.7,
    heroSupportSizeScale: 1,
    heroCasing: 'upper',
    heroSupportAlign: 'left',
    heroGapEm: 0.1,
    word: { fill: solid('#FFFFFF'), shadow: shadow(16, 4, 0.6) },
    active: {
      fill: solid('#9FD83A'),
      glow: glow('#9FD83A', [{ blur: 30, opacity: 0.5 }, { blur: 13, opacity: 0.75 }]),
      shadow: shadow(18, 6, 0.35),
      pop: pop(1.06, 200)
    },
    animation: { target: 'word', type: 'pop', durationMs: 240, from: 0.74, overshoot: 1.6 }
  },
  {
    id: 'muft-hero-impact',
    name: 'Muft Hero Impact',
    category: 'Signature',
    mode: 'hero',
    font: { family: 'Anton', weight: 400, size: 56, casing: 'upper' },
    layout: MIDDLE,
    heroSizeScale: 2.5,
    heroSupportSizeScale: 0.95,
    word: { fill: solid('#FFFFFF'), stroke: stroke(4), shadow: shadow(12, 5, 0.8) },
    active: { fill: solid('#FFE600'), stroke: stroke(8), shadow: shadow(10, 8, 0.9), pop: pop(1.1, 200) },
    animation: { target: 'line', type: 'zoom', durationMs: 240, from: 1.45 }
  },

  // ── High retention ───────────────────────────────────────────────────────────
  {
    id: 'bold-yellow',
    name: 'Bold Yellow',
    category: 'High retention',
    mode: 'karaoke',
    font: { family: 'Anton', weight: 400, size: 104, casing: 'upper', lineHeight: 1.06 },
    layout: CENTER,
    word: { fill: solid('#FFFFFF'), stroke: stroke(9), shadow: shadow(8, 8, 0.9) },
    active: { fill: solid('#FFE600'), stroke: stroke(10), pop: pop(1.18) },
    animation: ENTER_POP
  },
  {
    id: 'bold-green',
    name: 'Bold Green',
    category: 'High retention',
    mode: 'karaoke',
    font: { family: 'Anton', weight: 400, size: 104, casing: 'upper', lineHeight: 1.06 },
    layout: CENTER,
    word: { fill: solid('#FFFFFF'), stroke: stroke(9), shadow: shadow(8, 8, 0.9) },
    active: { fill: solid('#39FF14'), stroke: stroke(10), pop: pop(1.18) },
    animation: ENTER_POP
  },
  {
    id: 'comic-punch',
    name: 'Comic Punch',
    category: 'High retention',
    mode: 'karaoke',
    font: { family: 'Bangers', weight: 400, size: 104, casing: 'upper', letterSpacing: 1, lineHeight: 1.08 },
    layout: CENTER,
    word: { fill: solid('#FFFFFF'), stroke: stroke(10), shadow: shadow(0, 10, 1) },
    active: { fill: solid('#FFFF00'), stroke: stroke(11), pop: pop(1.24, 210) },
    animation: { target: 'word', type: 'pop', durationMs: 260, from: 0.45, overshoot: 3, staggerMs: 40 }
  },
  {
    id: 'comic-alt',
    name: 'Comic Alternate',
    category: 'High retention',
    mode: 'karaoke',
    font: { family: 'Nunito', weight: 900, size: 90, casing: 'upper', lineHeight: 1.12 },
    layout: CENTER,
    word: { fill: solid('#FFE600'), stroke: stroke(8), shadow: shadow(0, 8, 1) },
    active: { fill: solid('#FFFFFF'), stroke: stroke(9), pop: pop(1.2) },
    animation: ENTER_POP
  },
  {
    id: 'orange-box',
    name: 'Orange Box',
    category: 'High retention',
    mode: 'karaoke',
    font: { family: 'Inter', weight: 800, size: 82, casing: 'upper', lineHeight: 1.34 },
    layout: CENTER,
    word: { fill: solid('#FFFFFF'), shadow: shadow(10, 3, 0.7) },
    active: { fill: solid('#FFFFFF'), background: box('#FF6600', 8), pop: pop(1.06, 150) },
    animation: { target: 'word', type: 'scale', durationMs: 150, from: 0.92, staggerMs: 35 }
  },
  {
    id: 'bubble-pill',
    name: 'Bubble Pill',
    category: 'High retention',
    mode: 'karaoke',
    font: { family: 'Nunito', weight: 900, size: 80, casing: 'none', lineHeight: 1.4 },
    layout: CENTER,
    word: { fill: solid('#FFFFFF'), shadow: shadow(12, 4, 0.7) },
    active: { fill: solid('#03202B'), background: pill('#00E5FF'), pop: pop(1.08, 180) },
    animation: { target: 'word', type: 'pop', durationMs: 200, from: 0.8, staggerMs: 40 }
  },
  {
    id: 'marker-highlight',
    name: 'Marker Highlight',
    category: 'High retention',
    mode: 'karaoke',
    font: { family: 'Inter', weight: 700, size: 80, casing: 'none', lineHeight: 1.4 },
    layout: CENTER,
    word: { fill: solid('#FFFFFF'), shadow: shadow(10, 3, 0.7) },
    active: { fill: solid('#111111'), background: marker('#FFE600'), pop: pop(1.05, 160) },
    animation: { target: 'word', type: 'scale', durationMs: 170, from: 0.94, staggerMs: 35 }
  },
  {
    id: 'chaos-pop',
    name: 'Chaos Pop',
    category: 'High retention',
    mode: 'karaoke',
    font: { family: 'Bangers', weight: 400, size: 100, casing: 'upper', lineHeight: 1.08 },
    layout: CENTER,
    word: { fill: solid('#FFFFFF'), stroke: stroke(9), shadow: shadow(0, 9, 1) },
    active: {
      fill: solid('#FF00A8'),
      stroke: stroke(10),
      glow: glow('#FF00A8', [{ blur: 26, opacity: 0.7 }]),
      pop: pop(1.26, 200)
    },
    animation: { target: 'word', type: 'shake', durationMs: 260, amount: 12, staggerMs: 30 }
  },

  // ── Clean & modern ───────────────────────────────────────────────────────────
  {
    id: 'clean-motion',
    name: 'Clean Motion',
    category: 'Clean',
    mode: 'karaoke',
    font: { family: 'Outfit', weight: 600, size: 78, casing: 'none', lineHeight: 1.26 },
    layout: CENTER,
    word: { fill: solid('#FFFFFF'), stroke: stroke(1, 'rgba(0,0,0,0.55)'), shadow: shadow(16, 4, 0.6) },
    active: { fill: solid('#FFFFFF'), pop: pop(1.08, 200) },
    animation: ENTER_UP
  },
  {
    id: 'broadcast-clean',
    name: 'Broadcast Clean',
    category: 'Clean',
    mode: 'karaoke',
    font: { family: 'Inter', weight: 500, size: 66, casing: 'none', lineHeight: 1.32 },
    layout: LOWER,
    word: { fill: solid('#9A9A9A'), shadow: shadow(10, 2, 0.7) },
    active: { fill: solid('#FFFFFF') },
    animation: LINE_FADE
  },
  {
    id: 'seedha-saadha',
    name: 'Seedha Saadha',
    category: 'Clean',
    mode: 'karaoke',
    font: { family: 'Inter', weight: 700, size: 70, casing: 'none', lineHeight: 1.4 },
    layout: LOWER,
    lineBackground: { color: '#000000', opacity: 0.55, padX: 24, padY: 8, radius: 8 },
    word: { fill: solid('#FFFFFF') },
    active: { fill: solid('#00FFB2') },
    animation: LINE_FADE
  },
  {
    id: 'minimal-mono',
    name: 'Minimal Mono',
    category: 'Clean',
    mode: 'karaoke',
    font: { family: 'Space Grotesk', weight: 700, size: 74, casing: 'none', letterSpacing: 1, lineHeight: 1.3 },
    layout: CENTER,
    word: { fill: solid('#E8E8E8'), shadow: shadow(12, 3, 0.6) },
    active: { fill: solid('#FFFFFF'), underline: { width: 5, color: '#00FFB2' }, pop: pop(1.06, 180) },
    animation: ENTER_UP
  },
  {
    id: 'top-third',
    name: 'Top Third',
    category: 'Clean',
    mode: 'karaoke',
    font: { family: 'Inter', weight: 700, size: 76, casing: 'none', lineHeight: 1.26 },
    layout: { ...CENTER, y: 0.2 },
    word: { fill: solid('#FFFFFF'), stroke: stroke(2), shadow: shadow(14, 4, 0.7) },
    active: { fill: solid('#FFE600'), pop: pop(1.1) },
    animation: { target: 'word', type: 'slide_down', durationMs: 240, distance: 30, staggerMs: 45 }
  },
  {
    id: 'typewriter',
    name: 'Typewriter',
    category: 'Clean',
    mode: 'karaoke',
    font: { family: 'Space Grotesk', weight: 700, size: 74, casing: 'none', lineHeight: 1.3 },
    layout: { ...CENTER, reveal: 'progressive', align: 'left' },
    word: { fill: solid('#FFFFFF'), shadow: shadow(12, 3, 0.7) },
    active: { fill: solid('#00FFB2') },
    animation: { target: 'word', type: 'fade', durationMs: 90 }
  },

  // ── Glow & neon ──────────────────────────────────────────────────────────────
  {
    id: 'neon-glow',
    name: 'Neon Glow',
    category: 'Glow',
    mode: 'karaoke',
    font: { family: 'DM Sans', weight: 900, size: 86, casing: 'none', lineHeight: 1.2 },
    layout: CENTER,
    word: { fill: solid('#FFFFFF'), shadow: shadow(18, 4, 0.8) },
    active: {
      fill: solid('#00FFB2'),
      glow: glow('#00FFB2', [{ blur: 42, opacity: 0.5 }, { blur: 18, opacity: 0.85 }]),
      pop: pop(1.14)
    },
    animation: ENTER_POP
  },
  {
    id: 'deep-glow-cyber',
    name: 'Deep Glow Cyber',
    category: 'Glow',
    mode: 'karaoke',
    font: { family: 'Montserrat', weight: 900, size: 82, casing: 'upper', letterSpacing: 1, lineHeight: 1.24 },
    layout: CENTER,
    word: { fill: solid('#E8F9FF'), glow: glow('#00E5FF', [{ blur: 30, opacity: 0.45 }]), shadow: shadow(16, 4, 0.8) },
    active: {
      fill: solid('#FF3DFF'),
      glow: glow('#FF3DFF', [{ blur: 46, opacity: 0.55 }, { blur: 20, opacity: 0.9 }]),
      pop: pop(1.16)
    },
    animation: ENTER_POP
  },
  {
    id: 'clean-glow',
    name: 'Clean Glow',
    category: 'Glow',
    mode: 'karaoke',
    font: { family: 'Outfit', weight: 600, size: 78, casing: 'none', lineHeight: 1.26 },
    layout: CENTER,
    word: { fill: solid('#FFFFFF'), glow: glow('#FFFFFF', [{ blur: 26, opacity: 0.3 }]), shadow: shadow(14, 4, 0.55) },
    active: { fill: solid('#FFFFFF'), glow: glow('#9BF6FF', [{ blur: 36, opacity: 0.65 }]), pop: pop(1.08, 200) },
    animation: ENTER_UP
  },
  {
    id: 'liquid-glass',
    name: 'Liquid Glass',
    category: 'Glow',
    mode: 'karaoke',
    font: { family: 'Outfit', weight: 600, size: 76, casing: 'none', lineHeight: 1.42 },
    layout: CENTER,
    word: { fill: solid('#FFFFFF'), shadow: shadow(18, 5, 0.7) },
    active: {
      fill: solid('#FFFFFF'),
      background: {
        type: 'pill', color: '#FFFFFF', opacity: 0.2, padX: 26, padY: 14,
        borderColor: 'rgba(255,255,255,0.5)', borderWidth: 2
      },
      glow: glow('#FFFFFF', [{ blur: 24, opacity: 0.4 }]),
      pop: pop(1.06, 190)
    },
    animation: { target: 'word', type: 'scale', durationMs: 200, from: 0.9, staggerMs: 40 }
  },

  // ── Gradients ────────────────────────────────────────────────────────────────
  {
    id: 'gradient-sunset',
    name: 'Gradient Sunset',
    category: 'Gradient',
    mode: 'karaoke',
    font: { family: 'Poppins', weight: 900, size: 86, casing: 'upper', lineHeight: 1.18 },
    layout: CENTER,
    word: { fill: solid('#FFFFFF'), stroke: stroke(5), shadow: shadow(10, 6, 0.85) },
    active: {
      fill: gradient([{ offset: 0, color: '#FF9900' }, { offset: 1, color: '#FFCC00' }], 90),
      stroke: stroke(6),
      pop: pop(1.16)
    },
    animation: ENTER_POP
  },
  {
    id: 'gradient-fire',
    name: 'Gradient Fire',
    category: 'Gradient',
    mode: 'karaoke',
    font: { family: 'Archivo Black', weight: 400, size: 84, casing: 'upper', lineHeight: 1.18 },
    layout: CENTER,
    word: { fill: solid('#FFFFFF'), stroke: stroke(6), shadow: shadow(0, 8, 1) },
    active: {
      fill: gradient([{ offset: 0, color: '#FFE259' }, { offset: 1, color: '#FF512F' }], 90),
      stroke: stroke(7),
      pop: pop(1.18)
    },
    animation: ENTER_POP
  },
  {
    id: 'urban-gradient',
    name: 'Urban Gradient',
    category: 'Gradient',
    mode: 'karaoke',
    font: { family: 'Archivo Black', weight: 400, size: 82, casing: 'upper', letterSpacing: 1, lineHeight: 1.2 },
    layout: CENTER,
    word: { fill: solid('#FFFFFF'), stroke: stroke(3, '#00E5FF'), shadow: shadow(12, 5, 0.85) },
    active: {
      fill: gradient([{ offset: 0, color: '#00E5FF' }, { offset: 0.5, color: '#B14EFF' }, { offset: 1, color: '#FF3DFF' }], 90),
      stroke: stroke(4),
      pop: pop(1.16)
    },
    animation: { target: 'word', type: 'zoom', durationMs: 220, from: 1.4, staggerMs: 40 }
  },

  // ── Editorial ────────────────────────────────────────────────────────────────
  {
    id: 'soft-study',
    name: 'Soft Study',
    category: 'Editorial',
    mode: 'karaoke',
    font: { family: 'Source Serif 4', weight: 700, size: 70, casing: 'none', lineHeight: 1.4 },
    layout: LOWER,
    word: { fill: solid('#FFFFFF'), shadow: shadow(14, 3, 0.7) },
    active: { fill: solid('#111111'), background: marker('#FFE600', 0.95) },
    animation: LINE_FADE
  },
  {
    id: 'editorial-gold',
    name: 'Editorial Gold',
    category: 'Editorial',
    mode: 'karaoke',
    font: { family: 'Source Serif 4', weight: 700, size: 70, casing: 'none', letterSpacing: 2, lineHeight: 1.38 },
    layout: MIDDLE,
    word: { fill: solid('#F4F2F0'), shadow: shadow(16, 3, 0.6) },
    active: { fill: solid('#E8C87A'), pop: pop(1.05, 220) },
    animation: LINE_FADE
  },
  {
    id: 'cinematic-wide',
    name: 'Cinematic Wide',
    category: 'Editorial',
    mode: 'karaoke',
    font: { family: 'Source Serif 4', weight: 700, size: 58, casing: 'upper', letterSpacing: 5, lineHeight: 1.5 },
    layout: { ...CENTER, y: 0.85, maxLines: 2, maxWidthPct: 0.84 },
    word: { fill: solid('#F4F2F0'), shadow: shadow(18, 3, 0.7) },
    active: { fill: solid('#FFFFFF') },
    animation: LINE_FADE
  },
  {
    id: 'podcast-yellow',
    name: 'Podcast Yellow',
    category: 'Editorial',
    mode: 'karaoke',
    font: { family: 'Oswald', weight: 700, size: 92, casing: 'upper', lineHeight: 1.16 },
    layout: CENTER,
    word: { fill: solid('#FFFFFF'), shadow: shadow(6, 6, 0.95) },
    active: { fill: solid('#FFE600'), pop: pop(1.14) },
    animation: ENTER_POP
  },

  // ── Heavy display ────────────────────────────────────────────────────────────
  {
    id: 'black-punch',
    name: 'Black Punch 3D',
    category: 'Heavy',
    mode: 'karaoke',
    font: { family: 'Archivo Black', weight: 400, size: 86, casing: 'upper', lineHeight: 1.2 },
    layout: CENTER,
    word: { fill: solid('#FFFFFF'), extrude: { depth: 7, angle: 45, color: '#000000' } },
    active: { fill: solid('#FFFFFF'), extrude: { depth: 12, angle: 45, color: '#000000' }, pop: pop(1.16) },
    animation: ENTER_POP
  },
  {
    id: 'mega-wide',
    name: 'Mega Wide',
    category: 'Heavy',
    mode: 'karaoke',
    font: { family: 'Montserrat', weight: 900, size: 78, casing: 'upper', letterSpacing: 2, lineHeight: 1.44 },
    layout: { ...CENTER, maxWidthPct: 0.94 },
    lineBackground: { color: '#000000', opacity: 0.92, padX: 22, padY: 6 },
    word: { fill: solid('#FFFFFF') },
    active: { fill: solid('#FFE600'), pop: pop(1.08, 170) },
    animation: LINE_POP
  },
  {
    id: 'center-strong',
    name: 'Center Strong',
    category: 'Heavy',
    mode: 'karaoke',
    font: { family: 'Poppins', weight: 900, size: 84, casing: 'upper', lineHeight: 1.2 },
    layout: MIDDLE,
    word: { fill: solid('#FFFFFF'), stroke: stroke(7), shadow: shadow(10, 5, 0.85) },
    active: { fill: solid('#00FFB2'), stroke: stroke(8), pop: pop(1.16) },
    animation: ENTER_POP
  },
  {
    id: 'depth-blur',
    name: 'Depth Blur',
    category: 'Heavy',
    mode: 'karaoke',
    font: { family: 'DM Sans', weight: 700, size: 84, casing: 'none', lineHeight: 1.24 },
    layout: CENTER,
    word: { fill: solid('#FFFFFF'), shadow: shadow(14, 4, 0.75) },
    pending: { fill: solid('#FFFFFF'), blur: 6, opacity: 0.6 },
    active: { fill: solid('#FFFFFF'), glow: glow('#FFFFFF', [{ blur: 22, opacity: 0.4 }]), pop: pop(1.12) },
    animation: LINE_FADE
  },

  // ── Retro ────────────────────────────────────────────────────────────────────
  {
    id: 'retro-arcade',
    name: 'Retro Arcade',
    category: 'Retro',
    mode: 'karaoke',
    font: { family: 'Press Start 2P', weight: 400, size: 48, casing: 'upper', lineHeight: 1.7 },
    layout: { ...CENTER, maxWidthPct: 0.92 },
    word: { fill: solid('#FFFFFF'), shadow: shadow(0, 6, 1, '#1A1A1A', 6) },
    active: { fill: solid('#39FF14'), shadow: shadow(0, 6, 1, '#0A3D00', 6), pop: pop(1.1, 150) },
    animation: { target: 'word', type: 'slide_up', durationMs: 120, distance: 16, staggerMs: 30 }
  },
  {
    id: 'crt-terminal',
    name: 'CRT Terminal',
    category: 'Retro',
    mode: 'karaoke',
    font: { family: 'VT323', weight: 400, size: 104, casing: 'none', lineHeight: 1.16 },
    layout: CENTER,
    word: { fill: solid('#8CFF8C'), glow: glow('#39FF14', [{ blur: 22, opacity: 0.5 }]) },
    active: { fill: solid('#FFFFFF'), glow: glow('#39FF14', [{ blur: 32, opacity: 0.8 }]) },
    animation: { target: 'word', type: 'flicker', durationMs: 200, flickers: 3, staggerMs: 40 }
  },
  {
    id: 'zero-gravity',
    name: 'Zero Gravity',
    category: 'Retro',
    mode: 'karaoke',
    font: { family: 'Outfit', weight: 600, size: 78, casing: 'none', lineHeight: 1.32 },
    layout: MIDDLE,
    word: { fill: solid('#FFFFFF'), shadow: shadow(24, 8, 0.5) },
    active: { fill: solid('#CFFFF3'), glow: glow('#00FFB2', [{ blur: 32, opacity: 0.45 }]), pop: pop(1.07, 260) },
    animation: { target: 'word', type: 'float', durationMs: 520, distance: 44, staggerMs: 70 }
  }
];

// ─── Normalisation ──────────────────────────────────────────────────────────────

const DEFAULT_TEMPLATE_ID = 'muft-default';

/**
 * Fill in every optional field so the renderer never has to guess and so the
 * style panel always has concrete values to bind to.
 */
export function normalizeTemplate(template) {
  const font = template.font || {};
  const layout = template.layout || {};
  return {
    id: template.id,
    name: template.name || template.id,
    category: template.category || 'Other',
    mode: template.mode === 'hero' ? 'hero' : 'karaoke',
    font: {
      family: font.family || 'Inter',
      weight: font.weight || 800,
      size: font.size || 80,
      casing: font.casing || 'none',
      letterSpacing: font.letterSpacing || 0,
      lineHeight: font.lineHeight || 1.2
    },
    layout: {
      x: layout.x === undefined ? 0.5 : layout.x,
      y: layout.y === undefined ? 0.72 : layout.y,
      maxWidthPct: layout.maxWidthPct === undefined ? 0.88 : layout.maxWidthPct,
      maxLines: layout.maxLines === undefined ? 2 : layout.maxLines,
      align: layout.align || 'center',
      reveal: layout.reveal || 'all'
    },
    word: template.word || { fill: { type: 'solid', color: '#FFFFFF' } },
    active: template.active || { fill: { type: 'solid', color: '#00FFB2' } },
    pending: template.pending || null,
    spoken: template.spoken || null,
    lineBackground: template.lineBackground || null,
    animation: template.animation || { target: 'word', type: 'pop', durationMs: 240 },
    activeTransitionMs: template.activeTransitionMs === undefined ? 90 : template.activeTransitionMs,
    heroSizeScale: template.heroSizeScale === undefined ? 1.8 : template.heroSizeScale,
    heroSupportSizeScale: template.heroSupportSizeScale === undefined ? 1 : template.heroSupportSizeScale,
    heroCasing: template.heroCasing || font.casing || 'none',
    heroSupportAlign: template.heroSupportAlign || 'left',
    heroGapEm: template.heroGapEm === undefined ? 0.16 : template.heroGapEm
  };
}

export const TEMPLATE_IDS = TEMPLATES.map(t => t.id);

export function getTemplate(id) {
  const found = TEMPLATES.find(t => t.id === id)
    || TEMPLATES.find(t => t.id === DEFAULT_TEMPLATE_ID);
  return normalizeTemplate(found);
}

/** First colour of a fill, whether it is solid or a gradient. */
function fillColor(style, fallback) {
  const fill = style && style.fill;
  if (!fill) return fallback;
  if (fill.color) return fill.color;
  if (Array.isArray(fill.stops) && fill.stops.length) return fill.stops[0].color;
  return fallback;
}

/** Lightweight list for the picker UI (no style payload). */
export function listTemplates() {
  return TEMPLATES.map(t => ({
    id: t.id,
    name: t.name,
    category: t.category,
    mode: t.mode,
    previewFontFamily: (t.font && t.font.family) || 'Inter',
    previewFontWeight: (t.font && t.font.weight) || 800,
    previewCasing: (t.font && t.font.casing) || 'none',
    previewBaseColor: fillColor(t.word, '#FFFFFF'),
    previewActiveColor: fillColor(t.active, '#00FFB2')
  }));
}

export { DEFAULT_TEMPLATE_ID };
