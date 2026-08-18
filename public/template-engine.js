/**
 * template-engine.js
 * 
 * Shared layout, styling, and text rendering engine.
 * Single source of truth for both browser canvas and server export.
 */

const CANVAS_W = 1080;
const CANVAS_H = 1920;

function hexToRgba(hex, opacity = 1) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

function getFontFamilyString(family, defaultSuffix = '') {
  if (family.toLowerCase().includes('inter')) {
    return 'Inter';
  }
  if (family.toLowerCase().includes('roboto')) {
    return 'Roboto';
  }
  return family;
}

function getEffectiveTemplate(template, comp) {
  if (!comp || !template) return template;
  
  const t = {
    ...template,
    hero: { ...template.hero },
    support: { ...template.support },
    layout: { ...template.layout }
  };
  
  if (comp.override_hero_size !== undefined) t.hero.fontSize = comp.override_hero_size;
  if (comp.override_support_size !== undefined) t.support.fontSize = comp.override_support_size;
  if (comp.override_hero_color !== undefined) t.hero.color = comp.override_hero_color;
  if (comp.override_support_color !== undefined) t.support.color = comp.override_support_color;
  if (comp.override_font_family !== undefined) {
    t.hero.fontFamily = comp.override_font_family;
    t.support.fontFamily = comp.override_font_family;
  }
  if (comp.override_center_x !== undefined) t.layout.captionCenterX = comp.override_center_x;
  if (comp.override_center_y !== undefined) t.layout.captionCenterY = comp.override_center_y;
  
  return t;
}

function resolvePositions(template, comp, scaleX = 1, scaleY = 1) {
  const layout = template.layout;
  const canvasW = template.canvasWidth || 1080;
  const canvasH = template.canvasHeight || 1920;
  const captionX = Math.round(canvasW * (layout.captionCenterX || 0.5));
  const captionY = Math.round(canvasH * (layout.captionCenterY || 0.52));
  const compType = comp.comp_type || 'emphasis';

  if (compType === 'plain') {
    return {
      before: null,
      hero: null,
      text: {
        x: captionX * scaleX,
        y: captionY * scaleY,
        textAlign: 'center'
      }
    };
  }

  if (compType === 'spotlight') {
    return {
      before: null,
      hero: {
        x: captionX * scaleX,
        y: captionY * scaleY,
        textAlign: 'center'
      },
      after: null
    };
  }

  // -- Emphasis: Kalakar staggered layout --
  const heroFontSize = template.hero.fontSize;
  const supportFontSize = template.support.fontSize;
  
  const lineGap = Math.round(supportFontSize * 0.15);
  const heroY = captionY;
  const beforeY = heroY - Math.round(heroFontSize * 0.5) - Math.round(supportFontSize * 0.5) - lineGap;
  const afterY = heroY + Math.round(heroFontSize * 0.5) + Math.round(supportFontSize * 0.5) + lineGap;

  return {
    before: comp.before_text ? {
      x: captionX * scaleX,
      y: beforeY * scaleY,
      textAlign: 'left'
    } : null,
    hero: {
      x: captionX * scaleX,
      y: heroY * scaleY,
      textAlign: 'center'
    },
    after: comp.after_text ? {
      x: captionX * scaleX,
      y: afterY * scaleY,
      textAlign: 'right'
    } : null
  };
}

