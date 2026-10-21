(function (root) {
  'use strict';
  const Engine = root.AudioEngine;
  const AceApi = root.AceApi;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function jsonRequest(url, options) {
    const response = await fetch(url, options);
    let data;
    try { data = await response.json(); }
    catch (_) { data = { error: `HTTP ${response.status}` }; }
    if (!response.ok || data?.ok === false) throw new Error(data?.error || `HTTP ${response.status}`);
    return data;
  }

  const DemoProvider = {
    id: 'demo',
    label: '即时 Demo 合成器',
    async generate(model, params, onStage) {
      for (const stage of model.stages) {
        if (stage.id === 'sample') {
          const ticks = Math.min(20, Math.max(6, Math.round((params.steps || 24) / 2)));
          for (let index = 1; index <= ticks; index++) {
            onStage?.(stage.id, index / ticks);
            await sleep(35);
          }
        } else if (stage.id === 'decode') {
          onStage?.(stage.id, 0.1);
          await sleep(20);
          const { wav, meta } = Engine.generateWavBuffer(params);
          onStage?.(stage.id, 1);
          const blob = new Blob([wav], { type: 'audio/wav' });
          onStage?.('save', 1);
          return { url: URL.createObjectURL(blob), blob, meta, provider: 'demo' };
        } else {
          for (let index = 1; index <= 4; index++) {
            onStage?.(stage.id, index / 4);
            await sleep(22);
          }
        }
      }
      throw new Error('Demo 合成器未产生音频');
    },
  };

  function makeAceProvider(config = {}) {
    const base = String(config.proxyBase || '/ace').replace(/\/$/, '');
    return {
      id: 'ace',
      label: 'ACE-Step 1.5 本地',
      async testConnection() {
        return jsonRequest(`${base}/health`);
      },
      async generate(model, params, onStage) {
        onStage?.('load', 0.4);
        await this.testConnection();
        onStage?.('load', 1);
        onStage?.('encode', 0.35);
        const payload = AceApi.buildGenerationPayload(params);
        onStage?.('encode', 1);
        const released = await jsonRequest(`${base}/release_task`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        });
        const taskId = AceApi.releaseTaskId(released);
        onStage?.('queue', 1);

        let output = null;
        for (let attempt = 0; attempt < 1600; attempt++) {
          const queried = await jsonRequest(`${base}/query_result`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task_id_list: [taskId] }),
          });
          const result = AceApi.parseTaskResult(queried, taskId);
          if (result.status === 1) { output = result.output; break; }
          onStage?.('sample', Math.min(0.94, 0.08 + attempt * 0.015));
          await sleep(attempt < 20 ? 400 : 900);
        }
        if (!output) throw new Error('ACE-Step 生成超时');
        onStage?.('sample', 1);
        onStage?.('decode', 0.5);
        const audioResponse = await fetch(AceApi.proxiedAudioUrl(output.file || output.url, base));
        if (!audioResponse.ok) throw new Error(`音频读取失败 HTTP ${audioResponse.status}`);
        const blob = await audioResponse.blob();
        const url = URL.createObjectURL(blob);
        onStage?.('decode', 1);
        onStage?.('save', 1);
        return {
          url, blob, provider: 'ace',
          meta: {
            duration: Number(output.metas?.duration || params.duration),
            bpm: output.metas?.bpm,
            key: output.metas?.keyscale,
            seed: String(output.seed_value || params.seed),
            model: output.dit_model || 'ACE-Step 1.5',
          },
        };
      },
    };
  }

  function makeComfyUIProvider(config = {}) {
    const base = String(config.proxyBase || '/comfy').replace(/\/$/, '');
    let activePromptId = null;
    let cancelled = false;
    const stoppedError = () => {
      const error = new Error('生成已停止');
      error.name = 'AbortError';
      return error;
    };
    const provider = {
      id: 'comfy',
      label: 'ComfyUI',
      async testConnection() {
        const response = await fetch(`${base}/system_stats`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      },
      async cancel() {
        cancelled = true;
        const promptId = activePromptId;
        const requests = [fetch(`${base}/interrupt`, { method: 'POST' })];
        if (promptId) {
          requests.push(fetch(`${base}/queue`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ delete: [promptId] }),
          }));
        }
        await Promise.allSettled(requests);
        return { ok: true, promptId };
      },
      async generate(model, params, onStage, options = {}) {
        if (!model.buildPrompt) throw new Error('该模型没有可提交的 ComfyUI 工作流');
        cancelled = false;
        activePromptId = null;
        const signal = options.signal;
        const ensureRunning = () => {
          if (cancelled || signal?.aborted) throw stoppedError();
        };
        const stages = model.stages;
        const stageAt = (index) => (stages[Math.min(index, stages.length - 1)] || {}).id;
        const clientId = `yinyuetai-${Math.random().toString(36).slice(2)}`;
        const pollDelay = (attempt) => (attempt < 20 ? 200 : attempt < 60 ? 400 : 700);
        try {
          ensureRunning();
          onStage?.(stageAt(0), 0.5);
          if (params.continuityReferenceBlob) {
            const form = new FormData();
            const filename = `ace-continuity-${String(params.continuitySuiteId || Date.now()).replace(/[^a-z0-9-]/gi, '-')}-${Number(params.continuityIndex) || 0}.wav`;
            form.append('image', params.continuityReferenceBlob, filename);
            form.append('type', 'input');
            form.append('subfolder', 'yinyuetai-continuity');
            form.append('overwrite', 'true');
            const uploadResponse = await fetch(`${base}/upload/image`, { method: 'POST', body: form, signal });
            if (!uploadResponse.ok) throw new Error(`ACE 连续性参考上传失败 HTTP ${uploadResponse.status}`);
            const uploaded = await uploadResponse.json();
            params.continuityReferenceFilename = uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name;
          }
          const queueResponse = await fetch(`${base}/prompt`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
            body: JSON.stringify({ prompt: model.buildPrompt(params), client_id: clientId }),
          });
          if (!queueResponse.ok) throw new Error(`ComfyUI 提交失败 HTTP ${queueResponse.status}`);
          const queued = await queueResponse.json();
          activePromptId = queued.prompt_id;
          if (!activePromptId) throw new Error('ComfyUI 未返回 prompt_id');
          if (cancelled || signal?.aborted) {
            await provider.cancel();
            throw stoppedError();
          }
          onStage?.(stageAt(1), 1);
          const sampleId = stages.some((stage) => stage.id === 'sample') ? 'sample' : stageAt(2);
          let audioInfo = null;
          const maxPolls = model.id === 'minimax-music-3' ? 21600 : 7200;
          for (let attempt = 0; attempt < maxPolls; attempt++) {
            ensureRunning();
            onStage?.(sampleId, Math.min(0.95, 0.12 + attempt * 0.003));
            const historyResponse = await fetch(`${base}/history/${activePromptId}`, { signal });
            if (historyResponse.ok) {
              const history = await historyResponse.json();
              const entry = history[activePromptId];
              if (entry?.status?.status_str === 'error') {
                const failure = (entry.status.messages || []).find((message) => message?.[0] === 'execution_error')?.[1] || {};
                const rawMessage = String(failure.exception_message || failure.exception_type || '').trim();
                const detail = rawMessage.includes("aten::_int_mm")
                  ? 'Apple MPS 不支持当前 INT8 文本编码，请升级应用并重启本地引擎'
                  : rawMessage.split('\n')[0].slice(0, 240);
                throw new Error(`ComfyUI ${failure.node_type ? `节点 ${failure.node_type} ` : ''}执行失败${detail ? `：${detail}` : ''}`);
              }
              for (const output of Object.values(entry?.outputs || {})) {
                if (output.audio?.length) { audioInfo = output.audio[0]; break; }
              }
              if (audioInfo) break;
              // Finished without audio is a hard failure — don't keep polling for minutes.
              if (entry?.status?.completed || entry?.status?.status_str === 'success') {
                throw new Error('ComfyUI 任务完成但没有音频输出');
              }
            }
            await sleep(pollDelay(attempt));
          }
          ensureRunning();
          if (!audioInfo) throw new Error('ComfyUI 生成超时');
          onStage?.(stages.some((stage) => stage.id === 'decode') ? 'decode' : stageAt(3), 1);
          const query = new URLSearchParams({ filename: audioInfo.filename, subfolder: audioInfo.subfolder || '', type: audioInfo.type || 'output' });
          const audioResponse = await fetch(`${base}/view?${query}`, { signal });
          if (!audioResponse.ok) throw new Error(`ComfyUI 音频读取失败 HTTP ${audioResponse.status}`);
          const blob = await audioResponse.blob();
          onStage?.('save', 1);
          return {
            url: URL.createObjectURL(blob), blob, provider: 'comfy',
            meta: { duration: params.duration, filename: audioInfo.filename, model: model.id },
          };
        } finally {
          activePromptId = null;
        }
      },
    };
    return provider;
  }

  function makeMusic3Provider() {
    const comfy = makeComfyUIProvider({ proxyBase: '/local' });
    return {
      ...comfy,
      id: 'music3',
      label: 'MiniMax Music 3 本地',
      async generate(model, params, onStage, options) {
        const result = await comfy.generate(model, params, onStage, options);
        return { ...result, provider: 'music3' };
      },
    };
  }

  function makeLocalComfyProvider() {
    const comfy = makeComfyUIProvider({ proxyBase: '/local' });
    return {
      ...comfy,
      id: 'local-comfy',
      label: '本地模型引擎',
      async generate(model, params, onStage, options) {
        const result = await comfy.generate(model, params, onStage, options);
        return { ...result, provider: 'local-comfy' };
      },
    };
  }

  async function generatedAudio(url, params, onStage, provider, options = {}) {
    onStage?.('load', 1);
    onStage?.('encode', 1);
    onStage?.('sample', 0.2);
    const response = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params), signal: options.signal,
    });
    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      try { message = (await response.json()).error || message; } catch (_) {}
      throw new Error(message);
    }
    onStage?.('sample', 1);
    onStage?.('decode', 0.7);
    const blob = await response.blob();
    onStage?.('decode', 1);
    onStage?.('save', 1);
    return { url: URL.createObjectURL(blob), blob, provider, meta: { duration: params.duration } };
  }

  function makeLocalCliProvider() {
    let activeModelId = null;
    return {
      id: 'local-cli', label: '本地原生引擎',
      async cancel() {
        if (!activeModelId) return { ok: false };
        try {
          return await jsonRequest(`/api/local/models/${encodeURIComponent(activeModelId)}/cancel`, { method: 'POST' });
        } catch (_) {
          return { ok: false };
        }
      },
      async generate(model, params, onStage, options) {
        activeModelId = model.id;
        let referenceId = '';
        try {
          let payload = params;
          if (model.supportsReferenceAudio && params.referenceBlob) {
            onStage?.('load', 0.2);
            const wav = await root.ReferenceAudio.toModelWav(params.referenceBlob, params.duration);
            const uploaded = await Sidecar.uploadReference(wav);
            referenceId = uploaded.reference.id;
            payload = { ...params, referenceAudioId: referenceId };
            delete payload.referenceBlob;
            onStage?.('load', 0.8);
          }
          return await generatedAudio(`/api/local/models/${encodeURIComponent(model.id)}/generate`, payload, onStage, 'local-cli', options);
        } finally {
          if (referenceId) Sidecar.removeReference(referenceId).catch(() => {});
          activeModelId = null;
        }
      },
    };
  }

  function makeRemoteProvider() {
    return {
      id: 'remote', label: '用户远端 API',
      generate(model, params, onStage, options) {
        return generatedAudio(`/api/remote/providers/${encodeURIComponent(model.remoteId)}/generate`, params, onStage, `remote:${model.remoteId}`, options);
      },
    };
  }

  const Sidecar = {
    async available() {
      try { return (await fetch('/api/status')).ok; } catch (_) { return false; }
    },
    status() { return jsonRequest('/api/status'); },
    configSmart(body) { return jsonRequest('/api/smart/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); },
    testSmart() { return jsonRequest('/api/smart/test', { method: 'POST' }); },
    completeSmart(body) { return jsonRequest('/api/smart/complete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); },
    async uploadReference(blob) {
      const response = await fetch('/api/local/references', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: blob });
      const data = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
      if (!response.ok || data?.ok === false) throw new Error(data?.error || `HTTP ${response.status}`);
      return data;
    },
    removeReference(id) { return jsonRequest(`/api/local/references/${encodeURIComponent(id)}`, { method: 'DELETE' }); },
    installMusic3() { return jsonRequest('/api/music3/install', { method: 'POST' }); },
    updateMusic3() { return jsonRequest('/api/music3/update', { method: 'POST' }); },
    startMusic3() { return jsonRequest('/api/music3/start', { method: 'POST' }); },
    stopMusic3() { return jsonRequest('/api/music3/stop', { method: 'POST' }); },
    installLocalModel(id) { return jsonRequest(`/api/local/models/${encodeURIComponent(id)}/install`, { method: 'POST' }); },
    uninstallLocalModel(id) { return jsonRequest(`/api/local/models/${encodeURIComponent(id)}/uninstall`, { method: 'POST' }); },
    stopLocalModel(id) { return jsonRequest(`/api/local/models/${encodeURIComponent(id)}/stop`, { method: 'POST' }); },
    updateLocal() { return jsonRequest('/api/local/update', { method: 'POST' }); },
    startLocal() { return jsonRequest('/api/local/start', { method: 'POST' }); },
    stopLocal() { return jsonRequest('/api/local/stop', { method: 'POST' }); },
    configRemote(id, body) {
      return jsonRequest(`/api/remote/providers/${encodeURIComponent(id)}/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    },
    testRemote(id) { return jsonRequest(`/api/remote/providers/${encodeURIComponent(id)}/test`, { method: 'POST' }); },
    configAce(body) {
      return jsonRequest('/api/ace/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    },
    configComfy(body) {
      return jsonRequest('/api/comfy/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    },
    startComfy(body) {
      return jsonRequest('/api/comfy/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    },
    stopComfy() { return jsonRequest('/api/comfy/stop', { method: 'POST' }); },
    async logs(runtime, tail) {
      const data = await jsonRequest(`/api/logs?runtime=${encodeURIComponent(runtime || 'ace')}&tail=${Number(tail) || 200}`);
      return data.lines || [];
    },
  };

  root.Providers = { DemoProvider, makeAceProvider, makeMusic3Provider, makeComfyUIProvider, makeLocalComfyProvider, makeLocalCliProvider, makeRemoteProvider, Sidecar };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.Providers;
})(typeof self !== 'undefined' ? self : this);
