'use strict';

const fs = require('fs');
const path = require('path');
const { safeUrl } = require('./remote-provider-manager');
const VocalGuard = require('../js/vocal-guard.js');

const SMART_ENGINES = [
  { id: 'openai', label: 'OpenAI-compatible API', description: '连接支持 Chat Completions 的模型 API；服务地址、模型名和可选 Key 均由你配置。' },
  { id: 'ollama', label: 'Ollama 本地 API', description: '通过本机 Ollama API 调用你已安装的大语言模型，创作内容不离开设备。' },
];

const DEFAULT_SETTINGS = {
  engine: 'openai',
  ollama: { baseUrl: 'http://127.0.0.1:11434', model: '' },
  openai: { baseUrl: 'https://api.openai.com/v1', model: '' },
};

function cloneDefaults() {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
}

async function fetchTimeout(url, options = {}, timeoutMs = 120000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  catch (error) {
    if (error.name === 'AbortError') throw new Error('智能创作服务响应超时');
    throw error;
  } finally { clearTimeout(timer); }
}

async function responseError(response) {
  try {
    const data = await response.clone().json();
    return data?.error?.message || data?.error || data?.message || `HTTP ${response.status}`;
  } catch (_) { return `HTTP ${response.status}`; }
}

function stripIdea(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
}

function numeric(value, fallback, range) {
  const number = Number(value);
  const min = Number(range?.[0]);
  const max = Number(range?.[1]);
  const lower = Number.isFinite(min) ? min : -Infinity;
  const upper = Number.isFinite(max) ? max : Infinity;
  return Math.max(lower, Math.min(upper, Number.isFinite(number) ? number : fallback));
}

function normalizeContext(value = {}) {
  const existing = value.existing && typeof value.existing === 'object' ? value.existing : {};
  const ranges = value.ranges && typeof value.ranges === 'object' ? value.ranges : {};
  const declaredFields = Array.isArray(value.model?.fields) ? value.model.fields.map(String).slice(0, 20) : [];
  const modelFields = declaredFields.length
    ? declaredFields
    : ['prompt', 'negativePrompt', 'tags', 'lyrics', 'duration', 'steps', 'cfg'];
  const lockable = new Set(['title', 'description', 'negativePrompt', 'tags', 'lyrics', 'duration', 'steps', 'cfg', 'bpm', 'keyscale', 'timesignature', 'language']);
  const lockedFields = Array.isArray(value.lockedFields)
    ? [...new Set(value.lockedFields.map(String).filter((field) => lockable.has(field)))]
    : [];
  const avoidDrafts = Array.isArray(value.avoidDrafts)
    ? value.avoidDrafts.map((item) => String(item || '').trim().slice(0, 2400)).filter(Boolean).slice(-10)
    : [];
  return {
    model: {
      id: String(value.model?.id || '').slice(0, 100),
      label: String(value.model?.label || '').slice(0, 160),
      fields: modelFields,
      playbook: String(value.model?.playbook || '').slice(0, 40),
    },
    existing: {
      title: String(existing.title || '').replace(/\s+/g, ' ').trim().slice(0, 40),
      description: String(existing.description || '').trim().slice(0, 4000),
      negativePrompt: String(existing.negativePrompt || '').trim().slice(0, 2000),
      tags: Array.isArray(existing.tags) ? existing.tags.map(String).join(', ') : String(existing.tags || '').trim().slice(0, 1000),
      lyrics: String(existing.lyrics || '').trim().slice(0, 12000),
      duration: numeric(existing.duration ?? value.duration, 60, ranges.duration || [1, 360]),
      steps: Math.round(numeric(existing.steps, 30, ranges.steps || [1, 100])),
      cfg: numeric(existing.cfg, 1.7, ranges.cfg || [0, 20]),
      bpm: Math.round(numeric(existing.bpm, 96, ranges.bpm || [30, 300])),
      keyscale: String(existing.keyscale || 'C major').trim().slice(0, 32),
      timesignature: String(existing.timesignature || '4').trim().slice(0, 8),
      language: String(existing.language || 'auto').trim().toLowerCase().slice(0, 16),
    },
    ranges: {
      duration: ranges.duration || [1, 360],
      steps: ranges.steps || [1, 100],
      cfg: ranges.cfg || [0, 20],
      bpm: ranges.bpm || [30, 300],
    },
    lockedFields,
    avoidDrafts,
    requireUnique: Boolean(value.requireUnique),
    iteration: Math.max(0, Math.round(Number(value.iteration) || 0)),
  };
}

function activeDraftFields(context) {
  const fields = new Set(context?.model?.fields || []);
  return [
    'title',
    ...(fields.has('prompt') ? ['description'] : []),
    ...(fields.has('negativePrompt') ? ['negativePrompt'] : []),
    ...(fields.has('tags') ? ['tags'] : []),
    ...(fields.has('lyrics') ? ['lyrics'] : []),
    ...(fields.has('duration') ? ['duration'] : []),
    ...(fields.has('steps') ? ['steps'] : []),
    ...(fields.has('cfg') ? ['cfg'] : []),
    ...(fields.has('bpm') ? ['bpm'] : []),
    ...(fields.has('keyscale') ? ['keyscale'] : []),
    ...(fields.has('timesignature') ? ['timesignature'] : []),
    ...(fields.has('language') ? ['language'] : []),
  ];
}

function isAceStepModel(model = {}) {
  return /ace-step/i.test(String(model.id || '')) || /ace[- ]?step/i.test(String(model.label || ''));
}

