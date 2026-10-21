/* Validate vocal intent before a music model is asked to sing. No lyrics are invented or rewritten here. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.VocalGuard = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const NON_VOCAL = new Set(['instrumental', 'solo', 'guitar solo', 'piano interlude', 'fade out', 'silence']);

  function tagName(value) {
    return String(value || '').replace(/^\[|\]$/g, '').replace(/\s*[-:]\s*.*$/, '').replace(/\s+\d+$/, '').trim().toLowerCase();
  }

  function nonVocalTag(value) { return NON_VOCAL.has(tagName(value)); }

  function analyzeLyrics(value) {
    const source = String(value || '').replace(/\r\n/g, '\n').trim();
    const instrumentalOnly = /^\[Instrumental\]$/i.test(source);
    const sections = [];
    const malformed = [];
    let current = null;
    source.split('\n').forEach((raw, index) => {
      const line = raw.trim();
      if (!line) return;
      if (/^\[[^\]]+\]$/.test(line)) {
        current = { tag: line, lines: 0, lineNumber: index + 1 };
        sections.push(current);
        return;
      }
      if (line.startsWith('[') || (line.endsWith(']') && !line.startsWith('['))) {
        malformed.push(index + 1);
        return;
      }
      if (!current) {
        current = { tag: '[Verse]', lines: 0, lineNumber: index + 1 };
        sections.push(current);
      }
      current.lines += 1;
    });
    const contradictory = sections.filter((section) => nonVocalTag(section.tag) && section.lines > 0);
    const vocalLines = sections.reduce((sum, section) => sum + (nonVocalTag(section.tag) ? 0 : section.lines), 0);
    return { source, instrumentalOnly, sections, malformed, contradictory, vocalLines };
  }

  function preflight(value, options = {}) {
    const result = analyzeLyrics(value);
    if (!result.source || result.instrumentalOnly) return { ...result, error: '' };
    if (result.malformed.length) return { ...result, error: `歌词第 ${result.malformed[0]} 行的段落标签不完整；请把 [Verse] 等标签单独放在一行` };
    if (result.contradictory.length) {
      const first = result.contradictory[0];
      return { ...result, error: `${first.tag} 下有 ${first.lines} 行歌词，但该标签要求器乐/静音；请把要唱的文字移到 [Verse]、[Bridge] 或 [Chorus] 下` };
    }
    const duration = Number(options.duration) || 0;
    if (options.segmented && duration > 45) {
      const minimum = Math.ceil(duration / 45) * 3;
      if (result.vocalLines < minimum) return { ...result, error: `${Math.round(duration)} 秒分段歌曲只有 ${result.vocalLines} 行可演唱歌词；建议至少 ${minimum} 行，或缩短时长，避免后段变成纯器乐` };
    }
    return { ...result, error: '' };
  }

  return { NON_VOCAL, tagName, nonVocalTag, analyzeLyrics, preflight };
});