function drawSupportText(ctx, text, x, y, textAlign, template, scale = 1) {
  const s = template.support;
  const fontSize = Math.round(s.fontSize * scale);
  const fontFamily = getFontFamilyString(s.fontFamily, '-ExtraBold');
  
  ctx.font = `${s.fontWeight} ${fontSize}px ${fontFamily}`;
  ctx.textAlign = textAlign;
  ctx.textBaseline = 'middle';

  const supportWidth = ctx.measureText(text).width;
  const supportColor = s.color || '#ffffff';
  let r = 255, g = 255, b = 255;
  if (supportColor.startsWith('#') && supportColor.length === 7) {
    r = parseInt(supportColor.slice(1, 3), 16);
    g = parseInt(supportColor.slice(3, 5), 16);
    b = parseInt(supportColor.slice(5, 7), 16);
  }

  // 1. Soft Backdrop Blur (wide soft shadow) using solid black fill
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.75)';
  ctx.shadowBlur = 24 * scale;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
  ctx.fillStyle = '#000000';
  ctx.fillText(text, x, y);
  ctx.restore();

  // 1.2. Ambient Radial Glow (spreading light) - OPTIMIZED
  ctx.save();
  let glowCenterX = x;
  if (textAlign === 'left') glowCenterX = x + supportWidth / 2;
  else if (textAlign === 'right') glowCenterX = x - supportWidth / 2;

  const maxRadius = Math.min(220 * scale, Math.max(supportWidth * 0.75, fontSize * 1.5));
  const gradient = ctx.createRadialGradient(
    glowCenterX, y, 0,
    glowCenterX, y, maxRadius
  );
  gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.35)`);  // ambient center
  gradient.addColorStop(0.4, `rgba(${r}, ${g}, ${b}, 0.12)`); // fading
  gradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);       // transparent

  ctx.fillStyle = gradient;
  ctx.fillRect(
    glowCenterX - maxRadius,
    y - maxRadius,
    maxRadius * 2,
    maxRadius * 2
  );
  ctx.restore();

  // 1.5. Dynamic Neon/Soft Glow matching support color with a black backing core (makes it pop!)
  ctx.save();
  ctx.shadowColor = `rgba(${r}, ${g}, ${b}, 0.85)`;
  ctx.shadowBlur = 20 * scale;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
  ctx.fillStyle = '#000000'; // black core backing
  ctx.fillText(text, x, y);
  ctx.restore();

  // 2. Crisp Drop Shadow using solid black fill
  if (s.dropShadow.enabled) {
    const ds = s.dropShadow;
    ctx.save();
    ctx.shadowColor = hexToRgba(ds.color, ds.opacity);
    ctx.shadowBlur = ds.blur * scale;
    ctx.shadowOffsetX = ds.offset[0] * scale;
    ctx.shadowOffsetY = ds.offset[1] * scale;
    ctx.fillStyle = '#000000';
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  if (s.letterSpacing !== undefined) {
    ctx.letterSpacing = `${s.letterSpacing * scale}px`;
  }

  // 3. Final text color fill
  ctx.fillStyle = s.color;
  ctx.fillText(text, x, y);

  // Stroke outline if enabled
  if (s.stroke && s.stroke.enabled && s.stroke.width > 0) {
    ctx.strokeStyle = s.stroke.color;
    ctx.lineWidth = s.stroke.width * scale;
    ctx.lineJoin = 'round';
    ctx.strokeText(text, x, y);
  }

  // Reset properties
  ctx.shadowBlur = 0;
  ctx.shadowColor = 'transparent';
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
  ctx.letterSpacing = '0px';
}

function drawHeroText(ctx, text, x, y, template, scale = 1, textAlign = 'left') {
  const h = template.hero;
  const fontSize = Math.round(h.fontSize * scale);
  const fontFamily = getFontFamilyString(h.fontFamily, '-Black');
  
  ctx.font = `${h.fontWeight} ${fontSize}px ${fontFamily}`;
  ctx.textAlign = textAlign;
  ctx.textBaseline = 'middle';

  const heroWidth = ctx.measureText(text).width;
  const heroColor = h.color;

  const r = parseInt(heroColor.slice(1, 3), 16);
  const g = parseInt(heroColor.slice(3, 5), 16);
  const b = parseInt(heroColor.slice(5, 7), 16);

  // -- RADIAL GRADIENT GLOW (Kalakar light spread) - OPTIMIZED --
  ctx.save();
  let glowCenterX = x;
  if (textAlign === 'left') glowCenterX = x + heroWidth / 2;
  else if (textAlign === 'right') glowCenterX = x - heroWidth / 2;

  const maxRadius = Math.min(280 * scale, Math.max(heroWidth * 0.75, fontSize * 1.5));
  const gradient = ctx.createRadialGradient(
    glowCenterX, y, 0,
    glowCenterX, y, maxRadius
  );
  gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.55)`);  // ambient center
  gradient.addColorStop(0.35, `rgba(${r}, ${g}, ${b}, 0.22)`); // fading
  gradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);       // transparent

  ctx.fillStyle = gradient;
  ctx.fillRect(
    glowCenterX - maxRadius,
    y - maxRadius,
    maxRadius * 2,
    maxRadius * 2
  );
  ctx.restore();

  // -- Combined tight inner glow and drop shadow pass --
  ctx.save();
  ctx.shadowColor = `rgba(${r}, ${g}, ${b}, 0.85)`;
  ctx.shadowBlur = 25 * scale;
  ctx.shadowOffsetX = 2 * scale;
  ctx.shadowOffsetY = 2 * scale;
  ctx.fillStyle = '#000000';
  ctx.fillText(text, x, y);
  ctx.restore();

  // -- Drop shadow --
  if (h.dropShadow.enabled) {
    const ds = h.dropShadow;
    ctx.save();
    ctx.shadowColor = hexToRgba(ds.color, ds.opacity);
    ctx.shadowBlur = ds.blur * scale;
    ctx.shadowOffsetX = ds.offset[0] * scale;
    ctx.shadowOffsetY = ds.offset[1] * scale;
    ctx.fillStyle = '#000000';
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  // -- Final fill with RADIAL GRADIENT � the Kalakar premium depth --
  ctx.save();

  let textCenterX = x;
  if (textAlign === 'left') textCenterX = x + heroWidth / 2;
  else if (textAlign === 'right') textCenterX = x - heroWidth / 2;

  if (h.letterSpacing !== undefined) {
    ctx.letterSpacing = `${h.letterSpacing * scale}px`;
  }

  const textGradient = ctx.createRadialGradient(
    textCenterX, y, 0,
    textCenterX, y, heroWidth * 0.65
  );

  const lighterR = Math.min(255, r + 70);
  const lighterG = Math.min(255, g + 50);
  const lighterB = Math.min(255, b + 40);
  const darkerR = Math.max(0, r - 35);
  const darkerG = Math.max(0, g - 25);
  const darkerB = Math.max(0, b - 20);

  textGradient.addColorStop(0, '#FFFFFF');
  textGradient.addColorStop(0.2, `rgb(${lighterR}, ${lighterG}, ${lighterB})`);
  textGradient.addColorStop(0.65, heroColor);
  textGradient.addColorStop(1, `rgb(${darkerR}, ${darkerG}, ${darkerB})`);

  ctx.fillStyle = textGradient;
  ctx.fillText(text, x, y);

  if (h.stroke && h.stroke.enabled && h.stroke.width > 0) {
    ctx.strokeStyle = h.stroke.color;
    ctx.lineWidth = h.stroke.width * scale;
    ctx.lineJoin = 'round';
    ctx.strokeText(text, x, y);
  }

  ctx.restore();
  ctx.letterSpacing = '0px';

  return heroWidth;
}