function aceSectionSequence(segmentCount) {
  const count = Math.max(1, Math.round(Number(segmentCount) || 1));
  const presets = {
    1: ['Verse', 'Chorus'],
    2: ['Verse', 'Pre-Chorus', 'Chorus', 'Outro'],
    3: ['Intro', 'Verse', 'Pre-Chorus', 'Chorus', 'Bridge', 'Outro'],
    4: ['Intro', 'Verse 1', 'Pre-Chorus', 'Chorus 1', 'Verse 2', 'Chorus 2', 'Bridge', 'Outro'],
    5: ['Intro', 'Verse 1', 'Pre-Chorus 1', 'Chorus 1', 'Post-Chorus', 'Verse 2', 'Pre-Chorus 2', 'Chorus 2', 'Bridge', 'Outro'],
    6: ['Intro', 'Verse 1', 'Pre-Chorus 1', 'Chorus 1', 'Post-Chorus', 'Verse 2', 'Pre-Chorus 2', 'Chorus 2', 'Bridge', 'Verse 3', 'Final Chorus', 'Outro'],
  };
  if (presets[count]) return presets[count];
  const sections = [...presets[6]];
  while (sections.length < count * 2) sections.splice(-2, 0, `Verse ${Math.ceil(sections.length / 2)}`, `Chorus ${Math.ceil(sections.length / 2)}`);
  return sections.slice(0, count * 2);
}

function durationTargets(value, model = {}) {
  const duration = Math.max(10, Math.min(isAceStepModel(model) ? 600 : 300, Number(value) || 60));
  const segmentedAce = isAceStepModel(model) && (model.playbook === 'ace-segment' || model.id === 'ace-step-1.0');
  if (segmentedAce) {
    // Multi-part calls reserve an 8s cover handle at the head of every later part.
    // 37s of new material + 8s of overlap stays inside ACE's 45s safe call size.
    const baseCount = duration <= 45 ? 1 : Math.max(2, Math.ceil(duration / 37));
    const maximumCount = Math.max(1, Math.floor(duration / 20));
    const existingMetrics = lyricMetrics(model.existingLyrics);
    const segmentCount = duration <= 45 ? baseCount : Math.min(maximumCount, Math.max(
      baseCount,
      Math.ceil(existingMetrics.sections / 2),
      Math.ceil(existingMetrics.lyricLines / 10),
    ));
    const segmentSeconds = Math.round(duration / segmentCount);
    const isSingleSegment = duration <= 45;
    const maxSections = isSingleSegment ? (segmentSeconds <= 30 ? 1 : 2) : Math.min(28, maximumCount * 2);
    const minSections = isSingleSegment ? 1 : Math.max(3, segmentCount + 1);
    const minLyricLines = isSingleSegment
      ? (maxSections === 1 ? 3 : 5)
      : Math.max(segmentCount * 5, Math.ceil(duration / 7));
    const maxLyricLines = isSingleSegment ? (maxSections === 1 ? 6 : 10) : Math.min(140, maximumCount * 10);
    const sections = isSingleSegment
      ? (maxSections === 1 ? ['Verse'] : ['Verse', 'Pre-Chorus'])
      : aceSectionSequence(segmentCount);
    return {
      playbook: 'ace-segment',
      duration,
      segmentCount,
      segmentSeconds,
      sections,
      minSections,
      maxSections,
      minLyricLines,
      maxLyricLines,
      minLyricChars: Math.max(18, minLyricLines * 4),
      maxLyricChars: Math.max(80, maxLyricLines * 12),
      maxLineChars: 12,
      preferredDurationRange: [30, 37],
      minDescriptionChars: 0,
      minArrangementChars: 0,
      maxOutputTokens: Math.min(5200, Math.max(1200, Math.round(900 + duration * 12))),
    };
  }
  if (isAceStepModel(model)) {
    let sections;
    if (duration <= 60) sections = ['Intro', 'Verse', 'Chorus', 'Outro'];
    else if (duration <= 120) sections = ['Intro', 'Verse 1', 'Pre-Chorus', 'Chorus', 'Verse 2', 'Final Chorus', 'Outro'];
    else if (duration <= 240) sections = ['Intro', 'Verse 1', 'Pre-Chorus', 'Chorus', 'Verse 2', 'Chorus', 'Bridge', 'Final Chorus', 'Outro'];
    else sections = ['Intro', 'Verse 1', 'Pre-Chorus', 'Chorus', 'Post-Chorus', 'Verse 2', 'Chorus', 'Bridge', 'Verse 3', 'Final Chorus', 'Outro'];
    const minLyricLines = Math.max(8, Math.ceil(duration / 8));
    return {
      playbook: 'ace-native',
      duration,
      segmentCount: 1,
      segmentSeconds: duration,
      sections,
      minSections: duration <= 60 ? 3 : duration <= 120 ? 5 : duration <= 240 ? 8 : 10,
      maxSections: 18,
      minLyricLines,
      maxLyricLines: Math.max(minLyricLines + 8, Math.ceil(duration / 4)),
      minLyricChars: Math.max(36, minLyricLines * 4),
      maxLyricChars: Math.max(180, Math.ceil(duration * 3)),
      maxLineChars: 14,
      preferredDurationRange: [120, 240],
      minDescriptionChars: Math.min(260, Math.max(80, Math.round(60 + duration * 0.5))),
      minArrangementChars: 0,
      maxOutputTokens: Math.min(7000, Math.max(2200, Math.round(1500 + duration * 14))),
    };
  }
  let sections;
  if (duration <= 30) sections = ['Intro', 'Verse', 'Chorus', 'Outro'];
  else if (duration <= 60) sections = ['Intro', 'Verse', 'Pre-Chorus', 'Chorus', 'Outro'];
  else if (duration <= 120) sections = ['Intro', 'Verse', 'Pre-Chorus', 'Chorus', 'Verse', 'Chorus', 'Outro'];
  else if (duration <= 180) sections = ['Intro', 'Verse', 'Pre-Chorus', 'Chorus', 'Post-Chorus', 'Verse', 'Pre-Chorus', 'Chorus', 'Bridge', 'Chorus', 'Outro'];
  else sections = ['Intro', 'Verse', 'Pre-Chorus', 'Chorus', 'Post-Chorus', 'Verse', 'Pre-Chorus', 'Chorus', 'Bridge', 'Verse', 'Chorus', 'Final Chorus', 'Outro'];
  const minLyricLines = Math.max(4, Math.ceil(duration / 5));
  return {
    playbook: 'full-song',
    duration,
    sections,
    minSections: duration <= 30 ? 4 : duration <= 60 ? 5 : duration <= 120 ? 7 : duration <= 180 ? 10 : 12,
    maxSections: 16,
    minLyricLines,
    maxLyricLines: Math.max(minLyricLines + 4, Math.ceil(duration / 3)),
    minLyricChars: Math.max(36, Math.ceil(duration * 1.2)),
    maxLyricChars: Math.max(240, Math.ceil(duration * 4)),
    maxLineChars: 28,
    preferredDurationRange: null,
    minDescriptionChars: Math.min(420, Math.max(180, Math.round(150 + duration * 0.9))),
    minArrangementChars: Math.min(190, Math.max(80, Math.round(60 + duration * 0.45))),
    maxOutputTokens: Math.min(7000, Math.max(2200, Math.round(1400 + duration * 15))),
  };
}

