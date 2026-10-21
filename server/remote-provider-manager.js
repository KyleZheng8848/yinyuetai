'use strict';

const fs = require('fs');
const path = require('path');

const MINIMAX_FREE_MODEL = 'music-2.6-free';
const MINIMAX_PAID_MODEL = 'music-2.6';

const PROVIDER_PRESETS = {
  minimax: {
    id: 'minimax', label: 'MiniMax API', adapter: 'minimax',
    baseUrl: 'https://api.minimax.io', model: MINIMAX_FREE_MODEL,
    description: 'MiniMax 官方 Music 2.6 API；默认使用所有 API Key 均可调用的免费模型，付费或 Token Plan 用户可切换高并发模型。',
  },
  stability: {
    id: 'stability', label: 'Stable Audio 3 API', adapter: 'stability',
    baseUrl: 'https://api.stability.ai', model: 'stable-audio-3',
    description: 'Stability AI 官方异步音频 API',
  },
  suno: {
    id: 'suno', label: 'Suno / 自定义兼容 API', adapter: 'custom',
    baseUrl: '', model: '', submitPath: '/api/generate', statusPath: '/api/get?ids={id}',
    description: '填写你使用的 Suno 第三方服务或自建兼容端点',
  },
};

function safeUrl(input, allowEmpty = false) {
  const value = String(input || '').trim().replace(/\/$/, '');
  if (!value && allowEmpty) return '';
  const parsed = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new Error('远端地址必须使用 HTTPS；本机服务可使用 HTTP localhost');
  }
  return parsed.toString().replace(/\/$/, '');
}

function safePath(value, fallback) {
  const result = String(value || fallback || '').trim();
  if (!result.startsWith('/')) throw new Error('接口路径必须以 / 开头');
  return result;
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function fetchTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  catch (error) {
    if (error.name === 'AbortError') throw new Error('远端服务响应超时');
    throw error;
  } finally { clearTimeout(timer); }
}

async function responseMessage(response) {
  try {
    const body = await response.clone().json();
    return body?.error?.message || body?.error || body?.message || body?.base_resp?.status_msg || `HTTP ${response.status}`;
  } catch (_) { return `HTTP ${response.status}`; }
}

function findString(value, keys) {
  if (!value || typeof value !== 'object') return '';
  if (Array.isArray(value)) {
    for (const item of value) { const found = findString(item, keys); if (found) return found; }
    return '';
  }
  for (const key of keys) {
    if (typeof value[key] === 'string' && value[key]) return value[key];
    if (typeof value[key] === 'number') return String(value[key]);
  }
  for (const item of Object.values(value)) {
    const found = findString(item, keys);
    if (found) return found;
  }
  return '';
}

function audioCandidate(data) {
  return findString(data, ['audio_url', 'audioUrl', 'audio', 'url', 'stream_audio_url']);
}

function taskCandidate(data) {
  return findString(data, ['task_id', 'taskId', 'clip_id', 'clipId', 'id']);
}

function taskState(data) {
  return findString(data, ['status', 'state', 'task_status']).toLowerCase();
}

function isMiniMaxPaidAccessError(message) {
  const value = String(message || '');
  return /no longer available to new users|existing paying customers|available to token plan and paid users|not available.*new users/i.test(value);
}

function miniMaxFriendlyError(message, model) {
  const value = String(message || '').trim();
  if (isMiniMaxPaidAccessError(value)) {
    return `${model || MINIMAX_PAID_MODEL} 仅向 MiniMax 付费或 Token Plan 用户开放；请改用 ${MINIMAX_FREE_MODEL}，或在模型中心配置具有付费权限的 Key`;
  }
  return value || '远端服务没有返回错误详情';
}

async function materializeAudio(candidate, headers = {}) {
  if (!candidate) throw new Error('远端服务没有返回音频地址或音频数据');
  if (/^https?:\/\//i.test(candidate)) {
    const response = await fetchTimeout(candidate, { headers }, 5 * 60 * 1000);
    if (!response.ok) throw new Error(`下载远端音频失败：${await responseMessage(response)}`);
    return { buffer: Buffer.from(await response.arrayBuffer()), contentType: response.headers.get('content-type') || 'audio/mpeg' };
  }
  const stripped = candidate.replace(/^data:audio\/[^;]+;base64,/i, '');
  if (/^[0-9a-f]+$/i.test(stripped) && stripped.length % 2 === 0) {
    return { buffer: Buffer.from(stripped, 'hex'), contentType: 'audio/mpeg' };
  }
  try { return { buffer: Buffer.from(stripped, 'base64'), contentType: 'audio/mpeg' }; }
  catch (_) { throw new Error('远端音频编码无法识别'); }
}

class RemoteProviderManager {
  constructor(options = {}) {
    this.runtimeDir = path.resolve(options.runtimeDir || path.join(process.cwd(), '.runtime'));
    this.configPath = path.join(this.runtimeDir, 'remote-providers.json');
    this.secretCodec = options.secretCodec || null;
    this.providers = Object.fromEntries(Object.entries(PROVIDER_PRESETS).map(([id, item]) => [id, { ...item }]));
    this.secrets = {};
    this.secretMigrationRequired = {};
    this.load();
  }

