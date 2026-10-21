(function (root) {
  'use strict';

  function encodePcm16Wav(channels, sampleRate = 44100) {
    if (!Array.isArray(channels) || !channels.length || !channels[0]?.length) throw new Error('参考音频没有可用采样');
    const frames = channels[0].length;
    const channelCount = Math.min(2, channels.length);
    const buffer = new ArrayBuffer(44 + frames * 4);
    const view = new DataView(buffer);
    const text = (offset, value) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
    text(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 2, true);
    view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 4, true);
    view.setUint16(32, 4, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, frames * 4, true);
    let offset = 44;
    for (let frame = 0; frame < frames; frame++) {
      for (let channel = 0; channel < 2; channel++) {
        const source = channels[Math.min(channel, channelCount - 1)];
        const sample = Math.max(-1, Math.min(1, Number(source[frame]) || 0));
        view.setInt16(offset, sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767), true);
        offset += 2;
      }
    }
    return buffer;
  }

  async function toModelWav(blob, maxSeconds = 360) {
    if (!(blob instanceof Blob) || !blob.size) throw new Error('参考音乐文件不可用');
    const Context = root.AudioContext || root.webkitAudioContext;
    const Offline = root.OfflineAudioContext || root.webkitOfflineAudioContext;
    if (!Context || !Offline) throw new Error('当前环境不能转换参考音乐');
    const context = new Context({ sampleRate: 44100 });
    let decoded;
    try { decoded = await context.decodeAudioData(await blob.arrayBuffer()); }
    finally { await context.close().catch(() => {}); }
    const duration = Math.min(Number(maxSeconds) || 360, decoded.duration);
    const frames = Math.max(1, Math.ceil(duration * 44100));
    const offline = new Offline(2, frames, 44100);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start(0, 0, duration);
    const rendered = await offline.startRendering();
    const wav = encodePcm16Wav([rendered.getChannelData(0), rendered.getChannelData(Math.min(1, rendered.numberOfChannels - 1))], 44100);
    return new Blob([wav], { type: 'audio/wav' });
  }

  root.ReferenceAudio = { encodePcm16Wav, toModelWav };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.ReferenceAudio;
})(typeof self !== 'undefined' ? self : globalThis);