function durationTargetsForContext(context, duration = context.existing.duration) {
  return durationTargets(duration, { ...context.model, existingLyrics: context.existing.lyrics });
}

function lyricMetrics(value) {
  const source = String(value || '').trim();
  const lines = source.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const allowedTag = /^\[(Intro|Verse|Pre-Chorus|Chorus|Final Chorus|Post-Chorus|Bridge|Build|Drop|Breakdown|Instrumental|Solo|Guitar Solo|Piano Interlude|Main Theme|Climax|Outro|Fade Out|Silence)(?:\s*\d+)?(?:\s*[-:]\s*[^\]]+)?\]$/i;
  const lyricLines = lines.filter((line) => !/^\[[^\]]+\]$/.test(line));
  const semanticLength = (line) => Array.from(String(line || '').replace(/[\s，。！？；、,.!?;:：“”‘’'"（）()—…·-]/g, '')).length;
  const longLines = lyricLines.filter((line) => semanticLength(line) > 12);
  return {
    lyricLines: lyricLines.length,
    lyricChars: semanticLength(lyricLines.join('')),
    sections: lines.filter((line) => allowedTag.test(line)).length,
    longLines: longLines.length,
    maxLineChars: lyricLines.reduce((max, line) => Math.max(max, semanticLength(line)), 0),
  };
}

function repairAceLyrics(value, targets = {}) {
  const source = String(value || '').trim();
  if (!source || /^\[Instrumental\]$/i.test(source)) return { lyrics: source, changed: false };
  const maxChars = Math.max(6, Math.min(10, Math.round(Number(targets.maxLineChars) || 10)));
  const semantic = (char) => !/[\s，。！？；、,.!?;:：“”‘’'"（）()—…·-]/.test(char);
  const wrapPart = (part) => {
    const output = [];
    let buffer = '';
    let count = 0;
    for (const char of Array.from(part)) {
      const counts = semantic(char);
      if (counts && count >= maxChars && buffer.trim()) {
        output.push(buffer.trim());
        buffer = '';
        count = 0;
      }
      buffer += char;
      if (counts) count += 1;
    }
    if (buffer.trim()) output.push(buffer.trim());
    return output;
  };
  const output = [];
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^\[[^\]]+\]$/.test(line)) {
      output.push(line);
      continue;
    }
    const phraseParts = line.replace(/([，。！？；、,.!?;:：]+)/g, '$1\n').split('\n').map((part) => part.trim()).filter(Boolean);
    output.push(...phraseParts.flatMap(wrapPart));
  }
  const lyrics = output.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { lyrics, changed: lyrics !== source };
}

function validateAceSegmentLyrics(lyrics, targets) {
  if (lyrics === '[Instrumental]') return;
  const metrics = lyricMetrics(lyrics);
  const isSuite = Number(targets.segmentCount) > 1;
  if (metrics.sections < targets.minSections) {
    throw new Error(`ACE-Step ${targets.duration} 秒整首至少需要 ${targets.minSections} 个段落；当前 ${metrics.sections} 段，无法可靠拆成 ${targets.segmentCount} 个片段`);
  }
  if (metrics.sections > targets.maxSections) {
    throw new Error(isSuite
      ? `ACE-Step ${targets.duration} 秒在每段至少 20 秒、每段最多 2 个歌词段落的条件下，最多可拆 ${targets.maxSections} 个段落；当前 ${metrics.sections} 段`
      : `ACE-Step 单次最多 ${targets.maxSections} 个段落；当前 ${metrics.sections} 段，请缩短歌词或提高整首时长`);
  }
  if (metrics.longLines > 0 || metrics.maxLineChars > targets.maxLineChars) {
    throw new Error(`ACE-Step 每行尽量 ${Math.min(10, targets.maxLineChars)} 字以内，避免散文句；当前最长一行 ${metrics.maxLineChars} 字`);
  }
  if (metrics.lyricLines < targets.minLyricLines || metrics.lyricChars < targets.minLyricChars) {
    throw new Error(`ACE-Step ${isSuite ? '整首' : '分段'}歌词太短：至少 ${targets.minLyricLines} 行、${targets.minLyricChars} 字；当前 ${metrics.lyricLines} 行、${metrics.lyricChars} 字`);
  }
  if (metrics.lyricLines > targets.maxLyricLines || metrics.lyricChars > targets.maxLyricChars) {
    throw new Error(`ACE-Step ${isSuite ? '整首' : '分段'}歌词太长：最多 ${targets.maxLyricLines} 行、约 ${targets.maxLyricChars} 字；当前 ${metrics.lyricLines} 行、${metrics.lyricChars} 字`);
  }
}

function validateAceLyrics(lyrics, targets) {
  if (targets.playbook === 'ace-segment') return validateAceSegmentLyrics(lyrics, targets);
  if (lyrics === '[Instrumental]') return;
  const metrics = lyricMetrics(lyrics);
  if (metrics.sections < targets.minSections) {
    throw new Error(`ACE-Step ${targets.duration} 秒整曲至少需要 ${targets.minSections} 个段落；当前 ${metrics.sections} 段`);
  }
  if (metrics.sections > targets.maxSections) {
    throw new Error(`ACE-Step 整曲最多建议 ${targets.maxSections} 个段落；当前 ${metrics.sections} 段`);
  }
  if (metrics.longLines > 0 || metrics.maxLineChars > targets.maxLineChars) {
    throw new Error(`ACE-Step 每行尽量 6-10 个音节，当前最长一行 ${metrics.maxLineChars} 字`);
  }
  if (metrics.lyricLines < targets.minLyricLines || metrics.lyricChars < targets.minLyricChars) {
    throw new Error(`ACE-Step ${targets.duration} 秒整曲歌词太短：至少 ${targets.minLyricLines} 行、${targets.minLyricChars} 字；当前 ${metrics.lyricLines} 行、${metrics.lyricChars} 字`);
  }
  if (metrics.lyricLines > targets.maxLyricLines || metrics.lyricChars > targets.maxLyricChars) {
    throw new Error(`ACE-Step ${targets.duration} 秒整曲歌词过密：最多建议 ${targets.maxLyricLines} 行、约 ${targets.maxLyricChars} 字；当前 ${metrics.lyricLines} 行、${metrics.lyricChars} 字`);
  }
}