  load() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
      for (const [id, value] of Object.entries(saved.providers || {})) {
        if (!this.providers[id]) continue;
        const preset = this.providers[id];
        this.providers[id] = {
          ...preset,
          baseUrl: typeof value.baseUrl === 'string' ? value.baseUrl : preset.baseUrl,
          model: typeof value.model === 'string' ? value.model : preset.model,
          submitPath: typeof value.submitPath === 'string' ? value.submitPath : preset.submitPath,
          statusPath: typeof value.statusPath === 'string' ? value.statusPath : preset.statusPath,
        };
        if (value.secret && this.secretCodec?.decrypt) {
          try { this.secrets[id] = this.secretCodec.decrypt(value.secret); }
          catch (error) { this.secretMigrationRequired[id] = error?.code === 'LEGACY_SECRET'; }
        }
      }
    } catch (_) {}
  }

  save() {
    fs.mkdirSync(this.runtimeDir, { recursive: true });
    const providers = {};
    for (const [id, provider] of Object.entries(this.providers)) {
      providers[id] = {
        baseUrl: provider.baseUrl, model: provider.model,
        ...(provider.adapter === 'custom' ? { submitPath: provider.submitPath, statusPath: provider.statusPath } : {}),
      };
      if (this.secrets[id] && this.secretCodec?.encrypt) providers[id].secret = this.secretCodec.encrypt(this.secrets[id]);
    }
    fs.writeFileSync(this.configPath, `${JSON.stringify({ version: 1, providers }, null, 2)}\n`, { mode: 0o600 });
    try { fs.chmodSync(this.configPath, 0o600); } catch (_) {}
  }

  list() {
    return Object.values(this.providers).map((provider) => ({
      ...provider,
      configured: Boolean(provider.baseUrl && this.secrets[provider.id]),
      keyHint: this.secrets[provider.id] ? `••••${this.secrets[provider.id].slice(-4)}` : '',
      keyMigrationRequired: Boolean(this.secretMigrationRequired[provider.id]),
      secretPersistent: Boolean(this.secretCodec?.encrypt && this.secretCodec?.decrypt),
    }));
  }

  get(id) {
    const provider = this.providers[id];
    if (!provider) throw new Error('未知的远端模型服务');
    return provider;
  }

  configure(id, body = {}) {
    const current = this.get(id);
    const next = { ...current };
    if (body.baseUrl !== undefined) next.baseUrl = safeUrl(body.baseUrl, current.adapter === 'custom');
    if (body.model !== undefined) next.model = String(body.model || '').trim();
    if (current.adapter === 'custom') {
      if (body.submitPath !== undefined) next.submitPath = safePath(body.submitPath, current.submitPath);
      if (body.statusPath !== undefined) next.statusPath = safePath(body.statusPath, current.statusPath);
    }
    this.providers[id] = next;
    if (body.clearKey) { delete this.secrets[id]; this.secretMigrationRequired[id] = false; }
    else if (typeof body.apiKey === 'string' && body.apiKey.trim()) { this.secrets[id] = body.apiKey.trim(); this.secretMigrationRequired[id] = false; }
    this.save();
    return this.list().find((provider) => provider.id === id);
  }

  requireConfigured(id) {
    const provider = this.get(id);
    const apiKey = this.secrets[id];
    if (!provider.baseUrl) throw new Error('请先填写服务地址');
    if (!apiKey) throw new Error('请先填写 API Key');
    return { provider, apiKey };
  }

  async test(id) {
    const { provider, apiKey } = this.requireConfigured(id);
    const endpoint = provider.adapter === 'minimax' ? '/v1/models'
      : provider.adapter === 'stability' ? '/v1/user/account' : '/';
    const response = await fetchTimeout(new URL(endpoint, `${provider.baseUrl}/`), {
      method: 'GET', headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    }, 15000);
    if ([401, 403].includes(response.status)) throw new Error('服务拒绝了当前 API Key');
    if (response.status >= 500) throw new Error(`远端服务异常：HTTP ${response.status}`);
    return { ok: true, reachable: true, status: response.status };
  }

  async generate(id, params = {}) {
    const { provider, apiKey } = this.requireConfigured(id);
    if (provider.adapter === 'minimax') return this.generateMiniMax(provider, apiKey, params);
    if (provider.adapter === 'stability') return this.generateStability(provider, apiKey, params);
    return this.generateCustom(provider, apiKey, params);
  }

  async generateMiniMax(provider, apiKey, params) {
    const submit = async (model) => {
      const response = await fetchTimeout(new URL('/v1/music_generation', `${provider.baseUrl}/`), {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model, prompt: params.prompt || params.tags || '',
          lyrics: params.lyrics || undefined, lyrics_optimizer: !params.lyrics,
          is_instrumental: !params.lyrics,
          output_format: 'url',
          audio_setting: { sample_rate: 44100, bitrate: 256000, format: 'mp3' },
        }),
      }, 20 * 60 * 1000);
      if (!response.ok) return { ok: false, message: await responseMessage(response) };
      const data = await response.json();
      if (data?.base_resp?.status_code) {
        return { ok: false, message: data.base_resp.status_msg || String(data.base_resp.status_code) };
      }
      return { ok: true, data };
    };

    let model = provider.model || MINIMAX_FREE_MODEL;
    let result = await submit(model);
    if (!result.ok && model === MINIMAX_PAID_MODEL && isMiniMaxPaidAccessError(result.message)) {
      result = await submit(MINIMAX_FREE_MODEL);
      if (result.ok) {
        provider.model = MINIMAX_FREE_MODEL;
        this.save();
        model = MINIMAX_FREE_MODEL;
      }
    }
    if (!result.ok) throw new Error(`MiniMax API：${miniMaxFriendlyError(result.message, model)}`);
    return materializeAudio(result.data?.data?.audio || audioCandidate(result.data));
  }

  async generateStability(provider, apiKey, params) {
    const form = new FormData();
    form.append('prompt', params.prompt || params.tags || 'instrumental music');
    form.append('output_format', 'mp3');
    form.append('duration', String(Math.max(1, Math.min(360, Number(params.duration) || 30))));
    const headers = { Authorization: `Bearer ${apiKey}`, Accept: 'audio/*' };
    const submitted = await fetchTimeout(new URL('/v2beta/audio/stable-audio/text-to-audio', `${provider.baseUrl}/`), {
      method: 'POST', headers, body: form,
    }, 60000);
    if (submitted.status !== 202) throw new Error(`Stable Audio API：${await responseMessage(submitted)}`);
    const taskId = taskCandidate(await submitted.json());
    if (!taskId) throw new Error('Stable Audio API 未返回任务 ID');
    for (let attempt = 0; attempt < 240; attempt++) {
      const result = await fetchTimeout(new URL(`/v2beta/audio/results/${encodeURIComponent(taskId)}`, `${provider.baseUrl}/`), { headers }, 60000);
      if (result.status === 202) {
        await sleep(attempt < 10 ? 1500 : 3000);
        continue;
      }
      if (!result.ok) throw new Error(`Stable Audio API：${await responseMessage(result)}`);
      return { buffer: Buffer.from(await result.arrayBuffer()), contentType: result.headers.get('content-type') || 'audio/mpeg' };
    }
    throw new Error('Stable Audio API 生成超时');
  }

  async generateCustom(provider, apiKey, params) {
    const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json, audio/*' };
    const submitted = await fetchTimeout(new URL(provider.submitPath, `${provider.baseUrl}/`), {
      method: 'POST', headers,
      body: JSON.stringify({
        model: provider.model || undefined,
        title: params.title || undefined,
        prompt: params.prompt || params.tags || '',
        tags: params.tags || params.prompt || '', lyrics: params.lyrics || '',
        duration: Number(params.duration) || 30,
        make_instrumental: !params.lyrics,
      }),
    }, 5 * 60 * 1000);
    if (!submitted.ok) throw new Error(`自定义音乐 API：${await responseMessage(submitted)}`);
    if ((submitted.headers.get('content-type') || '').startsWith('audio/')) {
      return { buffer: Buffer.from(await submitted.arrayBuffer()), contentType: submitted.headers.get('content-type') };
    }
    const initial = await submitted.json();
    const immediate = audioCandidate(initial);
    if (immediate) return materializeAudio(immediate, { Authorization: `Bearer ${apiKey}` });
    const taskId = taskCandidate(initial);
    if (!taskId) throw new Error('自定义音乐 API 未返回音频或任务 ID');
    for (let attempt = 0; attempt < 400; attempt++) {
      const statusPath = provider.statusPath.replace('{id}', encodeURIComponent(taskId));
      const result = await fetchTimeout(new URL(statusPath, `${provider.baseUrl}/`), { headers }, 30000);
      if (!result.ok) throw new Error(`自定义音乐 API 查询失败：${await responseMessage(result)}`);
      const data = await result.json();
      const audio = audioCandidate(data);
      if (audio) return materializeAudio(audio, { Authorization: `Bearer ${apiKey}` });
      const state = taskState(data);
      if (['failed', 'error', 'cancelled', 'rejected'].includes(state)) throw new Error(`远端任务失败：${state}`);
      await sleep(attempt < 15 ? 1200 : 2500);
    }
    throw new Error('自定义音乐 API 生成超时');
  }
}

module.exports = {
  RemoteProviderManager, PROVIDER_PRESETS, safeUrl, safePath,
  audioCandidate, taskCandidate, taskState, isMiniMaxPaidAccessError, miniMaxFriendlyError,
  MINIMAX_FREE_MODEL, MINIMAX_PAID_MODEL,
};
