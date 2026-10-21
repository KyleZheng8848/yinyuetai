(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TimedLyrics = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STRUCTURE_TAG = /^\[(intro|verse|pre-chorus|chorus|post-chorus|bridge|instrumental|solo|outro)(?:\s+\d+)?\]$/i;
  const TIME_TAG = /^\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/;

  function clampTime(value, duration = Infinity) {
    const maximum = Number.isFinite(Number(duration)) && Number(duration) > 0 ? Number(duration) : Infinity;
    return Math.max(0, Math.min(maximum, Number(value) || 0));
  }

  function parseTime(value) {
    const input = String(value || '').trim().replace(/^\[|\]$/g, '');
    const parts = input.split(':');
    if (parts.length < 2 || parts.length > 3) return NaN;
    const seconds = Number(parts.pop());
    const minutes = Number(parts.pop());
    const hours = parts.length ? Number(parts.pop()) : 0;
    if (![hours, minutes, seconds].every(Number.isFinite) || minutes < 0 || seconds < 0 || seconds >= 60) return NaN;
    return hours * 3600 + minutes * 60 + seconds;
  }

  function formatTime(value, precision = 2) {
    const time = Math.max(0, Number(value) || 0);
    const minutes = Math.floor(time / 60);
    const seconds = time - minutes * 60;
    return `${String(minutes).padStart(2, '0')}:${seconds.toFixed(precision).padStart(precision ? 3 + precision : 2, '0')}`;
  }

  function plainLines(lyrics) {
    return String(lyrics || '').split(/\r?\n/).map((line) => line.trim()).filter((line) => {
      if (!line || STRUCTURE_TAG.test(line)) return false;
      return Boolean(line.replace(TIME_TAG, '').trim());
    }).map((line) => line.replace(TIME_TAG, '').trim());
  }

  function parseLrc(lyrics) {
    const timeline = [];
    String(lyrics || '').split(/\r?\n/).forEach((rawLine) => {
      let line = rawLine.trim();
      if (!line || STRUCTURE_TAG.test(line)) return;
      const times = [];
      let match;
      while ((match = line.match(TIME_TAG))) {
        const fraction = match[3] ? Number(`0.${match[3].padEnd(3, '0').slice(0, 3)}`) : 0;
        times.push(Number(match[1]) * 60 + Number(match[2]) + fraction);
        line = line.slice(match[0].length);
      }
      const text = line.trim();
      if (!text || !times.length) return;
      times.forEach((time) => timeline.push({ time, text }));
    });
    return timeline.sort((a, b) => a.time - b.time);
  }

  function sanitize(timeline, duration) {
    return (Array.isArray(timeline) ? timeline : []).map((item) => ({
      time: clampTime(item?.time, duration),
      text: String(item?.text || '').replace(/\s+/g, ' ').trim().slice(0, 500),
    })).filter((item) => item.text).sort((a, b) => a.time - b.time);
  }

  function distribute(lines, duration) {
    const clean = (Array.isArray(lines) ? lines : plainLines(lines)).map((item) => typeof item === 'string' ? item.trim() : String(item?.text || '').trim()).filter(Boolean);
    if (!clean.length) return [];
    const total = Math.max(0, Number(duration) || 0);
    if (!total) return clean.map((text, index) => ({ time: index * 4, text }));
    const start = Math.min(8, total * 0.06);
    const end = Math.max(start, total - Math.min(3, total * 0.04));
    const span = Math.max(0, end - start);
    return clean.map((text, index) => ({
      time: clean.length === 1 ? start : start + span * index / (clean.length - 1),
      text,
    }));
  }

  function timelineFor(lyrics, duration, existing) {
    const saved = sanitize(existing, duration);
    if (saved.length) return saved;
    const parsed = sanitize(parseLrc(lyrics), duration);
    return parsed.length ? parsed : distribute(plainLines(lyrics), duration);
  }

  function serializeLrc(timeline) {
    return sanitize(timeline).map((item) => `[${formatTime(item.time)}]${item.text}`).join('\n');
  }

  function activeIndex(timeline, currentTime) {
    if (!timeline?.length) return -1;
    const current = Math.max(0, Number(currentTime) || 0);
    let low = 0;
    let high = timeline.length - 1;
    let found = -1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (Number(timeline[middle]?.time) <= current) {
        found = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return found;
  }

  return { parseTime, formatTime, plainLines, parseLrc, sanitize, distribute, timelineFor, serializeLrc, activeIndex };
});