function tagList(value) {
  return (Array.isArray(value) ? value : String(value || '').split(/[,，]/))
    .map((item) => String(item).trim()).filter(Boolean);
}

const ACE_KEYS = new Set(['C major', 'C minor', 'D major', 'D minor', 'E major', 'E minor', 'F major', 'F minor', 'G major', 'G minor', 'A major', 'A minor', 'B major', 'B minor', 'F# major', 'F# minor', 'Bb major', 'Bb minor', 'Eb major', 'Eb minor']);

function normalizeAceKey(value, fallback = 'C major') {
  const source = String(value || '').trim();
  const match = [...ACE_KEYS].find((item) => item.toLowerCase() === source.toLowerCase());
  return match || (ACE_KEYS.has(fallback) ? fallback : 'C major');
}

function normalizeAceTimeSignature(value, fallback = '4') {
  const source = String(value || '').trim().replace(/\/.*$/, '');
  return ['2', '3', '4', '6'].includes(source) ? source : (['2', '3', '4', '6'].includes(String(fallback)) ? String(fallback) : '4');
}

function normalizeAceLanguage(value, fallback = 'auto') {
  const source = String(value || '').trim().toLowerCase();
  return ['auto', 'zh', 'yue', 'en', 'ja', 'ko'].includes(source) ? source : (['auto', 'zh', 'yue', 'en', 'ja', 'ko'].includes(fallback) ? fallback : 'auto');
}

function lyricStructure(value) {
  const source = String(value || '').trim();
  if (!source) return '';
  if (/^\[Instrumental\]$/i.test(source)) return '[Instrumental]';
  const aliases = {
    intro: 'Intro', verse: 'Verse', 'pre-chorus': 'Pre-Chorus', prechorus: 'Pre-Chorus',
    chorus: 'Chorus', 'post-chorus': 'Post-Chorus', postchorus: 'Post-Chorus',
    bridge: 'Bridge', build: 'Build', drop: 'Drop', breakdown: 'Breakdown', instrumental: 'Instrumental', solo: 'Solo',
    'guitar solo': 'Guitar Solo', 'piano interlude': 'Piano Interlude', 'main theme': 'Main Theme', climax: 'Climax',
    outro: 'Outro', 'fade out': 'Fade Out', silence: 'Silence', 'final chorus': 'Final Chorus',
    '前奏': 'Intro', '主歌': 'Verse', '预副歌': 'Pre-Chorus', '副歌': 'Chorus',
    '后副歌': 'Post-Chorus', '桥段': 'Bridge', '渐强': 'Build', '跌落': 'Drop', '间奏': 'Instrumental', '独奏': 'Solo', '尾奏': 'Outro',
  };
  // Only normalize known section aliases. Never invent structure labels the model did not write.
  const lyrics = source.replace(/^\s*\[([^\]]+)]\s*$/gm, (line, raw) => {
    const key = String(raw).trim().toLowerCase().replace(/\s*\d+$/, '');
    const numbered = String(raw).trim().match(/^(.*?)(\s*\d+)?$/);
    const base = String(numbered?.[1] || raw).trim().toLowerCase();
    if (aliases[key] || aliases[base]) {
      const label = aliases[key] || aliases[base];
      const suffix = numbered?.[2] || '';
      return `[${label}${suffix}]`;
    }
    return line;
  }).replace(/\n{3,}/g, '\n\n').trim();
  return lyrics.slice(0, 12000);
}

function captionSections(value, rawContext = {}) {
  const source = String(value || '').trim();
  const context = normalizeContext(rawContext);
  const targets = durationTargetsForContext(context);
  const compactLength = source.replace(/\s/g, '').length;
  if (targets.minDescriptionChars > 0 && compactLength < targets.minDescriptionChars) {
    throw new Error(`description 太短：目标 ${targets.duration} 秒至少需要 ${targets.minDescriptionChars} 个有效字符，当前只有 ${compactLength} 个`);
  }
  const prefersMiniMaxCaption = /minimax/i.test(context.model.id) || /minimax/i.test(context.model.label);
  if (prefersMiniMaxCaption) {
    const sections = source.match(/^Global Metadata:\s*([\s\S]*?)\r?\n+Vocal Details:\s*([\s\S]*?)\r?\n+Arrangement:\s*([\s\S]*)$/i);
    if (!sections || sections.slice(1).some((part) => !String(part).trim())) {
      throw new Error('MiniMax description 必须按顺序完整包含 Global Metadata、Vocal Details、Arrangement 三部分');
    }
    const arrangementLength = sections[3].replace(/\s/g, '').length;
    if (arrangementLength < targets.minArrangementChars) {
      throw new Error(`Arrangement 太短：目标 ${targets.duration} 秒至少需要 ${targets.minArrangementChars} 个有效字符，当前只有 ${arrangementLength} 个`);
    }
  }
  return source.slice(0, 4000);
}

