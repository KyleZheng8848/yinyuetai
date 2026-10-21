(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.AceApi = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const clamp = (value, min, max, fallback) => {
    const number = Number(value);
    return Math.min(max, Math.max(min, Number.isFinite(number) ? number : fallback));
  };

  function buildGenerationPayload(params) {
    const seed = Number.isFinite(Number(params.seed)) ? (Number(params.seed) >>> 0) : ((Math.random() * 4294967296) >>> 0);
    return {
      prompt: String(params.tags || params.prompt || '').trim(),
      lyrics: String(params.lyrics || ''),
      audio_duration: clamp(params.duration, 10, 600, 30),
      inference_steps: Math.round(clamp(params.steps, 1, 20, 8)),
      guidance_scale: clamp(params.cfg, 1, 15, 7),
      use_random_seed: false,
      seed,
      batch_size: 1,
      audio_format: 'mp3',
      thinking: true,
      use_cot_caption: true,
      use_cot_language: true,
    };
  }

  function unwrap(response) {
    if (!response || typeof response !== 'object') throw new Error('ACE-Step 返回了无效响应');
    if (response.error) throw new Error(String(response.error));
    if (Number(response.code || 200) >= 400) throw new Error(`ACE-Step 错误 ${response.code}`);
    return Object.prototype.hasOwnProperty.call(response, 'data') ? response.data : response;
  }

  function releaseTaskId(response) {
    const data = unwrap(response);
    const taskId = data && (data.task_id || data.taskId || data.id);
    if (!taskId) throw new Error('ACE-Step 未返回 task_id');
    return String(taskId);
  }

  function parseTaskResult(response, taskId) {
    const data = unwrap(response);
    const items = Array.isArray(data) ? data : (Array.isArray(data?.items) ? data.items : [data]);
    const task = items.find((item) => String(item?.task_id || item?.taskId || '') === String(taskId)) || items[0];
    if (!task) return { status: 0, output: null };
    const status = Number(task.status ?? 0);
    if (status === 2) throw new Error(task.error || task.message || 'ACE-Step 生成失败');
    if (status !== 1) return { status, output: null };
    let results = task.result;
    if (typeof results === 'string') {
      try { results = JSON.parse(results); }
      catch (_) { throw new Error('ACE-Step 结果 JSON 无法解析'); }
    }
    if (!Array.isArray(results)) results = results ? [results] : [];
    const output = results.find((item) => Number(item?.status ?? 1) === 1 && (item?.file || item?.url)) || results[0];
    if (!output || !(output.file || output.url)) throw new Error('ACE-Step 已完成，但没有返回音频文件');
    return { status, output };
  }

  function proxiedAudioUrl(file, proxyBase) {
    const value = String(file || '');
    if (!value) throw new Error('音频文件地址为空');
    let pathname = value;
    try {
      const absolute = new URL(value);
      pathname = absolute.pathname + absolute.search;
    } catch (_) {}
    if (!pathname.startsWith('/')) pathname = '/' + pathname;
    return String(proxyBase || '/ace').replace(/\/$/, '') + pathname;
  }

  return { buildGenerationPayload, unwrap, releaseTaskId, parseTaskResult, proxiedAudioUrl };
});
