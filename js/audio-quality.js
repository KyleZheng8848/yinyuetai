/* Conservative acoustic QA: detects near-silent gaps, not whether a singer followed every lyric. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.AudioQuality = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  function analyzeSamples(left, right, sampleRate) {
    const frames = Math.min(left?.length || 0, right?.length || left?.length || 0);
    const rate = Number(sampleRate) || 44100;
    const blockFrames = Math.max(1, Math.round(rate * 0.5));
    const stride = Math.max(1, Math.round(rate / 4000));
    const levels = [];
    for (let start = 0; start < frames; start += blockFrames) {
      let sum = 0;
      let count = 0;
      for (let index = start; index < Math.min(frames, start + blockFrames); index += stride) {
        const l = Number(left[index]) || 0;
        const r = Number(right?.[index] ?? l) || 0;
        sum += (l * l + r * r) / 2;
        count += 1;
      }
      levels.push(Math.sqrt(sum / Math.max(1, count)));
    }
    const duration = frames / rate;
    const loud = [...levels].sort((a, b) => b - a).slice(0, Math.max(1, Math.ceil(levels.length / 2)));
    const baselineRms = loud[Math.floor(loud.length / 2)] || 0;
    const threshold = Math.max(0.001, baselineRms * 0.05);
    let tailBlocks = 0;
    for (let index = levels.length - 1; index >= 0 && levels[index] < threshold; index--) tailBlocks += 1;
    let middleBlocks = 0;
    let longestMiddleBlocks = 0;
    for (let index = Math.floor(levels.length * 0.1); index < Math.ceil(levels.length * 0.9); index++) {
      if (levels[index] < threshold) middleBlocks += 1;
      else middleBlocks = 0;
      longestMiddleBlocks = Math.max(longestMiddleBlocks, middleBlocks);
    }
    const tailSilentSeconds = Math.min(duration, tailBlocks * 0.5);
    const middleSilentSeconds = longestMiddleBlocks * 0.5;
    const warnings = [];
    if (duration > 5 && baselineRms < 0.002) warnings.push('音频整体接近静音');
    if (duration > 10 && tailSilentSeconds >= Math.max(3, Math.min(6, duration * 0.04))) warnings.push(`尾部约 ${tailSilentSeconds.toFixed(1)} 秒近乎静音`);
    if (duration > 20 && middleSilentSeconds >= 8) warnings.push(`中途约 ${middleSilentSeconds.toFixed(1)} 秒近乎静音`);
    return { duration, baselineRms, threshold, tailSilentSeconds, middleSilentSeconds, warnings };
  }

  function trimSilentTail(left, right, sampleRate, quality) {
    const rate = Number(sampleRate) || 44100;
    const totalFrames = Math.min(left?.length || 0, right?.length || left?.length || 0);
    if (!quality || quality.tailSilentSeconds < 5 || quality.duration < 10 || !totalFrames) return null;
    const trimmedFrames = Math.floor(Math.max(0, quality.tailSilentSeconds - 0.5) * rate);
    const retainedFrames = totalFrames - trimmedFrames;
    if (retainedFrames < rate * 5) return null;
    const keptLeft = Float32Array.from(left.subarray(0, retainedFrames));
    const keptRight = Float32Array.from((right || left).subarray(0, retainedFrames));
    const fadeFrames = Math.min(Math.round(rate * 0.25), retainedFrames);
    for (let index = 0; index < fadeFrames; index++) {
      const gain = 1 - index / Math.max(1, fadeFrames - 1);
      keptLeft[retainedFrames - fadeFrames + index] *= gain;
      keptRight[retainedFrames - fadeFrames + index] *= gain;
    }
    return { left: keptLeft, right: keptRight, duration: retainedFrames / rate, trimmedSeconds: trimmedFrames / rate };
  }

  async function processVocalBlob(blob, encodeWav) {
    const Context = root.AudioContext || root.webkitAudioContext;
    if (!Context || !blob?.size) return { blob, quality: null };
    const context = new Context();
    try {
      const bytes = await blob.arrayBuffer();
      const decoded = await context.decodeAudioData(bytes.slice(0));
      const left = decoded.getChannelData(0);
      const right = decoded.numberOfChannels > 1 ? decoded.getChannelData(1) : left;
      const quality = analyzeSamples(left, right, decoded.sampleRate);
      const trimmed = typeof encodeWav === 'function' ? trimSilentTail(left, right, decoded.sampleRate, quality) : null;
      if (!trimmed) return { blob, quality };
      const wav = encodeWav(trimmed.left, trimmed.right, decoded.sampleRate);
      quality.sourceDuration = quality.duration;
      quality.duration = trimmed.duration;
      quality.trimmedTailSeconds = trimmed.trimmedSeconds;
      quality.warnings = quality.warnings.filter((warning) => !warning.startsWith('尾部'));
      quality.notes = [`已裁剪 ${trimmed.trimmedSeconds.toFixed(1)} 秒静音尾巴`];
      return { blob: new Blob([wav], { type: 'audio/wav' }), quality };
    } finally {
      context.close().catch(() => {});
    }
  }

  async function extractTailBlob(blob, seconds, encodeWav) {
    const Context = root.AudioContext || root.webkitAudioContext;
    if (!Context || !blob?.size || typeof encodeWav !== 'function') return null;
    const context = new Context();
    try {
      const decoded = await context.decodeAudioData((await blob.arrayBuffer()).slice(0));
      const rate = decoded.sampleRate;
      const frames = Math.min(decoded.length, Math.max(rate * 3, Math.round(rate * (Number(seconds) || 8))));
      const start = Math.max(0, decoded.length - frames);
      const left = Float32Array.from(decoded.getChannelData(0).subarray(start));
      const sourceRight = decoded.numberOfChannels > 1 ? decoded.getChannelData(1) : decoded.getChannelData(0);
      const right = Float32Array.from(sourceRight.subarray(start));
      const edge = Math.min(Math.round(rate * 0.08), Math.floor(frames / 8));
      for (let index = 0; index < edge; index++) {
        const gain = index / Math.max(1, edge - 1);
        left[index] *= gain;
        right[index] *= gain;
      }
      return new Blob([encodeWav(left, right, rate)], { type: 'audio/wav' });
    } finally {
      context.close().catch(() => {});
    }
  }

  async function analyzeBlob(blob) {
    const Context = root.AudioContext || root.webkitAudioContext;
    if (!Context || !blob?.size) return null;
    const context = new Context();
    try {
      const bytes = await blob.arrayBuffer();
      const decoded = await context.decodeAudioData(bytes.slice(0));
      const left = decoded.getChannelData(0);
      const right = decoded.numberOfChannels > 1 ? decoded.getChannelData(1) : left;
      return analyzeSamples(left, right, decoded.sampleRate);
    } finally {
      context.close().catch(() => {});
    }
  }

  return { analyzeSamples, analyzeBlob, trimSilentTail, processVocalBlob, extractTailBlob };
});