function drawPlainText(ctx, text, x, y, template, scale = 1) {
  const s = template.support;
  const fontSize = Math.round(s.fontSize * scale);
  const fontFamily = getFontFamilyString(s.fontFamily);
  
  ctx.font = `${s.fontWeight} ${fontSize}px ${fontFamily}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  if (s.dropShadow && s.dropShadow.enabled) {
    const ds = s.dropShadow;
    ctx.save();
    ctx.shadowColor = hexToRgba(ds.color, ds.opacity);
    ctx.shadowBlur = ds.blur * scale;
    ctx.shadowOffsetX = ds.offset[0] * scale;
    ctx.shadowOffsetY = ds.offset[1] * scale;
    ctx.fillStyle = s.color;
    ctx.fillText(text, x, y);
    ctx.restore();
  } else {
    ctx.fillStyle = s.color;
    ctx.fillText(text, x, y);
  }

  if (s.stroke && s.stroke.enabled && s.stroke.width > 0) {
    ctx.strokeStyle = s.stroke.color;
    ctx.lineWidth = s.stroke.width * scale;
    ctx.lineJoin = 'round';
    ctx.strokeText(text, x, y);
  }
}

function renderComposition(ctx, timestampMs, compositions, tokenMap, template, width, height, animationConfig) {
  const canvasW = template.canvasWidth || 1080;
  const canvasH = template.canvasHeight || 1920;
  const scaleX = width / canvasW;
  const scaleY = height / canvasH;
  const scale = scaleX;

  const comp = compositions.find(c => timestampMs >= c.start_ms && timestampMs <= c.end_ms);
  if (!comp) return;

  const effectiveTemplate = getEffectiveTemplate(template, comp);
  const compType = comp.comp_type || 'emphasis';
  const positions = resolvePositions(effectiveTemplate, comp, scaleX, scaleY);

  const s = effectiveTemplate.support;
  const supportFontSize = Math.round(s.fontSize * scale);
  const supportFontFamily = getFontFamilyString(s.fontFamily, '-ExtraBold');
  const spaceChar = ' ';

  // -- Plain text (no emphasis) --
  if (compType === 'plain') {
    const plainTokens = comp.token_ids.map(id => tokenMap.get(id)).filter(Boolean);
    if (!plainTokens.length) return;

    ctx.save();
    ctx.font = `${s.fontWeight} ${supportFontSize}px ${supportFontFamily}`;
    if (s.letterSpacing !== undefined) {
      ctx.letterSpacing = `${s.letterSpacing * scale}px`;
    }
    const spaceWidth = ctx.measureText(spaceChar).width;
    const plainWidths = plainTokens.map(t => ctx.measureText(t.text.trim()).width);
    
    let totalWidth = 0;
    if (plainWidths.length > 0) {
      totalWidth = plainWidths.reduce((sum, w) => sum + w, 0) + (plainWidths.length - 1) * spaceWidth;
    }
    
    const startX = positions.text.x - (totalWidth / 2);
    let currentX = startX;
    ctx.restore();

    for (let i = 0; i < plainTokens.length; i++) {
      const t = plainTokens[i];
      if (t.start_ms <= timestampMs) {
        drawSupportText(ctx, t.text.trim(), currentX, positions.text.y, 'left', effectiveTemplate, scale);
      }
      currentX += plainWidths[i] + spaceWidth;
    }
    return;
  }

  // -- Emphasis or Spotlight --

  // Measure hero text width beforehand so we can align support text to its edges
  let heroWidth = 0;
  const heroToken = tokenMap.get(comp.hero_token_id);
  if (heroToken && positions.hero) {
    const heroText = effectiveTemplate.hero.uppercase
      ? heroToken.text.trim().toUpperCase()
      : heroToken.text.trim();
    ctx.save();
    const h = effectiveTemplate.hero;
    const fontSize = Math.round(h.fontSize * scale);
    const fontFamily = getFontFamilyString(h.fontFamily, '-Black');
    ctx.font = `${h.fontWeight} ${fontSize}px ${fontFamily}`;
    heroWidth = ctx.measureText(heroText).width;
    ctx.restore();
  }

  // Draw before words (pre-positioned, stationary)
  if (positions.before && comp.before_token_ids?.length) {
    const beforeTokens = comp.before_token_ids.map(id => tokenMap.get(id)).filter(Boolean);
    
    ctx.save();
    ctx.font = `${s.fontWeight} ${supportFontSize}px ${supportFontFamily}`;
    if (s.letterSpacing !== undefined) {
      ctx.letterSpacing = `${s.letterSpacing * scale}px`;
    }
    const spaceWidth = ctx.measureText(spaceChar).width;
    const beforeWidths = beforeTokens.map(t => ctx.measureText(t.text.trim()).width);
    
    let totalBeforeWidth = 0;
    if (beforeWidths.length > 0) {
      totalBeforeWidth = beforeWidths.reduce((sum, w) => sum + w, 0) + (beforeWidths.length - 1) * spaceWidth;
    }
    
    const targetStartX = positions.hero ? positions.hero.x - (heroWidth / 2) : positions.before.x;
    let currentX = targetStartX;
    ctx.restore();

    for (let i = 0; i < beforeTokens.length; i++) {
      const t = beforeTokens[i];
      if (t.start_ms <= timestampMs) {
        drawSupportText(ctx, t.text.trim(), currentX, positions.before.y, 'left', effectiveTemplate, scale);
      }
      currentX += beforeWidths[i] + spaceWidth;
    }
  }

  // Draw hero word
  let heroDrawnWidth = 0;
  if (heroToken && heroToken.start_ms <= timestampMs && positions.hero) {
    // Animation disabled as per user request (static entry)
    let animScale = 1;

    const heroText = effectiveTemplate.hero.uppercase
      ? heroToken.text.trim().toUpperCase()
      : heroToken.text.trim();

    ctx.save();
    ctx.translate(positions.hero.x, positions.hero.y);
    ctx.scale(animScale, animScale);
    heroDrawnWidth = drawHeroText(ctx, heroText, 0, 0, effectiveTemplate, scale, positions.hero.textAlign);
    ctx.restore();
  }

  // Draw after words (pre-positioned, stationary)
  if (positions.after && comp.after_token_ids?.length) {
    const afterTokens = comp.after_token_ids.map(id => tokenMap.get(id)).filter(Boolean);
    
    ctx.save();
    ctx.font = `${s.fontWeight} ${supportFontSize}px ${supportFontFamily}`;
    if (s.letterSpacing !== undefined) {
      ctx.letterSpacing = `${s.letterSpacing * scale}px`;
    }
    const spaceWidth = ctx.measureText(spaceChar).width;
    const afterWidths = afterTokens.map(t => ctx.measureText(t.text.trim()).width);
    
    let totalAfterWidth = 0;
    if (afterWidths.length > 0) {
      totalAfterWidth = afterWidths.reduce((sum, w) => sum + w, 0) + (afterWidths.length - 1) * spaceWidth;
    }
    
    const targetEndX = positions.hero ? positions.hero.x + (heroWidth / 2) : positions.after.x;
    let currentX = targetEndX - totalAfterWidth;
    ctx.restore();

    for (let i = 0; i < afterTokens.length; i++) {
      const t = afterTokens[i];
      if (t.start_ms <= timestampMs) {
        drawSupportText(ctx, t.text.trim(), currentX, positions.after.y, 'left', effectiveTemplate, scale);
      }
      currentX += afterWidths[i] + spaceWidth;
    }
  }
}

// --- Exports --------------------------------------------------------------------

// For browser (loaded as regular script)
if (typeof window !== 'undefined') {
  window.TemplateEngine = {
    renderComposition,
    resolvePositions,
    getEffectiveTemplate,
    drawHeroText,
    drawSupportText,
    drawPlainText,
    hexToRgba,
    CANVAS_W,
    CANVAS_H
  };
}
