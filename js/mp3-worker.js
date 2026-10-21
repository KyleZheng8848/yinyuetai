'use strict';

importScripts('/node_modules/lamejs/lame.min.js');

function toPcm16(samples, start, end) {
  const output = new Int16Array(end - start);
  for (let sourceIndex = start, targetIndex = 0; sourceIndex < end; sourceIndex++, targetIndex++) {
    const sample = Math.max(-1, Math.min(1, samples[sourceIndex] || 0));
    output[targetIndex] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output;
}

self.onmessage = ({ data }) => {
  if (data?.type !== 'encode') return;
  try {
    const left = data.left;
    const right = data.right;
    const channels = right ? 2 : 1;
    const encoder = new lamejs.Mp3Encoder(channels, Number(data.sampleRate) || 44100, Number(data.bitRate) || 256);
    const output = [];
    const blockSize = 1152 * 8;
    let lastProgress = -1;

    for (let index = 0; index < left.length; index += blockSize) {
      const end = Math.min(left.length, index + blockSize);
      const leftPcm = toPcm16(left, index, end);
      const encoded = right
        ? encoder.encodeBuffer(leftPcm, toPcm16(right, index, end))
        : encoder.encodeBuffer(leftPcm);
      if (encoded.length) output.push(new Uint8Array(encoded));
      const progress = Math.floor((end / left.length) * 100);
      if (progress !== lastProgress && progress % 2 === 0) {
        lastProgress = progress;
        self.postMessage({ type: 'progress', value: 0.08 + progress / 100 * 0.9 });
      }
    }

    const tail = encoder.flush();
    if (tail.length) output.push(new Uint8Array(tail));
    const blob = new Blob(output, { type: 'audio/mpeg' });
    blob.arrayBuffer().then((buffer) => self.postMessage({ type: 'complete', buffer }, [buffer]));
  } catch (error) {
    self.postMessage({ type: 'error', message: error?.message || String(error) });
  }
};
