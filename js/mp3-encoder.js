(function (root) {
  'use strict';

  function audioContext() {
    const Context = root.AudioContext || root.webkitAudioContext;
    if (!Context) throw new Error('当前环境不支持音频解码');
    return new Context();
  }

  async function decode(blob) {
    const context = audioContext();
    try {
      const source = await blob.arrayBuffer();
      return await context.decodeAudioData(source.slice(0));
    } finally {
      context.close().catch(() => {});
    }
  }

  function encodeWithWorker(buffer, options = {}) {
    return new Promise((resolve, reject) => {
      const worker = new Worker('/js/mp3-worker.js');
      const left = buffer.getChannelData(0).slice();
      const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1).slice() : null;
      const cleanup = () => worker.terminate();
      worker.onmessage = ({ data }) => {
        if (data.type === 'progress') {
          options.onProgress?.(Math.max(0, Math.min(1, Number(data.value) || 0)));
          return;
        }
        cleanup();
        if (data.type === 'error') reject(new Error(data.message || 'MP3 编码失败'));
        else resolve(new Blob([data.buffer], { type: 'audio/mpeg' }));
      };
      worker.onerror = (event) => {
        cleanup();
        reject(new Error(event.message || 'MP3 编码线程异常'));
      };
      const transfers = right ? [left.buffer, right.buffer] : [left.buffer];
      worker.postMessage({
        type: 'encode',
        left,
        right,
        sampleRate: buffer.sampleRate,
        bitRate: Number(options.bitRate) || 256,
      }, transfers);
    });
  }

  async function encode(blob, options = {}) {
    if (!(blob instanceof Blob)) throw new Error('没有找到可编码的音频文件');
    options.onProgress?.(0.02);
    const buffer = await decode(blob);
    options.onProgress?.(0.08);
    return encodeWithWorker(buffer, options);
  }

  root.Mp3Exporter = Object.freeze({ encode });
})(typeof self !== 'undefined' ? self : this);
