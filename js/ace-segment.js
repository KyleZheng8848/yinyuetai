/* ACE-Step 分段编排：整首歌词自动拆段、估算时长、合轨。 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.AceSegment = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const SECTION_RE = /^\[(Intro|Verse|Pre-Chorus|Chorus|Final Chorus|Post-Chorus|Bridge|Build|Drop|Breakdown|Instrumental|Solo|Guitar Solo|Piano Interlude|Main Theme|Climax|Outro|Fade Out|Silence)(?:\s*\d+)?(?:\s*-\s*[^\]]{1,40})?\]$/i;
  const MIN_SEGMENT_SECONDS = 20;
  const MAX_SEGMENT_SECONDS = 45;
  // Later calls spend their first seconds re-covering the previous tail. Keep that
  // material as a disposable overlap handle instead of exposing it as a restart.
  const CONTINUITY_OVERLAP_SECONDS = 8;
  const MAX_SEGMENT_CONTENT_SECONDS = MAX_SEGMENT_SECONDS - CONTINUITY_OVERLAP_SECONDS;
  const SMART_NATIVE_MAX_SECONDS = 120;

  function baseTag(tag) {
    return String(tag || '').replace(/^\s*\[|\]\s*$/g, '').split(/\s+-\s+/, 1)[0].replace(/\s*\d+$/, '').trim().toLowerCase();
  }

  function isNonVocal(tag) {
    return ['instrumental', 'solo', 'guitar solo', 'piano interlude', 'fade out', 'silence'].includes(baseTag(tag));
  }

  function parseSections(lyrics) {
    const source = String(lyrics || '').replace(/\r\n/g, '\n').trim();
    if (!source || /^\[Instrumental\]$/i.test(source)) return [];
    const lines = source.split('\n');
    const sections = [];
    let current = null;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (SECTION_RE.test(line)) {
        if (current) sections.push(current);
        current = { tag: line.replace(/\s+/g, ' '), body: [] };
        continue;
      }
      if (!current) current = { tag: '[Verse]', body: [] };
      current.body.push(line);
    }
    if (current) sections.push(current);
    return sections.filter((section) => section.body.length || /instrumental|intro|outro|solo/i.test(baseTag(section.tag)));
  }

  function isGoodPair(a, b) {
    const left = baseTag(a);
    const right = baseTag(b);
    return (left === 'verse' && right === 'pre-chorus')
      || (left === 'pre-chorus' && right === 'chorus')
      || (left === 'chorus' && right === 'post-chorus')
      || (left === 'intro' && right === 'verse');
  }

  function serializeSections(sections) {
    return sections.map((section) => {
      const body = section.body.length ? `\n${section.body.join('\n')}` : '';
      return `${section.tag}${body}`;
    }).join('\n\n');
  }

  function overlapLyricsFor(sections, maximumLines = 2) {
    const source = [...(sections || [])].reverse().find((section) => !isNonVocal(section.tag) && section.body.length);
    if (!source) return '';
    return serializeSections([{ tag: source.tag, body: source.body.slice(-Math.max(1, maximumLines)) }]);
  }

  function lineCount(sections) {
    return sections.reduce((sum, section) => sum + Math.max(1, section.body.length), 0);
  }

  function sungLineCount(sections) {
    return sections.reduce((sum, section) => sum + (isNonVocal(section.tag) ? 0 : section.body.length), 0);
  }

  function splitSections(sections) {
    const groups = [];
    for (let index = 0; index < sections.length;) {
      const current = sections[index];
      const next = sections[index + 1];
      if (next && (isGoodPair(current.tag, next.tag) || (lineCount([current, next]) <= 10))) {
        groups.push([current, next]);
        index += 2;
      } else {
        groups.push([current]);
        index += 1;
      }
    }
    return groups;
  }

  function attachNonVocalGroups(sourceGroups) {
    const groups = sourceGroups.map(cloneSections);
    if (!groups.some((group) => group.some((section) => !isNonVocal(section.tag) && section.body.length))) return groups;
    for (let index = 0; index < groups.length;) {
      if (!groups[index].every((section) => isNonVocal(section.tag))) { index += 1; continue; }
      const [brief] = groups.splice(index, 1);
      if (index > 0) groups[index - 1].push(...brief);
      else if (groups.length) groups[0].unshift(...brief);
    }
    return groups;
  }

  function cloneSections(sections) {
    return sections.map((section) => ({ tag: section.tag, body: [...section.body] }));
  }

  function requestedSeconds(value) {
    return Math.max(MIN_SEGMENT_SECONDS, Math.min(600, Math.round(Number(value) || 40)));
  }

  function segmentCountForDuration(value) {
    const duration = requestedSeconds(value);
    if (duration <= MAX_SEGMENT_SECONDS) return 1;
    return Math.max(2, Math.ceil(duration / MAX_SEGMENT_CONTENT_SECONDS));
  }

  function segmentCountForLyrics(lyrics, duration) {
    const targetDuration = requestedSeconds(duration);
    const sections = parseSections(lyrics);
    const safeMaximum = Math.max(1, Math.floor(targetDuration / MIN_SEGMENT_SECONDS));
    const structuralCount = Math.ceil(sections.length / 2);
    const densityCount = Math.ceil(lineCount(sections) / 10);
    return Math.min(safeMaximum, Math.max(segmentCountForDuration(targetDuration), structuralCount, densityCount));
  }

  function smartStrategy(lyrics, duration) {
    const targetDuration = requestedSeconds(duration);
    const sections = parseSections(lyrics);
    const lyricLines = lineCount(sections);
    const durationRequiresSegments = targetDuration > SMART_NATIVE_MAX_SECONDS;
    const structureRequiresSegments = sections.length > 10 || lyricLines > 60;
    const segmented = durationRequiresSegments || structureRequiresSegments;
    return {
      strategy: segmented ? 'segment' : 'native',
      targetDuration,
      segmentCount: segmented ? segmentCountForLyrics(lyrics, targetDuration) : 1,
      reason: durationRequiresSegments
        ? `目标超过 ${SMART_NATIVE_MAX_SECONDS} 秒，自动分段可降低长曲丢词和结构漂移`
        : structureRequiresSegments
          ? '歌词段落较密，自动分段可为每段保留完整演唱空间'
          : `目标不超过 ${SMART_NATIVE_MAX_SECONDS} 秒，原生整首更利于保持旋律和声线一致`,
    };
  }

  function splitGroup(group) {
    if (group.length > 1) {
      if (group.some((section) => isNonVocal(section.tag))) {
        const index = group.findIndex((section) => !isNonVocal(section.tag) && section.body.length > 1);
        if (index < 0) return null;
        const section = group[index];
        const pivot = Math.ceil(section.body.length / 2);
        return [
          [...cloneSections(group.slice(0, index)), { tag: section.tag, body: section.body.slice(0, pivot) }],
          [{ tag: section.tag, body: section.body.slice(pivot) }, ...cloneSections(group.slice(index + 1))],
        ];
      }
      const pivot = Math.ceil(group.length / 2);
      return [cloneSections(group.slice(0, pivot)), cloneSections(group.slice(pivot))];
    }
    const section = group[0];
    if (section?.body?.length > 1) {
      const pivot = Math.ceil(section.body.length / 2);
      return [
        [{ tag: section.tag, body: section.body.slice(0, pivot) }],
        [{ tag: section.tag, body: section.body.slice(pivot) }],
      ];
    }
    return null;
  }

  function fitGroupCount(sourceGroups, desiredCount) {
    const groups = sourceGroups.map(cloneSections);
    while (groups.length < desiredCount) {
      let candidate = -1;
      let candidateScore = -1;
      groups.forEach((group, index) => {
        if (!splitGroup(group)) return;
        const score = lineCount(group) * 10 + group.length;
        if (score > candidateScore) { candidate = index; candidateScore = score; }
      });
      if (candidate < 0) {
        return null;
      }
      const pieces = splitGroup(groups[candidate]);
      groups.splice(candidate, 1, ...pieces);
    }
    while (groups.length > desiredCount) {
      let candidate = 0;
      let candidateScore = Infinity;
      for (let index = 0; index < groups.length - 1; index++) {
        const score = lineCount(groups[index]) + lineCount(groups[index + 1]);
        if (score < candidateScore) { candidate = index; candidateScore = score; }
      }
      groups.splice(candidate, 2, [...groups[candidate], ...groups[candidate + 1]]);
    }
    return groups;
  }

  function allocateDurations(totalSeconds, count) {
    const base = Math.floor(totalSeconds / Math.max(1, count));
    let remainder = totalSeconds - base * count;
    return Array.from({ length: count }, () => base + (remainder-- > 0 ? 1 : 0));
  }

  function allocateVocalDurations(totalSeconds, groups, maximumSeconds = MAX_SEGMENT_SECONDS) {
    const durations = groups.map(() => MIN_SEGMENT_SECONDS);
    const weights = groups.map((group) => Math.max(1, sungLineCount(group)));
    let remaining = totalSeconds - durations.length * MIN_SEGMENT_SECONDS;
    while (remaining > 0) {
      let selected = -1;
      let bestScore = -1;
      durations.forEach((duration, index) => {
        if (duration >= maximumSeconds) return;
        const score = weights[index] / duration;
        if (score > bestScore) { bestScore = score; selected = index; }
      });
      if (selected < 0) return null;
      durations[selected] += 1;
      remaining -= 1;
    }
    return durations;
  }

  function repartitionSungLyrics(sections, durations) {
    const required = durations.map((duration) => Math.ceil(duration / 10));
    let spare = sungLineCount(sections) - required.reduce((sum, count) => sum + count, 0);
    if (spare < 0) return null;
    while (spare-- > 0) {
      const selected = required.reduce((best, count, index) => count / durations[index] < required[best] / durations[best] ? index : best, 0);
      required[selected] += 1;
    }
    const groups = durations.map(() => []);
    let groupIndex = 0;
    let filled = 0;
    sections.forEach((section) => {
      if (!section.body.length) {
        const target = Math.min(Math.max(0, groupIndex), groups.length - 1);
        const attach = groups[target].length || target === 0 ? target : target - 1;
        groups[attach].push({ tag: section.tag, body: [] });
        return;
      }
      let consumed = 0;
      while (consumed < section.body.length && groupIndex < groups.length) {
        const take = Math.min(required[groupIndex] - filled, section.body.length - consumed);
        groups[groupIndex].push({ tag: section.tag, body: section.body.slice(consumed, consumed + take) });
        consumed += take;
        filled += take;
        if (filled >= required[groupIndex]) { groupIndex += 1; filled = 0; }
      }
    });
    return groups.every((group, index) => sungLineCount(group) >= Math.ceil(durations[index] / 10)) ? groups : null;
  }

  function estimateDuration(sections, requestedDuration, totalLines) {
    const lines = Math.max(1, lineCount(sections));
    const byLines = Math.round(Math.max(MIN_SEGMENT_SECONDS, Math.min(MAX_SEGMENT_SECONDS, 18 + lines * 5.5)));
    if (!(Number(requestedDuration) > 0) || !(Number(totalLines) > 0)) return byLines;
    const share = Math.round(Number(requestedDuration) * (lines / totalLines));
    return Math.max(MIN_SEGMENT_SECONDS, Math.min(MAX_SEGMENT_SECONDS, share || byLines));
  }

  function crossfadeSecondsForMusic(bpm, timesignature) {
    const tempo = Math.max(40, Math.min(240, Number(bpm) || 96));
    const beats = Math.max(2, Math.min(6, Number.parseInt(String(timesignature || '4'), 10) || 4));
    return Math.max(1.5, Math.min(4, beats * 60 / tempo));
  }

  function continuityOverlapSeconds(contentDuration) {
    return Math.max(0, Math.min(CONTINUITY_OVERLAP_SECONDS, MAX_SEGMENT_SECONDS - Number(contentDuration || 0)));
  }

  function plan(lyrics, options = {}) {
    const targetDuration = requestedSeconds(options.duration);
    const desiredCount = segmentCountForLyrics(lyrics, targetDuration);
    const sections = parseSections(lyrics);
    if (desiredCount === 1 && sections.length <= 2 && lineCount(sections) <= 10) {
      return {
        auto: false,
        targetDuration,
        plannedDuration: targetDuration,
        segments: [{
          index: 0,
          total: 1,
          label: sections.map((item) => item.tag.replace(/[\[\]]/g, '')).join(' + ') || '片段',
          lyrics: String(lyrics || '').trim() || '[Instrumental]',
          generationLyrics: String(lyrics || '').trim() || '[Instrumental]',
          duration: targetDuration,
          contentDuration: targetDuration,
          overlapSeconds: 0,
          generationDuration: targetDuration,
          sections,
        }],
      };
    }
    if (!sections.length) {
      const durations = allocateDurations(targetDuration, desiredCount);
      return {
        auto: desiredCount > 1,
        targetDuration,
        plannedDuration: durations.reduce((sum, duration) => sum + duration, 0),
        segments: durations.map((duration, index) => {
          const overlapSeconds = index > 0 ? continuityOverlapSeconds(duration) : 0;
          return {
            index, total: desiredCount, label: desiredCount > 1 ? `器乐段 ${index + 1}` : '片段', lyrics: '[Instrumental]',
            duration, contentDuration: duration, overlapSeconds, generationDuration: duration + overlapSeconds,
            generationLyrics: '[Instrumental]', sections: [],
          };
        }),
      };
    }
    const sungLines = sungLineCount(sections);
    if (desiredCount > 1 && sungLines < desiredCount * 2) {
      return {
        auto: false, targetDuration, plannedDuration: 0, segments: [],
        invalidReason: `现有 ${sungLines} 行可演唱歌词不足以覆盖 ${desiredCount} 个分段；建议至少 ${desiredCount * 2} 行，或缩短时长`,
      };
    }
    let groups = fitGroupCount(attachNonVocalGroups(splitSections(sections)), desiredCount);
    if (!groups || groups.some((group) => !group.some((section) => !isNonVocal(section.tag) && section.body.length))) {
      return {
        auto: false, targetDuration, plannedDuration: 0, segments: [],
        invalidReason: `现有歌词无法安全拆成 ${desiredCount} 个可演唱片段；请补充主歌/副歌正文或缩短时长，不会自动插入整段纯器乐`,
      };
    }
    let durations = allocateVocalDurations(
      targetDuration,
      groups,
      desiredCount > 1 ? MAX_SEGMENT_CONTENT_SECONDS : MAX_SEGMENT_SECONDS,
    );
    if (!durations) return { auto: false, targetDuration, plannedDuration: 0, segments: [], invalidReason: '目标时长无法分配到安全的演唱片段，请缩短时长或补充歌词段落' };
    let sparseIndex = groups.findIndex((group, index) => sungLineCount(group) < Math.ceil(durations[index] / 10));
    if (sparseIndex >= 0) {
      const redistributed = repartitionSungLyrics(sections, durations);
      if (redistributed) { groups = redistributed; sparseIndex = -1; }
    }
    if (sparseIndex >= 0) {
      return {
        auto: false, targetDuration, plannedDuration: 0, segments: [],
        invalidReason: `第 ${sparseIndex + 1} 段计划 ${durations[sparseIndex]} 秒，但只有 ${sungLineCount(groups[sparseIndex])} 行唱词；请补充该段歌词或缩短时长，避免后半段仅剩伴奏`,
      };
    }
    const segments = groups.map((group, index) => {
      const duration = durations[index];
      const overlapSeconds = index > 0 ? continuityOverlapSeconds(duration) : 0;
      const lyrics = serializeSections(group);
      const overlapLyrics = index > 0 ? overlapLyricsFor(groups[index - 1]) : '';
      return {
        index,
        total: groups.length,
        label: group.map((item) => item.tag.replace(/[\[\]]/g, '')).join(' + '),
        lyrics,
        generationLyrics: overlapLyrics ? `${overlapLyrics}\n\n${lyrics}` : lyrics,
        duration,
        contentDuration: duration,
        overlapSeconds,
        generationDuration: duration + overlapSeconds,
        sections: group,
      };
    });
    return {
      auto: segments.length > 1,
      targetDuration,
      plannedDuration: durations.reduce((sum, duration) => sum + duration, 0),
      segments,
    };
  }

  function shouldAutomate(model, lyrics, duration) {
    if (!model || model.playbook !== 'ace-segment') return false;
    if (Number(duration) > MAX_SEGMENT_SECONDS) return true;
    const sections = parseSections(lyrics);
    if (sections.length > 2) return true;
    if (lineCount(sections) > 10) return true;
    return false;
  }

  async function concatBlobs(blobs, encodeWav, options = {}) {
    if (!Array.isArray(blobs) || !blobs.length) throw new Error('没有可拼接的分段音频');
    if (blobs.length === 1) return blobs[0];
    const Context = root?.AudioContext || root?.webkitAudioContext;
    if (!Context) throw new Error('当前环境不支持音频拼接');
    const context = new Context();
    try {
      const buffers = [];
      for (const blob of blobs) {
        const data = await blob.arrayBuffer();
        buffers.push(await context.decodeAudioData(data.slice(0)));
      }
      const sampleRate = buffers[0].sampleRate || 44100;
      const requestedFades = Array.isArray(options.crossfadeSeconds) ? options.crossfadeSeconds : null;
      const overlaps = buffers.map((buffer, index) => index === 0 ? 0 : Math.min(
        Math.round(sampleRate * (Number(requestedFades?.[index] ?? options.crossfadeSeconds) > 0
          ? Number(requestedFades?.[index] ?? options.crossfadeSeconds)
          : 0.04)),
        Math.floor(buffer.length * 0.45),
        Math.floor(buffers[index - 1].length * 0.45),
      ));
      const total = buffers.reduce((sum, buffer, index) => sum + buffer.length - overlaps[index], 0);
      const left = new Float32Array(total);
      const right = new Float32Array(total);
      let offset = 0;
      buffers.forEach((buffer, index) => {
        const channelLeft = buffer.getChannelData(0);
        const channelRight = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : channelLeft;
        const start = overlaps[index];
        if (index > 0) {
          const overlap = Math.min(overlaps[index], offset, buffer.length);
          for (let i = 0; i < overlap; i++) {
            const mix = i / Math.max(1, overlap - 1);
            const dest = offset - overlap + i;
            const angle = mix * Math.PI * 0.5;
            left[dest] = left[dest] * Math.cos(angle) + channelLeft[i] * Math.sin(angle);
            right[dest] = right[dest] * Math.cos(angle) + channelRight[i] * Math.sin(angle);
          }
        }
        for (let i = start; i < buffer.length; i++) {
          left[offset + i - start] = channelLeft[i];
          right[offset + i - start] = channelRight[i];
        }
        offset += buffer.length - start;
      });
      const wav = encodeWav(left.subarray(0, offset), right.subarray(0, offset), sampleRate);
      return new Blob([wav], { type: 'audio/wav' });
    } finally {
      context.close().catch(() => {});
    }
  }

  return {
    SECTION_RE, MIN_SEGMENT_SECONDS, MAX_SEGMENT_SECONDS, MAX_SEGMENT_CONTENT_SECONDS, CONTINUITY_OVERLAP_SECONDS, SMART_NATIVE_MAX_SECONDS, parseSections, splitSections, serializeSections, overlapLyricsFor, isNonVocal,
    plan, shouldAutomate, smartStrategy, concatBlobs, lineCount, sungLineCount, estimateDuration, crossfadeSecondsForMusic, continuityOverlapSeconds, segmentCountForDuration, segmentCountForLyrics, allocateDurations, allocateVocalDurations,
  };
});
