(function () {
  'use strict';

  const { DemoProvider, makeLocalComfyProvider, makeLocalCliProvider, makeRemoteProvider, makeComfyUIProvider, Sidecar } = window.Providers;
  const Models = window.Models;
  const Engine = window.AudioEngine;
  const Store = window.LibraryStore;
  const QueuePersistence = window.QueuePersistence;
  const AceSegment = window.AceSegment;
  const VocalGuard = window.VocalGuard;
  const AudioQuality = window.AudioQuality;
  const Lyrics = window.TimedLyrics;
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));
  const LS_MODEL = 'yinyuetai.model.v2';
  const LS_CONFIG = 'yinyuetai.connections.v2';
  const LS_SMART_OPEN = 'yinyuetai.smart.open.v1';
  const LS_SMART_LOCKS = 'yinyuetai.smart.locks.v1';
  const LS_CREATION_ALBUM = 'yinyuetai.creation.album.v1';
  const LS_COMPLETION_POLICY = 'yinyuetai.completion.policy.v1';
  const LS_CREATION_DRAFT = 'yinyuetai.creation.draft.v1';
  const LS_ACE_STRATEGY_V2 = 'yinyuetai.ace.strategy.v2';
  const LS_GENERATION_QUEUE = 'yinyuetai.generation.queue.v1';
  const COMPLETION_NOTICE_MS = 8000;
  const DRAFT_SAVE_DELAY = 450;

  const state = {
    model: null,
    generating: false,
    stopRequested: false,
    activeProvider: null,
    generationController: null,
    generationQueue: [],
    queueRestored: false,
    queueResumeBusy: false,
    suiteParts: new Map(),
    queueProcessing: false,
    activeJob: null,
    smartBusy: false,
    smartChangedFields: [],
    smartLockedFields: new Set(),
    continuousEnabled: false,
    continuousPreparing: false,
    continuousTemplate: null,
    continuousSequence: 0,
    continuousFailures: 0,
    continuousHistory: [],
    followQueue: [],
    playbackHistory: [],
    playbackContext: null,
    completionNotices: [],
    completionPolicy: 'follow',
    library: [],
    albums: [],
    libraryQuery: '',
    libraryAlbum: '*',
    libraryCategory: '*',
    librarySelection: new Set(),
    librarySelectionAnchor: null,
    contextTrackId: null,
    libraryAlbumMoveIds: [],
    libraryCategoryIds: [],
    editingTrackId: null,
    detailTrackId: null,
    lyricTrackId: null,
    lyricDraft: [],
    lyricEditorActiveIndex: -1,
    current: null,
    lyrics: [],
    activeLyricIndex: -1,
    status: null,
    statusBusy: false,
    activeView: 'studio',
    localModelId: 'minimax-music-3',
    remoteProviderId: 'minimax',
    downloadTarget: null,
    downloadBusy: false,
    minimaxSpeedMode: 'custom',
    draftReady: false,
    draftRestored: false,
  };

  const audio = new Audio();
  let audioContext = null;
  let analyser = null;
  let sourceNode = null;
  let frequencyData = null;
  let visualFrame = null;
  let draftSaveTimer = null;
  let queueSaveTimer = null;
  let queuePersistenceWarningShown = false;
  const completionNoticeTimers = new Map();

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[char]);
  }

  function formatTime(seconds) {
    const whole = Math.max(0, Math.floor(Number(seconds) || 0));
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
  }

  function formatPreciseTime(seconds) {
    return Lyrics?.formatTime(seconds) || `00:${String(Number(seconds) || 0).padStart(2, '0')}`;
  }

  function formatElapsed(milliseconds) {
    const seconds = Math.max(0, Math.round((Number(milliseconds) || 0) / 1000));
    if (seconds < 60) return `${seconds}秒`;
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    return `${minutes}分${String(remainder).padStart(2, '0')}秒`;
  }

  function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)}GB`;
    if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(0)}MB`;
    return `${Math.round(value / 1024)}KB`;
  }

  function formatDate(timestamp) {
    if (!Number(timestamp)) return '—';
    return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', year: '2-digit' }).format(new Date(timestamp));
  }

  function stringHash(value) {
    let hash = 2166136261;
    for (const char of String(value || '')) {
      hash ^= char.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function seededRandom(seed) {
    let value = (Number(seed) || 1) >>> 0;
    return () => {
      value += 0x6D2B79F5;
      let result = value;
      result = Math.imul(result ^ (result >>> 15), result | 1);
      result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
      return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
    };
  }

  function trackCoverSeed(track) {
    return stringHash(track?.coverSeed || track?.id || 'yinyuetai-default-cover');
  }

  function coverMarkFromTitle(title) {
    const normalized = String(title || '').trim();
    if (!normalized) return 'Y';
    const words = normalized.split(/\s+/).filter(Boolean);
    if (words.length > 1 && /^[\x00-\x7F]+$/.test(normalized)) return words.slice(0, 2).map((word) => word[0]).join('').toUpperCase();
    return Array.from(normalized)[0].toUpperCase();
  }

  function ensureTrackCoverIdentity(track) {
    if (!track) return false;
    let changed = false;
    if (!track.coverSeed) {
      track.coverSeed = String(track.id || 'yinyuetai-default-cover');
      changed = true;
    }
    if (!track.coverMark) {
      track.coverMark = coverMarkFromTitle(track.title);
      changed = true;
    }
    return changed;
  }

  function trackTheme(track) {
    const value = trackCoverSeed(track);
    const hue = value % 360;
    const palettes = [
      { name: 'analog', offsets: [36, 76, 18] },
      { name: 'complement', offsets: [176, 214, 28] },
      { name: 'triad', offsets: [118, 238, 54] },
      { name: 'split', offsets: [148, 212, 326] },
      { name: 'mono', offsets: [8, 350, 22] },
      { name: 'clash', offsets: [92, 194, 278] },
    ];
    const palette = palettes[(value >>> 5) % palettes.length];
    const second = (hue + palette.offsets[0]) % 360;
    const third = (hue + palette.offsets[1]) % 360;
    const fourth = (hue + palette.offsets[2]) % 360;
    return {
      palette: palette.name,
      a: `hsl(${hue} ${34 + (value % 24)}% ${23 + ((value >>> 4) % 10)}%)`,
      b: `hsl(${second} ${48 + ((value >>> 8) % 24)}% ${50 + ((value >>> 12) % 16)}%)`,
      c: `hsl(${third} ${25 + ((value >>> 16) % 18)}% ${8 + ((value >>> 20) % 8)}%)`,
      d: `hsl(${fourth} ${54 + ((value >>> 10) % 22)}% ${48 + ((value >>> 18) % 19)}%)`,
      angle: `${value % 180}deg`,
      x: `${22 + (value % 57)}%`,
      y: `${18 + ((value >>> 7) % 61)}%`,
    };
  }

  function trackCoverComposition(track) {
    const seed = trackCoverSeed(track);
    const random = seededRandom(seed ^ 0x9E3779B9);
    const shapes = ['ring', 'orb', 'crescent', 'diamond', 'triangle', 'bar', 'cross', 'arc', 'star', 'frame', 'wave', 'capsule'];
    const patterns = ['none', 'dots', 'grid', 'rays', 'stripes', 'halftone'];
    const blends = ['normal', 'screen', 'overlay', 'soft-light'];
    const atoms = [];
    while (atoms.length < 3) {
      const shape = shapes[Math.floor(random() * shapes.length)];
      if (!atoms.includes(shape)) atoms.push(shape);
    }
    const sizes = [46 + random() * 28, 24 + random() * 24, 11 + random() * 19];
    const variables = atoms.map((shape, index) => ({
      shape,
      x: 12 + random() * 76,
      y: 12 + random() * 76,
      size: sizes[index],
      rotation: -78 + random() * 156,
      opacity: .42 + random() * .46,
    }));
    return {
      atoms, variables,
      pattern: patterns[Math.floor(random() * patterns.length)],
      blend: blends[Math.floor(random() * blends.length)],
    };
  }

  function trackCoverType(track) {
    if (!track) return 'orbit';
    const value = trackCoverSeed(track);
    const words = `${track.title || ''} ${track.tags || ''} ${track.prompt || ''} ${track.modelLabel || ''}`.toLowerCase();
    let types = ['orbit', 'horizon', 'prism', 'signal', 'bloom', 'matrix', 'eclipse', 'tape'];
    if (track.provider === 'import') types = ['tape', 'matrix', 'horizon', 'prism'];
    else if (/electro|edm|电子|合成器|synth|techno|house|舞曲/.test(words)) types = ['signal', 'matrix', 'prism', 'eclipse'];
    else if (/ambient|cinematic|氛围|电影|自然|山|海|雨|夜/.test(words)) types = ['horizon', 'eclipse', 'orbit', 'bloom'];
    else if (/jazz|soul|blues|爵士|灵魂|蓝调|钢琴|古典/.test(words)) types = ['tape', 'bloom', 'orbit', 'horizon'];
    else if (/pop|vocal|流行|人声|民谣|folk/.test(words)) types = ['bloom', 'prism', 'orbit', 'tape'];
    return types[(value >>> 9) % types.length];
  }

  function trackCoverMark(track) {
    return String(track?.coverMark || coverMarkFromTitle(track?.title)).slice(0, 2);
  }

  function trackThemeStyle(track) {
    const theme = trackTheme(track);
    const composition = trackCoverComposition(track);
    const atomVariables = composition.variables.map((atom, index) => {
      const number = index + 1;
      return `--atom${number}-x:${atom.x.toFixed(1)}%;--atom${number}-y:${atom.y.toFixed(1)}%;--atom${number}-size:${atom.size.toFixed(1)}%;--atom${number}-rotation:${atom.rotation.toFixed(1)}deg;--atom${number}-opacity:${atom.opacity.toFixed(2)}`;
    }).join(';');
    return `--cover-a:${theme.a};--cover-b:${theme.b};--cover-c:${theme.c};--cover-d:${theme.d};--cover-angle:${theme.angle};--cover-x:${theme.x};--cover-y:${theme.y};${atomVariables}`;
  }

  function trackCoverAttributes(track) {
    const theme = trackTheme(track);
    const composition = trackCoverComposition(track);
    return `data-cover-type="${trackCoverType(track)}" data-cover-pattern="${composition.pattern}" data-cover-palette="${theme.palette}" data-cover-blend="${composition.blend}" style="${trackThemeStyle(track)}"`;
  }

  function trackCoverAtoms(track) {
    const composition = trackCoverComposition(track);
    return `<span class="cover-atoms" aria-hidden="true">${composition.atoms.map((shape) => `<i class="cover-atom atom-${shape}"></i>`).join('')}</span>`;
  }

  function applyTrackTheme(element, track) {
    if (!element) return;
    const theme = trackTheme(track);
    element.style.setProperty('--cover-a', theme.a);
    element.style.setProperty('--cover-b', theme.b);
    element.style.setProperty('--cover-c', theme.c);
    element.style.setProperty('--cover-d', theme.d);
    element.style.setProperty('--cover-angle', theme.angle);
    element.style.setProperty('--cover-x', theme.x);
    element.style.setProperty('--cover-y', theme.y);
    element.dataset.coverType = trackCoverType(track);
    const composition = trackCoverComposition(track);
    element.dataset.coverPattern = composition.pattern;
    element.dataset.coverPalette = theme.palette;
    element.dataset.coverBlend = composition.blend;
    composition.variables.forEach((atom, index) => {
      const number = index + 1;
      element.style.setProperty(`--atom${number}-x`, `${atom.x.toFixed(1)}%`);
      element.style.setProperty(`--atom${number}-y`, `${atom.y.toFixed(1)}%`);
      element.style.setProperty(`--atom${number}-size`, `${atom.size.toFixed(1)}%`);
      element.style.setProperty(`--atom${number}-rotation`, `${atom.rotation.toFixed(1)}deg`);
      element.style.setProperty(`--atom${number}-opacity`, atom.opacity.toFixed(2));
    });
    const atoms = element.querySelector('.cover-atoms');
    if (atoms) atoms.innerHTML = composition.atoms.map((shape) => `<i class="cover-atom atom-${shape}"></i>`).join('');
  }

  let toastTimer = null;
  function toast(message, duration = 3200) {
    const element = $('#toast');
    element.textContent = message;
    element.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => element.classList.remove('show'), duration);
  }

  function showView(name) {
    if ($('#now-playing')?.classList.contains('open')) closeNowPlaying();
    state.activeView = name;
    $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === name));
    $$('[data-view-panel]').forEach((panel) => panel.classList.toggle('active', panel.dataset.viewPanel === name));
    $('.workspace').scrollTop = 0;
    if (name === 'models') refreshRuntimeLogs();
  }

  function buildModelSelect() {
    const select = $('#model');
    select.innerHTML = '';
    Models.grouped().forEach((group) => {
      const optgroup = document.createElement('optgroup');
      optgroup.label = group.group;
      group.items.forEach((model) => {
        const option = document.createElement('option');
        option.value = model.id;
        option.textContent = model.label;
        optgroup.appendChild(option);
      });
      select.appendChild(optgroup);
    });
    const saved = localStorage.getItem(LS_MODEL) || 'minimax-music-3';
    select.value = Models.byId(saved).id;
  }

  function setRange(id, range, defaultValue) {
    const input = $(`#${id}`);
    if (!input || !range) return;
    [input.min, input.max, input.step] = range.map(String);
    const editor = $(`#${id}-val`);
    if (editor?.matches('input[type="number"]')) [editor.min, editor.max, editor.step] = range.map(String);
    input.value = String(defaultValue);
    updateRangeLabel(id);
  }

  function updateRangeLabel(id) {
    const input = $(`#${id}`);
    const output = $(`#${id}-val`);
    if (!input || !output) return;
    if (output.matches('input[type="number"]')) output.value = input.value;
    else output.textContent = input.value + (id === 'duration' ? 's' : '');
    if (['duration', 'steps', 'cfg'].includes(id)) renderMiniMaxSpeedProfile();
    if (id === 'duration') renderAceSegmentPlan();
  }

  function compactEstimate(seconds) {
    const value = Math.max(1, Math.round(Number(seconds) || 0));
    if (value < 60) return `${value} 秒`;
    const minutes = Math.floor(value / 60);
    const remainder = value % 60;
    return remainder ? `${minutes} 分 ${remainder} 秒` : `${minutes} 分钟`;
  }

  function renderMiniMaxSpeedProfile() {
    const panel = $('#minimax-speed-profile');
    if (!panel) return;
    const visible = state.model?.id === 'minimax-music-3-mlx';
    panel.classList.toggle('hidden', !visible);
    if (!visible) return;
    const duration = Number($('#duration')?.value) || 30;
    const steps = Number($('#steps')?.value) || 8;
    const cfg = Number($('#cfg')?.value) || 1.7;
    const last = state.status?.local?.music3MlxWorker?.lastMetrics;
    const matchingLast = last && Math.abs(Number(last.steps) - steps) < 0.01 && Math.abs(Number(last.cfg) - cfg) < 0.01
      && Boolean(last.fastAr) === (state.minimaxSpeedMode === 'draft');
    const estimatedRtf = matchingLast
      ? Number(last.realTimeFactor)
      : state.minimaxSpeedMode === 'draft' ? 2.9 + steps * 0.22
        : 3.05 + steps * (cfg === 1 ? 0.22 : 0.43);
    const estimate = compactEstimate(duration * Math.max(1, estimatedRtf));
    const warm = Boolean(state.status?.local?.music3MlxWorker?.warm);
    $('#minimax-speed-estimate').textContent = `粗略预计 ${estimate}${warm ? ' · 权重已预热' : ' · 首次需预热'}`;
    const profiles = {
      draft: [20, 4, 1], balanced: [60, 8, 1.7], quality: [60, 20, 1.7],
    };
    $$('#minimax-speed-profile [data-minimax-speed]').forEach((button) => {
      const target = profiles[button.dataset.minimaxSpeed];
      button.classList.toggle('active', Boolean(target && state.minimaxSpeedMode === button.dataset.minimaxSpeed
        && duration === target[0] && steps === target[1] && Math.abs(cfg - target[2]) < 0.001));
    });
  }

  function applyMiniMaxSpeedProfile(profile) {
    const profiles = {
      draft: { duration: 20, steps: 4, cfg: 1 },
      balanced: { duration: 60, steps: 8, cfg: 1.7 },
      quality: { duration: 60, steps: 20, cfg: 1.7 },
    };
    const values = profiles[profile];
    if (!values) return;
    state.minimaxSpeedMode = profile;
    Object.entries(values).forEach(([id, value]) => {
      $(`#${id}`).value = String(value);
      updateRangeLabel(id);
    });
    state.smartChangedFields = [];
    renderSmartImpact();
    renderMiniMaxSpeedProfile();
    scheduleCreationDraftSave();
    toast(profile === 'draft' ? '已切换极速预览：短片段、低采样、单路声学生成' : profile === 'balanced' ? '已切换平衡成曲' : '已切换高质成曲；耗时会明显增加');
  }

  function rangePrecision(input) {
    const step = String(input.step || '1').toLowerCase();
    if (step.includes('e-')) return Number(step.split('e-')[1]) || 0;
    return step.includes('.') ? step.split('.')[1].length : 0;
  }

  function normalizedRangeValue(input, rawValue) {
    const current = Number(input.value);
    if (String(rawValue ?? '').trim() === '') return Number.isFinite(current) ? current : 0;
    const raw = Number(rawValue);
    if (!Number.isFinite(raw)) return Number.isFinite(current) ? current : 0;
    const min = Number(input.min);
    const max = Number(input.max);
    const step = Number(input.step);
    let value = Math.min(Number.isFinite(max) ? max : raw, Math.max(Number.isFinite(min) ? min : raw, raw));
    if (Number.isFinite(step) && step > 0) {
      const base = Number.isFinite(min) ? min : 0;
      value = base + Math.round((value - base) / step) * step;
    }
    return Number(value.toFixed(rangePrecision(input)));
  }

  function noteParameterEdit(id) {
    if (id === 'reference-strength') return;
    if (state.model?.id === 'minimax-music-3-mlx') state.minimaxSpeedMode = 'custom';
    state.smartChangedFields = [];
    renderSmartImpact();
    if (id === 'duration') renderAceSegmentPlan();
  }

  function bindRangeEditor(id) {
    const range = $(`#${id}`);
    const editor = $(`#${id}-val`);
    if (!range || !editor?.matches('input[type="number"]')) return;
    range.addEventListener('input', () => {
      updateRangeLabel(id);
      noteParameterEdit(id);
    });
    editor.addEventListener('input', () => {
      const value = Number(editor.value);
      const min = Number(range.min);
      const max = Number(range.max);
      if (!Number.isFinite(value) || value < min || value > max) return;
      range.value = String(value);
      noteParameterEdit(id);
    });
    const commit = () => {
      const value = normalizedRangeValue(range, editor.value);
      range.value = String(value);
      editor.value = String(value);
      noteParameterEdit(id);
    };
    editor.addEventListener('change', commit);
    editor.addEventListener('blur', commit);
    editor.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        commit();
        editor.blur();
      }
    });
  }

  function studioTipFor(model = state.model) {
    if (model?.playbook === 'ace-native') {
      return {
        index: 'ACE',
        text: 'ACE-Step 1.5 默认智能选择：短歌用原生整首保持一致，超过 120 秒自动分段生成并合轨。',
      };
    }
    if (model?.playbook === 'ace-segment' || /ace-step/i.test(model?.id || '')) {
      return {
        index: 'ACE',
        text: 'ACE-Step 智能模式会在 120 秒内优先原生整首，长歌自动拆成安全片段并合轨；也可手动强制原生或固定分段。',
      };
    }
    if (/minimax/i.test(model?.id || '')) {
      return {
        index: 'M3',
        text: 'MiniMax 描述写清人声、乐器进入和段落推进；长曲会明显更慢，先用短时长试听。',
      };
    }
    if (model?.id === 'stable-audio-3') {
      return {
        index: 'S3',
        text: 'Stable Audio 3 更适合器乐/配乐/音效；没有可控歌词，可用曲库参考音做变奏。',
      };
    }
    return {
      index: '01',
      text: '描述不只写曲风，也写清楚人声、乐器如何进入，以及副歌想把情绪推到哪里。',
    };
  }

  function renderStudioTip(model = state.model) {
    const tip = studioTipFor(model);
    const index = $('#studio-tip-index');
    const copy = $('#studio-tip');
    if (index) index.textContent = tip.index;
    if (copy) copy.textContent = tip.text;
  }

  function aceGenerationStrategy(model = state.model, params = {}) {
    if (!model || !AceSegment) return { strategy: 'native', selected: 'native', segmentCount: 1, reason: '' };
    if (model.playbook === 'ace-segment') {
      const duration = Number(params.duration) || Number($('#duration')?.value) || 40;
      return { strategy: 'segment', selected: 'fixed', segmentCount: AceSegment.segmentCountForDuration(duration), reason: '该模型使用兼容分段工作流' };
    }
    if (model.playbook !== 'ace-native') return { strategy: 'native', selected: 'native', segmentCount: 1, reason: '' };
    const selected = String(params.aceLongMode || $('#ace-long-mode')?.value || 'auto');
    if (selected === 'native') return { strategy: 'native', selected, segmentCount: 1, reason: '已强制使用一次原生整首推理' };
    const duration = Number(params.duration) || Number($('#duration')?.value) || Number(model.defaults?.duration) || 120;
    if (selected === 'compat') return { strategy: 'segment', selected, segmentCount: AceSegment.segmentCountForDuration(duration), reason: '已强制使用固定分段工作流' };
    const smart = AceSegment.smartStrategy(params.lyrics ?? $('#lyrics')?.value ?? '', duration);
    return { ...smart, selected: 'auto' };
  }

  function smartPlaybookFor(model, params) {
    const decision = aceGenerationStrategy(model, params);
    return decision.strategy === 'segment' && /ace-step/i.test(String(model?.id || '')) ? 'ace-segment' : String(model?.playbook || '');
  }

  function renderAceSegmentPlan() {
    const panel = $('#ace-segment-plan');
    if (!panel || !AceSegment) return;
    const isAce = state.model?.playbook === 'ace-segment' || /ace-step/i.test(state.model?.id || '');
    panel.classList.toggle('hidden', !isAce);
    if (!isAce) return;
    const duration = Number($('#duration')?.value) || Number(state.model?.defaults?.duration) || 40;
    const lyrics = String($('#lyrics')?.value || '').trim();
    const decision = aceGenerationStrategy(state.model, { duration, lyrics, aceLongMode: $('#ace-long-mode')?.value || 'auto' });
    const nativeLongform = decision.strategy === 'native';
    if (nativeLongform) {
      const bodyLines = lyrics.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !/^\[[^\]]+]$/.test(line));
      const minimumLines = Math.max(8, Math.ceil(duration / 8));
      const sparse = lyrics && !/^\[Instrumental\]$/i.test(lyrics) && bodyLines.length < minimumLines;
      $('#ace-plan-kicker').textContent = decision.selected === 'auto' ? 'ACE SMART' : 'ACE NATIVE';
      $('#ace-segment-title').textContent = `${Math.round(duration)} 秒 · ${decision.selected === 'auto' ? '智能采用原生整首' : '原生整曲生成'}`;
      $('#ace-segment-detail').textContent = sparse
        ? `当前 ${bodyLines.length} 行歌词偏少，建议约 ${minimumLines} 行以上，避免长曲后段转为器乐或重复`
        : `${decision.selected === 'auto' ? `${decision.reason} · ` : ''}一次推理共享旋律、声线与编排上下文`;
      $('#ace-segment-count').textContent = '1 次';
      panel.classList.toggle('warn', sparse);
      return;
    }
    const planned = AceSegment.plan(lyrics, { duration });
    const segments = planned.segments || [];
    if (planned.invalidReason) {
      $('#ace-plan-kicker').textContent = 'ACE LYRICS';
      $('#ace-segment-title').textContent = `${Math.round(duration)} 秒 · 分段歌词不足`;
      $('#ace-segment-detail').textContent = planned.invalidReason;
      $('#ace-segment-count').textContent = '需补歌词';
      panel.classList.add('warn');
      return;
    }
    const durations = segments.map((segment) => Number(segment.duration) || 0);
    const overlapSeconds = Math.max(0, ...segments.map((segment) => Number(segment.overlapSeconds) || 0));
    const shortest = Math.min(...durations);
    const longest = Math.max(...durations);
    const parsed = AceSegment.parseSections(lyrics);
    const lyricLines = parsed.reduce((sum, section) => sum + section.body.length, 0);
    const isInstrumental = !lyrics || /^\[Instrumental\]$/i.test(lyrics);
    const recommendedLines = Math.max(3, segments.length * 3);
    const sparse = !isInstrumental && segments.length > 1 && lyricLines < recommendedLines;
    $('#ace-plan-kicker').textContent = decision.selected === 'auto' ? 'ACE SMART' : 'ACE FIXED';
    $('#ace-segment-title').textContent = `${planned.targetDuration || Math.round(duration)} 秒 · ${segments.length > 1 ? (decision.selected === 'auto' ? '智能分段生成' : '固定分段生成') : '单段生成'}`;
    $('#ace-segment-detail').textContent = sparse
      ? `当前 ${lyricLines} 行歌词偏少，建议至少 ${recommendedLines} 行，避免后段只剩器乐`
      : segments.length > 1
        ? `${decision.selected === 'auto' ? `${decision.reason} · ` : ''}${shortest === longest ? `每段 ${shortest} 秒` : `每段 ${shortest}–${longest} 秒`} · 后续段含 ${overlapSeconds} 秒承接区，合轨后保留目标时长`
        : '当前时长无需拆分，直接生成一个片段';
    $('#ace-segment-count').textContent = `${segments.length} 段`;
    panel.classList.toggle('warn', sparse);
  }

  function aceLyricRisk(params = {}) {
    const lyrics = String(params.lyrics || '').trim();
    if (!lyrics || /^\[Instrumental\]$/i.test(lyrics)) return '';
    const lines = lyrics.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const sections = lines.filter((line) => /^\[[^\]]+\]$/.test(line)).length;
    const body = lines.filter((line) => !/^\[[^\]]+\]$/.test(line));
    const longLines = body.filter((line) => line.replace(/\s/g, '').length > 12).length;
    if (longLines > 0) return '存在偏长的散文句，ACE-Step 更容易含糊或跳句；尽量每行 6–10 个音节';
    const strategy = aceGenerationStrategy(state.model, params);
    if (strategy.strategy === 'segment' && sections > 18) return `分段计划包含 ${sections} 个段落，建议精简重复结构以改善段间衔接`;
    if (strategy.strategy === 'native' && state.model?.playbook === 'ace-native' && Number(params.duration) > 240) return '强制原生生成超过 240 秒时，重复、跑调和结构漂移风险会升高；建议改用智能分段';
    return '';
  }

  function selectModel(id) {
    const previousModelId = state.model?.id;
    state.model = Models.byId(id);
    if (previousModelId !== state.model.id && state.model.id === 'minimax-music-3-mlx') state.minimaxSpeedMode = 'custom';
    localStorage.setItem(LS_MODEL, state.model.id);
    const has = (field) => state.model.fields.includes(field);
    const composer = $('.composer-scroll');
    if (composer) {
      composer.dataset.modelLayout = has('prompt') && has('tags') && has('lyrics')
        ? 'prompt-tags-lyrics'
        : has('tags') && has('lyrics') && !has('prompt') ? 'tags-lyrics' : 'default';
    }
    $('#field-tags').classList.toggle('hidden', !has('tags'));
    $('#field-prompt').classList.toggle('hidden', !has('prompt'));
    $('#field-neg').classList.toggle('hidden', !has('negativePrompt'));
    $('#field-lyrics').classList.toggle('hidden', !has('lyrics'));
    $('#slider-duration').classList.toggle('hidden', !has('duration'));
    $('#slider-steps').classList.toggle('hidden', !has('steps'));
    $('#slider-cfg').classList.toggle('hidden', !has('cfg'));
    $('#field-reference').classList.toggle('hidden', !has('referenceAudio'));
    $('#ace-native-profile')?.classList.toggle('hidden', state.model.playbook !== 'ace-native');
    if (state.model.playbook === 'ace-native') {
      if ($('#ace-bpm') && !$('#ace-bpm').value) $('#ace-bpm').value = String(state.model.defaults?.bpm || 96);
      if ($('#ace-keyscale') && !$('#ace-keyscale').value) $('#ace-keyscale').value = state.model.defaults?.keyscale || 'C major';
      if ($('#ace-timesignature') && !$('#ace-timesignature').value) $('#ace-timesignature').value = state.model.defaults?.timesignature || '4';
      if ($('#ace-language') && !$('#ace-language').value) $('#ace-language').value = state.model.defaults?.language || 'auto';
    }
    renderMiniMaxSpeedProfile();
    $('#model-hint').textContent = state.model.hint || '';
    renderStudioTip(state.model);
    const lyricsField = $('#lyrics');
    if (lyricsField && (state.model.playbook === 'ace-segment' || /ace-step/i.test(state.model.id))) {
      lyricsField.placeholder = '[Verse]\n夜色落在窗台\n风吹过旧街牌\n\n[Pre-Chorus]\n如果回忆还在\n别让梦醒太快';
      const tagsField = $('#tags');
      if (tagsField && !tagsField.value.trim()) tagsField.placeholder = '华语流行，女声，中慢速，人声靠前，歌词清晰，旋律简单';
    } else if (lyricsField) {
      lyricsField.placeholder = '[Verse]\n写下第一段歌词\n\n[Chorus]\n写下副歌';
    }
    const defaults = state.model.defaults || { duration: 24, steps: 28, cfg: 5 };
    const ranges = state.model.ranges || { duration: [8, 300, 1], steps: [1, 60, 1], cfg: [1, 9, .5] };
    setRange('duration', ranges.duration || [8, 300, 1], defaults.duration);
    setRange('steps', ranges.steps || [1, 60, 1], defaults.steps);
    setRange('cfg', ranges.cfg || [1, 9, .5], defaults.cfg);
    const referenceRange = ranges.referenceStrength || [0.4, 0.8, 0.05];
    setRange('reference-strength', referenceRange, defaults.referenceStrength ?? 0.7);
    renderReferenceOptions();
    buildPipeline(state.activeJob?.model || state.model);
    if (state.model.source === 'local') {
      state.localModelId = state.model.id;
      $$('.family-leaf').forEach((button) => button.classList.toggle('active', button.dataset.localModel === state.model.id));
    }
    if (state.model.source === 'remote') {
      state.remoteProviderId = state.model.remoteId;
      $$('.remote-provider-button').forEach((button) => button.classList.toggle('active', button.dataset.remoteProvider === state.model.remoteId));
    }
    updateRuntimeUI();
    renderSmartImpact();
    renderAceSegmentPlan();
  }

  function buildPipeline(model = state.model) {
    const pipeline = $('#pipeline');
    pipeline.innerHTML = '';
    (model?.stages || []).forEach((stage, index) => {
      const node = document.createElement('div');
      node.className = 'node';
      node.dataset.stage = stage.id;
      node.innerHTML = `<div class="node-dot">${String(index + 1).padStart(2, '0')}</div><div class="node-label">${escapeHtml(stage.label)}</div><div class="node-type">${escapeHtml(stage.node)}</div><div class="node-bar"><span></span></div>`;
      pipeline.appendChild(node);
    });
  }

  function resetPipeline() {
    $$('#pipeline .node').forEach((node) => {
      node.classList.remove('active', 'done');
      node.querySelector('.node-bar span').style.width = '0%';
    });
  }

  function onStage(stageId, progress) {
    const nodes = $$('#pipeline .node');
    const currentIndex = nodes.findIndex((node) => node.dataset.stage === stageId);
    nodes.forEach((node, index) => {
      node.classList.toggle('done', index < currentIndex || (index === currentIndex && progress >= 1));
      node.classList.toggle('active', index === currentIndex && progress < 1);
      node.querySelector('.node-bar span').style.width = index < currentIndex ? '100%' : index === currentIndex ? `${Math.round(progress * 100)}%` : '0%';
    });
  }

  function readParams() {
    const rawSeed = $('#seed').value.trim();
    const music3Profile = state.status?.local?.music3Profile || state.status?.music3?.profile || {};
    const has = (field) => state.model.fields.includes(field);
    return {
      title: $('#song-title').value.trim(),
      album: cleanFacet($('#creation-album')?.value, 'AI 作品'),
      tags: has('tags') ? $('#tags').value.trim() : '',
      prompt: has('prompt') ? $('#prompt').value.trim() : '',
      negativePrompt: has('negativePrompt') ? $('#neg').value.trim() : '',
      lyrics: has('lyrics') ? $('#lyrics').value.trim() : '',
      duration: Number($('#duration').value),
      steps: Number($('#steps').value),
      cfg: Number($('#cfg').value),
      referenceTrackId: state.model.fields.includes('referenceAudio') ? $('#reference-track').value : '',
      referenceStrength: Number($('#reference-strength').value),
      bpm: Number($('#ace-bpm')?.value || state.model.defaults?.bpm || 96),
      keyscale: $('#ace-keyscale')?.value || state.model.defaults?.keyscale || 'C major',
      timesignature: $('#ace-timesignature')?.value || state.model.defaults?.timesignature || '4',
      language: $('#ace-language')?.value || state.model.defaults?.language || 'auto',
      aceLongMode: $('#ace-long-mode')?.value || 'auto',
      seed: rawSeed ? (Number.parseInt(rawSeed, 10) >>> 0) : ((Math.random() * 4294967296) >>> 0),
      music3DiffusionModel: music3Profile.diffusionModel,
      music3TextEncoder: music3Profile.textEncoder,
      speedMode: state.model.id === 'minimax-music-3-mlx' ? state.minimaxSpeedMode : '',
    };
  }

  function validate(params, model = state.model) {
    const aceNative = model.playbook === 'ace-native';
    if (model.fields.includes('prompt') && !params.prompt && !(aceNative && params.tags)) return '请先写一段音乐描述';
    if (model.fields.includes('tags') && !params.tags && !(aceNative && params.prompt)) return '请先填写风格标签';
    if (aceNative && (!Number.isFinite(params.bpm) || params.bpm < 30 || params.bpm > 300)) return 'ACE-Step BPM 需要在 30–300 之间';
    if (model.id.startsWith('minimax-music-3') && !params.lyrics) return 'MiniMax Music 3 需要歌词；纯音乐可填写 [Instrumental]';
    if (model.fields.includes('lyrics') && params.lyrics && (/ace-step/i.test(model.id) || /minimax-music-3/i.test(model.id))) {
      const decision = /ace-step/i.test(model.id) ? aceGenerationStrategy(model, params) : null;
      const check = VocalGuard.preflight(params.lyrics, { duration: params.duration, segmented: decision?.strategy === 'segment' });
      if (check.error) return check.error;
    }
    const pack = state.status?.local?.packs?.find((item) => item.id === model.id);
    if (model.provider === 'local-comfy' && !pack?.installed) return `${model.label} 尚未安装，请到「模型」页部署`;
    if (model.provider === 'local-comfy' && !state.status?.local?.ready) return '共享本地引擎尚未启动，请到「模型」页启动';
    if (model.provider === 'local-cli' && !pack?.installed) return `${model.label} 尚未安装，请到「模型」页部署`;
    if (model.provider === 'remote') {
      const remote = state.status?.remote?.providers?.find((item) => item.id === model.remoteId);
      if (!remote?.configured) return `${remote?.label || '远端服务'} 尚未配置，请到「模型」页填写 API Key`;
    }
    return null;
  }

  function providerForModel(model) {
    if (model.provider === 'local-comfy') return makeLocalComfyProvider();
    if (model.provider === 'local-cli') return makeLocalCliProvider();
    if (model.provider === 'remote') return makeRemoteProvider();
    return DemoProvider;
  }

  function normalizeSongTitle(value) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  }

  function updateProjectTitle(value) {
    $('.project-chip').innerHTML = `<span></span> ${escapeHtml(normalizeSongTitle(value) || '未命名工程')}`;
  }

  function titleFrom(params, model = state.model) {
    const configured = normalizeSongTitle(params.title);
    if (configured) return configured;
    const source = params.prompt || params.tags || model?.label;
    const cleaned = source.replace(/###.*$/gm, '').split(/[，,。.;；\n]/).map((part) => part.trim()).filter(Boolean)[0] || '未命名曲目';
    return cleaned.slice(0, 30);
  }

  function draftTimeLabel(timestamp) {
    if (!Number(timestamp)) return '';
    return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(timestamp));
  }

  function setDraftStatus(text, mode = '') {
    const status = $('#draft-status');
    if (!status) return;
    status.textContent = text;
    status.classList.toggle('saving', mode === 'saving');
    status.classList.toggle('saved', mode === 'saved');
  }

  function creationDraftSnapshot() {
    const values = {};
    ['smart-idea', 'song-title', 'prompt', 'neg', 'tags', 'lyrics', 'duration', 'steps', 'cfg', 'seed', 'creation-album', 'reference-strength', 'ace-long-mode', 'ace-bpm', 'ace-keyscale', 'ace-timesignature', 'ace-language'].forEach((id) => {
      const element = $(`#${id}`);
      if (element) values[id] = element.value;
    });
    return {
      version: 1,
      savedAt: Date.now(),
      modelId: state.model?.id || $('#model')?.value || '',
      minimaxSpeedMode: state.minimaxSpeedMode,
      values,
    };
  }

  function persistCreationDraft() {
    if (!state.draftReady) return;
    clearTimeout(draftSaveTimer);
    draftSaveTimer = null;
    try {
      const draft = creationDraftSnapshot();
      localStorage.setItem(LS_CREATION_DRAFT, JSON.stringify(draft));
      setDraftStatus(`已保存 ${draftTimeLabel(draft.savedAt)}`, 'saved');
    } catch (error) {
      console.warn('创作单自动保存失败', error);
      setDraftStatus('自动保存失败');
    }
  }

  function scheduleCreationDraftSave() {
    if (!state.draftReady) return;
    setDraftStatus('保存中…', 'saving');
    clearTimeout(draftSaveTimer);
    draftSaveTimer = setTimeout(persistCreationDraft, DRAFT_SAVE_DELAY);
  }

  function restoreCreationDraft() {
    try {
      const draft = JSON.parse(localStorage.getItem(LS_CREATION_DRAFT) || 'null');
      if (!draft?.values || typeof draft.values !== 'object') return false;
      const model = Models.byId(draft.modelId || $('#model').value);
      if (model?.id && model.id !== state.model?.id) {
        $('#model').value = model.id;
        selectModel(model.id);
      }
      Object.entries(draft.values).forEach(([id, rawValue]) => {
        const element = $(`#${id}`);
        if (!element || rawValue === undefined || rawValue === null) return;
        if (['duration', 'steps', 'cfg', 'reference-strength'].includes(id)) {
          element.value = String(normalizedRangeValue(element, rawValue));
          updateRangeLabel(id);
        } else element.value = String(rawValue);
      });
      const aceMode = $('#ace-long-mode');
      if (model?.id === 'ace-step-1.5' && !localStorage.getItem(LS_ACE_STRATEGY_V2)) {
        if (aceMode?.value === 'native') aceMode.value = 'auto';
        localStorage.setItem(LS_ACE_STRATEGY_V2, '1');
      }
      state.minimaxSpeedMode = draft.minimaxSpeedMode || 'custom';
      updateProjectTitle($('#song-title').value);
      syncCreationAlbumTrigger();
      renderMiniMaxSpeedProfile();
      renderAceSegmentPlan();
      state.draftRestored = true;
      setDraftStatus(`已恢复 ${draftTimeLabel(draft.savedAt)}`, 'saved');
      return true;
    } catch (error) {
      console.warn('恢复创作单失败', error);
      localStorage.removeItem(LS_CREATION_DRAFT);
      return false;
    }
  }

  function resetCreationDraft() {
    const snapshot = creationDraftSnapshot();
    const hasContent = ['smart-idea', 'song-title', 'prompt', 'neg', 'tags', 'lyrics'].some((id) => String(snapshot.values[id] || '').trim());
    if (hasContent && !window.confirm('新建创作单会清空当前描述、歌词和参数设置。已生成的歌曲不会受到影响。')) return;
    clearTimeout(draftSaveTimer);
    ['smart-idea', 'song-title', 'prompt', 'neg', 'tags', 'lyrics', 'seed'].forEach((id) => { const element = $(`#${id}`); if (element) element.value = ''; });
    state.smartLockedFields.clear();
    state.smartChangedFields = [];
    persistSmartLocks();
    selectModel(state.model.id);
    updateProjectTitle('');
    renderSmartImpact();
    localStorage.removeItem(LS_CREATION_DRAFT);
    setDraftStatus('新创作单', 'saved');
    $('#smart-idea').focus();
    toast('已新建空白创作单；模型和收录专辑保持不变');
  }

  async function persistTrack(track) {
    const copy = { ...track };
    delete copy.url;
    await Store.put(copy);
  }

  async function persistTracks(tracks) {
    const copies = (tracks || []).map((track) => {
      const copy = { ...track };
      delete copy.url;
      return copy;
    });
    if (Store.putMany) await Store.putMany(copies);
    else await Promise.all(copies.map((track) => Store.put(track)));
  }

  function generationRecord(job, result, actualDuration, finishedAt) {
    const requested = {};
    Object.entries(job.params || {}).forEach(([key, value]) => {
      if (key === 'referenceBlob' || key === 'continuityReferenceBlob' || key === 'continuityReferenceFilename' || value === undefined || typeof value === 'function') return;
      if (value instanceof Blob) return;
      if (key.startsWith('music3') && !job.model.id.startsWith('minimax-music-3')) return;
      if ((key === 'referenceTrackId' || key === 'referenceTitle' || key === 'referenceStrength') && !job.model.fields.includes('referenceAudio')) return;
      requested[key] = value;
    });
    return {
      schemaVersion: 1,
      model: { id: job.model.id, label: job.model.label, source: job.model.source, provider: job.model.provider },
      provider: result.provider || job.model.provider,
      queuedAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt,
      elapsedMs: Math.max(0, finishedAt - (job.startedAt || finishedAt)),
      requested,
      output: {
        duration: actualDuration,
        mimeType: result.blob?.type || 'audio/wav',
        bytes: Number(result.blob?.size) || 0,
        metadata: result.meta || {},
      },
    };
  }

  function queueProgress(job) {
    if (job.status === 'completed') return 100;
    if (!job.stage) return 0;
    const stages = job.model?.stages || [];
    const index = stages.findIndex((stage) => stage.id === job.stage);
    return index < 0 ? 0 : Math.round(((index + (job.stageProgress || 0)) / Math.max(1, stages.length)) * 100);
  }

  function estimatedJobSeconds(job) {
    const requestedDuration = Math.max(1, Number(job?.params?.duration) || 30);
    const history = state.library
      .filter((track) => track.modelId === job?.model?.id && Number(track.generationElapsedMs) > 0 && Number(track.requestedDuration || track.duration) > 0)
      .slice(0, 8)
      .map((track) => Number(track.generationElapsedMs) / 1000 / Number(track.requestedDuration || track.duration))
      .filter((ratio) => Number.isFinite(ratio) && ratio > 0)
      .sort((a, b) => a - b);
    if (history.length) return requestedDuration * history[Math.floor(history.length / 2)];
    const id = String(job?.model?.id || '');
    const steps = Math.max(1, Number(job?.params?.steps) || 8);
    const cfg = Number(job?.params?.cfg) || 1;
    if (id === 'demo') return Math.max(3, requestedDuration / 5);
    if (id === 'minimax-music-3-mlx') return requestedDuration * (3.05 + steps * (cfg === 1 ? .22 : .43));
    if (id === 'minimax-music-3') return requestedDuration * (12 + steps * .8);
    if (id.includes('ace-step')) return requestedDuration * 3.5;
    if (id === 'stable-audio-3') return requestedDuration * 2.2;
    if (job?.model?.source === 'remote') return Math.max(45, requestedDuration * .8);
    return requestedDuration * 2.5;
  }

  function queueTiming(job) {
    const index = state.generationQueue.indexOf(job);
    if (index < 0) return '';
    if (job.status === 'running' || job.status === 'stopping') {
      const estimate = estimatedJobSeconds(job);
      const elapsed = Math.max(0, (Date.now() - Number(job.startedAt || Date.now())) / 1000);
      const remaining = estimate - elapsed;
      return remaining > 5 ? `粗略还需 ${compactEstimate(remaining)}` : elapsed > estimate * 1.15 ? '已超过粗略预计，仍在处理' : '接近完成';
    }
    if (job.status !== 'queued') return '';
    if (job.suiteId && state.generationQueue.some((item) => item.suiteId === job.suiteId && item.status === 'interrupted')) {
      return '等待中断分段重试';
    }
    const ahead = state.generationQueue.slice(0, index).filter((item) => ['queued', 'running', 'stopping'].includes(item.status));
    if (!ahead.length) return '即将开始';
    const waitSeconds = ahead.reduce((total, item) => {
      const estimate = estimatedJobSeconds(item);
      if (item.status !== 'running' || !item.startedAt) return total + estimate;
      return total + Math.max(5, estimate - (Date.now() - item.startedAt) / 1000);
    }, 0);
    return `前方 ${ahead.length} 首 · 约 ${compactEstimate(waitSeconds)} 后开始`;
  }

  function persistGenerationQueue() {
    if (!state.queueRestored || !QueuePersistence) return;
    clearTimeout(queueSaveTimer);
    queueSaveTimer = null;
    try { localStorage.setItem(LS_GENERATION_QUEUE, QueuePersistence.serialize(state.generationQueue)); }
    catch (error) {
      console.error('保存生成队列失败', error);
      if (!queuePersistenceWarningShown) {
        queuePersistenceWarningShown = true;
        toast('生成队列无法写入本机存储；请清理过多旧任务或磁盘空间', 6500);
      }
    }
  }

  function scheduleGenerationQueueSave() {
    if (!state.queueRestored || !QueuePersistence) return;
    clearTimeout(queueSaveTimer);
    queueSaveTimer = setTimeout(persistGenerationQueue, 600);
  }

  function restoreGenerationQueue() {
    const restored = QueuePersistence?.restore(localStorage.getItem(LS_GENERATION_QUEUE), (id) => Models.MODELS.find((model) => model.id === id)) || { jobs: [] };
    state.generationQueue = restored.jobs;
    state.queueRestored = true;
    persistGenerationQueue();
    renderGenerationQueue();
    return restored.jobs.length;
  }

  function nextQueuedJob() {
    return state.generationQueue.find((job) => job.status === 'queued'
      && (!job.suiteId || !state.generationQueue.some((item) => item.suiteId === job.suiteId && item.status === 'interrupted')));
  }

  function renderGenerationQueue() {
    scheduleGenerationQueueSave();
    const queue = $('#generation-queue');
    const pending = state.generationQueue.filter((job) => job.status === 'queued').length;
    const interrupted = state.generationQueue.filter((job) => job.status === 'interrupted').length;
    const active = state.activeJob && ['running', 'stopping'].includes(state.activeJob.status) ? 1 : 0;
    const preparing = state.continuousPreparing ? '1 PREPARING · ' : '';
    $('#queue-summary').textContent = `${preparing}${active ? '1 ACTIVE · ' : ''}${interrupted ? `${interrupted} INTERRUPTED · ` : ''}${pending} WAITING`;
    $('#queue-resume').disabled = state.queueResumeBusy || Boolean(active) || !nextQueuedJob();
    $('#queue-clear').disabled = !state.generationQueue.some((job) => ['completed', 'error', 'cancelled'].includes(job.status));
    $('#generate span').textContent = active || pending ? '继续加入队列' : '加入生成队列';
    const continuous = $('#continuous-toggle');
    continuous.classList.toggle('active', state.continuousEnabled);
    continuous.setAttribute('aria-pressed', String(state.continuousEnabled));
    continuous.querySelector('span').textContent = state.continuousEnabled ? '停止续创' : '持续生成';
    $('#continuous-state').textContent = state.continuousEnabled
      ? (state.continuousPreparing
        ? (state.continuousTemplate?.allLocked ? '∞ 锁定内容直出' : '∞ 智能迭代下一首')
        : `∞ ${state.continuousTemplate?.allLocked ? '锁定直出' : '智能联动'} · ${state.continuousSequence} 首`)
      : '';
    if (!state.generationQueue.length) {
      queue.innerHTML = state.continuousPreparing
        ? '<div class="queue-empty active">智能模型正在策划下一首创作单…</div>'
        : '<div class="queue-empty">队列为空</div>';
      return;
    }
    const labels = { queued: '等待中', running: '生成中', stopping: '停止中', interrupted: '已中断', completed: '已完成', error: '失败', cancelled: '已取消' };
    const visible = state.generationQueue.slice(-12).reverse();
    queue.innerHTML = visible.map((job) => {
      const order = state.generationQueue.indexOf(job) + 1;
      const current = Boolean(job.trackId && state.current?.id === job.trackId);
      const followed = Boolean(job.trackId && state.followQueue.includes(job.trackId));
      const suiteLast = Number(job.suiteIndex) === Number(job.suiteTotal) - 1;
      const assembled = !job.suiteId || Boolean(job.suiteAssembled && suiteLast);
      const playable = Boolean(job.trackId && state.library.some((track) => track.id === job.trackId && track.url));
      const suiteFailed = Boolean(job.suiteId && job.suiteAssemblyError && !job.suiteFinalized);
      const action = job.status === 'queued' ? '<button data-queue-action="cancel">取消</button>'
        : job.status === 'running' ? '<button data-queue-action="stop">停止</button>'
          : job.status === 'interrupted' ? '<div class="queue-job-actions"><button data-queue-action="retry">重试</button><button data-queue-action="cancel">取消</button></div>'
          : job.status === 'completed' && assembled && playable
            ? `<div class="queue-job-actions"><button data-queue-action="play">${current ? '播放中' : '播放'}</button><button data-queue-action="follow" ${current || followed ? 'disabled' : ''}>${current ? '当前' : followed ? '已跟随' : '跟随'}</button><button data-queue-action="remove" aria-label="移除">×</button></div>`
            : job.status === 'completed' && suiteFailed && suiteLast ? '<button data-queue-action="retry-suite">重试合轨</button>'
              : ['error', 'cancelled'].includes(job.status) ? '<button data-queue-action="remove">移除</button>' : '';
      const elapsed = job.startedAt ? formatElapsed((job.finishedAt || Date.now()) - job.startedAt) : '';
      const audioLength = formatTime(job.actualDuration || job.params.duration);
      const timing = queueTiming(job);
      const detail = job.status === 'error' ? job.error : `${job.suiteAssembled && suiteLast ? `整首 · ${job.suiteTotal} 段合轨 · ` : job.suiteId ? `分段 ${Number(job.suiteIndex) + 1}/${job.suiteTotal} · ` : ''}${job.continuous ? '持续创作 · ' : ''}${job.model.label} · 专辑 ${job.params.album || 'AI 作品'} · 音频 ${audioLength}${elapsed ? ` · ${job.finishedAt ? '耗时' : '已用'} ${elapsed}` : ''}${timing ? ` · ${timing}` : ''}${job.qualityWarning ? ` · 需试听：${job.qualityWarning}` : ''}${suiteFailed ? ` · 合轨失败：${job.suiteAssemblyError}` : ''} · SEED ${job.params.seed}`;
      return `<article class="queue-job ${job.status}" data-job-id="${escapeHtml(job.id)}">
        <div class="queue-order">${String(order).padStart(2, '0')}</div>
        <div class="queue-copy"><strong>${escapeHtml(job.suiteAssembled && suiteLast ? job.suiteTitle || job.title : job.title)}</strong><span>${escapeHtml(detail)}</span><div><i style="width:${queueProgress(job)}%"></i></div></div>
        <div class="queue-state"><span>${suiteFailed ? '合轨失败' : job.suiteAssembling ? '合轨中' : job.suiteAssembled ? suiteLast ? '整首已完成' : '已并入整首' : job.status === 'completed' && job.suiteId && !job.suiteFinalized ? '待合轨' : labels[job.status] || job.status}</span>${action}</div>
      </article>`;
    }).join('');
  }

  function updateJobStage(job, stageId, progress) {
    job.stage = stageId;
    job.stageProgress = progress;
    if (state.activeJob?.id === job.id) onStage(stageId, progress);
    renderGenerationQueue();
  }

  function enqueueGenerationJob(model, sourceParams, options = {}) {
    if (state.generationQueue.filter((job) => ['queued', 'running', 'stopping'].includes(job.status)).length >= 20) {
      toast('队列最多保留 20 个待处理任务');
      return null;
    }
    const params = { ...sourceParams };
    delete params.referenceBlob;
    if (params.referenceTrackId) {
      const referenceTrack = state.library.find((track) => track.id === params.referenceTrackId);
      if (!referenceTrack?.blob) { toast('参考音乐不可用，请重新从曲库选择'); return null; }
      params.referenceBlob = referenceTrack.blob;
      params.referenceTitle = referenceTrack.title;
    }
    const title = normalizeSongTitle(options.title) || titleFrom(params, model);
    params.title = title;
    const job = {
      id: `job-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      model, params, title, status: 'queued', createdAt: Date.now(),
      stage: null, stageProgress: 0, error: '', stopRequested: false, continuous: Boolean(options.continuous),
      suiteId: options.suiteId || '',
      suiteIndex: Number.isFinite(options.suiteIndex) ? options.suiteIndex : null,
      suiteTotal: Number.isFinite(options.suiteTotal) ? options.suiteTotal : null,
      suiteTitle: options.suiteTitle || '',
      suiteFullLyrics: options.suiteFullLyrics || '',
      suiteSegmentLabel: options.suiteSegmentLabel || '',
      suiteContentDuration: Number.isFinite(options.suiteContentDuration) ? options.suiteContentDuration : null,
      suiteOverlapSeconds: Number.isFinite(options.suiteOverlapSeconds) ? options.suiteOverlapSeconds : null,
      suiteTargetDuration: Number.isFinite(options.suiteTargetDuration) ? options.suiteTargetDuration : null,
    };
    state.generationQueue.push(job);
    while (state.generationQueue.length > 60) {
      const removable = state.generationQueue.findIndex((item) => ['completed', 'error', 'cancelled'].includes(item.status) && (!item.suiteId || item.suiteFinalized));
      if (removable < 0) break;
      state.generationQueue.splice(removable, 1);
    }
    persistGenerationQueue();
    return job;
  }

  function enqueueGenerationPlan(model, params, options = {}) {
    const decision = aceGenerationStrategy(model, params);
    const shouldSegment = Boolean(AceSegment) && (decision.strategy === 'segment' || AceSegment.shouldAutomate(model, params.lyrics, params.duration));
    const planned = shouldSegment ? AceSegment.plan(params.lyrics, { duration: params.duration }) : null;
    if (planned?.invalidReason) { toast(planned.invalidReason, 6500); return null; }
    if (!planned?.auto || planned.segments.length <= 1) {
      const job = enqueueGenerationJob(model, params, options);
      return job ? { jobs: [job], plan: null, suiteId: '' } : null;
    }
    const activeCount = state.generationQueue.filter((job) => ['queued', 'running', 'stopping'].includes(job.status)).length;
    if (activeCount + planned.segments.length > 20) {
      toast(`自动分段需要 ${planned.segments.length} 个队列位，请先清理队列`);
      return null;
    }
    const suiteId = `suite-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const suiteTitle = normalizeSongTitle(options.title || params.title) || titleFrom(params, model);
    const jobs = [];
    for (const [index, segment] of planned.segments.entries()) {
      const segmentParams = {
        ...params,
        lyrics: segment.generationLyrics || segment.lyrics,
        duration: segment.generationDuration || segment.duration,
        seed: Number(params.seed) >>> 0,
        continuitySuiteId: suiteId,
        continuityIndex: index,
        title: `${suiteTitle} · ${segment.label}`,
      };
      const job = enqueueGenerationJob(model, segmentParams, {
        ...options,
        title: segmentParams.title,
        suiteId,
        suiteIndex: index,
        suiteTotal: planned.segments.length,
        suiteTitle,
        suiteFullLyrics: params.lyrics,
        suiteSegmentLabel: segment.label,
        suiteContentDuration: Number(segment.contentDuration || segment.duration),
        suiteOverlapSeconds: Number(segment.overlapSeconds || 0),
        suiteTargetDuration: Number(planned.targetDuration || params.duration),
      });
      if (!job) {
        const createdIds = new Set(jobs.map((item) => item.id));
        state.generationQueue = state.generationQueue.filter((item) => !createdIds.has(item.id));
        persistGenerationQueue();
        return null;
      }
      jobs.push(job);
    }
    return { jobs, plan: planned, suiteId };
  }

  async function maybeAssembleAceSuite(job) {
    if (!job?.suiteId || !AceSegment) return null;
    const members = state.generationQueue.filter((item) => item.suiteId === job.suiteId);
    if (!members.length || members.some((item) => !['completed', 'error', 'cancelled'].includes(item.status))) return null;
    if (members.some((item) => item.suiteFinalized || item.suiteAssembling)) return null;
    if (members.some((item) => item.status !== 'completed' || !item.trackId)) {
      const completedParts = members
        .map((item) => state.suiteParts.get(item.trackId))
        .filter(Boolean);
      completedParts.forEach((track) => {
        track.category = 'ACE 未完成分段';
        track.suitePart = false;
        if (!state.library.some((item) => item.id === track.id)) state.library.unshift(track);
      });
      if (completedParts.length) await persistTracks(completedParts);
      members.forEach((item) => {
        item.suiteFinalized = true;
        if (item.trackId) state.suiteParts.delete(item.trackId);
      });
      persistGenerationQueue();
      renderLibrary();
      toast(completedParts.length
        ? `整首未完成，已把成功的 ${completedParts.length} 个分段保留到曲库：${job.suiteTitle || job.title}`
        : `整首分段任务未完成：${job.suiteTitle || job.title}`);
      return null;
    }
    const ordered = [...members].sort((a, b) => Number(a.suiteIndex) - Number(b.suiteIndex));
    const tracks = ordered.map((item) => state.suiteParts.get(item.trackId)).filter((track) => track?.blob);
    members.forEach((item) => {
      item.suiteAssembling = true;
      item.suiteAssemblyError = '';
    });
    renderGenerationQueue();
    try {
      if (tracks.length !== ordered.length) throw new Error(`只找到 ${tracks.length}/${ordered.length} 段可用音频`);
      toast(`正在合成整首：${job.suiteTitle || job.title}（${tracks.length} 段）`);
      const first = tracks[0];
      const legacyCrossfadeSeconds = AceSegment.crossfadeSecondsForMusic(first.bpm || ordered[0]?.params?.bpm, ordered[0]?.params?.timesignature);
      const crossfadeSeconds = ordered.map((item, index) => index === 0 ? 0 : (
        Number.isFinite(Number(item.suiteOverlapSeconds)) && item.suiteOverlapSeconds !== null
          ? Number(item.suiteOverlapSeconds)
          : legacyCrossfadeSeconds
      ));
      const blob = await AceSegment.concatBlobs(tracks.map((track) => track.blob), Engine.encodeWav, { crossfadeSeconds });
      const duration = await readAudioDuration(blob);
      const finishedAt = Date.now();
      const requestedDuration = Number(ordered[0]?.suiteTargetDuration) || ordered.reduce((sum, item) => (
        sum + Number(item.suiteContentDuration ?? item.params.duration ?? 0)
      ), 0);
      const assembled = {
        id: `track-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        title: job.suiteTitle || first.title,
        modelId: first.modelId,
        modelLabel: first.modelLabel,
        provider: first.provider,
        tags: first.tags,
        prompt: first.prompt,
        negativePrompt: first.negativePrompt,
        lyrics: job.suiteFullLyrics || tracks.map((track) => track.lyrics).filter(Boolean).join('\n\n'),
        duration,
        requestedDuration,
        steps: first.steps,
        cfg: first.cfg,
        seed: first.seed,
        album: first.album,
        category: 'ACE 整首合成',
        presetLabel: first.presetLabel,
        createdAt: finishedAt,
        generationElapsedMs: ordered.reduce((sum, item) => sum + Number(item.finishedAt && item.startedAt ? item.finishedAt - item.startedAt : 0), 0),
        generation: {
          ...first.generation,
          requested: {
            ...(first.generation?.requested || {}),
            title: job.suiteTitle || first.title,
            lyrics: job.suiteFullLyrics || tracks.map((track) => track.lyrics).filter(Boolean).join('\n\n'),
            duration: requestedDuration,
            segmentDurations: ordered.map((item) => Number(item.suiteContentDuration ?? item.params.duration ?? 0)),
            segmentGenerationDurations: ordered.map((item) => Number(item.params.duration || 0)),
            segmentOverlapSeconds: crossfadeSeconds,
            segmentSeeds: ordered.map((item) => Number(item.params.seed || 0)),
          },
          output: {
            duration,
            mimeType: blob.type,
            bytes: blob.size,
            metadata: { suiteId: job.suiteId, segmentCount: tracks.length, assembly: `${crossfadeSeconds.slice(1).map((seconds) => `${seconds.toFixed(2)}s`).join(' / ')} equal-power overlap handles`, continuity: 'shared seed + matched previous-tail cover handle', qualityWarnings: tracks.flatMap((track) => track.quality?.warnings || []), qualityNotes: tracks.flatMap((track) => track.quality?.notes || []) },
          },
        },
        quality: { warnings: tracks.flatMap((track) => track.quality?.warnings || []), notes: tracks.flatMap((track) => track.quality?.notes || []) },
        suiteId: job.suiteId,
        suiteAssembled: true,
        blob,
        url: URL.createObjectURL(blob),
      };
      ensureTrackCoverIdentity(assembled);
      await persistTrack(assembled);
      state.library = state.library.filter((item) => !tracks.some((part) => part.id === item.id));
      state.library.unshift(assembled);
      try {
        await Store.removeMany(tracks.map((track) => track.id));
      } catch (cleanupError) {
        console.warn('整首已保存，清理分段缓存失败；下次启动会再次清理', cleanupError);
      }
      members.forEach((item) => {
        item.suiteAssembled = true;
        item.suiteFinalized = true;
        if (item.trackId) state.suiteParts.delete(item.trackId);
        item.trackId = assembled.id;
        if (Number(item.suiteIndex) === Number(item.suiteTotal) - 1) item.actualDuration = duration;
      });
      if (assembled.quality.warnings.length) ordered.at(-1).qualityWarning = [...new Set(assembled.quality.warnings)].join('；');
      tracks.forEach((track) => { if (track.url) URL.revokeObjectURL(track.url); });
      const completionAction = applyCompletionPolicy(assembled);
      showCompletionNotice(assembled, completionAction);
      renderLibrary();
      renderGenerationQueue();
      toast(`整首已自动合成：${assembled.title} · ${tracks.length} 段已拼接${assembled.quality.warnings.length ? ` · 需试听：${ordered.at(-1).qualityWarning}` : ''}`, assembled.quality.warnings.length ? 7200 : 3200);
      return assembled;
    } catch (error) {
      console.error(error);
      const message = error.message || String(error);
      members.forEach((item) => { item.suiteAssemblyError = message; });
      tracks.forEach((track) => {
        track.category = 'ACE 合轨待重试';
        if (!state.library.some((item) => item.id === track.id)) state.library.unshift(track);
      });
      try { if (tracks.length) await persistTracks(tracks); }
      catch (persistError) { console.error('保存可恢复的 ACE 分段失败', persistError); }
      renderLibrary();
      renderGenerationQueue();
      toast(`合轨失败：${message}。分段已保留在曲库，可点“重试合轨”`, 7200);
      return null;
    } finally {
      members.forEach((item) => { item.suiteAssembling = false; });
      persistGenerationQueue();
      renderGenerationQueue();
    }
  }

  function generate() {
    const params = readParams();
    const model = state.model;
    const error = validate(params, model);
    if (error) { toast(error); return; }
    const configuredTitle = normalizeSongTitle(params.title);
    $('#creation-album').value = params.album;
    localStorage.setItem(LS_CREATION_ALBUM, params.album);
    $('#song-title').value = configuredTitle;
    updateProjectTitle(configuredTitle || titleFrom(params, model));
    $('#seed').value = String(params.seed);

    const submission = enqueueGenerationPlan(model, params, { title: configuredTitle });
    if (!submission) return;
    renderGenerationQueue();
    if (submission.plan?.auto) {
      const durations = submission.plan.segments.map((segment) => Number(segment.duration) || 0);
      const shortest = Math.min(...durations);
      const longest = Math.max(...durations);
      const perSegment = shortest === longest ? `${shortest} 秒/段` : `${shortest}–${longest} 秒/段`;
      const overlapSeconds = Math.max(0, ...submission.plan.segments.map((segment) => Number(segment.overlapSeconds) || 0));
      toast(`ACE 已按 ${params.duration} 秒目标拆成 ${submission.jobs.length} 段（${perSegment}），后续段会多生成 ${overlapSeconds} 秒承接区并在合轨时消化`, 6800);
      processGenerationQueue();
      return;
    }
    const position = state.generationQueue.filter((item) => item.status === 'queued').length;
    if (model.id.startsWith('minimax-music-3') && params.duration > 60) {
      toast(`已提交 ${params.duration} 秒长曲；MiniMax 的自回归阶段耗时会随时长明显增加`, 5200);
    } else if (model.id === 'stable-audio-3' && params.duration > 120) {
      toast(`已提交 ${params.duration} 秒配乐；Stable Audio 3 超过 120 秒时结构一致性可能下降`, 5200);
    } else if (/ace-step/i.test(model.id)) {
      const risk = aceLyricRisk(params);
      if (risk) toast(risk, 6200);
      else toast(position > 1 ? `已加入队列，前面还有 ${position - 1} 个任务` : '已提交，正在后台生成');
    } else toast(position > 1 ? `已加入队列，前面还有 ${position - 1} 个任务` : '已提交，正在后台生成');
    processGenerationQueue();
  }

  function generationParamsFromSmartDraft(base, draft, model, lockedFields = new Set()) {
    const params = { ...base };
    const has = (field) => model.fields.includes(field);
    if (!lockedFields.has('title')) params.title = String(draft.title ?? '');
    if (has('prompt') && !lockedFields.has('description')) params.prompt = String(draft.description ?? '');
    if (has('negativePrompt') && !lockedFields.has('negativePrompt')) params.negativePrompt = String(draft.negativePrompt ?? '');
    if (has('tags') && !lockedFields.has('tags')) params.tags = Array.isArray(draft.tags) ? draft.tags.join('，') : String(draft.tags ?? '');
    if (has('lyrics') && !lockedFields.has('lyrics')) params.lyrics = String(draft.lyrics ?? '');
    if (has('duration') && !lockedFields.has('duration')) params.duration = Number(draft.duration);
    if (has('steps') && !lockedFields.has('steps')) params.steps = Number(draft.steps);
    if (has('cfg') && !lockedFields.has('cfg')) params.cfg = Number(draft.cfg);
    if (has('bpm') && !lockedFields.has('bpm')) params.bpm = Number(draft.bpm);
    if (has('keyscale') && !lockedFields.has('keyscale')) params.keyscale = String(draft.keyscale ?? '');
    if (has('timesignature') && !lockedFields.has('timesignature')) params.timesignature = String(draft.timesignature ?? '');
    if (has('language') && !lockedFields.has('language')) params.language = String(draft.language ?? '');
    return params;
  }

  function continuousDraftIdentity(params, model, lockedFields = new Set()) {
    const has = (field) => model.fields.includes(field);
    const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const creative = [];
    if (has('prompt') && !lockedFields.has('description')) creative.push(['description', clean(params.prompt)]);
    if (has('negativePrompt') && !lockedFields.has('negativePrompt')) creative.push(['negativePrompt', clean(params.negativePrompt)]);
    if (has('tags') && !lockedFields.has('tags')) creative.push(['tags', clean(params.tags)]);
    if (has('lyrics') && !lockedFields.has('lyrics')) creative.push(['lyrics', clean(params.lyrics)]);
    if (has('duration') && !lockedFields.has('duration')) creative.push(['duration', Number(params.duration)]);
    if (has('steps') && !lockedFields.has('steps')) creative.push(['steps', Number(params.steps)]);
    if (has('cfg') && !lockedFields.has('cfg')) creative.push(['cfg', Number(params.cfg)]);
    if (has('bpm') && !lockedFields.has('bpm')) creative.push(['bpm', Number(params.bpm)]);
    if (has('keyscale') && !lockedFields.has('keyscale')) creative.push(['keyscale', clean(params.keyscale)]);
    if (has('timesignature') && !lockedFields.has('timesignature')) creative.push(['timesignature', clean(params.timesignature)]);
    if (has('language') && !lockedFields.has('language')) creative.push(['language', clean(params.language)]);
    return {
      title: lockedFields.has('title') ? '' : clean(params.title),
      creative: creative.length ? JSON.stringify(creative) : '',
    };
  }

  function continuousDraftSummary(params, model) {
    return JSON.stringify({
      title: normalizeSongTitle(params.title),
      description: model.fields.includes('prompt') ? String(params.prompt || '').slice(0, 700) : '',
      negativePrompt: model.fields.includes('negativePrompt') ? String(params.negativePrompt || '').slice(0, 300) : '',
      tags: model.fields.includes('tags') ? String(params.tags || '').slice(0, 300) : '',
      lyrics: model.fields.includes('lyrics') ? String(params.lyrics || '').slice(0, 1000) : '',
      duration: Number(params.duration), steps: Number(params.steps), cfg: Number(params.cfg),
      bpm: Number(params.bpm), keyscale: params.keyscale || '', timesignature: params.timesignature || '', language: params.language || '',
    });
  }

  function isDuplicateContinuousDraft(identity, history) {
    return history.some((item) => (identity.title && item.title === identity.title)
      || (identity.creative && item.creative === identity.creative));
  }

  async function prepareContinuousJob() {
    if (!state.continuousEnabled || state.continuousPreparing || !state.continuousTemplate) return null;
    state.continuousPreparing = true;
    renderGenerationQueue();
    const template = state.continuousTemplate;
    const sequence = state.continuousSequence + 1;
    const lockedFields = new Set(template.lockedFields || []);
    let params = {
      ...template.params,
      title: lockedFields.has('title') ? template.params.title : '',
      seed: ((Math.random() * 4294967296) >>> 0),
    };
    try {
      if (!template.allLocked) {
        let unique = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
          const result = await Sidecar.completeSmart({
            idea: `${template.idea}。这是持续创作的第 ${sequence} 首、第 ${attempt} 次差异化尝试：保留被锁定内容和核心审美，但所有未锁定素材都要形成明确的新变化，禁止只改写同义词。`,
            model: { id: template.model.id, label: template.model.label, fields: template.model.fields, playbook: smartPlaybookFor(template.model, template.params) },
            existing: smartExistingFromParams(template.params, template.model, true),
            lockedFields: [...lockedFields],
            avoidDrafts: state.continuousHistory.slice(-10).map((item) => item.summary),
            requireUnique: true,
            iteration: sequence,
            ranges: template.ranges,
          });
          if (!state.continuousEnabled) return null;
          const candidate = generationParamsFromSmartDraft(params, result.draft, template.model, lockedFields);
          const identity = continuousDraftIdentity(candidate, template.model, lockedFields);
          if (!isDuplicateContinuousDraft(identity, state.continuousHistory)) {
            params = candidate;
            state.continuousHistory.push({ ...identity, summary: continuousDraftSummary(candidate, template.model) });
            unique = true;
            break;
          }
        }
        if (!unique) throw new Error('智能模型连续 3 次返回重复创作单，已停止以避免生成重复音乐');
      }
      if (!state.continuousEnabled) return null;
      if (!normalizeSongTitle(params.title)) params.title = `${template.baseTitle} · ${String(sequence).padStart(2, '0')}`;
      const validationError = validate(params, template.model);
      if (validationError) throw new Error(validationError);
      const submission = enqueueGenerationPlan(template.model, params, { continuous: true, title: params.title });
      const job = submission?.jobs?.[0] || null;
      if (job) {
        state.continuousSequence = sequence;
        if (submission.plan?.auto) toast(`持续创作第 ${sequence} 首已拆成 ${submission.jobs.length} 段，完成后自动合轨`, 4800);
      }
      return job;
    } catch (error) {
      if (state.continuousEnabled) {
        stopContinuousGeneration();
        toast(`持续生成已停止：${error.message || error}`, 6200);
      }
      return null;
    } finally {
      state.continuousPreparing = false;
      renderGenerationQueue();
    }
  }

  function startContinuousGeneration() {
    const params = readParams();
    const model = state.model;
    const error = validate(params, model);
    if (error) { toast(error); return; }
    const lockedFields = activeSmartLocks(model);
    const allLocked = smartFieldIds(model).every((id) => lockedFields.has(id));
    if (!allLocked && !state.status?.smart?.configured) {
      toast('持续生成需要智能模型逐轮创建不重复素材；请先配置智能模型 API，或锁定全部内容后直接生成', 6200);
      openSmartSettings();
      return;
    }
    const ranges = { duration: smartRange('duration'), steps: smartRange('steps'), cfg: smartRange('cfg'), bpm: [30, 300, 1] };
    state.continuousEnabled = true;
    state.continuousSequence = 0;
    state.continuousFailures = 0;
    const baseIdentity = continuousDraftIdentity(params, model, lockedFields);
    state.continuousHistory = [{ ...baseIdentity, summary: continuousDraftSummary(params, model) }];
    state.continuousTemplate = {
      model,
      params: { ...params },
      ranges,
      lockedFields: [...lockedFields],
      allLocked,
      baseTitle: titleFrom(params, model),
      idea: $('#smart-idea').value.trim() || '沿用当前创作单的主题与声音审美，持续创作彼此不同但属于同一播放氛围的新作品',
    };
    renderGenerationQueue();
    toast(allLocked ? '持续生成已开启：全部内容已锁定，每首只更换随机种子后直接生成' : '持续生成已开启：每轮先生成不重复智能创作单，再顺序生成音乐', 5600);
    processGenerationQueue();
  }

  function stopContinuousGeneration(showToast = false) {
    if (!state.continuousEnabled && !state.continuousPreparing) return;
    state.continuousEnabled = false;
    state.continuousPreparing = false;
    state.continuousTemplate = null;
    state.continuousHistory = [];
    state.generationQueue.forEach((job) => {
      if (job.continuous && job.status === 'queued') job.status = 'cancelled';
    });
    renderGenerationQueue();
    if (showToast) toast('持续生成已停止；当前正在生成的歌曲会正常完成');
  }

  function toggleContinuousGeneration() {
    if (state.continuousEnabled) stopContinuousGeneration(true);
    else startContinuousGeneration();
  }

  async function resumeSavedQueue() {
    if (state.queueResumeBusy || state.queueProcessing || !nextQueuedJob()) return;
    state.queueResumeBusy = true;
    renderGenerationQueue();
    try {
      const first = nextQueuedJob();
      if (first?.model?.provider === 'local-comfy' && !state.status?.local?.ready) {
        toast('正在启动共享本地引擎，队列会在引擎就绪后继续', 5200);
        await Sidecar.startLocal();
        let ready = false;
        for (let attempt = 0; attempt < 90; attempt++) {
          await refreshStatus();
          if (state.status?.local?.ready) { ready = true; break; }
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        if (!ready) throw new Error('本地引擎尚未就绪，请到「模型」页查看启动日志');
      }
      toast('已继续处理恢复的生成队列');
      processGenerationQueue();
    } catch (error) {
      toast(`继续队列失败：${error.message || error}`, 6200);
    } finally {
      state.queueResumeBusy = false;
      renderGenerationQueue();
    }
  }

  async function processGenerationQueue() {
    if (state.queueProcessing) return;
    state.queueProcessing = true;
    while (true) {
      let job = nextQueuedJob();
      if (!job && state.continuousEnabled) job = await prepareContinuousJob();
      if (!job) break;
      if (job.model?.provider === 'local-comfy' && !state.status?.local?.ready) break;
      if (job.params?.referenceTrackId && !job.params.referenceBlob) {
        const referenceTrack = state.library.find((track) => track.id === job.params.referenceTrackId && track.blob);
        if (!referenceTrack) {
          job.status = 'error';
          job.error = '排队时选择的参考音乐已不可用；请重新选择参考音乐再提交';
          persistGenerationQueue();
          renderGenerationQueue();
          continue;
        }
        job.params.referenceBlob = referenceTrack.blob;
        job.params.referenceTitle = referenceTrack.title;
      }
      if (job.suiteId && Number(job.suiteIndex) > 0 && !job.params.continuityReferenceBlob) {
        const previousJob = state.generationQueue.find((item) => item.suiteId === job.suiteId && Number(item.suiteIndex) === Number(job.suiteIndex) - 1);
        const previousTrack = previousJob?.trackId ? state.suiteParts.get(previousJob.trackId) : null;
        if (!previousTrack?.blob) {
          job.status = 'error';
          job.error = '上一分段音频不可用，无法建立连续性参考；已停止后续分段以避免割裂';
          state.generationQueue.forEach((item) => {
            if (item.suiteId === job.suiteId && item.status === 'queued' && Number(item.suiteIndex) > Number(job.suiteIndex)) item.status = 'cancelled';
          });
          persistGenerationQueue();
          renderGenerationQueue();
          await maybeAssembleAceSuite(job);
          continue;
        }
        try {
          const referenceSeconds = Number(job.suiteOverlapSeconds) > 0 ? Number(job.suiteOverlapSeconds) : 10;
          job.params.continuityReferenceBlob = await AudioQuality.extractTailBlob(previousTrack.blob, referenceSeconds, Engine.encodeWav);
          if (!job.params.continuityReferenceBlob) throw new Error('无法解码上一分段');
        } catch (continuityError) {
          job.status = 'error';
          job.error = `连续性参考准备失败：${continuityError.message || continuityError}`;
          state.generationQueue.forEach((item) => {
            if (item.suiteId === job.suiteId && item.status === 'queued' && Number(item.suiteIndex) > Number(job.suiteIndex)) item.status = 'cancelled';
          });
          persistGenerationQueue();
          renderGenerationQueue();
          await maybeAssembleAceSuite(job);
          continue;
        }
      }
      state.activeJob = job;
      state.generating = true;
      state.stopRequested = false;
      state.activeProvider = providerForModel(job.model);
      state.generationController = new AbortController();
      job.status = 'running';
      job.startedAt = Date.now();
      persistGenerationQueue();
      buildPipeline(job.model);
      resetPipeline();
      $('#stop-generation').disabled = typeof state.activeProvider.cancel !== 'function';
      $('#stop-generation').classList.remove('stopping');
      $('#stop-generation span').textContent = '停止';
      renderGenerationQueue();
      try {
        const result = await state.activeProvider.generate(job.model, job.params, (stage, progress) => updateJobStage(job, stage, progress), { signal: state.generationController.signal });
        let quality = null;
        const vocalInput = VocalGuard.analyzeLyrics(job.params.lyrics).vocalLines > 0;
        if (result.blob && vocalInput && /ace-step|minimax-music-3/i.test(job.model.id)) {
          try {
            const processed = await AudioQuality.processVocalBlob(result.blob, Engine.encodeWav);
            quality = processed.quality;
            if (processed.blob !== result.blob) {
              const previousUrl = result.url;
              result.blob = processed.blob;
              result.url = URL.createObjectURL(result.blob);
              if (String(previousUrl || '').startsWith('blob:')) URL.revokeObjectURL(previousUrl);
              job.trimmedTailSeconds = quality.trimmedTailSeconds;
            }
          }
          catch (qualityError) { console.warn('音频质量检查未完成，不影响原始音频保存', qualityError); }
        }
        const measuredDuration = result.blob ? await readAudioDuration(result.blob) : 0;
        const actualDuration = Number(measuredDuration || result.meta?.duration || job.params.duration);
        const finishedAt = Date.now();
        job.actualDuration = actualDuration;
        job.finishedAt = finishedAt;
        const preset = Engine.presetForTags(job.params.tags || job.params.prompt);
        const track = {
          id: `track-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          title: job.title, modelId: job.model.id, modelLabel: job.model.label, provider: result.provider,
          tags: job.params.tags, prompt: job.params.prompt, negativePrompt: job.params.negativePrompt, lyrics: job.params.lyrics,
          duration: actualDuration, requestedDuration: job.params.duration, steps: job.params.steps, cfg: job.params.cfg, seed: job.params.seed,
          referenceTitle: job.params.referenceTitle || '', album: await ensureAlbum(job.params.album || 'AI 作品'), category: String(job.params.tags || job.params.prompt || 'AI 生成').split(/[,，\n]/)[0].trim().slice(0, 40) || 'AI 生成',
          presetLabel: result.meta?.presetLabel || preset.label, createdAt: finishedAt, generationElapsedMs: finishedAt - job.startedAt,
          generation: generationRecord(job, result, actualDuration, finishedAt), blob: result.blob, url: result.url,
        };
        if (quality) {
          track.quality = quality;
          track.generation.output.quality = quality;
          if (quality.warnings.length) job.qualityWarning = quality.warnings.join('；');
        }
        ensureTrackCoverIdentity(track);
        track.suiteId = job.suiteId || '';
        track.suiteIndex = job.suiteIndex;
        track.suitePart = Boolean(job.suiteId);
        track.suiteTotal = job.suiteTotal;
        track.suiteTitle = job.suiteTitle;
        track.suiteFullLyrics = job.suiteFullLyrics;
        track.suiteSegmentLabel = job.suiteSegmentLabel;
        track.suiteContentDuration = job.suiteContentDuration;
        track.suiteOverlapSeconds = job.suiteOverlapSeconds;
        track.suiteTargetDuration = job.suiteTargetDuration;
        if (job.suiteId) {
          state.suiteParts.set(track.id, track);
          await persistTrack(track);
        }
        else {
          state.library.unshift(track);
          await persistTrack(track);
        }
        job.trackId = track.id;
        job.status = 'completed';
        job.stageProgress = 1;
        state.continuousFailures = 0;
        const completionAction = job.suiteId ? 'none' : applyCompletionPolicy(track);
        if (!job.suiteId) showCompletionNotice(track, completionAction);
        if (!job.suiteId) renderLibrary();
        const playbackMessage = completionAction === 'play' ? '正在立即播放'
          : completionAction === 'follow' ? '已加入跟随播放' : '播放状态未改变';
        if (job.suiteId) {
          toast(`分段完成 ${Number(job.suiteIndex) + 1}/${job.suiteTotal}：${job.suiteSegmentLabel || job.title}${job.trimmedTailSeconds ? ` · 已裁剪 ${job.trimmedTailSeconds.toFixed(1)} 秒静音尾巴` : ''}${job.qualityWarning ? ` · 需试听：${job.qualityWarning}` : ''}`, job.qualityWarning ? 6500 : 3200);
          await maybeAssembleAceSuite(job);
        } else {
          toast(`新歌已完成：${track.title} · 已归入「${track.album}」· ${playbackMessage}${job.trimmedTailSeconds ? ` · 已裁剪 ${job.trimmedTailSeconds.toFixed(1)} 秒静音尾巴` : ''}${job.qualityWarning ? ` · 需试听：${job.qualityWarning}` : ''}`, job.qualityWarning ? 7500 : 3200);
        }
      } catch (generationError) {
        job.finishedAt = Date.now();
        if (job.stopRequested || state.stopRequested || generationError?.name === 'AbortError') {
          job.status = 'cancelled';
          toast(`已停止：${job.title}`);
        } else {
          console.error(generationError);
          job.status = 'error';
          job.error = generationError.message || String(generationError);
          if (job.continuous) {
            state.continuousFailures += 1;
            if (state.continuousFailures >= 3) {
              stopContinuousGeneration();
              job.error += ' · 持续生成已在连续 3 次失败后停止';
            }
          }
          toast(`生成失败：${job.error}`, 5200);
        }
        if (job.suiteId) {
          state.generationQueue.forEach((item) => {
            if (item.suiteId === job.suiteId && item.status === 'queued') item.status = 'cancelled';
          });
          await maybeAssembleAceSuite(job);
        }
      } finally {
        delete job.params.referenceBlob;
        delete job.params.continuityReferenceBlob;
        delete job.params.continuityReferenceFilename;
        state.generating = false;
        state.stopRequested = false;
        state.activeProvider = null;
        state.generationController = null;
        state.activeJob = null;
        persistGenerationQueue();
        $('#stop-generation').disabled = true;
        $('#stop-generation').classList.remove('stopping');
        $('#stop-generation span').textContent = '停止';
        renderGenerationQueue();
      }
    }
    state.queueProcessing = false;
    buildPipeline(state.model);
    renderGenerationQueue();
  }

  async function stopGeneration() {
    if (!state.generating || state.stopRequested || typeof state.activeProvider?.cancel !== 'function') return;
    if (state.continuousEnabled) stopContinuousGeneration();
    state.stopRequested = true;
    if (state.activeJob) { state.activeJob.stopRequested = true; state.activeJob.status = 'stopping'; }
    persistGenerationQueue();
    const button = $('#stop-generation');
    button.disabled = true;
    button.classList.add('stopping');
    button.querySelector('span').textContent = '停止中';
    const cancellation = state.activeProvider.cancel();
    state.generationController?.abort();
    await cancellation;
    renderGenerationQueue();
  }

  function queueAction(event) {
    const button = event.target.closest('button[data-queue-action]');
    const row = event.target.closest('[data-job-id]');
    if (!button || !row) return;
    const job = state.generationQueue.find((item) => item.id === row.dataset.jobId);
    if (!job) return;
    if (button.dataset.queueAction === 'stop') stopGeneration();
    else if (button.dataset.queueAction === 'retry' && job.status === 'interrupted') {
      job.status = 'queued';
      job.error = '';
      job.finishedAt = null;
      job.startedAt = null;
      persistGenerationQueue();
      renderGenerationQueue();
      resumeSavedQueue();
    }
    else if (button.dataset.queueAction === 'retry-suite' && job.suiteAssemblyError) {
      maybeAssembleAceSuite(job).catch((error) => console.error('重试 ACE 合轨失败', error));
    }
    else if (button.dataset.queueAction === 'play' && job.trackId) {
      const track = state.library.find((item) => item.id === job.trackId);
      if (track) playTrack(track);
    } else if (button.dataset.queueAction === 'follow' && job.trackId) {
      const track = state.library.find((item) => item.id === job.trackId);
      if (track) queueTrackForFollow(track);
    }
    else if (button.dataset.queueAction === 'cancel' && ['queued', 'interrupted'].includes(job.status)) {
      job.status = 'cancelled';
      if (job.suiteId) {
        state.generationQueue.forEach((item) => {
          if (item.suiteId === job.suiteId && ['queued', 'interrupted'].includes(item.status)) item.status = 'cancelled';
        });
        toast('已取消该套件剩余分段');
        maybeAssembleAceSuite(job).catch((error) => console.warn('整理已取消的 ACE 分段失败', error));
      }
      persistGenerationQueue();
      renderGenerationQueue();
    } else if (button.dataset.queueAction === 'remove' && ['completed', 'error', 'cancelled'].includes(job.status)) {
      state.generationQueue = state.generationQueue.filter((item) => item.id !== job.id);
      persistGenerationQueue();
      renderGenerationQueue();
    }
  }

  function clearFinishedJobs() {
    state.generationQueue = state.generationQueue.filter((job) => !['completed', 'error', 'cancelled'].includes(job.status) || (job.suiteId && !job.suiteFinalized));
    persistGenerationQueue();
    renderGenerationQueue();
  }

  async function recoverPersistedAceSuites() {
    const groups = new Map();
    state.library.filter((track) => track.suitePart && track.suiteId).forEach((track) => {
      if (!groups.has(track.suiteId)) groups.set(track.suiteId, []);
      groups.get(track.suiteId).push(track);
    });
    for (const [suiteId, parts] of groups) {
      const storedWhole = state.library.some((track) => track.suiteId === suiteId && track.suiteAssembled);
      if (storedWhole) {
        try { await Store.removeMany(parts.map((track) => track.id)); }
        catch (error) { console.warn('清理已合成歌曲的分段缓存失败', error); }
        parts.forEach((track) => { if (track.url) URL.revokeObjectURL(track.url); });
        state.library = state.library.filter((track) => !parts.some((part) => part.id === track.id));
        continue;
      }
      const ordered = [...parts].sort((a, b) => Number(a.suiteIndex) - Number(b.suiteIndex));
      const total = Number(ordered[0]?.suiteTotal) || 0;
      const complete = total > 1 && ordered.length === total
        && ordered.every((part, index) => Number(part.suiteIndex) === index && part.blob);
      const restoredJobs = state.generationQueue.filter((item) => item.suiteId === suiteId);
      if (restoredJobs.length) {
        ordered.forEach((part) => {
          const matchingJob = restoredJobs.find((item) => Number(item.suiteIndex) === Number(part.suiteIndex));
          if (!matchingJob) return;
          matchingJob.trackId = part.id;
          matchingJob.actualDuration = Number(part.duration);
          matchingJob.status = 'completed';
          matchingJob.stageProgress = 1;
          matchingJob.finishedAt = matchingJob.finishedAt || Number(part.createdAt) || Date.now();
          state.suiteParts.set(part.id, part);
        });
        const fullQueue = total > 1 && restoredJobs.length === total
          && restoredJobs.every((item, index) => restoredJobs.some((other) => Number(other.suiteIndex) === index));
        if (complete && fullQueue) {
          restoredJobs.forEach((item) => { item.suiteFinalized = false; });
          await maybeAssembleAceSuite(restoredJobs.at(-1));
          continue;
        }
        if (!complete && restoredJobs.some((item) => ['queued', 'interrupted'].includes(item.status))) {
          // Keep finished parts hidden but durable until the user resumes the remaining queue items.
          continue;
        }
      }
      if (!complete) {
        parts.forEach((track) => {
          track.suitePart = false;
          track.category = 'ACE 未完成分段';
        });
        try { await persistTracks(parts); }
        catch (error) { console.warn('保存未完成的 ACE 分段状态失败', error); }
        restoredJobs.forEach((item) => { item.suiteFinalized = true; });
        continue;
      }
      if (restoredJobs.length) state.generationQueue = state.generationQueue.filter((item) => item.suiteId !== suiteId);
      const jobs = ordered.map((track, index) => ({
        id: `recovered-${suiteId}-${index}`,
        model: Models.byId(track.modelId),
        params: { duration: Number(track.requestedDuration || track.duration), album: track.album, seed: track.seed },
        title: track.title,
        status: 'completed',
        createdAt: Number(track.createdAt) || Date.now(),
        startedAt: Number(track.generation?.startedAt) || Number(track.createdAt) || Date.now(),
        finishedAt: Number(track.createdAt) || Date.now(),
        actualDuration: track.duration,
        stageProgress: 1,
        trackId: track.id,
        suiteId,
        suiteIndex: index,
        suiteTotal: total,
        suiteTitle: track.suiteTitle || ordered[0].title.split(' · ')[0],
        suiteFullLyrics: track.suiteFullLyrics || ordered.map((part) => part.lyrics).filter(Boolean).join('\n\n'),
        suiteSegmentLabel: track.suiteSegmentLabel || '',
        suiteContentDuration: Number.isFinite(Number(track.suiteContentDuration)) && track.suiteContentDuration !== null ? Number(track.suiteContentDuration) : null,
        suiteOverlapSeconds: Number.isFinite(Number(track.suiteOverlapSeconds)) && track.suiteOverlapSeconds !== null ? Number(track.suiteOverlapSeconds) : null,
        suiteTargetDuration: Number.isFinite(Number(track.suiteTargetDuration)) && track.suiteTargetDuration !== null ? Number(track.suiteTargetDuration) : null,
      }));
      ordered.forEach((track) => state.suiteParts.set(track.id, track));
      state.generationQueue.push(...jobs);
      await maybeAssembleAceSuite(jobs.at(-1));
    }
    persistGenerationQueue();
    renderGenerationQueue();
  }

  async function loadLibrary() {
    try {
      [state.library, state.albums] = await Promise.all([Store.list(), Store.listAlbums()]);
      const coverIdentityUpdates = [];
      state.library.forEach((track) => {
        if (ensureTrackCoverIdentity(track)) coverIdentityUpdates.push(track);
        if (track.blob) track.url = URL.createObjectURL(track.blob);
      });
      if (coverIdentityUpdates.length) await persistTracks(coverIdentityUpdates);
      await recoverPersistedAceSuites();
    } catch (error) {
      console.error(error);
      state.library = [];
      toast('曲库读取失败，本次仍可继续创作');
    }
    renderLibrary();
    repairTrackDurations().catch((error) => console.warn('更新曲目实际时长失败', error));
  }

  function cleanFacet(value, fallback) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 60) || fallback;
  }

  function trackAlbum(track) {
    return cleanFacet(track.album, track.provider === 'import' ? '本地导入' : 'AI 作品');
  }

  function trackCategory(track) {
    return cleanFacet(track.category, track.provider === 'import' ? '本地音乐' : 'AI 生成');
  }

  async function ensureAlbum(name) {
    const albumName = cleanFacet(name, '未分类专辑');
    if (!state.albums.some((album) => album.name === albumName)) {
      const album = { name: albumName, createdAt: Date.now() };
      await Store.putAlbum(album);
      state.albums.push(album);
    }
    return albumName;
  }

  function knownCreationAlbums() {
    return [...new Set([...state.albums.map((album) => album.name), ...state.library.map(trackAlbum)])]
      .map((name) => cleanFacet(name, ''))
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right, 'zh-CN'));
  }

  function syncCreationAlbumTrigger() {
    const input = $('#creation-album');
    const trigger = $('#creation-album-trigger');
    if (!input || !trigger) return;
    const name = cleanFacet(input.value, 'AI 作品');
    const count = state.library.filter((track) => trackAlbum(track) === name).length;
    const exists = state.albums.some((album) => album.name === name) || count > 0;
    input.value = name;
    $('#creation-album-name').textContent = name;
    $('#creation-album-state').textContent = exists ? `${count} 首作品 · 已有专辑` : '生成时自动创建';
    trigger.title = `当前收录到「${name}」；点击选择或新建专辑`;
    trigger.setAttribute('aria-label', `当前收录专辑：${name}，点击选择或新建`);
  }

  function renderAlbumPickerResults(query = $('#album-picker-search')?.value || '') {
    const results = $('#album-picker-results');
    if (!results) return;
    const current = cleanFacet($('#creation-album')?.value, 'AI 作品');
    const normalized = query.trim().toLowerCase();
    const known = knownCreationAlbums();
    const names = [...new Set([current, ...known])];
    const matches = normalized ? names.filter((name) => name.toLowerCase().includes(normalized)) : names;
    $('#album-picker-count').textContent = `${known.length} 张已有专辑`;

    const candidate = cleanFacet(query, '');
    const canCreate = Boolean(candidate) && !known.some((name) => name.toLowerCase() === candidate.toLowerCase());
    $('#album-create-option').classList.toggle('hidden', !canCreate);
    $('#album-create-name').textContent = canCreate ? `「${candidate}」将立即建立并设为创作目标` : '';

    if (!matches.length) {
      results.innerHTML = '<div class="album-picker-empty">没有匹配的已有专辑<br>可以使用上方的新建选项</div>';
      return;
    }
    results.innerHTML = matches.map((name) => {
      const count = state.library.filter((track) => trackAlbum(track) === name).length;
      const exists = known.includes(name);
      const active = name === current;
      return `<button class="album-picker-result${active ? ' active' : ''}" type="button" role="option" aria-selected="${active}" data-album-name="${escapeHtml(name)}">
        <span class="album-picker-cover">${escapeHtml(name.trim().slice(0, 1).toUpperCase() || 'Y')}</span>
        <span class="album-picker-copy"><strong>${escapeHtml(name)}</strong><small>${count} 首作品 · ${exists ? '已有专辑' : '生成时自动创建'}</small></span><em>✓</em>
      </button>`;
    }).join('');
  }

  function openCreationAlbumPicker() {
    const dialog = $('#album-picker-dialog');
    if (!dialog || dialog.open) return;
    $('#album-picker-search').value = '';
    renderAlbumPickerResults();
    $('#creation-album-trigger').setAttribute('aria-expanded', 'true');
    dialog.showModal();
    requestAnimationFrame(() => $('#album-picker-search').focus());
  }

  async function chooseCreationAlbum(name, create = false) {
    const albumName = cleanFacet(name, '');
    if (!albumName) return;
    const existed = knownCreationAlbums().some((item) => item.toLowerCase() === albumName.toLowerCase());
    const selectedName = existed
      ? knownCreationAlbums().find((item) => item.toLowerCase() === albumName.toLowerCase())
      : albumName;
    if (create && !existed) await ensureAlbum(selectedName);
    $('#creation-album').value = selectedName;
    localStorage.setItem(LS_CREATION_ALBUM, selectedName);
    syncCreationAlbumTrigger();
    scheduleCreationDraftSave();
    $('#album-picker-dialog').close();
    if (create && !existed) {
      renderLibrary();
      toast(`已新建专辑「${selectedName}」，接下来生成的音乐会自动收录`);
    }
  }

  function referenceSearchText(track) {
    return [track.title, trackAlbum(track), trackCategory(track), track.modelLabel, track.presetLabel, track.tags, track.prompt, track.fileName]
      .map((value) => String(value || '').toLowerCase()).join('\n');
  }

  function syncReferencePicker() {
    const select = $('#reference-track');
    const trigger = $('#reference-picker-trigger');
    if (!select || !trigger) return;
    const selected = state.library.find((track) => track.id === select.value);
    const title = selected?.title || '不使用参考音乐';
    trigger.querySelector('span').textContent = title;
    trigger.querySelector('small').textContent = selected
      ? `${trackAlbum(selected)} · ${trackCategory(selected)}`
      : '点击搜索曲库';
    trigger.title = selected ? `${title} · ${trackAlbum(selected)} · ${trackCategory(selected)}` : '从曲库搜索参考音乐';
    trigger.setAttribute('aria-label', selected ? `当前参考音乐：${title}，点击重新选择` : '从曲库搜索参考音乐');
  }

  function renderReferenceResults(query = $('#reference-search')?.value || '') {
    const results = $('#reference-results');
    const count = $('#reference-result-count');
    if (!results || !count) return;
    const normalized = query.trim().toLowerCase();
    const playable = libraryVisibleTracks().filter((track) => track.blob && track.url);
    const matches = normalized ? playable.filter((track) => referenceSearchText(track).includes(normalized)) : playable;
    count.textContent = normalized ? `${matches.length} / ${playable.length} 首` : `${playable.length} 首可用`;
    $('#reference-clear')?.classList.toggle('active', !$('#reference-track')?.value);
    if (!matches.length) {
      results.innerHTML = `<div class="reference-empty"><b>${playable.length ? '没有匹配的音乐' : '曲库还没有可用音乐'}</b><span>${playable.length ? '试试歌名、专辑、分类或模型关键词' : '可以先点创作区的“导入”添加本地音乐'}</span></div>`;
      return;
    }
    const selectedId = $('#reference-track')?.value || '';
    results.innerHTML = matches.map((track) => {
      const active = track.id === selectedId;
      const source = track.provider === 'import' ? '本地导入' : (track.modelLabel || '音悦台 AI');
      return `<button class="reference-result${active ? ' active' : ''}" type="button" role="option" aria-selected="${active}" data-reference-id="${escapeHtml(track.id)}">
        <span class="reference-result-cover" ${trackCoverAttributes(track)}>${trackCoverAtoms(track)}<span class="cover-mark">${escapeHtml(trackCoverMark(track))}</span></span>
        <span class="reference-result-copy"><strong>${escapeHtml(track.title || '未命名音乐')}</strong><small>${escapeHtml(trackAlbum(track))} · ${escapeHtml(trackCategory(track))} · ${escapeHtml(source)}</small></span>
        <time>${formatTime(track.duration)}</time><i>✓</i>
      </button>`;
    }).join('');
  }

  function openReferencePicker() {
    const dialog = $('#reference-picker-dialog');
    const search = $('#reference-search');
    if (!dialog || dialog.open) return;
    search.value = '';
    renderReferenceResults();
    $('#reference-picker-trigger').setAttribute('aria-expanded', 'true');
    dialog.showModal();
    requestAnimationFrame(() => search.focus());
  }

  function selectReferenceTrack(id) {
    const select = $('#reference-track');
    const playable = state.library.some((track) => track.id === id && track.blob && track.url);
    select.value = playable ? id : '';
    syncReferencePicker();
    $('#reference-picker-dialog').close();
  }

  function renderReferenceOptions(selected = $('#reference-track')?.value || '') {
    const select = $('#reference-track');
    if (!select) return;
    const playable = libraryVisibleTracks().filter((track) => track.blob && track.url);
    select.innerHTML = `<option value="">不使用参考音乐</option>${playable.map((track) => `<option value="${escapeHtml(track.id)}">${escapeHtml(track.title)} · ${escapeHtml(trackAlbum(track))}</option>`).join('')}`;
    select.value = playable.some((track) => track.id === selected) ? selected : '';
    syncReferencePicker();
    if ($('#reference-picker-dialog')?.open) renderReferenceResults();
  }

  function facetButton(kind, value, label, count, active) {
    return `<button class="${active ? 'active' : ''}" data-library-filter="${kind}" data-filter-value="${escapeHtml(value)}"><span>${escapeHtml(label)}</span><b>${count}</b></button>`;
  }

  function libraryVisibleTracks() {
    return state.library.filter((track) => !track.suitePart || ['ACE 合轨待重试', 'ACE 未完成分段'].includes(track.category));
  }

  function renderLibraryFacets() {
    const visibleTracks = libraryVisibleTracks();
    const albumNames = [...new Set([...state.albums.map((album) => album.name), ...visibleTracks.map(trackAlbum)])].filter(Boolean);
    const categories = [...new Set(visibleTracks.map(trackCategory))].filter(Boolean);
    $('#library-albums').innerHTML = facetButton('album', '*', '全部', visibleTracks.length, state.libraryAlbum === '*')
      + albumNames.map((name) => facetButton('album', name, name, visibleTracks.filter((track) => trackAlbum(track) === name).length, state.libraryAlbum === name)).join('');
    $('#library-categories').innerHTML = facetButton('category', '*', '全部', visibleTracks.length, state.libraryCategory === '*')
      + categories.map((name) => facetButton('category', name, name, visibleTracks.filter((track) => trackCategory(track) === name).length, state.libraryCategory === name)).join('');
    $('#album-suggestions').innerHTML = albumNames.map((name) => `<option value="${escapeHtml(name)}"></option>`).join('');
    syncCreationAlbumTrigger();
    if ($('#album-picker-dialog')?.open) renderAlbumPickerResults();
  }

  function filteredLibrary() {
    const query = state.libraryQuery.toLowerCase();
    return libraryVisibleTracks().filter((track) => {
      if (state.libraryAlbum !== '*' && trackAlbum(track) !== state.libraryAlbum) return false;
      if (state.libraryCategory !== '*' && trackCategory(track) !== state.libraryCategory) return false;
      return !query || [track.title, track.modelLabel, track.presetLabel, track.tags, track.prompt, trackAlbum(track), trackCategory(track)]
        .some((value) => String(value || '').toLowerCase().includes(query));
    });
  }

  function selectedLibraryTracks(ids = state.librarySelection) {
    const selectedIds = ids instanceof Set ? ids : new Set(ids || []);
    return state.library.filter((track) => selectedIds.has(track.id));
  }

  function renderLibrarySelectionState() {
    const validIds = new Set(state.library.map((track) => track.id));
    [...state.librarySelection].forEach((id) => { if (!validIds.has(id)) state.librarySelection.delete(id); });
    const visible = filteredLibrary();
    const visibleSelected = visible.filter((track) => state.librarySelection.has(track.id)).length;
    const allVisibleSelected = visible.length > 0 && visibleSelected === visible.length;
    const selectAll = $('#library-select-all');
    if (selectAll) {
      selectAll.setAttribute('aria-pressed', String(allVisibleSelected));
      selectAll.classList.toggle('checked', allVisibleSelected);
      selectAll.classList.toggle('partial', visibleSelected > 0 && !allVisibleSelected);
      selectAll.title = allVisibleSelected ? '取消选择当前列表全部歌曲' : '选择当前列表全部歌曲';
    }
    $$('#library .track').forEach((row) => {
      const selected = state.librarySelection.has(row.dataset.id);
      row.classList.toggle('selected', selected);
      row.setAttribute('aria-selected', String(selected));
      const control = row.querySelector('.track-select');
      if (control) {
        control.classList.toggle('checked', selected);
        control.setAttribute('aria-pressed', String(selected));
        control.setAttribute('aria-label', selected ? '取消选择这首歌' : '选择这首歌');
      }
    });
    const count = state.librarySelection.size;
    $('#library-batchbar')?.classList.toggle('hidden', count === 0);
    if ($('#library-selected-count')) $('#library-selected-count').textContent = String(count);
    if ($('#library-batch-play')) $('#library-batch-play').disabled = !selectedLibraryTracks().some((track) => track.url);
  }

  function toggleLibrarySelection(id, extend = false) {
    const visible = filteredLibrary();
    if (extend && state.librarySelectionAnchor) {
      const anchorIndex = visible.findIndex((track) => track.id === state.librarySelectionAnchor);
      const targetIndex = visible.findIndex((track) => track.id === id);
      if (anchorIndex >= 0 && targetIndex >= 0) {
        const [start, end] = anchorIndex < targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
        visible.slice(start, end + 1).forEach((track) => state.librarySelection.add(track.id));
      } else state.librarySelection.add(id);
    } else if (state.librarySelection.has(id)) state.librarySelection.delete(id);
    else state.librarySelection.add(id);
    state.librarySelectionAnchor = id;
    renderLibrarySelectionState();
  }

  function toggleVisibleLibrarySelection() {
    const visible = filteredLibrary();
    const allSelected = visible.length > 0 && visible.every((track) => state.librarySelection.has(track.id));
    visible.forEach((track) => allSelected ? state.librarySelection.delete(track.id) : state.librarySelection.add(track.id));
    state.librarySelectionAnchor = visible.at(-1)?.id || null;
    renderLibrarySelectionState();
  }

  function clearLibrarySelection() {
    state.librarySelection.clear();
    state.librarySelectionAnchor = null;
    renderLibrarySelectionState();
  }

  function renderLibrary() {
    const visibleTracks = libraryVisibleTracks();
    const totalDuration = visibleTracks.reduce((sum, track) => sum + (Number(track.duration) || 0), 0);
    $('#library-count').textContent = `${visibleTracks.length} 首作品`;
    $('#library-duration').textContent = `总时长 ${formatTime(totalDuration)}`;
    renderLibraryFacets();
    renderReferenceOptions();
    const library = $('#library');
    const tracks = filteredLibrary();
    const filtered = state.libraryQuery || state.libraryAlbum !== '*' || state.libraryCategory !== '*';
    $('#library-play-all').disabled = !tracks.some((track) => track.url);
    $('#library-play-label').textContent = state.libraryAlbum !== '*' ? '播放当前专辑' : filtered ? '播放当前列表' : '播放全部';
    $('#library-play-all').title = state.libraryAlbum !== '*' ? `从头播放专辑「${state.libraryAlbum}」` : filtered ? '按当前筛选结果顺序播放' : '播放曲库全部歌曲';
    renderPlaybackQueue();
    if (!visibleTracks.length) {
      $('#library-filter-count').textContent = '';
      library.innerHTML = '<div class="library-empty"><div><b>曲库还是空的</b><span>可以批量导入本地音乐，也可以从创作台生成</span><br><button data-library-action="import">导入音乐</button><button data-library-action="studio">去创作</button></div></div>';
      renderLibrarySelectionState();
      return;
    }
    $('#library-filter-count').textContent = filtered ? `${tracks.length} / ${visibleTracks.length}` : '';
    if (!tracks.length) {
      library.innerHTML = '<div class="library-empty"><div><b>没有找到这首歌</b><span>换一个歌名、模型或风格关键词试试</span></div></div>';
      renderLibrarySelectionState();
      return;
    }
    library.innerHTML = tracks.map((track) => {
      const originalIndex = visibleTracks.findIndex((item) => item.id === track.id);
      const subtitle = track.provider === 'import'
        ? `${track.fileName || '本地文件'} · 本地导入`
        : `${track.modelLabel || '音悦台 AI'} · SEED ${track.seed || '—'}`;
      return `
      <article class="track${state.current?.id === track.id ? ' current' : ''}${state.librarySelection.has(track.id) ? ' selected' : ''}" data-id="${escapeHtml(track.id)}" aria-selected="${state.librarySelection.has(track.id)}">
        <button type="button" class="track-select${state.librarySelection.has(track.id) ? ' checked' : ''}" data-action="select" aria-label="${state.librarySelection.has(track.id) ? '取消选择这首歌' : '选择这首歌'}" aria-pressed="${state.librarySelection.has(track.id)}"><i></i></button>
        <div class="track-number"><span>${String(originalIndex + 1).padStart(2, '0')}</span>${track.url ? '<button data-action="play" aria-label="播放">▶</button>' : track.provider === 'demo' ? '<button data-action="revive" aria-label="重新合成">↻</button>' : '<button disabled aria-label="音频不可用">—</button>'}</div>
        <div class="track-identity"><button class="track-cover" data-action="open" aria-label="打开播放页" ${trackCoverAttributes(track)}>${trackCoverAtoms(track)}<span class="cover-mark">${escapeHtml(trackCoverMark(track))}</span></button><div class="track-title-wrap"><div class="track-title">${escapeHtml(track.title)}</div><span>${escapeHtml(subtitle)}</span></div></div>
        <div class="track-model"><button type="button" data-action="play-album" title="播放专辑「${escapeHtml(trackAlbum(track))}」">${escapeHtml(trackAlbum(track))}</button></div>
        <div class="track-style">${escapeHtml(trackCategory(track))}</div>
        <div class="track-date">${formatDate(track.createdAt)}</div>
        <div class="track-duration" title="实际音频时长 ${formatPreciseTime(track.duration)}">${formatTime(track.duration)}</div>
        <div class="track-actions">
          <button data-action="open" title="打开播放页" aria-label="打开播放页" ${track.url ? '' : 'disabled'}>↗</button>
          <button data-action="download" title="选择下载格式" aria-label="选择下载格式" ${track.url ? '' : 'disabled'}>↓</button>
          <button data-action="detail" title="查看完整生成参数" aria-label="查看作品参数">ⓘ</button>
          <button data-action="edit" title="编辑歌曲信息" aria-label="编辑歌曲信息">✎</button>
          <button class="danger" data-action="delete" title="删除" aria-label="删除">×</button>
        </div>
      </article>`;
    }).join('');
    renderLibrarySelectionState();
  }

  function readAudioDuration(blob) {
    return new Promise((resolve) => {
      const probe = document.createElement('audio');
      const url = URL.createObjectURL(blob);
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        URL.revokeObjectURL(url);
        resolve(Number.isFinite(value) ? value : 0);
      };
      const timer = setTimeout(() => finish(0), 10000);
      probe.preload = 'metadata';
      probe.onloadedmetadata = () => { clearTimeout(timer); finish(probe.duration); };
      probe.onerror = () => { clearTimeout(timer); finish(0); };
      probe.src = url;
    });
  }

  async function repairTrackDurations() {
    let changed = false;
    await Promise.all(state.library.filter((track) => track.blob).map(async (track) => {
      const actual = await readAudioDuration(track.blob);
      if (!actual || Math.abs(actual - (Number(track.duration) || 0)) < 0.05) return;
      track.duration = actual;
      if (track.generation?.output) track.generation.output.duration = actual;
      await persistTrack(track);
      changed = true;
    }));
    if (changed) {
      renderLibrary();
      if (state.current) updateNowPlaying(state.current);
    }
  }

  async function importAudioFiles(fileList, useAsReference = false) {
    const files = [...(fileList || [])].filter((file) => file.type.startsWith('audio/') || /\.(wav|mp3|m4a|aac|flac|ogg|webm)$/i.test(file.name));
    if (!files.length) { toast('没有找到可导入的音频文件'); return; }
    const album = await ensureAlbum(state.libraryAlbum === '*' ? '本地导入' : state.libraryAlbum);
    const category = state.libraryCategory === '*' ? '本地音乐' : state.libraryCategory;
    const imported = [];
    for (const [index, file] of files.entries()) {
      const duration = await readAudioDuration(file);
      const track = {
        id: `import-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`,
        title: file.name.replace(/\.[^.]+$/, '').trim() || '未命名音乐', provider: 'import', modelId: 'imported', modelLabel: '本地导入',
        fileName: file.name, tags: '', lyrics: '', album, category, duration, createdAt: Date.now() + index, blob: file,
      };
      ensureTrackCoverIdentity(track);
      track.url = URL.createObjectURL(track.blob);
      await persistTrack(track);
      imported.push(track);
    }
    state.library.unshift(...imported.reverse());
    renderLibrary();
    if (useAsReference && imported[0]) {
      renderReferenceOptions(imported[0].id);
      showView('studio');
      toast(`已导入并选为参考：${imported[0].title}`);
    } else toast(`已导入 ${imported.length} 首音乐到「${album}」`);
  }

  function createAlbum() {
    $('#album-edit-name').value = '';
    $('#album-editor').showModal();
    $('#album-edit-name').focus();
  }

  async function saveAlbum(event) {
    event.preventDefault();
    const name = cleanFacet($('#album-edit-name').value, '');
    if (!name) { toast('请填写专辑名称'); return; }
    await ensureAlbum(name);
    state.libraryAlbum = name;
    $('#album-editor').close();
    renderLibrary();
    toast(`专辑「${name}」已创建；现在导入的音乐会直接放进该专辑`);
  }

  function openTrackEditor(track) {
    state.editingTrackId = track.id;
    $('#track-edit-title').value = track.title || '';
    $('#track-edit-album').value = trackAlbum(track);
    $('#track-edit-category').value = trackCategory(track);
    $('#track-edit-tags').value = track.tags || '';
    $('#track-editor').showModal();
    $('#track-edit-title').focus();
  }

  async function saveTrackEditor(event) {
    event.preventDefault();
    const track = state.library.find((item) => item.id === state.editingTrackId);
    if (!track) return;
    const title = normalizeSongTitle($('#track-edit-title').value);
    if (!title) { toast('歌名不能为空'); return; }
    track.title = title;
    track.album = await ensureAlbum($('#track-edit-album').value);
    track.category = cleanFacet($('#track-edit-category').value, '未分类');
    track.tags = $('#track-edit-tags').value.trim();
    await persistTrack(track);
    $('#track-editor').close();
    state.editingTrackId = null;
    updateNowPlaying(state.current);
    renderLibrary();
    toast('歌曲信息已保存');
  }

  function libraryActionIds(ids) {
    const valid = new Set(state.library.map((track) => track.id));
    return [...new Set(ids || [])].filter((id) => valid.has(id));
  }

  function playLibraryTracks(ids = [...state.librarySelection]) {
    const selected = selectedLibraryTracks(new Set(libraryActionIds(ids))).filter((track) => track.url);
    if (!selected.length) { toast('所选歌曲里没有可播放的音频'); return; }
    playCollection(selected, '所选歌曲');
  }

  function renderLibraryAlbumResults(query = $('#library-album-search')?.value || '') {
    const results = $('#library-album-results');
    if (!results) return;
    const normalized = query.trim().toLowerCase();
    const known = knownCreationAlbums();
    const matches = normalized ? known.filter((name) => name.toLowerCase().includes(normalized)) : known;
    const candidate = cleanFacet(query, '');
    const canCreate = Boolean(candidate) && !known.some((name) => name.toLowerCase() === candidate.toLowerCase());
    $('#library-album-create').classList.toggle('hidden', !canCreate);
    $('#library-album-create-name').textContent = canCreate ? `建立「${candidate}」并迁移所选歌曲` : '';
    if (!matches.length) {
      results.innerHTML = '<div class="album-picker-empty">没有匹配的已有专辑<br>可以使用上方的新建选项</div>';
      return;
    }
    results.innerHTML = matches.map((name) => {
      const count = state.library.filter((track) => trackAlbum(track) === name).length;
      return `<button class="album-picker-result" type="button" role="option" data-library-album-name="${escapeHtml(name)}">
        <span class="album-picker-cover">${escapeHtml(name.trim().slice(0, 1).toUpperCase() || 'Y')}</span>
        <span class="album-picker-copy"><strong>${escapeHtml(name)}</strong><small>${count} 首作品 · 点击迁移</small></span><em>→</em>
      </button>`;
    }).join('');
  }

  function openLibraryAlbumDialog(ids) {
    const trackIds = libraryActionIds(ids);
    if (!trackIds.length) return;
    state.libraryAlbumMoveIds = trackIds;
    $('#library-album-count').textContent = `${trackIds.length} 首歌曲将被迁移`;
    $('#library-album-search').value = '';
    renderLibraryAlbumResults();
    hideTrackContextMenu();
    $('#library-album-dialog').showModal();
    requestAnimationFrame(() => $('#library-album-search').focus());
  }

  async function moveLibraryTracksToAlbum(name) {
    const albumName = cleanFacet(name, '');
    const ids = libraryActionIds(state.libraryAlbumMoveIds);
    if (!albumName || !ids.length) return;
    const target = await ensureAlbum(albumName);
    const idSet = new Set(ids);
    const tracks = state.library.filter((track) => idSet.has(track.id));
    tracks.forEach((track) => { track.album = target; });
    await persistTracks(tracks);
    ids.forEach((id) => state.librarySelection.delete(id));
    state.libraryAlbumMoveIds = [];
    $('#library-album-dialog').close();
    renderLibrary();
    updateNowPlaying(state.current);
    toast(`${tracks.length} 首歌曲已迁移到「${target}」`);
  }

  function openLibraryCategoryDialog(ids) {
    const trackIds = libraryActionIds(ids);
    if (!trackIds.length) return;
    state.libraryCategoryIds = trackIds;
    const tracks = selectedLibraryTracks(new Set(trackIds));
    const categories = [...new Set(tracks.map(trackCategory))];
    $('#library-category-input').value = categories.length === 1 ? categories[0] : '';
    $('#library-category-count').textContent = `${tracks.length} 首歌曲将同时更新${categories.length > 1 ? ' · 当前包含多个分类' : ''}`;
    hideTrackContextMenu();
    $('#library-category-dialog').showModal();
    requestAnimationFrame(() => $('#library-category-input').focus());
  }

  async function saveLibraryCategory(event) {
    event.preventDefault();
    const category = cleanFacet($('#library-category-input').value, '');
    const ids = libraryActionIds(state.libraryCategoryIds);
    if (!category) { toast('请填写分类名称'); return; }
    if (!ids.length) return;
    const idSet = new Set(ids);
    const tracks = state.library.filter((track) => idSet.has(track.id));
    tracks.forEach((track) => { track.category = category; });
    await persistTracks(tracks);
    state.libraryCategoryIds = [];
    ids.forEach((id) => state.librarySelection.delete(id));
    $('#library-category-dialog').close();
    renderLibrary();
    toast(`${tracks.length} 首歌曲已归类为「${category}」`);
  }

  function contextTrackActionIds() {
    if (state.contextTrackId && state.librarySelection.has(state.contextTrackId)) return libraryActionIds([...state.librarySelection]);
    return libraryActionIds([state.contextTrackId]);
  }

  function hideTrackContextMenu() {
    const menu = $('#track-context-menu');
    if (!menu) return;
    menu.classList.add('hidden');
    menu.setAttribute('aria-hidden', 'true');
    state.contextTrackId = null;
  }

  function openTrackContextMenu(event, track) {
    event.preventDefault();
    state.contextTrackId = track.id;
    const ids = contextTrackActionIds();
    const tracks = selectedLibraryTracks(new Set(ids));
    const multiple = tracks.length > 1;
    const playable = tracks.filter((item) => item.url);
    const menu = $('#track-context-menu');
    $('#track-context-kicker').textContent = multiple ? `${tracks.length} TRACKS SELECTED` : 'TRACK ACTIONS';
    $('#track-context-title').textContent = multiple ? `${tracks.length} 首已选择` : track.title;
    $('#track-context-select-label').textContent = multiple ? `取消选择这 ${tracks.length} 首` : (state.librarySelection.has(track.id) ? '取消选择这首歌' : '选择这首歌');
    const disable = (action, value) => { const button = menu.querySelector(`[data-context-action="${action}"]`); if (button) button.disabled = value; };
    disable('play', playable.length === 0);
    disable('open', multiple || !track.url);
    disable('follow', playable.length === 0);
    disable('play-album', multiple);
    disable('edit', multiple);
    disable('lyrics', multiple);
    disable('detail', multiple);
    disable('reference', multiple || !track.blob || !track.url);
    disable('download', multiple || !track.url);
    menu.classList.remove('hidden');
    menu.setAttribute('aria-hidden', 'false');
    menu.style.left = '0px';
    menu.style.top = '0px';
    const bounds = menu.getBoundingClientRect();
    const left = Math.min(event.clientX, window.innerWidth - bounds.width - 10);
    const top = Math.min(event.clientY, window.innerHeight - bounds.height - 10);
    menu.style.left = `${Math.max(10, left)}px`;
    menu.style.top = `${Math.max(10, top)}px`;
    requestAnimationFrame(() => menu.querySelector('button:not(:disabled)')?.focus({ preventScroll: true }));
  }

  async function followLibraryTracks(ids) {
    const tracks = selectedLibraryTracks(new Set(libraryActionIds(ids))).filter((track) => track.url && track.id !== state.current?.id);
    state.followQueue = [...new Set([...state.followQueue, ...tracks.map((track) => track.id)])];
    renderCompletionNotices();
    renderGenerationQueue();
    toast(tracks.length ? `${tracks.length} 首歌曲已加入跟随播放` : '这些歌曲已在播放或无法播放');
  }

  async function handleTrackContextAction(event) {
    const button = event.target.closest('[data-context-action]');
    if (!button || button.disabled) return;
    const action = button.dataset.contextAction;
    const ids = contextTrackActionIds();
    const tracks = selectedLibraryTracks(new Set(ids));
    const track = state.library.find((item) => item.id === state.contextTrackId) || tracks[0];
    hideTrackContextMenu();
    if (!track) return;
    if (action === 'play') playLibraryTracks(ids);
    else if (action === 'open') openNowPlaying(track);
    else if (action === 'follow') followLibraryTracks(ids);
    else if (action === 'play-album') playAlbum(track);
    else if (action === 'album') openLibraryAlbumDialog(ids);
    else if (action === 'category') openLibraryCategoryDialog(ids);
    else if (action === 'select') {
      const allSelected = ids.length && ids.every((id) => state.librarySelection.has(id));
      ids.forEach((id) => allSelected ? state.librarySelection.delete(id) : state.librarySelection.add(id));
      state.librarySelectionAnchor = track.id;
      renderLibrarySelectionState();
    } else if (action === 'edit') openTrackEditor(track);
    else if (action === 'lyrics') openLyricEditor(track);
    else if (action === 'detail') openTrackDetail(track);
    else if (action === 'reference') {
      renderReferenceOptions(track.id);
      showView('studio');
      toast(`已设为参考音乐：${track.title}`);
    } else if (action === 'download') openDownloadMenu(track);
    else if (action === 'delete') deleteTracks(ids);
  }

  const PARAMETER_LABELS = {
    title: '歌名', album: '目标专辑', tags: '风格标签', prompt: '音乐描述', negativePrompt: '排除内容', lyrics: '生成时歌词',
    duration: '目标时长', steps: '采样步数', cfg: '遵循度 / CFG', seed: '随机种子', referenceTrackId: '参考曲目 ID',
    referenceTitle: '参考音乐', referenceStrength: '参考强度', music3DiffusionModel: '扩散权重', music3TextEncoder: '文本编码器',
  };

  function trackDetailPayload(track) {
    if (track.generation) return track.generation;
    if (track.provider !== 'import') {
      return {
        schemaVersion: 0,
        model: { id: track.modelId || '', label: track.modelLabel || track.presetLabel || '', provider: track.provider || '' },
        provider: track.provider || '',
        finishedAt: track.createdAt,
        elapsedMs: Number(track.generationElapsedMs) || 0,
        requested: {
          title: track.title || '', tags: track.tags || '', prompt: track.prompt || '', negativePrompt: track.negativePrompt || '', lyrics: track.lyrics || '',
          duration: Number(track.requestedDuration || track.duration) || 0, steps: track.steps, cfg: track.cfg, seed: track.seed,
          referenceTitle: track.referenceTitle || '',
        },
        output: { duration: Number(track.duration) || 0, mimeType: track.blob?.type || '', bytes: Number(track.blob?.size) || 0 },
      };
    }
    return {
      schemaVersion: 1,
      source: 'import',
      importedAt: track.createdAt,
      requested: {
        fileName: track.fileName || '', album: trackAlbum(track), category: trackCategory(track), tags: track.tags || '',
      },
      output: { duration: Number(track.duration) || 0, mimeType: track.blob?.type || '', bytes: Number(track.blob?.size) || 0 },
    };
  }

  function detailValue(value, key = '') {
    if (key === 'duration') return `${formatPreciseTime(value)}（${Number(value).toFixed(2)} 秒）`;
    if (typeof value === 'boolean') return value ? '是' : '否';
    if (Array.isArray(value)) return value.join('，');
    if (value && typeof value === 'object') return JSON.stringify(value);
    if (value === '' || value === null || value === undefined) return '未设置';
    return String(value);
  }

  function openTrackDetail(track) {
    if (!track) return;
    state.detailTrackId = track.id;
    const record = trackDetailPayload(track);
    const generated = Boolean(track.generation || track.provider !== 'import');
    $('#track-detail-title').textContent = track.title || '作品详情';
    $('#track-detail-copy').textContent = generated ? '复制参数 JSON' : '复制文件信息 JSON';
    const elapsedMs = Number(record.elapsedMs || track.generationElapsedMs) || 0;
    $('#track-detail-summary').innerHTML = [
      ['实际音频时长', formatPreciseTime(track.duration)],
      ['生成耗时', generated ? (elapsedMs ? formatElapsed(elapsedMs) : '历史作品未记录') : '本地导入'],
      ['模型 / 来源', generated ? (record.model?.label || track.modelLabel || track.provider || '—') : '本地音频'],
      ['完成时间', track.createdAt ? new Date(track.createdAt).toLocaleString('zh-CN') : '—'],
    ].map(([label, value]) => `<div><small>${escapeHtml(label)}</small><strong title="${escapeHtml(value)}">${escapeHtml(value)}</strong></div>`).join('');

    const requested = record.requested || {};
    const longKeys = new Set(['prompt', 'negativePrompt', 'lyrics']);
    const regular = Object.entries(requested).filter(([key]) => !longKeys.has(key));
    const paramGrid = regular.length ? `<section class="detail-section"><h3>完整生成参数</h3><div class="detail-param-grid">${regular.map(([key, value]) => `<div class="detail-param"><small>${escapeHtml(PARAMETER_LABELS[key] || key)}</small><b title="${escapeHtml(detailValue(value, key))}">${escapeHtml(detailValue(value, key))}</b></div>`).join('')}</div></section>` : '';
    const textSections = [...longKeys].filter((key) => requested[key]).map((key) => `<section class="detail-section"><h3>${escapeHtml(PARAMETER_LABELS[key] || key)}</h3><p class="detail-text">${escapeHtml(requested[key])}</p></section>`).join('');
    const output = record.output || {};
    const outputSection = `<section class="detail-section"><h3>输出文件</h3><div class="detail-param-grid">
      <div class="detail-param"><small>实际时长</small><b>${escapeHtml(detailValue(output.duration || track.duration, 'duration'))}</b></div>
      <div class="detail-param"><small>格式</small><b>${escapeHtml(output.mimeType || track.blob?.type || '未知')}</b></div>
      <div class="detail-param"><small>文件大小</small><b>${escapeHtml(formatBytes(output.bytes || track.blob?.size || 0))}</b></div>
      ${record.provider ? `<div class="detail-param"><small>推理 Provider</small><b>${escapeHtml(record.provider)}</b></div>` : ''}
    </div></section>`;
    const raw = JSON.stringify(record, null, 2);
    $('#track-detail-body').innerHTML = `${paramGrid}${textSections}${outputSection}<details class="detail-section"><summary>原始参数 JSON</summary><pre class="detail-json">${escapeHtml(raw)}</pre></details>`;
    $('#track-detail').showModal();
  }

  async function copyTrackParameters() {
    const track = state.library.find((item) => item.id === state.detailTrackId);
    if (!track) return;
    const text = JSON.stringify(trackDetailPayload(track), null, 2);
    try {
      await navigator.clipboard.writeText(text);
      toast('完整参数已复制');
    } catch (_) {
      const area = document.createElement('textarea');
      area.value = text;
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
      toast('完整参数已复制');
    }
  }

  function lyricEditorTrack() {
    return state.library.find((track) => track.id === state.lyricTrackId) || null;
  }

  function openLyricEditor(track = state.current) {
    if (!track) { toast('请先选择一首曲目'); return; }
    if (track.url && state.current?.id !== track.id) playTrack(track);
    else if (state.current?.id !== track.id) { state.current = track; updateNowPlaying(track); }
    state.lyricTrackId = track.id;
    state.lyricDraft = Lyrics.timelineFor(track.lyrics, track.duration, track.lyricTimeline).map((item) => ({ ...item }));
    state.lyricEditorActiveIndex = -1;
    $('#lyric-editor-title').textContent = `${track.title} · 歌词时间轴`;
    $('#lyric-current-time').textContent = formatPreciseTime(audio.currentTime);
    renderLyricTimeline();
    $('#lyric-editor').showModal();
  }

  function renderLyricTimeline(focusIndex = -1) {
    const container = $('#lyric-timeline');
    if (!state.lyricDraft.length) {
      container.innerHTML = '<div class="lyric-empty">还没有歌词，点击“新增一行”开始制作时间轴</div>';
      return;
    }
    const active = Lyrics.activeIndex(state.lyricDraft, audio.currentTime);
    state.lyricEditorActiveIndex = active;
    container.innerHTML = state.lyricDraft.map((item, index) => `<div class="lyric-row${index === active ? ' active' : ''}" data-lyric-index="${index}">
      <button type="button" class="lyric-row-play" data-lyric-action="seek" title="从这一行试听">▶</button>
      <input class="lyric-time-input" aria-label="第 ${index + 1} 行时间戳" value="${escapeHtml(formatPreciseTime(item.time))}">
      <div class="lyric-nudges"><button type="button" data-lyric-action="nudge" data-value="-0.1">−0.1</button><button type="button" class="lyric-stamp" data-lyric-action="stamp">取当前</button><button type="button" data-lyric-action="nudge" data-value="0.1">＋0.1</button></div>
      <input class="lyric-text-input" aria-label="第 ${index + 1} 行歌词" maxlength="500" value="${escapeHtml(item.text)}">
      <button type="button" class="lyric-row-delete" data-lyric-action="delete" title="删除这一行">×</button>
    </div>`).join('');
    if (focusIndex >= 0) container.querySelector(`[data-lyric-index="${focusIndex}"] .lyric-text-input`)?.focus();
  }

  function syncLyricDraftInputs() {
    $$('#lyric-timeline .lyric-row').forEach((row) => {
      const index = Number(row.dataset.lyricIndex);
      if (!state.lyricDraft[index]) return;
      const parsed = Lyrics.parseTime(row.querySelector('.lyric-time-input').value);
      if (Number.isFinite(parsed)) state.lyricDraft[index].time = Math.min(Number(lyricEditorTrack()?.duration) || Infinity, Math.max(0, parsed));
      state.lyricDraft[index].text = row.querySelector('.lyric-text-input').value.trim();
    });
  }

  function updateLyricRowTime(index) {
    const row = $$('#lyric-timeline .lyric-row').find((item) => Number(item.dataset.lyricIndex) === index);
    const input = row?.querySelector('.lyric-time-input');
    if (input && state.lyricDraft[index]) input.value = formatPreciseTime(state.lyricDraft[index].time);
  }

  function updateLyricTimeInputs() {
    $$('#lyric-timeline .lyric-row').forEach((row) => {
      const index = Number(row.dataset.lyricIndex);
      const input = row.querySelector('.lyric-time-input');
      if (input && state.lyricDraft[index]) input.value = formatPreciseTime(state.lyricDraft[index].time);
    });
    updateLyricEditorPlayback();
  }

  function updateLyricEditorPlayback() {
    $('#lyric-current-time').textContent = formatPreciseTime(audio.currentTime);
    $('#lyric-preview span').textContent = audio.paused ? '▶' : 'Ⅱ';
    const active = Lyrics.activeIndex(state.lyricDraft, audio.currentTime);
    if (active === state.lyricEditorActiveIndex) return;
    const rows = $$('#lyric-timeline .lyric-row');
    rows.find((row) => Number(row.dataset.lyricIndex) === state.lyricEditorActiveIndex)?.classList.remove('active');
    rows.find((row) => Number(row.dataset.lyricIndex) === active)?.classList.add('active');
    state.lyricEditorActiveIndex = active;
  }

  function addLyricLine() {
    syncLyricDraftInputs();
    const time = Number.isFinite(audio.currentTime) ? audio.currentTime : (state.lyricDraft.at(-1)?.time || 0) + 4;
    state.lyricDraft.push({ time, text: '新歌词' });
    renderLyricTimeline(state.lyricDraft.length - 1);
  }

  function autoTimeLyrics() {
    syncLyricDraftInputs();
    const texts = state.lyricDraft.map((item) => item.text).filter(Boolean);
    if (!texts.length) { toast('先添加歌词内容'); return; }
    state.lyricDraft = Lyrics.distribute(texts, lyricEditorTrack()?.duration);
    renderLyricTimeline();
    toast('已按成品实际时长均匀排布，可继续逐行微调');
  }

  function shiftLyrics(seconds) {
    syncLyricDraftInputs();
    const duration = Number(lyricEditorTrack()?.duration) || Infinity;
    state.lyricDraft.forEach((item) => { item.time = Math.min(duration, Math.max(0, item.time + seconds)); });
    updateLyricTimeInputs();
  }

  function applyCustomLyricShift() {
    const input = $('#lyric-shift-amount');
    const seconds = Math.max(-3600, Math.min(3600, Number(input.value)));
    if (!Number.isFinite(seconds) || seconds === 0) { toast('请输入 −3600 到 3600 之间的非零秒数'); return; }
    input.value = String(seconds);
    shiftLyrics(seconds);
    toast(`整段歌词已${seconds > 0 ? '延后' : '提前'} ${Math.abs(seconds)} 秒`);
  }

  async function saveLyricTimeline() {
    const track = lyricEditorTrack();
    if (!track) return;
    syncLyricDraftInputs();
    const timeline = Lyrics.sanitize(state.lyricDraft, track.duration);
    track.lyricTimeline = timeline;
    track.lyrics = Lyrics.serializeLrc(timeline);
    track.lyricsEditedAt = Date.now();
    await persistTrack(track);
    if (state.current?.id === track.id) prepareLyrics(track);
    $('#lyric-editor').close();
    renderLibrary();
    toast(`已保存 ${timeline.length} 行同步歌词`);
  }

  async function reviveTrack(track) {
    if (track.provider !== 'demo') return;
    const { wav } = Engine.generateWavBuffer(track);
    track.blob = new Blob([wav], { type: 'audio/wav' });
    track.url = URL.createObjectURL(track.blob);
    await persistTrack(track);
    renderLibrary();
    playTrack(track);
  }

  async function deleteTracks(ids, ask = true) {
    const trackIds = libraryActionIds(ids);
    const idSet = new Set(trackIds);
    const tracks = state.library.filter((track) => idSet.has(track.id));
    if (!tracks.length) return;
    const label = tracks.length === 1 ? `「${tracks[0].title}」` : `所选 ${tracks.length} 首歌曲`;
    if (ask && !window.confirm(`确定删除${label}吗？\n\n本地音频文件和歌词时间轴将一并删除，无法恢复。`)) return;
    if (state.current && idSet.has(state.current.id)) {
      audio.pause();
      audio.removeAttribute('src');
      state.current = null;
      closeNowPlaying();
      updateNowPlaying(null);
      prepareLyrics('');
    }
    tracks.forEach((track) => {
      if (track.url) URL.revokeObjectURL(track.url);
      clearCompletionNoticeTimer(track.id);
      state.librarySelection.delete(track.id);
    });
    state.library = state.library.filter((item) => !idSet.has(item.id));
    state.followQueue = state.followQueue.filter((id) => !idSet.has(id));
    state.playbackHistory = state.playbackHistory.filter((id) => !idSet.has(id));
    state.completionNotices = state.completionNotices.filter((notice) => !idSet.has(notice.trackId));
    if (Store.removeMany) await Store.removeMany(trackIds);
    else await Promise.all(trackIds.map((id) => Store.remove(id)));
    renderLibrary();
    renderCompletionNotices();
    renderGenerationQueue();
    renderPlaybackQueue();
    toast(`${tracks.length} 首歌曲已从本地曲库删除`);
  }

  function deleteTrack(track) {
    return deleteTracks([track.id]);
  }

  function audioExtension(track) {
    const mime = String(track?.blob?.type || '').toLowerCase();
    if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
    if (mime.includes('flac')) return 'flac';
    if (mime.includes('ogg')) return 'ogg';
    if (mime.includes('webm')) return 'webm';
    return 'wav';
  }

  function safeTrackName(track) {
    return String(track?.title || '音悦台作品').replace(/[\\/:*?"<>|]/g, '_').trim() || '音悦台作品';
  }

  function saveAudioBlob(track, blob, extension, existingUrl = '') {
    const anchor = document.createElement('a');
    const temporaryUrl = existingUrl || URL.createObjectURL(blob);
    anchor.href = temporaryUrl;
    anchor.download = `${safeTrackName(track)}.${extension}`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    if (!existingUrl) setTimeout(() => URL.revokeObjectURL(temporaryUrl), 1000);
  }

  function setDownloadProgress(progress = 0, label = '') {
    const element = $('#download-progress');
    element.classList.toggle('visible', Boolean(label));
    element.querySelector('span').textContent = label;
    element.querySelector('i').style.width = `${Math.max(0, Math.min(1, progress)) * 100}%`;
    $$('.download-option').forEach((button) => { button.disabled = state.downloadBusy; });
  }

  function closeDownloadMenu(force = false) {
    if (state.downloadBusy && !force) return;
    $('#download-menu').classList.remove('open');
    $('#download-menu').setAttribute('aria-hidden', 'true');
    $('#download-menu-scrim').classList.remove('open');
    if (!state.downloadBusy) state.downloadTarget = null;
  }

  function openDownloadMenu(track) {
    if (!track?.url) { toast('这首曲目的音频不可用'); return; }
    state.downloadTarget = track;
    const extension = audioExtension(track).toUpperCase();
    $('#download-menu-title').textContent = track.title || '下载音频';
    $('#download-original-label').textContent = `原始格式 · ${extension}`;
    setDownloadProgress(0, '');
    $('#download-menu').classList.add('open');
    $('#download-menu').setAttribute('aria-hidden', 'false');
    $('#download-menu-scrim').classList.add('open');
    $('#download-menu .download-option.primary').focus();
  }

  async function downloadTrack(track, format = 'original') {
    if (!track?.url || state.downloadBusy) return;
    const originalExtension = audioExtension(track);
    if (format !== 'mp3' || originalExtension === 'mp3') {
      saveAudioBlob(track, track.blob, originalExtension, track.url);
      closeDownloadMenu(true);
      toast(`已开始下载 ${originalExtension.toUpperCase()}`);
      return;
    }

    state.downloadBusy = true;
    setDownloadProgress(0.02, '准备 MP3 编码…');
    try {
      const sourceBlob = track.blob || await fetch(track.url).then((response) => {
        if (!response.ok) throw new Error(`音频读取失败 HTTP ${response.status}`);
        return response.blob();
      });
      const mp3 = await window.Mp3Exporter.encode(sourceBlob, {
        bitRate: 256,
        onProgress(progress) {
          setDownloadProgress(progress, `正在编码 MP3 · ${Math.round(progress * 100)}%`);
        },
      });
      saveAudioBlob(track, mp3, 'mp3');
      toast('MP3 已编码，开始下载');
    } catch (error) {
      console.error(error);
      toast(`MP3 导出失败：${error.message || error}`, 5200);
    } finally {
      state.downloadBusy = false;
      setDownloadProgress(1, '');
      closeDownloadMenu(true);
    }
  }

  function ensureAudioGraph() {
    if (audioContext) return;
    const Context = window.AudioContext || window.webkitAudioContext;
    audioContext = new Context();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    frequencyData = new Uint8Array(analyser.frequencyBinCount);
    sourceNode = audioContext.createMediaElementSource(audio);
    sourceNode.connect(analyser);
    analyser.connect(audioContext.destination);
  }

  function updateNowPlaying(track) {
    const title = track?.title || '还没有正在播放的歌曲';
    const model = track ? (track.provider === 'import' ? `${trackAlbum(track)} · 本地导入` : (track.modelLabel || track.presetLabel || '音悦台 Studio')) : '等待选择曲目';
    const tags = track ? String(track.tags || trackCategory(track) || track.presetLabel || '本地音乐').split(/[,，\n]/).filter(Boolean).slice(0, 4).join(' · ') : '从曲库选择一首作品开始播放';
    $('#now-title').textContent = track ? title : '还没有正在播放的曲目';
    $('#now-sub').textContent = track ? `${model} / ${formatTime(track.duration)}` : '准备好后，生成第一首作品';
    $('#transport-title').textContent = track ? title : '等待第一首作品';
    $('#transport-model').textContent = track ? (track.provider === 'import' ? `${model} · ${trackCategory(track)}` : `${model} · seed ${track.seed || '—'}`) : '音悦台 Studio';
    $('#player-title').textContent = title;
    $('#player-model').textContent = model;
    $('#player-tags').textContent = tags;
    $('#player-total-time').textContent = formatTime(track?.duration);
    $('#player-duration').textContent = track ? `实际时长 ${formatPreciseTime(track.duration)}` : '实际时长 —';
    $('#player-generation-time').textContent = track
      ? (track.provider === 'import' ? '本地导入' : `生成耗时 ${track.generationElapsedMs || track.generation?.elapsedMs ? formatElapsed(track.generationElapsedMs || track.generation?.elapsedMs) : '未记录'}`)
      : '生成耗时 —';
    applyTrackTheme($('#transport'), track);
    applyTrackTheme($('#transport-open'), track);
    applyTrackTheme($('#now-playing'), track);
    applyTrackTheme($('#player-disc-label'), track);
    $('#transport-open .cover-mark').textContent = trackCoverMark(track);
    $('#player-disc-label .cover-mark').textContent = trackCoverMark(track);
  }

  function openNowPlaying(track = null) {
    if (track && !track.url) { toast('这首曲目的音频未保留，可重新生成'); return; }
    if (track && state.current?.id !== track.id) playTrack(track);
    if (!state.current) { toast('先从曲库选择一首歌'); return; }
    const player = $('#now-playing');
    player.classList.add('open');
    player.setAttribute('aria-hidden', 'false');
    document.body.classList.add('player-expanded');
    syncLyrics(true);
  }

  function closeNowPlaying() {
    const player = $('#now-playing');
    player.classList.remove('open');
    player.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('player-expanded');
  }

  function renderCompletionNotices() {
    const container = $('#completion-notices');
    if (!container) return;
    state.completionNotices = state.completionNotices.filter((notice) => state.library.some((track) => track.id === notice.trackId)).slice(0, 3);
    container.innerHTML = state.completionNotices.map((notice) => {
      const track = state.library.find((item) => item.id === notice.trackId);
      const followed = state.followQueue.includes(track.id);
      const current = state.current?.id === track.id;
      const status = current ? '正在播放' : followed ? '已加入跟随播放' : notice.action === 'none' ? '仅提醒，不改变播放' : '未打断当前歌曲';
      const age = Math.min(COMPLETION_NOTICE_MS, Math.max(0, Date.now() - notice.createdAt));
      return `<article class="completion-card${notice.leaving ? ' leaving' : ''}" data-completion-track="${escapeHtml(track.id)}" style="--notice-delay:-${age}ms">
        <button class="completion-dismiss" data-completion-action="dismiss" aria-label="关闭提醒">×</button>
        <div class="completion-mark"><span>✓</span><i></i></div>
        <div class="completion-copy"><small>NEW TRACK READY · 8S</small><strong>${escapeHtml(track.title)}</strong><span>${escapeHtml(track.modelLabel || '音悦台 AI')} · ${formatTime(track.duration)} · ${status}</span></div>
        <div class="completion-actions"><button data-completion-action="play" ${current ? 'disabled' : ''}>${current ? '播放中' : '立即播放'}</button><button data-completion-action="follow" ${current || followed ? 'disabled' : ''}>${current ? '当前歌曲' : followed ? '已跟随' : '跟随播放'}</button></div><i class="completion-lifetime" aria-hidden="true"></i>
      </article>`;
    }).join('');
  }

  function clearCompletionNoticeTimer(trackId) {
    const timer = completionNoticeTimers.get(trackId);
    if (timer) clearTimeout(timer);
    completionNoticeTimers.delete(trackId);
  }

  function dismissCompletionNotice(trackId, animate = true) {
    clearCompletionNoticeTimer(trackId);
    const notice = state.completionNotices.find((item) => item.trackId === trackId);
    if (!notice) return;
    const remove = () => {
      state.completionNotices = state.completionNotices.filter((item) => item.trackId !== trackId);
      completionNoticeTimers.delete(trackId);
      renderCompletionNotices();
    };
    if (!animate) { remove(); return; }
    notice.leaving = true;
    renderCompletionNotices();
    completionNoticeTimers.set(trackId, setTimeout(remove, 220));
  }

  function showCompletionNotice(track, action = 'none') {
    clearCompletionNoticeTimer(track.id);
    const retainedIds = new Set([track.id, ...state.completionNotices.map((notice) => notice.trackId)].slice(0, 3));
    state.completionNotices.forEach((notice) => { if (!retainedIds.has(notice.trackId)) clearCompletionNoticeTimer(notice.trackId); });
    state.completionNotices = [{ trackId: track.id, action, createdAt: Date.now(), leaving: false }, ...state.completionNotices.filter((notice) => notice.trackId !== track.id)].slice(0, 3);
    renderCompletionNotices();
    completionNoticeTimers.set(track.id, setTimeout(() => dismissCompletionNotice(track.id), COMPLETION_NOTICE_MS));
  }

  function setCompletionPolicy(policy, announce = false) {
    const allowed = new Set(['follow', 'play', 'none']);
    state.completionPolicy = allowed.has(policy) ? policy : 'follow';
    localStorage.setItem(LS_COMPLETION_POLICY, state.completionPolicy);
    $$('[data-completion-policy]').forEach((button) => {
      const active = button.dataset.completionPolicy === state.completionPolicy;
      button.classList.toggle('active', active);
      button.setAttribute('aria-checked', String(active));
    });
    if (announce) {
      const labels = { follow: '新歌会在当前歌曲结束后紧跟播放', play: '新歌完成后会立即播放', none: '新歌只提醒，不改变播放状态' };
      toast(labels[state.completionPolicy]);
    }
  }

  function applyCompletionPolicy(track) {
    if (state.completionPolicy === 'play') { playTrack(track); return 'play'; }
    if (state.completionPolicy === 'follow') { queueTrackForFollow(track, true); return 'follow'; }
    return 'none';
  }

  function renderPlaybackQueue() {
    const validTracks = new Map(state.library.filter((track) => track.url).map((track) => [track.id, track]));
    const seen = new Set();
    state.followQueue = state.followQueue.filter((id) => {
      if (!validTracks.has(id) || id === state.current?.id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    const current = state.current?.url ? state.current : null;
    const currentContainer = $('#playback-queue-current');
    if (currentContainer) {
      currentContainer.innerHTML = current ? `<button type="button" data-playback-action="open" data-track-id="${escapeHtml(current.id)}" class="playback-current-track">
        <span class="playback-queue-cover" ${trackCoverAttributes(current)}>${trackCoverAtoms(current)}<span class="cover-mark">${escapeHtml(trackCoverMark(current))}</span></span>
        <span class="playback-queue-copy"><small>${audio.paused ? 'CURRENT TRACK' : 'NOW PLAYING'}</small><strong>${escapeHtml(current.title)}</strong><em>${escapeHtml(trackAlbum(current))} · ${formatTime(current.duration)}</em></span>
        <i>${audio.paused ? '▶' : 'Ⅱ'}</i>
      </button>` : '<div class="playback-queue-empty current-empty"><b>还没有正在播放的音乐</b><span>从曲库、专辑或生成队列开始播放</span></div>';
    }
    const queued = state.followQueue.map((id) => validTracks.get(id)).filter(Boolean);
    const list = $('#playback-queue-list');
    if (list) {
      list.innerHTML = queued.length ? queued.map((track, index) => `<article class="playback-queue-row" data-track-id="${escapeHtml(track.id)}">
        <button type="button" class="playback-queue-main" data-playback-action="play" data-track-id="${escapeHtml(track.id)}">
          <span class="playback-queue-order">${String(index + 1).padStart(2, '0')}</span>
          <span class="playback-queue-cover" ${trackCoverAttributes(track)}>${trackCoverAtoms(track)}<span class="cover-mark">${escapeHtml(trackCoverMark(track))}</span></span>
          <span class="playback-queue-copy"><strong>${escapeHtml(track.title)}</strong><em>${escapeHtml(trackAlbum(track))} · ${escapeHtml(trackCategory(track))}</em></span>
          <time>${formatTime(track.duration)}</time>
        </button>
        <button type="button" class="playback-queue-remove" data-playback-action="remove" data-track-id="${escapeHtml(track.id)}" title="从播放列表移除" aria-label="从播放列表移除 ${escapeHtml(track.title)}">×</button>
      </article>`).join('') : '<div class="playback-queue-empty"><b>待播列表为空</b><span>播放专辑或将歌曲加入跟随播放</span></div>';
    }
    const context = state.playbackContext?.label || (current ? '手动播放' : '等待选择音乐');
    if ($('#playback-queue-context')) $('#playback-queue-context').textContent = context;
    if ($('#playback-queue-total')) $('#playback-queue-total').textContent = `${queued.length} 首`;
    if ($('#playback-queue-clear')) $('#playback-queue-clear').disabled = queued.length === 0;
    [$('#transport-queue-count'), $('#player-queue-count')].forEach((element) => { if (element) element.textContent = String(queued.length); });
    [$('#transport-queue'), $('#player-queue')].forEach((button) => { if (button) button.setAttribute('aria-expanded', String($('#playback-queue')?.classList.contains('open'))); });
  }

  function togglePlaybackQueue(force) {
    const panel = $('#playback-queue');
    const open = typeof force === 'boolean' ? force : !panel.classList.contains('open');
    panel.classList.toggle('open', open);
    panel.setAttribute('aria-hidden', String(!open));
    renderPlaybackQueue();
    if (open) requestAnimationFrame(() => $('#playback-queue-close').focus({ preventScroll: true }));
  }

  function clearPlaybackQueue() {
    state.followQueue = [];
    renderPlaybackQueue();
    renderCompletionNotices();
    renderGenerationQueue();
    toast('待播列表已清空，当前歌曲会继续播放');
  }

  function playbackQueueAction(event) {
    const button = event.target.closest('[data-playback-action]');
    if (!button) return;
    const track = state.library.find((item) => item.id === button.dataset.trackId);
    if (button.dataset.playbackAction === 'remove') {
      state.followQueue = state.followQueue.filter((id) => id !== button.dataset.trackId);
      renderPlaybackQueue();
      renderCompletionNotices();
      renderGenerationQueue();
    } else if (button.dataset.playbackAction === 'play' && track) playTrack(track);
    else if (button.dataset.playbackAction === 'open' && track) openNowPlaying(track);
  }

  function playCollection(tracks, label = '播放列表') {
    const playable = (tracks || []).filter((track, index, items) => track?.url && items.findIndex((item) => item.id === track.id) === index);
    if (!playable.length) { toast('这个列表里没有可播放的歌曲'); return; }
    state.followQueue = playable.slice(1).map((track) => track.id);
    state.playbackHistory = [];
    state.playbackContext = { label, bounded: true, trackIds: playable.map((track) => track.id) };
    playTrack(playable[0], { skipHistory: true });
    toast(playable.length > 1 ? `开始播放${label} · 后续 ${playable.length - 1} 首已进入播放列表` : `正在播放「${playable[0].title}」`);
  }

  function playAlbum(track) {
    if (!track) return;
    const album = trackAlbum(track);
    playCollection(state.library.filter((item) => trackAlbum(item) === album), `专辑 · ${album}`);
  }

  function playVisibleLibrary() {
    const tracks = filteredLibrary();
    const label = state.libraryAlbum !== '*' ? `专辑 · ${state.libraryAlbum}`
      : state.libraryCategory !== '*' ? `分类 · ${state.libraryCategory}`
        : state.libraryQuery ? `搜索结果 · ${state.libraryQuery}` : '全部曲库';
    playCollection(tracks, label);
  }

  function queueTrackForFollow(track, silent = false) {
    if (!track?.url || state.current?.id === track.id || state.followQueue.includes(track.id)) return;
    state.followQueue.push(track.id);
    if (!state.playbackContext) state.playbackContext = { label: '跟随播放', bounded: true, trackIds: [] };
    renderPlaybackQueue();
    renderCompletionNotices();
    renderGenerationQueue();
    if (!silent) toast(`已加入跟随播放：${track.title}`);
  }

  function nextFollowTrack() {
    while (state.followQueue.length) {
      const id = state.followQueue.shift();
      const track = state.library.find((item) => item.id === id && item.url);
      if (track) return track;
    }
    renderCompletionNotices();
    renderGenerationQueue();
    renderPlaybackQueue();
    return null;
  }

  function completionNoticeAction(event) {
    const button = event.target.closest('[data-completion-action]');
    const card = event.target.closest('[data-completion-track]');
    if (!button || !card) return;
    const track = state.library.find((item) => item.id === card.dataset.completionTrack);
    if (button.dataset.completionAction === 'dismiss') {
      dismissCompletionNotice(card.dataset.completionTrack);
    } else if (button.dataset.completionAction === 'play' && track) playTrack(track);
    else if (button.dataset.completionAction === 'follow' && track) queueTrackForFollow(track);
  }

  function playableTracks() {
    return state.library.filter((track) => track.url);
  }

  function playAdjacent(direction, automatic = false) {
    if (direction < 0) {
      while (state.playbackHistory.length) {
        const previousId = state.playbackHistory.pop();
        const previous = state.library.find((track) => track.id === previousId && track.url);
        if (!previous) continue;
        if (state.current?.url && !state.followQueue.includes(state.current.id)) state.followQueue.unshift(state.current.id);
        playTrack(previous, { skipHistory: true });
        return true;
      }
    }
    if (direction > 0) {
      const followed = nextFollowTrack();
      if (followed) { playTrack(followed); return true; }
      if (automatic && state.playbackContext?.bounded) {
        renderPlaybackQueue();
        return false;
      }
    }
    const tracks = playableTracks();
    if (!tracks.length) { toast('曲库里还没有可播放的歌曲'); return false; }
    const currentIndex = tracks.findIndex((track) => track.id === state.current?.id);
    const nextIndex = currentIndex < 0 ? 0 : (currentIndex + direction + tracks.length) % tracks.length;
    playTrack(tracks[nextIndex]);
    return true;
  }

  function togglePlayback() {
    if (!state.current) {
      const followed = nextFollowTrack();
      if (followed) { playTrack(followed); return; }
      toast('先生成或从曲库选择一首歌');
      return;
    }
    audio.paused ? audio.play() : audio.pause();
  }

  function seekAudio(element, event) {
    if (!audio.duration) return;
    const bounds = element.getBoundingClientRect();
    audio.currentTime = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)) * audio.duration;
  }

  function playTrack(track, options = {}) {
    if (!track?.url) { toast('这首曲目的音频未保留，可重新生成'); return; }
    const changed = state.current?.id !== track.id || audio.src !== track.url;
    if (changed && state.current?.url && !options.skipHistory) {
      state.playbackHistory.push(state.current.id);
      state.playbackHistory = state.playbackHistory.slice(-80);
    }
    state.followQueue = state.followQueue.filter((id) => id !== track.id);
    state.completionNotices = state.completionNotices.filter((notice) => notice.trackId !== track.id);
    clearCompletionNoticeTimer(track.id);
    state.current = track;
    ensureAudioGraph();
    if (audioContext.state === 'suspended') audioContext.resume();
    if (changed) audio.src = track.url;
    audio.play().catch(() => toast('点击底部播放键开始试听'));
    updateNowPlaying(track);
    prepareLyrics(track);
    renderLibrary();
    renderCompletionNotices();
    renderGenerationQueue();
    renderPlaybackQueue();
  }

  function prepareLyrics(trackOrLyrics) {
    const track = trackOrLyrics && typeof trackOrLyrics === 'object' ? trackOrLyrics : null;
    const lyrics = track ? track.lyrics : trackOrLyrics;
    const timeline = Lyrics.timelineFor(lyrics, track?.duration || audio.duration, track?.lyricTimeline);
    state.lyrics = timeline.length ? timeline : [{ time: 0, text: '♪ 纯音乐 ♪' }];
    state.activeLyricIndex = -1;
    $('#lyrics-view').innerHTML = state.lyrics.map((line, index) => `<p data-index="${index}" data-time="${line.time}">${escapeHtml(line.text)}</p>`).join('');
    $('#player-lyrics').innerHTML = state.lyrics.map((line, index) => `<p data-index="${index}" data-time="${line.time}"><time>${escapeHtml(formatPreciseTime(line.time))}</time>${escapeHtml(line.text)}</p>`).join('');
  }

  function centerLyric(container, line, smooth = true) {
    if (!container || !line) return;
    const top = line.offsetTop - container.clientHeight / 2 + line.offsetHeight / 2;
    container.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' });
  }

  function syncLyrics(force = false) {
    if (!audio.duration || !state.lyrics.length) return;
    const index = Lyrics.activeIndex(state.lyrics, audio.currentTime);
    if (index < 0) {
      state.activeLyricIndex = -1;
      $$('#lyrics-view p, #player-lyrics p').forEach((line) => line.classList.remove('active'));
      return;
    }
    if (!force && index === state.activeLyricIndex) return;
    state.activeLyricIndex = index;
    $$('#lyrics-view p, #player-lyrics p').forEach((line) => line.classList.toggle('active', Number(line.dataset.index) === index));
    centerLyric($('#lyrics-view'), $('#lyrics-view p.active'), !force);
    if ($('#now-playing').classList.contains('open')) centerLyric($('#player-lyrics'), $('#player-lyrics p.active'), !force);
  }

  function startVisualizer() {
    if (visualFrame) cancelAnimationFrame(visualFrame);
    const canvas = $('#viz');
    const context = canvas.getContext('2d');
    const resize = () => {
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.floor(canvas.clientWidth * ratio);
      canvas.height = Math.floor(canvas.clientHeight * ratio);
    };
    resize();
    window.addEventListener('resize', resize);
    let phase = 0;
    const draw = () => {
      visualFrame = requestAnimationFrame(draw);
      phase += .008;
      const width = canvas.width;
      const height = canvas.height;
      context.clearRect(0, 0, width, height);
      if (analyser) analyser.getByteFrequencyData(frequencyData);
      const points = 80;
      context.beginPath();
      for (let index = 0; index <= points; index++) {
        const x = index / points * width;
        const energy = analyser ? frequencyData[Math.min(frequencyData.length - 1, index)] / 255 : 0;
        const idle = Math.sin(index * .32 + phase * 20) * 5;
        const y = height * .72 + idle + (energy - .15) * height * .15;
        index ? context.lineTo(x, y) : context.moveTo(x, y);
      }
      context.strokeStyle = document.body.classList.contains('playing') ? 'rgba(111,228,213,.55)' : 'rgba(214,255,85,.14)';
      context.lineWidth = Math.max(1, window.devicePixelRatio || 1);
      context.stroke();
    };
    draw();
  }

  function connectionConfig() {
    return {
      comfyBase: $('#comfy-base').value.trim(),
      comfyCmd: $('#comfy-cmd').value.trim(),
      comfyCwd: $('#comfy-cwd').value.trim(),
    };
  }

  function loadConnectionConfig() {
    try {
      const config = JSON.parse(localStorage.getItem(LS_CONFIG) || '{}');
      if (config.comfyBase) $('#comfy-base').value = config.comfyBase;
      if (config.comfyCmd) $('#comfy-cmd').value = config.comfyCmd;
      if (config.comfyCwd) $('#comfy-cwd').value = config.comfyCwd;
    } catch (_) {}
  }

  function saveConnectionConfig() {
    localStorage.setItem(LS_CONFIG, JSON.stringify(connectionConfig()));
  }

  async function refreshStatus() {
    if (state.statusBusy) return;
    state.statusBusy = true;
    try {
      state.status = await Sidecar.status();
      const config = state.status;
      if (document.activeElement !== $('#comfy-base') && config.comfy?.base) $('#comfy-base').value = config.comfy.base;
      if (!$('#comfy-cmd').value && config.comfy?.cmd) $('#comfy-cmd').value = config.comfy.cmd;
      if (!$('#comfy-cwd').value && config.comfy?.cwd) $('#comfy-cwd').value = config.comfy.cwd;
    } catch (error) {
      state.status = null;
    } finally {
      state.statusBusy = false;
      updateRuntimeUI();
    }
    if (state.activeView === 'models' || ['installing', 'updating', 'starting'].includes(state.status?.local?.phase)) refreshRuntimeLogs();
  }

  function setStateElement(element, mode, text, detail) {
    if (!element) return;
    element.classList.remove('ready', 'busy', 'error');
    if (mode) element.classList.add(mode);
    const textNode = element.querySelector('span') || element.querySelector('strong');
    if (textNode) textNode.textContent = text;
    const small = element.querySelector('small');
    if (small) small.textContent = detail || '';
  }

  function selectedPack() {
    return state.status?.local?.packs?.find((pack) => pack.id === state.localModelId) || null;
  }

  function selectedRemote() {
    return state.status?.remote?.providers?.find((provider) => provider.id === state.remoteProviderId) || null;
  }

  function packPresentation(pack, runtime) {
    if (!pack || !runtime) return { mode: 'error', text: '桌面服务未连接', detail: '' };
    if (!pack.supported) return { mode: 'error', text: '当前系统不支持', detail: '需要 Apple Silicon Mac' };
    if (pack.active || (runtime.phase === 'installing' && runtime.activePack === pack.id)) return { mode: 'busy', text: `正在安装 ${pack.label}`, detail: '可在右侧查看日志' };
    if (runtime.generating && runtime.activeGenerationModel === pack.id) return { mode: 'busy', text: '正在生成', detail: '可在创作台停止当前任务' };
    if (runtime.phase === 'updating') return { mode: 'busy', text: '正在更新运行时', detail: '' };
    if (!pack.installed && pack.removable) return { mode: 'error', text: '发现未完成的模型文件', detail: '可卸载清理后重新安装' };
    if (!pack.installed) return { mode: '', text: '尚未安装', detail: `${formatBytes(pack.downloadBytes)} 下载` };
    if (pack.runtime === 'minimax-mlx' && runtime.music3MlxWorker?.running) {
      return {
        mode: runtime.music3MlxWorker.warm ? 'ready' : 'busy',
        text: runtime.music3MlxWorker.warm ? '常驻服务在线' : '正在载入模型',
        detail: `${runtime.music3MlxWorker.pid ? `PID ${runtime.music3MlxWorker.pid} · ` : ''}停止后可释放模型内存`,
      };
    }
    if (pack.runtime !== 'comfy') return { mode: 'ready', text: '已安装，按需运行', detail: pack.runtime === 'minimax-mlx' ? '生成时自动启动 MLX 服务' : '任务结束后自动退出，无常驻服务' };
    if (runtime.ready) return { mode: 'ready', text: '已安装，引擎在线', detail: runtime.managed ? `PID ${runtime.pid}` : '已有本地进程' };
    if (runtime.running || runtime.phase === 'starting') return { mode: 'busy', text: '正在启动共享引擎', detail: '首次启动可能需要几分钟' };
    return { mode: '', text: '已安装，等待启动', detail: '点击“启动共享引擎”' };
  }

  function glyphFor(id) {
    return ({ 'minimax-music-3': 'M3', 'minimax-music-3-mlx': 'M3', 'stable-audio-open-1.0': 'S1', 'stable-audio-3': 'S3', 'ace-step-1.0': 'A1', 'ace-step-1.5': 'A1.5' })[id] || 'AI';
  }

  function selectLocalModel(id, syncStudio = false) {
    state.localModelId = id;
    $$('.family-leaf').forEach((button) => button.classList.toggle('active', button.dataset.localModel === id));
    if (syncStudio) {
      $('#model').value = Models.byId(id).id;
      selectModel(id);
    }
    renderLocalModel();
  }

  function renderLocalModel() {
    const runtime = state.status?.local;
    const pack = selectedPack();
    if (!pack) return;
    $$('.family-leaf').forEach((button) => {
      const item = runtime?.packs?.find((candidate) => candidate.id === button.dataset.localModel);
      button.classList.toggle('installed', Boolean(item?.installed));
    });
    $('#local-model-glyph').textContent = glyphFor(pack.id);
    $('#local-model-title').textContent = pack.label;
    const music3Profile = pack.id === 'minimax-music-3' ? runtime?.music3Profile : null;
    $('#local-model-method').textContent = music3Profile
      ? `ComfyUI · DiT ${music3Profile.diffusionPrecision} · 文本编码 ${music3Profile.textEncoderPrecision}`
      : pack.method;
    $('#local-model-description').textContent = pack.description;
    const view = packPresentation(pack, runtime);
    setStateElement($('#local-model-status'), view.mode, view.text, view.detail);
    const busy = ['installing', 'updating'].includes(runtime?.phase) || runtime?.generating || Boolean(runtime?.activePack);
    const recoverableInstall = Boolean(!pack.installed && pack.removable);
    $('#local-model-install').disabled = Boolean(pack.installed || !pack.supported || busy);
    $('#local-model-install').textContent = pack.installed ? '模型已安装' : !pack.supported ? '当前系统不支持' : recoverableInstall ? '继续安装 · 保留断点' : '安装所选模型';
    $('#local-model-install').title = recoverableInstall ? '继续使用已经下载的断点；完整性校验通过后才会安装' : '';
    const showRecovery = recoverableInstall || runtime?.phase === 'error';
    $('#local-recovery-hint').classList.toggle('hidden', !showRecovery);
    $('#local-recovery-hint p').textContent = recoverableInstall
      ? '安装没有完成，已下载的断点仍然保留。点击继续安装会从断点恢复；反复失败时可复制诊断。'
      : '本地运行时最近一次操作失败。可复制诊断信息后再重试。';
    $('#local-copy-diagnostics').classList.toggle('hidden', !showRecovery);
    const isComfyRuntime = pack.runtime === 'comfy';
    const isMusic3Mlx = pack.runtime === 'minimax-mlx';
    const mlxServiceRunning = Boolean(isMusic3Mlx && runtime?.music3MlxWorker?.running);
    const startButton = $('#local-engine-start');
    const stopButton = $('#local-engine-stop');
    startButton.disabled = Boolean(!isComfyRuntime || !runtime?.runtimeInstalled || runtime?.ready || runtime?.running || busy);
    startButton.textContent = isComfyRuntime ? '启动共享引擎' : isMusic3Mlx ? '生成时自动启动' : '按任务自动启动';
    startButton.title = isComfyRuntime ? '启动供 MiniMax Comfy、Stable Audio 1.0 与 ACE-Step 共用的 ComfyUI 服务' : '原生 MLX 模型会在提交生成任务时自动启动';
    stopButton.disabled = Boolean(busy || (isComfyRuntime ? !runtime?.managed : isMusic3Mlx ? !mlxServiceRunning : true));
    stopButton.textContent = isComfyRuntime ? '停止共享引擎' : isMusic3Mlx ? (mlxServiceRunning ? '停止并释放内存' : '服务未运行') : '无需停止';
    stopButton.title = isComfyRuntime
      ? runtime?.ready && !runtime?.managed ? '当前是外部 ComfyUI，请在原来的终端中停止' : '停止音悦台托管的共享 ComfyUI 服务'
      : isMusic3Mlx ? (mlxServiceRunning ? '停止 MiniMax Music 3 MLX 常驻服务并释放权重内存' : '服务会在生成时自动启动')
        : '这个模型按任务启动，生成结束后进程会自动退出';
    $('#local-engine-update').disabled = Boolean((!runtime?.runtimeInstalled && !state.status?.local?.packs?.some((item) => ['stable-audio-3', 'minimax-music-3-mlx'].includes(item.id) && item.installed)) || runtime?.running || runtime?.generating || busy);
    const uninstall = $('#local-model-uninstall');
    const comfyInUse = pack.runtime === 'comfy' && Boolean(runtime?.ready || runtime?.running);
    uninstall.disabled = Boolean(!pack.removable || busy || comfyInUse);
    uninstall.textContent = pack.installed ? '卸载模型' : pack.removable ? '清理残留' : '没有本地文件';
    uninstall.title = comfyInUse ? '请先停止共享本地引擎' : pack.installed ? `删除 ${pack.label} 的本地文件` : pack.removable ? '删除未完成的安装文件' : '';
    const progress = pack.progress || (runtime?.activePack === pack.id ? runtime.progress : null);
    $('#local-model-progress').classList.toggle('hidden', !progress);
    if (progress) {
      const percent = progress.indeterminate ? 35 : Math.min(100, Math.round(progress.received / Math.max(1, progress.total) * 100));
      $('#local-model-progress span').style.width = `${percent}%`;
      $('#local-model-progress p').textContent = progress.indeterminate
        ? `${progress.file} · ${progress.downloader === 'curl' ? '代理感知断点下载器正在传输' : progress.downloader === 'huggingface-hub' ? 'Hugging Face 官方分块下载器正在传输' : '官方安装器正在处理依赖和权重'}${progress.sourceLabel ? ` · ${progress.sourceLabel}` : ''}`
        : `${progress.fileIndex}/${progress.fileCount} · ${progress.file} · ${formatBytes(progress.received)} / ${formatBytes(progress.total)}${progress.sourceLabel ? ` · ${progress.sourceLabel}` : ''}${progress.retryAttempt ? ` · 正在重连 ${progress.retryAttempt}/${progress.retryLimit}` : ''}`;
    }
    $('#local-model-license').innerHTML = `${escapeHtml(pack.space)} · 下载约 ${formatBytes(pack.downloadBytes)}。安装即表示你接受 <a href="${escapeHtml(pack.license)}" target="_blank" rel="noreferrer">对应模型许可</a>。`;
  }

  function selectRemoteProvider(id, populate = true) {
    state.remoteProviderId = id;
    $$('.remote-provider-button').forEach((button) => button.classList.toggle('active', button.dataset.remoteProvider === id));
    const provider = selectedRemote();
    if (!provider) return;
    $('#remote-provider-title').textContent = provider.label;
    $('#remote-provider-description').textContent = provider.description;
    $('#remote-custom-paths').classList.toggle('hidden', provider.adapter !== 'custom');
    const modelSuggestions = $('#remote-model-suggestions');
    const modelInput = $('#remote-model');
    if (provider.adapter === 'minimax') {
      modelInput.setAttribute('list', 'remote-model-suggestions');
      modelSuggestions.innerHTML = '<option value="music-2.6-free">所有 API Key · 较低 RPM</option><option value="music-2.6">付费 / Token Plan · 较高 RPM</option>';
    } else {
      modelInput.removeAttribute('list');
      modelSuggestions.innerHTML = '';
    }
    if (populate) {
      $('#remote-base-url').value = provider.baseUrl || '';
      $('#remote-model').value = provider.model || '';
      $('#remote-submit-path').value = provider.submitPath || '/api/generate';
      $('#remote-status-path').value = provider.statusPath || '/api/get?ids={id}';
      $('#remote-api-key').value = '';
    }
    updateRemoteModelHint();
    $('#remote-key-hint').textContent = provider.keyMigrationRequired ? '更新后需重新输入一次' : provider.keyHint || '尚未配置';
    setStateElement($('#remote-provider-state'), provider.configured ? 'ready' : '', provider.configured ? '配置已保存' : provider.keyMigrationRequired ? '请重新输入 API Key 完成安全迁移' : '尚未配置');
  }

  function updateRemoteModelHint() {
    const hint = $('#remote-model-hint');
    if (!hint) return;
    const provider = selectedRemote();
    if (provider?.adapter !== 'minimax') { hint.textContent = ''; return; }
    const model = $('#remote-model').value.trim();
    hint.textContent = model === 'music-2.6'
      ? '付费 / Token Plan；权限不足会自动回退免费模型'
      : model === 'music-2.6-free' || !model ? '所有 API Key 可用' : '请确认当前 Key 具有该模型权限';
  }

  function showModelSource(source) {
    $$('.model-source-tab').forEach((button) => button.classList.toggle('active', button.dataset.modelSource === source));
    $$('[data-model-source-panel]').forEach((panel) => panel.classList.toggle('active', panel.dataset.modelSourcePanel === source));
  }

  function openCurrentModelSettings() {
    const model = state.model || Models.byId($('#model')?.value);
    showView('models');
    const source = model.source === 'remote' ? 'remote' : model.source === 'local' ? 'local' : 'builtin';
    showModelSource(source);
    let target = null;
    if (source === 'local') {
      selectLocalModel(model.id, false);
      target = $(`.family-leaf[data-local-model="${model.id}"]`);
    } else if (source === 'remote') {
      selectRemoteProvider(model.remoteId, true);
      target = $(`.remote-provider-button[data-remote-provider="${model.remoteId}"]`);
    } else {
      target = $('[data-model-source-panel="builtin"]');
    }
    requestAnimationFrame(() => target?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' }));
  }

  function smartEngineMeta(id) {
    return state.status?.smart?.engines?.find((item) => item.id === id) || ({
      ollama: { id: 'ollama', label: 'Ollama 本地 API', description: '通过本机 Ollama API 调用你已安装的大语言模型，创作内容不离开设备。' },
      openai: { id: 'openai', label: 'OpenAI-compatible API', description: '连接支持 Chat Completions 的模型 API；服务地址、模型名和可选 Key 均由你配置。' },
    })[id];
  }

  function showSmartEngineFields(engine, populate = false) {
    $('#smart-service-fields').classList.remove('hidden');
    $('#smart-key-field').classList.toggle('hidden', engine !== 'openai');
    $('#smart-clear-key').classList.toggle('hidden', engine !== 'openai');
    $('#smart-engine-description').textContent = smartEngineMeta(engine)?.description || '';
    if (populate) {
      const config = state.status?.smart?.configs?.[engine]
        || (state.status?.smart?.engine === engine ? state.status.smart : null);
      $('#smart-base-url').value = config?.baseUrl || (engine === 'ollama' ? 'http://127.0.0.1:11434' : 'https://api.openai.com/v1');
      $('#smart-model').value = config?.model || (engine === 'ollama' ? 'qwen3:4b' : 'gpt-4.1-mini');
      $('#smart-api-key').value = '';
    }
  }

  function renderSmartSettings() {
    const smart = state.status?.smart;
    if (!smart) return;
    const focused = $('.smart-settings-form')?.contains(document.activeElement);
    if (!focused) {
      $('#smart-engine').value = smart.engine;
      showSmartEngineFields(smart.engine, true);
    } else showSmartEngineFields($('#smart-engine').value, false);
    const meta = smartEngineMeta(smart.engine);
    $('#smart-engine-label').textContent = smart.configured ? `${meta?.label || smart.engine} · 已配置` : smart.keyMigrationRequired ? '智能模型需重新输入 Key' : '智能模型未配置';
    $('#smart-key-hint').textContent = smart.keyHint || '可选 / 尚未配置';
    const text = smart.configured ? `${meta?.label || smart.engine} 已配置` : smart.keyMigrationRequired ? '请重新输入一次 API Key 完成安全迁移' : '等待配置模型 API';
    setStateElement($('#smart-config-state'), smart.configured ? 'ready' : '', text);
  }

  function openSmartSettings() {
    showView('models');
    showModelSource('smart');
    setTimeout(() => $('#smart-engine').focus(), 120);
  }

  function setSmartComposerOpen(active, focus = false) {
    $('#smart-composer').classList.toggle('active', active);
    $('#smart-mode-toggle').setAttribute('aria-expanded', String(active));
    localStorage.setItem(LS_SMART_OPEN, active ? '1' : '0');
    if (active && focus) $('#smart-idea').focus();
  }

  function smartConfig(clearKey = false) {
    return {
      engine: $('#smart-engine').value,
      baseUrl: $('#smart-base-url').value.trim(),
      model: $('#smart-model').value.trim(),
      apiKey: $('#smart-api-key').value.trim(),
      clearKey,
    };
  }

  async function saveSmart(testAfterSave = false, clearKey = false) {
    await runtimeAction(async () => {
      await Sidecar.configSmart(smartConfig(clearKey));
      if (testAfterSave) await Sidecar.testSmart();
      return { ok: true };
    }, clearKey ? '智能创作 API Key 已清除' : testAfterSave ? '智能创作服务连接成功' : '智能创作配置已保存');
    $('#smart-api-key').value = '';
  }

  function smartFieldSpecs(model = state.model) {
    if (!model) return [];
    const has = (field) => model.fields.includes(field);
    return [
      { id: 'title', label: '歌名', selector: '#song-title', active: true },
      { id: 'description', label: '音乐描述', selector: '#prompt', active: has('prompt') },
      { id: 'negativePrompt', label: '排除内容', selector: '#neg', active: has('negativePrompt') },
      { id: 'tags', label: '风格标签', selector: '#tags', active: has('tags') },
      { id: 'lyrics', label: '歌词', selector: '#lyrics', active: has('lyrics') },
      { id: 'duration', label: '时长', selector: '#duration', pulse: '#slider-duration', active: has('duration'), numeric: true },
      { id: 'steps', label: '采样', selector: '#steps', pulse: '#slider-steps', active: has('steps'), numeric: true },
      { id: 'cfg', label: '遵循度', selector: '#cfg', pulse: '#slider-cfg', active: has('cfg'), numeric: true },
      { id: 'bpm', label: 'BPM', selector: '#ace-bpm', active: has('bpm'), numeric: true, parameter: true },
      { id: 'keyscale', label: '调式', selector: '#ace-keyscale', active: has('keyscale'), parameter: true },
      { id: 'timesignature', label: '拍号', selector: '#ace-timesignature', active: has('timesignature'), parameter: true },
      { id: 'language', label: '语言', selector: '#ace-language', active: has('language'), parameter: true },
    ].filter((item) => item.active);
  }

  function smartFieldIds(model = state.model) {
    if (!model) return [];
    const fields = new Set(model.fields || []);
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

  function activeSmartLocks(model = state.model) {
    const active = new Set(smartFieldIds(model));
    return new Set([...state.smartLockedFields].filter((id) => active.has(id)));
  }

  function persistSmartLocks() {
    localStorage.setItem(LS_SMART_LOCKS, JSON.stringify([...state.smartLockedFields]));
  }

  function loadSmartLocks() {
    try {
      const saved = JSON.parse(localStorage.getItem(LS_SMART_LOCKS) || '[]');
      state.smartLockedFields = new Set(Array.isArray(saved) ? saved.map(String) : []);
    } catch (_) { state.smartLockedFields = new Set(); }
  }

  function toggleSmartLock(fieldId) {
    if (!smartFieldIds().includes(fieldId)) return;
    if (state.smartLockedFields.has(fieldId)) state.smartLockedFields.delete(fieldId);
    else state.smartLockedFields.add(fieldId);
    state.smartChangedFields = state.smartChangedFields.filter((id) => id !== fieldId);
    persistSmartLocks();
    renderSmartImpact();
  }

  function clearSmartLocks() {
    if (!activeSmartLocks().size) return;
    state.smartLockedFields.clear();
    state.smartChangedFields = [];
    persistSmartLocks();
    renderSmartImpact();
    toast('智能字段已全部解锁');
  }

  function renderSmartImpact() {
    const container = $('#smart-impact');
    if (!container) return;
    const changed = new Set(state.smartChangedFields);
    const locked = activeSmartLocks();
    $('#smart-unlock-all')?.classList.toggle('hidden', locked.size === 0);
    const specs = smartFieldSpecs();
    const contentIds = new Set(['title', 'description', 'negativePrompt', 'tags', 'lyrics']);
    const contentLabels = specs.filter((spec) => contentIds.has(spec.id)).map((spec) => spec.label);
    const parameterLabels = specs.filter((spec) => spec.numeric || spec.parameter).map((spec) => spec.label);
    $('#smart-impact-title').textContent = `${state.model?.label || '当前模型'} · 内容联动`;
    $('#smart-impact-summary').textContent = `${contentLabels.join(' · ')}${parameterLabels.length ? ` · ${parameterLabels.join(' · ')}` : ''}：未锁定即全部改写`;
    container.innerHTML = specs.map((spec) => {
      const value = $(spec.selector)?.value?.trim?.() || '';
      const isLocked = locked.has(spec.id);
      const effect = isLocked ? '已锁定' : '改写';
      const icon = isLocked ? '▣' : changed.has(spec.id) ? '✓' : '↗';
      const kind = contentIds.has(spec.id) ? 'content-field' : 'parameter-field';
      return `<button type="button" data-smart-lock="${escapeHtml(spec.id)}" class="${kind} ${isLocked ? 'locked' : changed.has(spec.id) ? 'changed' : ''}" aria-pressed="${isLocked}" title="${isLocked ? `解锁${escapeHtml(spec.label)}` : `锁定${escapeHtml(spec.label)}，智能模式不会修改`}\"><i>${icon}</i>${escapeHtml(spec.label)}<small>${effect}</small></button>`;
    }).join('');
    $('#smart-last-change').textContent = changed.size
      ? `刚刚更新：${specs.filter((spec) => changed.has(spec.id)).map((spec) => spec.label).join('、')}`
      : locked.size
        ? `已锁定：${specs.filter((spec) => locked.has(spec.id)).map((spec) => spec.label).join('、')} · 仅协助优化其他字段`
        : '所有未锁定槽位都会改写 · ⌘ Enter';
  }

  function smartExistingFromParams(params, model = state.model, includeTitle = true) {
    const has = (field) => model.fields.includes(field);
    return {
      title: includeTitle ? normalizeSongTitle(params.title) : '',
      description: has('prompt') ? String(params.prompt || '').trim() : '',
      negativePrompt: has('negativePrompt') ? String(params.negativePrompt || '').trim() : '',
      tags: has('tags') ? String(params.tags || '').trim() : '',
      lyrics: has('lyrics') ? String(params.lyrics || '').trim() : '',
      duration: Number(params.duration),
      steps: Number(params.steps),
      cfg: Number(params.cfg),
      bpm: Number(params.bpm),
      keyscale: String(params.keyscale || ''),
      timesignature: String(params.timesignature || ''),
      language: String(params.language || ''),
    };
  }

  function pulseSmartFields(selectors) {
    selectors.forEach((selector) => {
      const element = $(selector);
      if (!element) return;
      element.classList.remove('smart-filled');
      void element.offsetWidth;
      element.classList.add('smart-filled');
      setTimeout(() => element.classList.remove('smart-filled'), 900);
    });
  }

  function applySmartDraftToForm(draft, lockedFields = activeSmartLocks()) {
    const changed = [];
    const pulses = [];
    const specs = smartFieldSpecs();
    const byId = Object.fromEntries(specs.map((spec) => [spec.id, spec]));
    const setText = (id, value) => {
      const spec = byId[id];
      if (!spec || lockedFields.has(id) || value === undefined || value === null) return;
      const element = $(spec.selector);
      const next = String(value);
      if (element.value !== next) {
        element.value = next;
        element.dispatchEvent(new Event('input', { bubbles: true }));
        changed.push(id);
        pulses.push(spec.pulse || spec.selector);
      }
    };
    setText('title', draft.title || '');
    setText('description', draft.description || '');
    setText('negativePrompt', draft.negativePrompt || '');
    setText('tags', Array.isArray(draft.tags) ? draft.tags.join('，') : (draft.tags || ''));
    setText('lyrics', draft.lyrics || '');
    setText('keyscale', draft.keyscale);
    setText('timesignature', draft.timesignature);
    setText('language', draft.language);
    ['duration', 'steps', 'cfg'].forEach((id) => {
      const spec = byId[id];
      if (!spec || lockedFields.has(id) || !Number.isFinite(Number(draft[id]))) return;
      const before = Number($(spec.selector).value);
      applySmartRange(id, draft[id]);
      if (Number($(spec.selector).value) !== before) { changed.push(id); pulses.push(spec.pulse); }
    });
    const bpmSpec = byId.bpm;
    if (bpmSpec && !lockedFields.has('bpm') && Number.isFinite(Number(draft.bpm))) {
      const element = $(bpmSpec.selector);
      const before = Number(element.value);
      element.value = String(Math.max(Number(element.min || 30), Math.min(Number(element.max || 300), Math.round(Number(draft.bpm)))));
      element.dispatchEvent(new Event('input', { bubbles: true }));
      if (Number(element.value) !== before) { changed.push('bpm'); pulses.push(bpmSpec.selector); }
    }
    updateProjectTitle($('#song-title').value);
    state.smartChangedFields = [...new Set(changed)];
    pulseSmartFields([...new Set(pulses)]);
    renderSmartImpact();
    scheduleCreationDraftSave();
    return specs.filter((spec) => state.smartChangedFields.includes(spec.id)).map((spec) => spec.label);
  }

  function smartRange(id) {
    const element = $(`#${id}`);
    return [Number(element.min), Number(element.max), Number(element.step)];
  }

  function applySmartRange(id, value) {
    const element = $(`#${id}`);
    const number = Number(value);
    if (!Number.isFinite(number)) return;
    element.value = String(Math.max(Number(element.min), Math.min(Number(element.max), number)));
    updateRangeLabel(id);
  }

  async function completeSmartDraft() {
    if (state.smartBusy) return;
    const idea = $('#smart-idea').value.trim();
    if (idea.length < 2) { toast('先说一句你想写什么样的歌'); return; }
    if (!state.status?.smart?.configured) {
      toast('请先配置并测试智能模型 API', 4800);
      openSmartSettings();
      return;
    }
    const lockedFields = activeSmartLocks();
    if (smartFieldIds().every((id) => lockedFields.has(id))) {
      toast('当前模型的全部内容都已锁定，无需运行智能模式');
      return;
    }
    state.smartBusy = true;
    const button = $('#smart-complete');
    button.disabled = true;
    button.querySelector('span').textContent = '正在生成…';
    try {
      const params = readParams();
      const existing = smartExistingFromParams(params);
      const hadExisting = Boolean(existing.title || existing.description || existing.negativePrompt || existing.tags || existing.lyrics);
      const result = await Sidecar.completeSmart({
        idea,
        model: { id: state.model?.id, label: state.model?.label, fields: state.model?.fields || [], playbook: smartPlaybookFor(state.model, params) },
        existing,
        lockedFields: [...lockedFields],
        ranges: { duration: smartRange('duration'), steps: smartRange('steps'), cfg: smartRange('cfg'), bpm: [30, 300, 1] },
      });
      const draft = result.draft;
      const changed = applySmartDraftToForm(draft, lockedFields);
      const repairNote = Array.isArray(draft.warnings) && draft.warnings.length ? ` · ${draft.warnings.join('；')}` : '';
      const expectedChanges = smartFieldSpecs().filter((spec) => !lockedFields.has(spec.id)).length;
      if (changed.length !== expectedChanges) throw new Error(`未锁定槽位应全部改写，实际只更新了 ${changed.length}/${expectedChanges} 个`);
      toast(`${hadExisting ? '已改写全部未锁定槽位' : '创作单已生成并填满全部槽位'}：${changed.join('、')} · ${smartEngineMeta(draft.engine)?.label || draft.engine}${repairNote}`, repairNote ? 7200 : 5200);
    } catch (error) {
      toast(`智能补全失败：${error.message || error}`, 5200);
    } finally {
      state.smartBusy = false;
      button.disabled = false;
      button.querySelector('span').textContent = '生成 / 改写';
    }
  }

  function updateRuntimeUI() {
    const local = state.status?.local;
    const appVersion = String(state.status?.app?.version || '').trim();
    if (appVersion) {
      $('#app-version').textContent = `v${appVersion}`;
      $('#app-version').title = `当前版本 v${appVersion}`;
      document.title = `音悦台 Studio · v${appVersion}`;
    }
    const packForStudio = local?.packs?.find((pack) => pack.id === state.model?.id);
    const remoteForStudio = state.status?.remote?.providers?.find((provider) => provider.id === state.model?.remoteId);
    let mode = 'ready';
    let text = '即时可用';
    if (state.model?.source === 'local') {
      const view = packPresentation(packForStudio, local);
      mode = view.mode || (packForStudio?.installed ? 'ready' : 'error');
      text = state.model?.id === 'minimax-music-3-mlx' && local?.music3MlxWorker?.running
        ? local.music3MlxWorker.warm ? 'MLX 服务在线' : 'MLX 正在载入'
        : packForStudio?.runtime !== 'comfy' && packForStudio?.installed ? 'MLX 本地可用'
        : packForStudio?.installed && local?.ready ? '本地引擎在线'
          : packForStudio?.active ? '正在安装' : packForStudio?.installed ? '等待启动' : '需安装';
    } else if (state.model?.source === 'remote') {
      mode = remoteForStudio?.configured ? 'ready' : 'error';
      text = remoteForStudio?.configured ? '远端已配置' : '需配置 Key';
    }
    const badge = $('#model-badge');
    badge.className = `badge model-badge-link ${mode}`;
    badge.querySelector('span').textContent = text;
    badge.title = `打开「${state.model?.label || '当前模型'}」设置`;
    badge.setAttribute('aria-label', badge.title);
    setStateElement($('#global-engine'), mode, `${state.model?.label || '模型'} · ${text}`);
    $('#global-engine').title = badge.title;
    $('#global-engine').setAttribute('aria-label', badge.title);
    setStateElement($('#studio-engine-state'), mode, text);
    $('#studio-model-glyph').textContent = state.model?.source === 'remote' ? 'API' : glyphFor(state.model?.id);
    $('#studio-model-name').textContent = state.model?.label || '选择模型';
    const music3Profile = state.model?.id === 'minimax-music-3' ? local?.music3Profile : null;
    $('#studio-model-method').textContent = state.model?.source === 'remote' ? '远端 API · 用户凭据'
      : music3Profile ? `本地权重 · DiT ${music3Profile.diffusionPrecision} / 编码 ${music3Profile.textEncoderPrecision}`
        : packForStudio?.runtime === 'minimax-mlx' ? 'Apple MLX · MXFP8 原生推理'
        : state.model?.source === 'local' ? '本地权重 · 本机推理' : '内置即时合成器';
    $('#studio-model-source').textContent = state.model?.source === 'remote' ? '远端' : '本机';
    $('#studio-model-privacy').textContent = state.model?.source === 'remote' ? '用户 API Key' : '不需要 Key';
    $('#studio-model-config').textContent = state.model?.source === 'remote' ? '远端 API' : state.model?.source === 'local' ? '本地部署' : '无需配置';
    setStateElement($('#comfy-state'), state.status?.comfy?.ready ? 'ready' : '', state.status?.comfy?.ready ? '外部 ComfyUI 已连接' : '外部 ComfyUI 未连接');
    const hardware = state.status?.hardware;
    if (hardware) $('#hardware-profile').innerHTML = `<span>${escapeHtml(hardware.cpu)}</span><span>${hardware.memoryGb}GB RAM</span><span>${escapeHtml(hardware.accelerator)}</span><span>${escapeHtml(hardware.recommendation)}</span>`;
    renderMiniMaxSpeedProfile();
    renderLocalModel();
    $$('.remote-provider-button').forEach((button) => {
      const provider = state.status?.remote?.providers?.find((item) => item.id === button.dataset.remoteProvider);
      button.classList.toggle('configured', Boolean(provider?.configured));
    });
    const remoteFormFocused = $('.remote-detail')?.contains(document.activeElement);
    selectRemoteProvider(state.remoteProviderId, !remoteFormFocused);
    renderSmartSettings();
  }

  async function refreshRuntimeLogs() {
    try {
      const lines = await Sidecar.logs('local', 160);
      const log = $('#local-runtime-logs');
      log.textContent = lines.length ? lines.join('\n') : '等待操作…';
      log.scrollTop = log.scrollHeight;
    } catch (_) {}
  }

  async function runtimeAction(action, successMessage) {
    try {
      const result = await action();
      if (result?.ok === false) throw new Error(result.error || '操作失败');
      toast(typeof successMessage === 'function' ? successMessage(result) : successMessage);
      await refreshStatus();
    } catch (error) {
      toast(error.message || String(error), 5000);
    }
  }

  async function copyLocalDiagnostics() {
    const pack = selectedPack();
    const runtime = state.status?.local || {};
    const logs = $('#local-runtime-logs')?.textContent?.trim() || '没有运行日志';
    const diagnostics = [
      `音悦台 Studio v${state.status?.app?.version || 'unknown'}`,
      `模型：${pack?.label || state.localModelId}`,
      `状态：${runtime.phase || 'unknown'}`,
      `系统：${state.status?.hardware?.chip || navigator.platform} · ${state.status?.hardware?.memory || ''}`,
      '',
      logs.slice(-16000),
    ].join('\n');
    try {
      await navigator.clipboard.writeText(diagnostics);
    } catch (_) {
      const area = document.createElement('textarea');
      area.value = diagnostics;
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    toast('模型诊断信息已复制');
  }

  async function uninstallSelectedModel() {
    const pack = selectedPack();
    if (!pack?.removable) { toast('这个模型没有可卸载的本地文件'); return; }
    const scope = pack.runtime === 'comfy'
      ? '只删除该模型的权重；共享 ComfyUI 运行时和其他模型会保留。'
      : '删除该模型的权重和专用运行环境。';
    const estimate = pack.downloadBytes ? `\n预计可释放约 ${formatBytes(pack.downloadBytes)}。` : '';
    if (!window.confirm(`确定卸载「${pack.label}」吗？\n\n${scope}${estimate}\n\n此操作不能撤销，需要时必须重新下载安装。`)) return;
    await runtimeAction(() => Sidecar.uninstallLocalModel(pack.id), `${pack.label} 已卸载`);
  }

  function remoteConfig(clearKey = false) {
    return {
      baseUrl: $('#remote-base-url').value.trim(), model: $('#remote-model').value.trim(),
      apiKey: $('#remote-api-key').value.trim(), clearKey,
      submitPath: $('#remote-submit-path').value.trim(), statusPath: $('#remote-status-path').value.trim(),
    };
  }

  async function saveRemote(testAfterSave = false, clearKey = false) {
    await runtimeAction(async () => {
      await Sidecar.configRemote(state.remoteProviderId, remoteConfig(clearKey));
      if (testAfterSave) await Sidecar.testRemote(state.remoteProviderId);
      return { ok: true };
    }, clearKey ? 'API Key 已清除' : testAfterSave ? '远端服务连接成功' : '远端配置已安全保存');
    $('#remote-api-key').value = '';
  }

  async function testComfy() {
    saveConnectionConfig();
    await runtimeAction(async () => {
      await Sidecar.configComfy(connectionConfig());
      await makeComfyUIProvider({ proxyBase: '/comfy' }).testConnection();
      return { ok: true };
    }, '外部 ComfyUI 连接成功');
  }

  async function startComfy() {
    saveConnectionConfig();
    await runtimeAction(() => Sidecar.startComfy(connectionConfig()), '已请求启动 ComfyUI，正在等待就绪');
  }

  function exportWorkflow() {
    if (!state.model?.buildPrompt) { toast('当前模型没有 ComfyUI 工作流可导出'); return; }
    const workflow = state.model.buildPrompt(readParams());
    const blob = new Blob([JSON.stringify(workflow, null, 2)], { type: 'application/json' });
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(blob);
    anchor.download = `${state.model.id}_api_workflow.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(anchor.href), 1000);
    toast('已导出当前 API 工作流');
  }

  function bindEvents() {
    $('.composer-module').addEventListener('input', (event) => {
      if (event.target.matches('input, textarea, select')) scheduleCreationDraftSave();
    });
    $('.composer-module').addEventListener('change', (event) => {
      if (event.target.matches('input, textarea, select')) scheduleCreationDraftSave();
    });
    $$('.nav-item[data-view]').forEach((button) => button.addEventListener('click', () => showView(button.dataset.view)));
    $$('[data-view-jump]').forEach((button) => button.addEventListener('click', () => showView(button.dataset.viewJump)));
    $('#model-badge').addEventListener('click', openCurrentModelSettings);
    $('#global-engine').addEventListener('click', openCurrentModelSettings);
    $('#manage-current-model').addEventListener('click', openCurrentModelSettings);
    $('#model').addEventListener('change', (event) => selectModel(event.target.value));
    $('#ace-long-mode')?.addEventListener('change', () => {
      localStorage.setItem(LS_ACE_STRATEGY_V2, '1');
      state.smartChangedFields = [];
      renderSmartImpact();
      renderAceSegmentPlan();
    });
    $('#song-title').addEventListener('input', (event) => updateProjectTitle(event.target.value));
    $('#generate').addEventListener('click', generate);
    $('#stop-generation').addEventListener('click', stopGeneration);
    $('#generation-queue').addEventListener('click', queueAction);
    $('#queue-resume').addEventListener('click', resumeSavedQueue);
    $('#queue-clear').addEventListener('click', clearFinishedJobs);
    $('#continuous-toggle').addEventListener('click', toggleContinuousGeneration);
    $('#completion-notices').addEventListener('click', completionNoticeAction);
    $('#completion-policy').addEventListener('click', (event) => {
      const button = event.target.closest('[data-completion-policy]');
      if (button) setCompletionPolicy(button.dataset.completionPolicy, true);
    });
    $('#smart-mode-toggle').addEventListener('click', () => {
      setSmartComposerOpen(!$('#smart-composer').classList.contains('active'), true);
    });
    $('#smart-complete').addEventListener('click', completeSmartDraft);
    $('#smart-unlock-all').addEventListener('click', clearSmartLocks);
    $('#new-draft').addEventListener('click', resetCreationDraft);
    $('#smart-impact').addEventListener('click', (event) => {
      const button = event.target.closest('[data-smart-lock]');
      if (button) toggleSmartLock(button.dataset.smartLock);
    });
    $('#smart-configure').addEventListener('click', openSmartSettings);
    $('#smart-idea').addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        completeSmartDraft();
      }
    });
    ['song-title', 'prompt', 'neg', 'tags', 'lyrics', 'ace-bpm', 'ace-keyscale', 'ace-timesignature', 'ace-language'].forEach((id) => $(`#${id}`)?.addEventListener('input', () => {
      state.smartChangedFields = [];
      renderSmartImpact();
      if (id === 'lyrics') renderAceSegmentPlan();
    }));
    $('#creation-album-trigger').addEventListener('click', openCreationAlbumPicker);
    $('#album-picker-search').addEventListener('input', (event) => renderAlbumPickerResults(event.target.value));
    $('#album-picker-results').addEventListener('click', (event) => {
      const option = event.target.closest('[data-album-name]');
      if (option) chooseCreationAlbum(option.dataset.albumName).catch((error) => toast(error.message));
    });
    $('#album-create-option').addEventListener('click', () => {
      chooseCreationAlbum($('#album-picker-search').value, true).catch((error) => toast(`新建专辑失败：${error.message}`));
    });
    $('#album-picker-dialog').addEventListener('close', () => $('#creation-album-trigger').setAttribute('aria-expanded', 'false'));
    $('#smart-engine').addEventListener('change', (event) => showSmartEngineFields(event.target.value, true));
    $('#smart-save').addEventListener('click', () => saveSmart(false, false));
    $('#smart-test').addEventListener('click', () => saveSmart(true, false));
    $('#smart-clear-key').addEventListener('click', () => saveSmart(false, true));
    $('#randseed').addEventListener('click', () => { $('#seed').value = String((Math.random() * 4294967296) >>> 0); scheduleCreationDraftSave(); });
    ['duration', 'steps', 'cfg', 'reference-strength'].forEach(bindRangeEditor);
    $('#minimax-speed-profile').addEventListener('click', (event) => {
      const button = event.target.closest('[data-minimax-speed]');
      if (button) applyMiniMaxSpeedProfile(button.dataset.minimaxSpeed);
    });
    $('#reference-import').addEventListener('click', () => {
      $('#library-file-input').dataset.reference = '1';
      $('#library-file-input').click();
    });
    $('#reference-picker-trigger').addEventListener('click', openReferencePicker);
    $('#reference-search').addEventListener('input', (event) => renderReferenceResults(event.target.value));
    $('#reference-results').addEventListener('click', (event) => {
      const option = event.target.closest('[data-reference-id]');
      if (option) selectReferenceTrack(option.dataset.referenceId);
    });
    $('#reference-clear').addEventListener('click', () => selectReferenceTrack(''));
    $('#reference-picker-dialog').addEventListener('close', () => $('#reference-picker-trigger').setAttribute('aria-expanded', 'false'));
    $$('.chip').forEach((chip) => chip.addEventListener('click', () => {
      const target = state.model?.fields.includes('prompt') ? $('#prompt') : $('#tags');
      const value = target.value.trim();
      target.value = value ? `${value}，${chip.dataset.tag}` : chip.dataset.tag;
      target.dispatchEvent(new Event('input', { bubbles: true }));
    }));
    document.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); generate(); }
      if (event.key === 'Escape' && !$('#track-context-menu').classList.contains('hidden')) { event.preventDefault(); hideTrackContextMenu(); }
      else if (event.key === 'Escape' && $('#playback-queue').classList.contains('open')) { event.preventDefault(); togglePlaybackQueue(false); }
      else if (event.key === 'Escape' && $('#download-menu').classList.contains('open')) { event.preventDefault(); closeDownloadMenu(); }
      else if (event.key === 'Escape' && $('#now-playing').classList.contains('open')) { event.preventDefault(); closeNowPlaying(); }
      else if (event.key === 'Escape' && state.generating) { event.preventDefault(); stopGeneration(); }
    });
    document.addEventListener('pointerdown', (event) => {
      if (!event.target.closest('#track-context-menu')) hideTrackContextMenu();
      if ($('#playback-queue').classList.contains('open') && !event.target.closest('#playback-queue, #transport-queue, #player-queue')) togglePlaybackQueue(false);
    });
    window.addEventListener('resize', hideTrackContextMenu);
    window.addEventListener('beforeunload', (event) => {
      persistCreationDraft();
      persistGenerationQueue();
      if (state.generationQueue.some((job) => ['running', 'stopping'].includes(job.status))) {
        event.preventDefault();
        event.returnValue = '';
      }
    });
    $('.workspace').addEventListener('scroll', hideTrackContextMenu, { passive: true });

    $$('.model-source-tab').forEach((button) => button.addEventListener('click', () => showModelSource(button.dataset.modelSource)));
    $$('.family-leaf').forEach((button) => button.addEventListener('click', () => selectLocalModel(button.dataset.localModel, true)));
    $$('.remote-provider-button').forEach((button) => button.addEventListener('click', () => {
      selectRemoteProvider(button.dataset.remoteProvider, true);
      const modelId = `remote-${button.dataset.remoteProvider}`;
      $('#model').value = Models.byId(modelId).id;
      selectModel(modelId);
    }));
    $('#local-model-install').addEventListener('click', () => runtimeAction(() => Sidecar.installLocalModel(state.localModelId), `${selectedPack()?.label || '模型'} 部署任务已开始`));
    $('#local-model-uninstall').addEventListener('click', uninstallSelectedModel);
    $('#local-engine-start').addEventListener('click', () => runtimeAction(() => Sidecar.startLocal(), '正在启动共享本地引擎'));
    $('#local-engine-stop').addEventListener('click', () => runtimeAction(
      () => Sidecar.stopLocalModel(state.localModelId),
      (result) => result?.message || `${selectedPack()?.label || '本地模型'} 服务已停止`,
    ));
    $('#local-engine-update').addEventListener('click', () => runtimeAction(() => Sidecar.updateLocal(), '运行时更新任务已开始'));
    $('#local-copy-diagnostics').addEventListener('click', copyLocalDiagnostics);
    $('#remote-save').addEventListener('click', () => saveRemote(false, false));
    $('#remote-test').addEventListener('click', () => saveRemote(true, false));
    $('#remote-clear-key').addEventListener('click', () => saveRemote(false, true));
    $('#remote-model').addEventListener('input', updateRemoteModelHint);
    $('#comfy-test').addEventListener('click', testComfy);
    $('#comfy-start').addEventListener('click', startComfy);
    $('#comfy-stop').addEventListener('click', () => runtimeAction(() => Sidecar.stopComfy(), 'ComfyUI 已停止'));
    $('#export-workflow').addEventListener('click', exportWorkflow);

    $('#library').addEventListener('click', (event) => {
      if (event.target.closest('[data-library-action="import"]')) {
        $('#library-file-input').dataset.reference = '0';
        $('#library-file-input').click();
        return;
      }
      if (event.target.closest('[data-library-action="studio"]')) { showView('studio'); return; }
      const trackElement = event.target.closest('.track');
      if (!trackElement) return;
      const track = state.library.find((item) => item.id === trackElement.dataset.id);
      if (!track) return;
      const action = event.target.closest('button')?.dataset.action;
      if (action === 'select') toggleLibrarySelection(track.id, event.shiftKey);
      else if (action === 'play') playTrack(track);
      else if (action === 'play-album') playAlbum(track);
      else if (action === 'revive') reviveTrack(track);
      else if (action === 'open') openNowPlaying(track);
      else if (action === 'download') openDownloadMenu(track);
      else if (action === 'detail') openTrackDetail(track);
      else if (action === 'edit') openTrackEditor(track);
      else if (action === 'delete') deleteTrack(track);
      else playTrack(track);
    });
    $('#library').addEventListener('contextmenu', (event) => {
      const trackElement = event.target.closest('.track');
      if (!trackElement) return;
      const track = state.library.find((item) => item.id === trackElement.dataset.id);
      if (track) openTrackContextMenu(event, track);
    });
    $('#track-context-menu').addEventListener('click', handleTrackContextAction);
    $('#library-select-all').addEventListener('click', toggleVisibleLibrarySelection);
    $('#library-selection-clear').addEventListener('click', clearLibrarySelection);
    $('#library-batch-play').addEventListener('click', () => playLibraryTracks([...state.librarySelection]));
    $('#library-batch-album').addEventListener('click', () => openLibraryAlbumDialog([...state.librarySelection]));
    $('#library-batch-category').addEventListener('click', () => openLibraryCategoryDialog([...state.librarySelection]));
    $('#library-batch-delete').addEventListener('click', () => deleteTracks([...state.librarySelection]));
    $('#library-album-search').addEventListener('input', (event) => renderLibraryAlbumResults(event.target.value));
    $('#library-album-results').addEventListener('click', (event) => {
      const option = event.target.closest('[data-library-album-name]');
      if (option) moveLibraryTracksToAlbum(option.dataset.libraryAlbumName).catch((error) => toast(`迁移失败：${error.message}`));
    });
    $('#library-album-create').addEventListener('click', () => {
      moveLibraryTracksToAlbum($('#library-album-search').value).catch((error) => toast(`迁移失败：${error.message}`));
    });
    $('#library-category-dialog form').addEventListener('submit', (event) => saveLibraryCategory(event).catch((error) => toast(`分类更新失败：${error.message}`)));
    $('#library-import').addEventListener('click', () => {
      $('#library-file-input').dataset.reference = '0';
      $('#library-file-input').click();
    });
    $('#library-new-album').addEventListener('click', createAlbum);
    $('#album-edit-save').addEventListener('click', saveAlbum);
    $('#library-file-input').addEventListener('change', async (event) => {
      const useAsReference = event.target.dataset.reference === '1';
      try { await importAudioFiles(event.target.files, useAsReference); }
      catch (error) { console.error(error); toast(`导入失败：${error.message || error}`, 5200); }
      finally { event.target.value = ''; event.target.dataset.reference = '0'; }
    });
    $('.library-facets').addEventListener('click', (event) => {
      const button = event.target.closest('[data-library-filter]');
      if (!button) return;
      if (button.dataset.libraryFilter === 'album') state.libraryAlbum = button.dataset.filterValue;
      else state.libraryCategory = button.dataset.filterValue;
      renderLibrary();
    });
    $('#track-edit-save').addEventListener('click', saveTrackEditor);
    $('#track-editor').addEventListener('close', () => { state.editingTrackId = null; });
    $('#track-detail').addEventListener('close', () => { state.detailTrackId = null; });
    $('#library-album-dialog').addEventListener('close', () => { state.libraryAlbumMoveIds = []; });
    $('#library-category-dialog').addEventListener('close', () => { state.libraryCategoryIds = []; });
    $('#lyric-editor').addEventListener('close', () => { state.lyricTrackId = null; state.lyricDraft = []; state.lyricEditorActiveIndex = -1; });
    $$('[data-dialog-close]').forEach((button) => button.addEventListener('click', () => $(`#${button.dataset.dialogClose}`).close()));
    $('#track-detail-copy').addEventListener('click', copyTrackParameters);
    $('#track-detail-lyrics').addEventListener('click', () => {
      const track = state.library.find((item) => item.id === state.detailTrackId);
      $('#track-detail').close();
      if (track) openLyricEditor(track);
    });
    $('#library-search').addEventListener('input', (event) => {
      state.libraryQuery = event.target.value.trim();
      renderLibrary();
    });
    $('#library-play-all').addEventListener('click', playVisibleLibrary);

    $('#play-toggle').addEventListener('click', togglePlayback);
    $('#player-play').addEventListener('click', togglePlayback);
    $('#transport-prev').addEventListener('click', () => playAdjacent(-1));
    $('#player-prev').addEventListener('click', () => playAdjacent(-1));
    $('#transport-next').addEventListener('click', () => playAdjacent(1));
    $('#player-next').addEventListener('click', () => playAdjacent(1));
    $('#transport-queue').addEventListener('click', () => togglePlaybackQueue());
    $('#player-queue').addEventListener('click', () => togglePlaybackQueue());
    $('#playback-queue-close').addEventListener('click', () => togglePlaybackQueue(false));
    $('#playback-queue-clear').addEventListener('click', clearPlaybackQueue);
    $('#playback-queue').addEventListener('click', playbackQueueAction);
    $('#transport-open').addEventListener('click', () => openNowPlaying());
    $('#transport-copy').addEventListener('click', () => openNowPlaying());
    $('#player-expand').addEventListener('click', () => openNowPlaying());
    $('#player-close').addEventListener('click', closeNowPlaying);
    $('#player-params').addEventListener('click', () => state.current ? openTrackDetail(state.current) : toast('请先选择一首曲目'));
    $('#player-lyrics-edit').addEventListener('click', () => openLyricEditor(state.current));
    $('#seek').addEventListener('click', (event) => seekAudio($('#seek'), event));
    $('#player-seek').addEventListener('click', (event) => seekAudio($('#player-seek'), event));
    $('#player-lyrics').addEventListener('click', (event) => {
      const line = event.target.closest('p[data-index]');
      if (!line || !audio.duration) return;
      audio.currentTime = Math.max(0, Math.min(audio.duration, Number(line.dataset.time) || 0));
    });
    $('#lyric-preview').addEventListener('click', togglePlayback);
    $('#lyric-auto-time').addEventListener('click', autoTimeLyrics);
    $('#lyric-add-line').addEventListener('click', addLyricLine);
    $('#lyric-save').addEventListener('click', saveLyricTimeline);
    $('.lyric-batch-tools').addEventListener('click', (event) => {
      const button = event.target.closest('[data-lyric-shift]');
      if (button) shiftLyrics(Number(button.dataset.lyricShift));
    });
    $('#lyric-shift-apply').addEventListener('click', applyCustomLyricShift);
    $('#lyric-shift-amount').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); applyCustomLyricShift(); }
    });
    $('#lyric-timeline').addEventListener('input', (event) => {
      const row = event.target.closest('.lyric-row');
      const index = Number(row?.dataset.lyricIndex);
      if (!state.lyricDraft[index]) return;
      if (event.target.classList.contains('lyric-text-input')) state.lyricDraft[index].text = event.target.value;
      else if (event.target.classList.contains('lyric-time-input')) {
        const parsed = Lyrics.parseTime(event.target.value);
        if (Number.isFinite(parsed)) state.lyricDraft[index].time = Math.min(Number(lyricEditorTrack()?.duration) || Infinity, Math.max(0, parsed));
      }
    });
    $('#lyric-timeline').addEventListener('change', (event) => {
      if (!event.target.classList.contains('lyric-time-input')) return;
      const row = event.target.closest('.lyric-row');
      const index = Number(row?.dataset.lyricIndex);
      const parsed = Lyrics.parseTime(event.target.value);
      if (!Number.isFinite(parsed)) { toast('时间戳格式应为 00:12.34'); updateLyricRowTime(index); return; }
      state.lyricDraft[index].time = Math.min(Number(lyricEditorTrack()?.duration) || Infinity, Math.max(0, parsed));
      event.target.value = formatPreciseTime(state.lyricDraft[index].time);
    });
    $('#lyric-timeline').addEventListener('click', (event) => {
      const button = event.target.closest('[data-lyric-action]');
      if (!button) return;
      const row = button.closest('.lyric-row');
      const index = Number(row?.dataset.lyricIndex);
      const item = state.lyricDraft[index];
      if (!item) return;
      const action = button.dataset.lyricAction;
      if (action === 'seek') {
        if (audio.duration) audio.currentTime = Math.min(audio.duration, item.time);
        audio.play().catch(() => {});
      } else if (action === 'stamp') {
        item.time = Math.max(0, Math.min(Number(lyricEditorTrack()?.duration) || Infinity, audio.currentTime || 0));
        updateLyricRowTime(index);
        updateLyricEditorPlayback();
      } else if (action === 'nudge') {
        item.time = Math.max(0, Math.min(Number(lyricEditorTrack()?.duration) || Infinity, item.time + Number(button.dataset.value)));
        updateLyricRowTime(index);
        updateLyricEditorPlayback();
      } else if (action === 'delete') {
        state.lyricDraft.splice(index, 1);
        renderLyricTimeline();
      }
    });
    $('#download-current').addEventListener('click', () => state.current ? openDownloadMenu(state.current) : toast('还没有可下载的曲目'));
    $('#player-download').addEventListener('click', () => state.current ? openDownloadMenu(state.current) : toast('还没有可下载的曲目'));
    $('#download-menu').addEventListener('click', (event) => {
      const option = event.target.closest('[data-download-format]');
      if (option && state.downloadTarget) downloadTrack(state.downloadTarget, option.dataset.downloadFormat);
    });
    $('#download-menu-close').addEventListener('click', () => closeDownloadMenu());
    $('#download-menu-scrim').addEventListener('click', () => closeDownloadMenu());

    audio.addEventListener('timeupdate', () => {
      const ratio = audio.duration ? audio.currentTime / audio.duration : 0;
      $('#seekbar').style.width = `${ratio * 100}%`;
      $('#player-seekbar').style.width = `${ratio * 100}%`;
      $('#time').textContent = `${formatTime(audio.currentTime)} / ${formatTime(audio.duration)}`;
      $('#player-current-time').textContent = formatTime(audio.currentTime);
      $('#player-total-time').textContent = formatTime(audio.duration);
      syncLyrics();
      if ($('#lyric-editor').open) updateLyricEditorPlayback();
    });
    audio.addEventListener('loadedmetadata', async () => {
      const track = state.current;
      if (!track || !Number.isFinite(audio.duration) || audio.duration <= 0 || Math.abs(audio.duration - (Number(track.duration) || 0)) < 0.05) return;
      track.duration = audio.duration;
      if (track.generation?.output) track.generation.output.duration = audio.duration;
      await persistTrack(track);
      updateNowPlaying(track);
      prepareLyrics(track);
      renderLibrary();
    });
    audio.addEventListener('play', () => {
      document.body.classList.add('playing');
      $('#play-toggle').textContent = 'Ⅱ';
      $('#player-play').textContent = 'Ⅱ';
      updateLyricEditorPlayback();
      renderPlaybackQueue();
    });
    audio.addEventListener('pause', () => {
      document.body.classList.remove('playing');
      $('#play-toggle').textContent = '▶';
      $('#player-play').textContent = '▶';
      updateLyricEditorPlayback();
      renderPlaybackQueue();
    });
    audio.addEventListener('ended', () => {
      if (!playAdjacent(1, true)) {
        document.body.classList.remove('playing');
        $('#play-toggle').textContent = '▶';
        $('#player-play').textContent = '▶';
        renderPlaybackQueue();
      }
    });
  }

  async function init() {
    if (window.desktopShell?.isDesktop) {
      document.body.classList.add('desktop', window.desktopShell.platform || 'desktop');
    }
    buildModelSelect();
    loadSmartLocks();
    setCompletionPolicy(localStorage.getItem(LS_COMPLETION_POLICY) || 'follow');
    $('#creation-album').value = cleanFacet(localStorage.getItem(LS_CREATION_ALBUM), 'AI 作品');
    syncCreationAlbumTrigger();
    loadConnectionConfig();
    selectModel($('#model').value);
    const restoredDraft = restoreCreationDraft();
    state.draftReady = true;
    if (!restoredDraft) setDraftStatus('自动保存已开启');
    bindEvents();
    setSmartComposerOpen(localStorage.getItem(LS_SMART_OPEN) !== '0');
    renderSmartImpact();
    updateNowPlaying(null);
    const restoredJobCount = restoreGenerationQueue();
    showModelSource(state.model.source === 'remote' ? 'remote' : state.model.source === 'local' ? 'local' : 'builtin');
    startVisualizer();
    await Promise.all([loadLibrary(), refreshStatus()]);
    if (restoredJobCount && state.generationQueue.some((job) => ['queued', 'interrupted'].includes(job.status))) {
      toast('已恢复生成队列：等待项可点“继续队列”，中断项可点“重试”', 7500);
    }
    if (state.draftRestored) toast('已恢复上次未完成的创作单');
    renderPlaybackQueue();
    setInterval(refreshStatus, 4000);
    setInterval(() => {
      if (state.generationQueue.some((job) => ['running', 'stopping'].includes(job.status))) renderGenerationQueue();
    }, 1000);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