function parseJsonContent(content) {
  if (content && typeof content === 'object') return content;
  const source = String(content || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('智能创作服务没有返回可解析的 JSON');
  return JSON.parse(source.slice(start, end + 1));
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function requiredDraftValue(data, field, aliases = []) {
  const key = [field, ...aliases].find((candidate) => hasOwn(data, candidate));
  if (!key) throw new Error(`模型没有返回未锁定字段 ${field}`);
  return data[key];
}

function requiredDraftText(data, field, aliases = []) {
  const value = String(requiredDraftValue(data, field, aliases) ?? '').trim();
  if (!value) throw new Error(`模型没有返回未锁定字段 ${field}`);
  return value;
}

function requiredDraftNumber(data, field, range, integer = false) {
  const raw = requiredDraftValue(data, field);
  if (raw === '' || raw === null || raw === undefined || !Number.isFinite(Number(raw))) {
    throw new Error(`模型没有返回有效的未锁定字段 ${field}`);
  }
  const value = numeric(raw, Number(raw), range);
  return integer ? Math.round(value) : value;
}

function comparableDraftValue(field, value) {
  if (['duration', 'steps', 'cfg', 'bpm'].includes(field)) return Number(value);
  if (field === 'tags') {
    return tagList(value).map((item) => item.replace(/\s+/g, ' ').trim().toLowerCase()).sort().join('|');
  }
  if (field === 'lyrics') return lyricStructure(value).replace(/\s+/g, ' ').trim().toLowerCase();
  return String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function assertUnlockedFieldsRewritten(draft, context) {
  const locked = new Set(context.lockedFields);
  const unchanged = activeDraftFields(context).filter((field) => !locked.has(field)
    && comparableDraftValue(field, draft[field]) === comparableDraftValue(field, context.existing[field]));
  if (unchanged.length) throw new Error(`未锁定字段没有改写：${unchanged.join('、')}`);
}

function normalizeDraft(value, idea, engine, rawContext = {}) {
  const context = normalizeContext(rawContext);
  const data = parseJsonContent(value);
  const locked = new Set(context.lockedFields);
  const supports = (field) => context.model.fields.includes(field);
  const titleSource = locked.has('title') ? context.existing.title : requiredDraftText(data, 'title');
  const title = String(titleSource).replace(/\s+/g, ' ').trim().slice(0, 40);
  const duration = !supports('duration') || locked.has('duration')
    ? context.existing.duration
    : requiredDraftNumber(data, 'duration', context.ranges.duration);
  const validationContext = { ...context, existing: { ...context.existing, duration } };
  const targets = durationTargetsForContext(validationContext, duration);
  const descriptionSource = locked.has('description')
    ? context.existing.description
    : supports('prompt') ? requiredDraftText(data, 'description', ['prompt']) : '';
  const description = supports('prompt')
    ? (locked.has('description') ? String(descriptionSource || '').trim().slice(0, 4000) : captionSections(descriptionSource, validationContext))
    : '';
  const negativeSource = locked.has('negativePrompt')
    ? context.existing.negativePrompt
    : supports('negativePrompt') ? requiredDraftText(data, 'negativePrompt') : '';
  const negativePrompt = supports('negativePrompt') ? String(negativeSource).trim().slice(0, 2000) : '';
  const lyricsSource = locked.has('lyrics')
    ? context.existing.lyrics
    : supports('lyrics') ? requiredDraftText(data, 'lyrics') : '[Instrumental]';
  let lyrics = supports('lyrics') ? lyricStructure(lyricsSource) : '[Instrumental]';
  const warnings = [];
  if (supports('lyrics') && !locked.has('lyrics') && (targets.playbook === 'ace-segment' || targets.playbook === 'ace-native')) {
    const repaired = repairAceLyrics(lyrics, targets);
    lyrics = repaired.lyrics;
    if (repaired.changed) warnings.push('已自动整理 ACE-Step 歌词断行');
  }
  if (supports('lyrics') && !locked.has('lyrics') && lyrics !== '[Instrumental]') {
    const vocalCheck = VocalGuard.preflight(lyrics, { duration, segmented: targets.playbook === 'ace-segment' });
    if (vocalCheck.error) throw new Error(`歌词结构与演唱目标冲突：${vocalCheck.error}`);
    if (targets.playbook === 'ace-segment' || targets.playbook === 'ace-native') {
      validateAceLyrics(lyrics, targets);
      if (targets.playbook === 'ace-segment' && lyricMetrics(lyrics).sections > targets.segmentCount * 2) {
        warnings.push('歌词结构较丰富，生成时会自动增加安全分段数');
      }
    } else {
      const metrics = lyricMetrics(lyrics);
      if (metrics.lyricLines < targets.minLyricLines || metrics.lyricChars < targets.minLyricChars || metrics.sections < targets.minSections) {
        throw new Error(`lyrics 与 ${targets.duration} 秒时长不匹配：至少 ${targets.minLyricLines} 行、${targets.minLyricChars} 个有效字符、${targets.minSections} 个段落标签；当前为 ${metrics.lyricLines} 行、${metrics.lyricChars} 字符、${metrics.sections} 段`);
      }
    }
  }
  const tagsSource = locked.has('tags')
    ? context.existing.tags
    : supports('tags') ? requiredDraftValue(data, 'tags') : [];
  const tags = supports('tags') ? tagList(tagsSource).slice(0, 8) : [];
  if (supports('tags') && !locked.has('tags') && !tags.length) throw new Error('模型没有返回 tags');
  const bpm = !supports('bpm') || locked.has('bpm')
    ? context.existing.bpm
    : requiredDraftNumber(data, 'bpm', context.ranges.bpm, true);
  const keyscale = !supports('keyscale') || locked.has('keyscale')
    ? context.existing.keyscale
    : normalizeAceKey(requiredDraftText(data, 'keyscale'), context.existing.keyscale);
  const timesignature = !supports('timesignature') || locked.has('timesignature')
    ? context.existing.timesignature
    : normalizeAceTimeSignature(requiredDraftText(data, 'timesignature'), context.existing.timesignature);
  const language = !supports('language') || locked.has('language')
    ? context.existing.language
    : normalizeAceLanguage(requiredDraftText(data, 'language'), context.existing.language);
  const draft = {
    title,
    description,
    negativePrompt,
    lyrics,
    tags,
    duration,
    steps: !supports('steps') || locked.has('steps') ? context.existing.steps : requiredDraftNumber(data, 'steps', context.ranges.steps, true),
    cfg: !supports('cfg') || locked.has('cfg') ? context.existing.cfg : requiredDraftNumber(data, 'cfg', context.ranges.cfg),
    bpm,
    keyscale,
    timesignature,
    language,
    engine,
    playbook: targets.playbook,
    warnings,
  };
  assertUnlockedFieldsRewritten(draft, context);
  return draft;
}

function systemPrompt(rawContext = {}) {
  const context = normalizeContext(rawContext);
  const targets = durationTargetsForContext(context);
  const unlockedFields = activeDraftFields(context).filter((field) => !context.lockedFields.includes(field));
  const modelId = context.model.id || '';
  const prefersMiniMaxCaption = /minimax/i.test(modelId) || /minimax/i.test(context.model.label || '');
  const prefersStableAudio3 = /stable-audio-3|remote-stability/i.test(modelId);
  const prefersAceStep = targets.playbook === 'ace-segment' || targets.playbook === 'ace-native';
  const prefersAceNative = targets.playbook === 'ace-native';
  const supportsDescription = context.model.fields.includes('prompt');
  const supportsNegativePrompt = context.model.fields.includes('negativePrompt');
  const supportsLyrics = context.model.fields.includes('lyrics');
  const supportsTags = context.model.fields.includes('tags');
  const descriptionRule = !supportsDescription
    ? '当前模型不读取 description，返回空字符串；把流派、情绪、人声、配器与制作要求集中写入 tags。'
    : prefersAceStep
    ? `当前目标模型是 ACE-Step 1.5：description/caption 至少 ${targets.minDescriptionChars} 个有效字符，使用具体自然的音乐语言写清流派融合、情绪与年代质感、主唱音色和唱法、核心乐器、制作空间，以及从前奏到尾奏的密度、动态和转场发展。BPM、调式、拍号和歌词语言分别写入专用字段，不要在 caption 中堆叠参数。`
    : prefersMiniMaxCaption
    ? `当前目标模型是 MiniMax：description 必须严格写成三部分且保持这个顺序，行首分别为“Global Metadata:”、“Vocal Details:”、“Arrangement:”。完整 description 至少 ${targets.minDescriptionChars} 个有效字符，其中 Arrangement 至少 ${targets.minArrangementChars} 个有效字符。Global Metadata 写清流派融合、年代质感、情绪弧线、BPM/调性/拍号和制作审美；Vocal Details 写清主唱音色、性别/声部、发声、咬字、距离、和声与情绪递进；Arrangement 按 Intro→Verse→Chorus→Bridge→Outro 的时间发展写清乐器进入/退出、密度、动态、转场、高潮和收尾。每部分都给模型可执行信息，禁止模板空话。`
    : prefersStableAudio3
      ? `当前目标模型是 Stable Audio 3：description 必须用自然、具体的英文音乐制作语言写成单段提示，至少 ${targets.minDescriptionChars} 个有效字符；优先描述流派、BPM、调性、核心乐器、音色、空间、动态和随时间变化的编排。它适合器乐、配乐、氛围和音效，不具备可控歌词能力，所以 lyrics 只返回 [Instrumental]。推荐 duration 30-120、steps 8、cfg 1；除非用户明确要求更长，否则不要超过 120 秒。`
      : `description 至少 ${targets.minDescriptionChars} 个有效字符，写成完整可执行的音乐描述：流派融合、年代质感、情绪弧线、BPM/调性/拍号、主唱音色与演唱方式、核心乐器、各段落进入/退出、动态发展、高潮和收尾。不要套用固定模板空话。`;
  const lockedRule = context.lockedFields.length
    ? `以下字段已被用户锁定：${context.lockedFields.join('、')}。这些字段必须逐字逐数保持 existing 中的原值，不得改写、补全或清空；但必须把它们当作强约束，用来协助优化所有未锁定字段。`
    : '当前没有锁定字段；当前模型支持的全部槽位都必须改写。';
  const rewriteRule = `本次必须完整改写这些未锁定槽位：${unlockedFields.join('、')}。每个字段都必须返回有效的新值，并且与 existing 中的对应值实际不同；不能照抄、遗漏、返回空值，也不能只调整格式、大小写、分隔符或标签顺序。existing 仅作为创作上下文，只有 lockedFields 中的字段才允许原样保留。`;
  const uniqueRule = context.requireUnique
    ? `这是持续生成第 ${context.iteration || 1} 轮。新创作单必须与 avoidDrafts 中每一项在歌名和未锁定创意素材上都明显不同；旋律意象、歌词叙事、段落推进、配器组合至少改变两类，禁止仅替换同义词或编号。`
    : '';
  const lyricsRule = !supportsLyrics
    ? '当前模型不支持可控歌词，lyrics 必须只返回 [Instrumental]。'
    : prefersAceNative
      ? [
        `当前目标模型是 ACE-Step 1.5 原生长歌：duration=${targets.duration} 是一次推理的整首时长，不拆段，不拼接。`,
        `请输出完整整首歌词，共 ${targets.minSections}-${targets.maxSections} 个 section、${targets.minLyricLines}-${targets.maxLyricLines} 行；建议顺序为 ${targets.sections.map((item) => `[${item}]`).join(' → ')}。`,
        '每行约 6-10 个音节，每个重复出现的副歌都写完整正文；用段落标签控制结构，用歌词正文表达画面与情绪。有人声的歌曲不要把唱词写在 [Instrumental]/[Solo] 下，也不要为了填时长增加长间奏。纯音乐时 lyrics 只返回 [Instrumental]。',
      ].join(' ')
    : prefersAceStep
      ? [
        `当前目标模型是 ACE-Step 兼容分段：duration=${targets.duration} 代表最终整首时长。应用会按最终歌词结构动态拆成至少 ${targets.segmentCount} 个、每段 20-37 秒的新内容；后续段会加上 8 秒上一段尾音承接区，合轨时完整重叠消化，不缩短最终时长。每段尽量只有 1-2 个 section、至多约 10 行歌词。`,
        targets.segmentCount > 1
          ? `请一次输出完整整首歌词蓝图，共 ${targets.minSections}-${targets.maxSections} 个 section、${targets.minLyricLines}-${targets.maxLyricLines} 行；建议顺序为 ${targets.sections.map((item) => `[${item}]`).join(' → ')}。`
          : `本次是单段歌曲，Lyrics 最多 ${targets.maxSections} 个 section（建议 ${targets.sections.map((item) => `[${item}]`).join(' + ')}），${targets.minLyricLines}-${targets.maxLyricLines} 行。`,
        '每行 5-10 个汉字，不要散文长句。每个要演唱的段落都写完整正文，不要写“重复副歌/同上”；不要为凑分段数量增加器乐/静音段。纯音乐时 lyrics 只返回 [Instrumental]。',
      ].join(' ')
      : `Lyrics 必须与 ${targets.duration} 秒目标时长匹配：非纯音乐至少 ${targets.minLyricLines} 行、${targets.minLyricChars} 个有效字符和 ${targets.minSections} 个段落标签，建议控制在 ${targets.minLyricLines}-${targets.maxLyricLines} 行；建议段落顺序为 ${targets.sections.map((item) => `[${item}]`).join(' → ')}。Verse 与 Chorus 通常各写 4-8 行，重复出现的 Chorus 必须写出完整正文，禁止用“重复副歌”“同上”省略。`;
  const tagsRule = supportsTags
    ? prefersAceStep
      ? 'tags 是 ACE-Step 的风格控制字段：提供 4-8 个互补的短标签，覆盖流派、情绪、主唱、核心配器、速度感与制作质感；避免与 description、BPM、调式和拍号矛盾。若用户要求歌词清晰，可加入 vocals upfront、clear lyrics，但不要一律强制简单编曲。'
      : 'tags 是模型的主要音乐控制字段，必须提供 3-8 个具体标签，覆盖流派、情绪、人声、核心配器、速度或制作质感，避免同义重复。'
    : '当前模型不读取 tags，返回空数组。';
  return [
    '你是专业歌曲策划、编曲与作词人。所有创意内容必须由你根据用户指令生成或改写；应用不会替你硬编码歌词、描述或标签。',
    prefersAceNative
      ? '把用户指令整理成 ACE-Step 1.5 可一次生成的完整长歌创作单，让歌名、caption、风格标签、歌词结构、BPM、调式、拍号与语言互相一致。'
      : prefersAceStep
      ? `把用户指令整理成 ACE-Step 兼容分段创作单，应用会根据歌词结构动态分段生成和合轨。`
      : '把用户的新指令和当前创作单合并：可延续核心主题、叙事和 hook，但所有未锁定槽位都要重新创作，不能沿用旧值。',
    lockedRule,
    rewriteRule,
    uniqueRule,
    '只返回 JSON，不要 Markdown。字段必须是 title、description、negativePrompt（字符串）、lyrics、tags（字符串数组）、duration（数字）、steps（整数）、cfg（数字）、bpm（整数）、keyscale（如 C major）、timesignature（2/3/4/6）、language（auto/zh/yue/en/ja/ko）。具体字段内容服从当前目标模型能力与锁定规则。当前模型支持且未锁定的参数也必须返回不同的新值，不能默认保留。',
    supportsNegativePrompt
      ? '当前模型支持 negativePrompt：未锁定时必须根据新目标重新生成简洁、具体、互不冲突的英文排除项，并与旧值不同；重点排除噪声、失真、削波、浑浊低频、刺耳高频和不需要的空间效果。'
      : '当前模型不使用 negativePrompt，返回空字符串；不要把排除内容偷偷写进 description。',
    descriptionRule,
    tagsRule,
    lyricsRule,
    supportsLyrics
      ? '有人声的歌用 [Intro]、[Verse]、[Pre-Chorus]、[Chorus]、[Post-Chorus]、[Bridge]、[Final Chorus]、[Outro] 承载全部唱词；不要默认添加 [Instrumental]、[Solo]、[Fade Out]、[Silence]。只有用户明确要求短间奏时才用器乐标签，并且标签下面不得有唱词。标签必须单独占一整行，不能折断。纯音乐时 lyrics 只返回 [Instrumental]。'
      : '不要生成歌词正文或虚构演唱结构。',
    prefersAceNative
      ? `整首歌词体量必须匹配一次生成的 ${targets.duration} 秒，并在前后保持同一叙事、hook、主唱身份和编排弧线。不模仿在世艺人，不引用已有歌词，不输出占位符。`
      : prefersAceStep
      ? `整首歌词体量必须匹配最终 ${targets.duration} 秒，并能拆成 ${targets.segmentCount} 个片段。不模仿在世艺人，不引用已有歌词，不输出占位符。`
      : `编排复杂度和歌词体量都要匹配目标 ${targets.duration} 秒。不模仿在世艺人，不引用已有歌词，不输出占位符或“待填写”。`,
  ].join('\n\n');
}

class SmartComposerManager {
  constructor(options = {}) {
    this.runtimeDir = path.resolve(options.runtimeDir || path.join(process.cwd(), '.runtime'));
    this.configPath = path.join(this.runtimeDir, 'smart-composer.json');
    this.secretCodec = options.secretCodec || null;
    this.settings = cloneDefaults();
    this.secrets = {};
    this.secretMigrationRequired = { ollama: false, openai: false };
    this.configured = { ollama: false, openai: false };
    this.load();
  }

  load() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
      if (SMART_ENGINES.some((item) => item.id === saved.engine)) this.settings.engine = saved.engine;
      for (const id of ['ollama', 'openai']) {
        if (!saved[id]) continue;
        this.settings[id].baseUrl = typeof saved[id].baseUrl === 'string' ? saved[id].baseUrl : this.settings[id].baseUrl;
        this.settings[id].model = typeof saved[id].model === 'string' ? saved[id].model : this.settings[id].model;
        this.configured[id] = saved.version >= 2
          ? Boolean(saved.configured?.[id] && this.settings[id].baseUrl && this.settings[id].model)
          : saved.engine === id && Boolean(this.settings[id].baseUrl && this.settings[id].model);
        if (saved[id].secret && this.secretCodec?.decrypt) {
          try { this.secrets[id] = this.secretCodec.decrypt(saved[id].secret); }
          catch (error) { this.secretMigrationRequired[id] = error?.code === 'LEGACY_SECRET'; }
        }
      }
    } catch (_) {}
  }

  save() {
    fs.mkdirSync(this.runtimeDir, { recursive: true });
    const saved = { version: 2, engine: this.settings.engine, configured: { ...this.configured } };
    for (const id of ['ollama', 'openai']) {
      saved[id] = { ...this.settings[id] };
      if (this.secrets[id] && this.secretCodec?.encrypt) saved[id].secret = this.secretCodec.encrypt(this.secrets[id]);
    }
    fs.writeFileSync(this.configPath, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
    try { fs.chmodSync(this.configPath, 0o600); } catch (_) {}
  }

  status() {
    const engine = this.settings.engine;
    const config = this.settings[engine];
    const configured = Boolean(this.configured[engine] && config.baseUrl && config.model && !this.secretMigrationRequired[engine]);
    return {
      engine, engines: SMART_ENGINES, ...config, configured,
      configs: {
        ollama: { ...this.settings.ollama, configured: this.configured.ollama },
        openai: { ...this.settings.openai, configured: this.configured.openai },
      },
      keyHint: this.secretMigrationRequired[engine] ? '更新后需重新输入一次' : this.secrets[engine] ? `••••${this.secrets[engine].slice(-4)}` : '',
      keyMigrationRequired: this.secretMigrationRequired[engine],
      secretPersistent: Boolean(this.secretCodec?.encrypt && this.secretCodec?.decrypt),
    };
  }

  configure(body = {}) {
    const engine = String(body.engine || this.settings.engine);
    if (!SMART_ENGINES.some((item) => item.id === engine)) throw new Error('未知的智能创作引擎');
    this.settings.engine = engine;
    const current = this.settings[engine];
    if (body.baseUrl !== undefined) current.baseUrl = safeUrl(body.baseUrl);
    if (body.model !== undefined) current.model = String(body.model || '').trim();
    if (!current.baseUrl) throw new Error('请填写智能创作服务地址');
    if (!current.model) throw new Error('请填写智能创作模型名');
    if (body.clearKey) { delete this.secrets[engine]; this.secretMigrationRequired[engine] = false; }
    else if (typeof body.apiKey === 'string' && body.apiKey.trim()) { this.secrets[engine] = body.apiKey.trim(); this.secretMigrationRequired[engine] = false; }
    this.configured[engine] = true;
    this.save();
    return this.status();
  }

  async test() {
    const status = this.status();
    if (!status.configured) throw new Error('请先配置智能模型 API');
    const headers = { Accept: 'application/json' };
    const endpoint = status.engine === 'ollama'
      ? new URL('api/tags', `${status.baseUrl}/`)
      : new URL('models', `${status.baseUrl}/`);
    if (status.engine === 'openai' && this.secrets.openai) headers.Authorization = `Bearer ${this.secrets.openai}`;
    const response = await fetchTimeout(endpoint, { headers }, 15000);
    if (!response.ok) throw new Error(`智能创作服务：${await responseError(response)}`);
    return { ok: true, engine: status.engine, model: status.model };
  }

  async complete(body = {}) {
    const idea = stripIdea(body.idea);
    if (idea.length < 2) throw new Error('请至少输入两个字的歌曲想法');
    const context = normalizeContext(body);
    const targets = durationTargetsForContext(context);
    const status = this.status();
    if (!status.configured) throw new Error('请先在“模型 → 智能创作”中配置并测试模型 API');
    const hasExisting = Boolean(context.existing.title || context.existing.description || context.existing.negativePrompt || context.existing.tags || context.existing.lyrics);
    const messages = [
      { role: 'system', content: systemPrompt(context) },
      { role: 'user', content: JSON.stringify({ task: hasExisting ? 'optimize_existing_draft' : 'create_new_draft', instruction: idea, playbook: targets.playbook, ...context }, null, 2) },
    ];
    const callModel = async (activeMessages) => {
      if (status.engine === 'ollama') {
        const response = await fetchTimeout(new URL('api/chat', `${status.baseUrl}/`), {
          method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ model: status.model, messages: activeMessages, stream: false, format: 'json', options: { temperature: context.requireUnique ? 1 : 0.8, num_predict: targets.maxOutputTokens } }),
        });
        if (!response.ok) throw new Error(`Ollama：${await responseError(response)}`);
        return (await response.json())?.message?.content;
      }
      const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
      if (this.secrets.openai) headers.Authorization = `Bearer ${this.secrets.openai}`;
      const request = async (structured = true) => fetchTimeout(new URL('chat/completions', `${status.baseUrl}/`), {
        method: 'POST', headers,
        body: JSON.stringify({ model: status.model, messages: activeMessages, temperature: context.requireUnique ? 1 : 0.8, max_tokens: targets.maxOutputTokens, ...(structured ? { response_format: { type: 'json_object' } } : {}) }),
      });
      let response = await request(true);
      if ([400, 404, 422].includes(response.status)) response = await request(false);
      if (!response.ok) throw new Error(`OpenAI-compatible：${await responseError(response)}`);
      return (await response.json())?.choices?.[0]?.message?.content;
    };

    let content = await callModel(messages);
    try {
      return normalizeDraft(content, idea, status.engine, context);
    } catch (firstError) {
      content = await callModel([
        ...messages,
        { role: 'assistant', content: String(content || '') },
        { role: 'user', content: `上一次输出无法写入创作单：${firstError.message}。请重新返回完整且格式正确的 JSON；所有创意内容必须由你生成。当前模型支持的每个未锁定槽位都不得省略或照抄 existing，必须返回实际不同的新值。` },
      ]);
      try {
        return normalizeDraft(content, idea, status.engine, context);
      } catch (secondError) {
        throw new Error(`模型连续两次返回了无效创作单：${secondError.message}`);
      }
    }
  }
}

module.exports = {
  SmartComposerManager, SMART_ENGINES, DEFAULT_SETTINGS,
  parseJsonContent, normalizeDraft, normalizeContext, activeDraftFields, durationTargets, lyricStructure, lyricMetrics, repairAceLyrics,
  captionSections, isAceStepModel, validateAceSegmentLyrics, validateAceLyrics, aceSectionSequence,
};
