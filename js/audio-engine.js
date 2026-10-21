/*
 * 音悦台 · 音频引擎 (Audio Engine)
 * -------------------------------------------------------------
 * 纯 JavaScript 程序化音乐合成 + WAV 编码。
 * 设计目标：既能在浏览器里运行（离线 Demo 合成器），
 * 也能在 Node 里被测试（无 Web Audio 依赖，全部直接写 PCM 采样）。
 *
 * 参数与 ComfyUI ACE-Step 工作流一一映射：
 *   - tags(风格标签) → 曲风预设（BPM/音阶/和声/配器）
 *   - lyrics(歌词)   → 旋律乐句种子 + 卡拉OK字幕
 *   - duration(秒)   → 曲目长度（EmptyAceStepLatentAudio）
 *   - steps          → 采样步数 → 旋律密度 / 层次细化
 *   - cfg            → 提示词遵循度 → 曲风纯度 / 清晰度
 *   - seed           → 可复现随机种子（KSampler seed）
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.AudioEngine = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- 可复现随机数 (mulberry32) --------------------------------
  function makeRng(seed) {
    let a = (seed >>> 0) || 0x9e3779b9;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hashString(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);

  // ---- 音阶 & 和声 ----------------------------------------------
  const SCALES = {
    major: [0, 2, 4, 5, 7, 9, 11],
    minor: [0, 2, 3, 5, 7, 8, 10],
    dorian: [0, 2, 3, 5, 7, 9, 10],
    pentaMinor: [0, 3, 5, 7, 10],
    pentaMajor: [0, 2, 4, 7, 9],
  };

  const CHORD = { maj: [0, 4, 7], min: [0, 3, 7], sus: [0, 5, 7], maj7: [0, 4, 7, 11], min7: [0, 3, 7, 10] };

  // 曲风预设：由风格标签关键词命中
  const PRESETS = {
    pop: {
      label: '流行 Pop', bpm: 112, keyRoot: 60, scale: 'major',
      progression: [['maj', 0], ['maj', 7], ['min', 9], ['maj', 5]],
      brightness: 0.9, drums: 1.0, reverb: 0.25, waves: { pad: 'saw', lead: 'square', bass: 'saw' },
    },
    lofi: {
      label: 'Lo-Fi 慵懒', bpm: 78, keyRoot: 57, scale: 'dorian',
      progression: [['min7', 0], ['maj7', 8], ['maj7', 3], ['min7', 10]],
      brightness: 0.45, drums: 0.6, reverb: 0.4, swing: 0.18, waves: { pad: 'tri', lead: 'sine', bass: 'sine' },
    },
    ambient: {
      label: '氛围 Ambient', bpm: 64, keyRoot: 55, scale: 'pentaMajor',
      progression: [['maj7', 0], ['maj7', 5], ['maj7', 7], ['maj7', 2]],
      brightness: 0.6, drums: 0.0, reverb: 0.7, waves: { pad: 'sine', lead: 'sine', bass: 'sine' },
    },
    cinematic: {
      label: '电影感 Cinematic', bpm: 88, keyRoot: 50, scale: 'minor',
      progression: [['min', 0], ['maj', 8], ['maj', 3], ['maj', 10]],
      brightness: 0.7, drums: 0.5, reverb: 0.6, waves: { pad: 'saw', lead: 'saw', bass: 'saw' },
    },
    edm: {
      label: '电子舞曲 EDM', bpm: 128, keyRoot: 57, scale: 'minor',
      progression: [['min', 0], ['maj', 10], ['maj', 8], ['maj', 5]],
      brightness: 1.0, drums: 1.2, reverb: 0.3, waves: { pad: 'saw', lead: 'saw', bass: 'square' },
    },
    rock: {
      label: '摇滚 Rock', bpm: 120, keyRoot: 52, scale: 'minor',
      progression: [['min', 0], ['maj', 5], ['maj', 7], ['min', 0]],
      brightness: 0.85, drums: 1.1, reverb: 0.2, waves: { pad: 'saw', lead: 'saw', bass: 'saw' },
    },
    jazz: {
      label: '爵士 Jazz', bpm: 96, keyRoot: 58, scale: 'dorian',
      progression: [['min7', 0], ['maj7', 5], ['min7', 2], ['maj7', 7]],
      brightness: 0.65, drums: 0.7, reverb: 0.35, swing: 0.25, waves: { pad: 'tri', lead: 'sine', bass: 'sine' },
    },
    chill: {
      label: '轻松 Chill', bpm: 90, keyRoot: 60, scale: 'pentaMajor',
      progression: [['maj', 0], ['min', 9], ['maj', 5], ['maj', 7]],
      brightness: 0.6, drums: 0.7, reverb: 0.45, waves: { pad: 'tri', lead: 'sine', bass: 'sine' },
    },
  };

  const KEYWORDS = [
    [/lo-?fi|慵懒|放松/i, 'lofi'],
    [/ambient|氛围|冥想|空灵/i, 'ambient'],
    [/cinematic|电影|史诗|epic|配乐/i, 'cinematic'],
    [/edm|电子|舞曲|techno|house|synth/i, 'edm'],
    [/rock|摇滚|金属|metal|punk/i, 'rock'],
    [/jazz|爵士|blues|布鲁斯/i, 'jazz'],
    [/chill|轻松|治愈|散步/i, 'chill'],
    [/pop|流行|抒情|ballad/i, 'pop'],
  ];

  function presetForTags(tags) {
    const text = String(tags || '');
    for (const [re, key] of KEYWORDS) {
      if (re.test(text)) return Object.assign({ key }, PRESETS[key]);
    }
    return Object.assign({ key: 'pop' }, PRESETS.pop);
  }

  // ---- 声部合成 --------------------------------------------------
  function addNote(buf, startSample, durSamples, freq, sr, gain, opts) {
    opts = opts || {};
    const wave = opts.wave || 'sine';
    const bright = opts.brightness == null ? 0.7 : opts.brightness;
    const a = (opts.attack || 0.01) * sr;
    const d = (opts.decay || 0.1) * sr;
    const s = opts.sustain == null ? 0.7 : opts.sustain;
    const r = (opts.release || 0.15) * sr;
    const detune = opts.detune || 0;
    const partials = Math.max(1, Math.round(1 + bright * 10));
    const end = Math.min(buf.length, startSample + durSamples + r);
    const twoPi = Math.PI * 2;
    const f2 = freq * Math.pow(2, detune / 1200);
    for (let n = startSample, i = 0; n < end; n++, i++) {
      // ADSR 包络
      let env;
      if (i < a) env = i / a;
      else if (i < a + d) env = 1 - (1 - s) * ((i - a) / d);
      else if (i < durSamples) env = s;
      else env = s * Math.max(0, 1 - (i - durSamples) / r);
      if (env <= 0) continue;
      const t = n / sr;
      let sample = 0;
      for (let p = 1; p <= partials; p++) {
        let amp;
        if (wave === 'sine') { amp = p === 1 ? 1 : 0; }
        else if (wave === 'saw') { amp = 1 / p; }
        else if (wave === 'square') { amp = p % 2 ? 1 / p : 0; }
        else { amp = p % 2 ? 1 / (p * p) : 0; } // tri
        if (amp === 0) continue;
        sample += amp * Math.sin(twoPi * f2 * p * t);
        if (detune) sample += 0.6 * amp * Math.sin(twoPi * freq * p * t);
      }
      buf[n] += sample * env * gain;
    }
  }

  function addKick(buf, start, sr, gain) {
    const dur = Math.floor(0.18 * sr);
    for (let i = 0; i < dur && start + i < buf.length; i++) {
      const t = i / sr;
      const env = Math.exp(-t * 22);
      const freq = 120 * Math.exp(-t * 30) + 45;
      buf[start + i] += Math.sin(2 * Math.PI * freq * t) * env * gain;
    }
  }

  function addSnare(buf, start, sr, gain, rng) {
    const dur = Math.floor(0.16 * sr);
    for (let i = 0; i < dur && start + i < buf.length; i++) {
      const t = i / sr;
      const env = Math.exp(-t * 28);
      const noise = rng() * 2 - 1;
      const tone = Math.sin(2 * Math.PI * 185 * t);
      buf[start + i] += (noise * 0.7 + tone * 0.3) * env * gain;
    }
  }

  function addHat(buf, start, sr, gain, rng) {
    const dur = Math.floor(0.05 * sr);
    let prev = 0;
    for (let i = 0; i < dur && start + i < buf.length; i++) {
      const t = i / sr;
      const env = Math.exp(-t * 90);
      const noise = rng() * 2 - 1;
      const hp = noise - prev; // 粗糙高通
      prev = noise;
      buf[start + i] += hp * env * gain;
    }
  }

  // ---- 轻量混响 (Schroeder) --------------------------------------
  function reverb(input, sr, mix) {
    if (mix <= 0) return input;
    const out = new Float32Array(input.length);
    const combs = [0.0297, 0.0371, 0.0411, 0.0437].map((d) => ({
      buf: new Float32Array(Math.floor(d * sr)), idx: 0, fb: 0.78,
    }));
    for (let i = 0; i < input.length; i++) {
      let wet = 0;
      for (const c of combs) {
        const v = c.buf[c.idx];
        wet += v;
        c.buf[c.idx] = input[i] + v * c.fb;
        c.idx = (c.idx + 1) % c.buf.length;
      }
      wet /= combs.length;
      out[i] = input[i] * (1 - mix) + wet * mix;
    }
    return out;
  }

  // ---- 主合成流程 ------------------------------------------------
  function synthesize(params) {
    const sr = params.sampleRate || 44100;
    const duration = Math.max(3, Math.min(120, params.duration || 20));
    const preset = params.preset || presetForTags(params.tags);
    const seedBase = (params.seed >>> 0) ^ hashString(String(params.tags || '') + '|' + String(params.lyrics || ''));
    const rng = makeRng(seedBase);

    // steps → 旋律密度；cfg → 曲风纯度（越高越贴合、失真越少）
    const steps = Math.max(1, params.steps || 24);
    const cfg = params.cfg == null ? 5 : params.cfg;
    const density = Math.min(1, 0.35 + (steps / 60) + rng() * 0.1);
    const purity = Math.min(1, Math.max(0.3, cfg / 9));

    const total = Math.floor(duration * sr);
    const left = new Float32Array(total);
    const right = new Float32Array(total);

    const bpm = preset.bpm;
    const beat = 60 / bpm;
    const barBeats = 4;
    const bar = beat * barBeats;
    const swing = (preset.swing || 0) * (1 - purity + 0.5);

    const scale = SCALES[preset.scale];
    const prog = preset.progression;
    const wantDrums = preset.drums > 0;

    const totalBars = Math.ceil(duration / bar);

    for (let b = 0; b < totalBars; b++) {
      const barStart = b * bar;
      if (barStart >= duration) break;
      const chord = prog[b % prog.length];
      const quality = chord[0];
      const rootOffset = chord[1];
      const rootMidi = preset.keyRoot + rootOffset;
      const tones = CHORD[quality];

      // 段落能量：intro 弱 → 主歌/副歌强 → 结尾收
      const posN = barStart / duration;
      let energy = 1;
      if (posN < 0.12) energy = 0.55 + posN * 3.5;
      if (posN > 0.86) energy = Math.max(0.4, 1 - (posN - 0.86) * 4);

      // Pad / 和声铺底
      for (const tone of tones) {
        const m = rootMidi + tone + 12;
        addNote(left, Math.floor(barStart * sr), Math.floor(bar * sr), midiToFreq(m), sr,
          0.09 * energy, { wave: preset.waves.pad, brightness: preset.brightness * 0.6, attack: 0.4, decay: 0.6, sustain: 0.8, release: 0.5, detune: -6 });
        addNote(right, Math.floor(barStart * sr), Math.floor(bar * sr), midiToFreq(m), sr,
          0.09 * energy, { wave: preset.waves.pad, brightness: preset.brightness * 0.6, attack: 0.4, decay: 0.6, sustain: 0.8, release: 0.5, detune: 6 });
      }

      // Bass 每拍
      for (let bt = 0; bt < barBeats; bt++) {
        const t = barStart + bt * beat;
        if (t >= duration) break;
        const bassMidi = rootMidi - 12 + (bt % 2 === 0 ? 0 : tones[1]);
        const gain = 0.22 * energy;
        addNote(left, Math.floor(t * sr), Math.floor(beat * 0.9 * sr), midiToFreq(bassMidi), sr, gain,
          { wave: preset.waves.bass, brightness: 0.35, attack: 0.005, decay: 0.12, sustain: 0.6, release: 0.08 });
        addNote(right, Math.floor(t * sr), Math.floor(beat * 0.9 * sr), midiToFreq(bassMidi), sr, gain,
          { wave: preset.waves.bass, brightness: 0.35, attack: 0.005, decay: 0.12, sustain: 0.6, release: 0.08 });
      }

      // Lead 旋律（八分音符，密度受 steps 控制）
      for (let e = 0; e < barBeats * 2; e++) {
        if (rng() > density * energy) continue;
        const sw = e % 2 === 1 ? swing * beat : 0;
        const t = barStart + e * (beat / 2) + sw;
        if (t >= duration) break;
        const degree = Math.floor(rng() * scale.length);
        const oct = rng() > 0.7 ? 12 : 0;
        const leadMidi = preset.keyRoot + scale[degree] + 12 + oct;
        const gain = 0.14 * energy;
        const noteDur = (beat / 2) * (0.6 + rng() * 0.6);
        addNote(left, Math.floor(t * sr), Math.floor(noteDur * sr), midiToFreq(leadMidi), sr, gain,
          { wave: preset.waves.lead, brightness: preset.brightness, attack: 0.01, decay: 0.08, sustain: 0.4, release: 0.12, detune: -3 });
        addNote(right, Math.floor(t * sr), Math.floor(noteDur * sr), midiToFreq(leadMidi), sr, gain,
          { wave: preset.waves.lead, brightness: preset.brightness, attack: 0.01, decay: 0.08, sustain: 0.4, release: 0.12, detune: 3 });
      }

      // 鼓组
      if (wantDrums) {
        const dg = preset.drums * energy;
        for (let bt = 0; bt < barBeats; bt++) {
          const s = Math.floor((barStart + bt * beat) * sr);
          if (bt % 2 === 0) { addKick(left, s, sr, 0.5 * dg); addKick(right, s, sr, 0.5 * dg); }
          if (bt % 2 === 1) { addSnare(left, s, sr, 0.32 * dg, rng); addSnare(right, s, sr, 0.32 * dg, rng); }
          for (const off of [0, 0.5]) {
            const hs = Math.floor((barStart + (bt + off) * beat) * sr);
            addHat(left, hs, sr, 0.12 * dg, rng);
            addHat(right, hs, sr, 0.12 * dg, rng);
          }
        }
      }
    }

    // 混响 + 主控
    let L = reverb(left, sr, preset.reverb * (1 - purity * 0.3));
    let R = reverb(right, sr, preset.reverb * (1 - purity * 0.3));

    // 淡入淡出 + 软削波 + 归一化
    const fade = Math.floor(Math.min(1.2, duration * 0.08) * sr);
    let peak = 1e-6;
    for (let i = 0; i < total; i++) {
      peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
    }
    const norm = 0.9 / peak;
    for (let i = 0; i < total; i++) {
      let fg = 1;
      if (i < fade) fg = i / fade;
      else if (i > total - fade) fg = Math.max(0, (total - i) / fade);
      L[i] = Math.tanh(L[i] * norm) * fg;
      R[i] = Math.tanh(R[i] * norm) * fg;
    }

    return { sampleRate: sr, left: L, right: R, duration, preset };
  }

  // ---- WAV 编码 (16-bit PCM stereo) ------------------------------
  function encodeWav(left, right, sampleRate) {
    const numFrames = left.length;
    const numChannels = 2;
    const bytesPerSample = 2;
    const blockAlign = numChannels * bytesPerSample;
    const dataSize = numFrames * blockAlign;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);
    const writeStr = (off, str) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)); };

    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, dataSize, true);

    let off = 44;
    for (let i = 0; i < numFrames; i++) {
      const l = Math.max(-1, Math.min(1, left[i]));
      const r = Math.max(-1, Math.min(1, right[i]));
      view.setInt16(off, l < 0 ? l * 0x8000 : l * 0x7fff, true); off += 2;
      view.setInt16(off, r < 0 ? r * 0x8000 : r * 0x7fff, true); off += 2;
    }
    return buffer;
  }

  function generateWavBuffer(params) {
    const t = synthesize(params);
    const wav = encodeWav(t.left, t.right, t.sampleRate);
    return { wav, meta: { duration: t.duration, sampleRate: t.sampleRate, presetKey: t.preset.key, presetLabel: t.preset.label } };
  }

  return {
    makeRng, hashString, midiToFreq, presetForTags,
    synthesize, encodeWav, generateWavBuffer,
    PRESETS, SCALES, CHORD,
  };
});
