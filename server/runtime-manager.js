'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const http = require('http');
const https = require('https');

// Electron's bundled Node may configure a 5s timeout on the global HTTPS agent.
// Model files are multi-GB, so downloads use dedicated agents and their own
// inactivity timeout instead of inheriting that global setting.
const DOWNLOAD_AGENTS = {
  'http:': new http.Agent({ keepAlive: true, maxSockets: 2, timeout: 120000 }),
  'https:': new https.Agent({ keepAlive: true, maxSockets: 2, timeout: 120000 }),
};
const DOWNLOAD_INACTIVITY_TIMEOUT = 120000;
const DOWNLOAD_RETRY_LIMIT = 8;

const PROXY_ENV_KEYS = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
];

const COMFY_REPOSITORY = 'https://github.com/Comfy-Org/ComfyUI.git';
const STABLE_AUDIO3_REPOSITORY = 'https://github.com/Stability-AI/stable-audio-3.git';
const STABLE_AUDIO3_REVISION = '779434a908193105335fd8d833418603625b2859';
const STABLE_AUDIO3_ARCHIVE = `https://codeload.github.com/Stability-AI/stable-audio-3/tar.gz/${STABLE_AUDIO3_REVISION}`;
const MUSIC3_LICENSE = 'https://huggingface.co/MiniMaxAI/MiniMax-Music3/blob/main/LICENSE';
const MUSIC3_MLX_REPOSITORY = 'mlx-community/MiniMax-Music3-mxfp8';
const MUSIC3_MLX_REVISION = 'd00a12c3c7f80eb66379dd02dd0f30ed0ce2d96e';
const MUSIC3_MLX_MODELSCOPE_REPOSITORY = 'mlx-community/MiniMax-Music3-mxfp8';
const MUSIC3_MLX_MODELSCOPE_REVISION = 'master';
const MUSIC3_COMFY_MODELSCOPE_REPOSITORY = 'Comfy-Org/MiniMax-Music-3';
const ACE15_MODELSCOPE_REPOSITORY = 'Comfy-Org/ace_step_1.5_ComfyUI_files';
const COMFY_MODELSCOPE_REVISION = 'master';
const MLX_AUDIO_SPEC = 'mlx-audio @ git+https://github.com/Blaizzy/mlx-audio.git@784b29e2691a93ca7483147d86f61859dfaa6296';
const MUSIC3_MLX_EVENT_PREFIX = 'YYT_MUSIC3_EVENT ';
const MUSIC3_MLX_IDLE_TIMEOUT = 10 * 60 * 1000;

const MUSIC3_MLX_FILES = [
  { name: 'config.json', bytes: 1607, sha256: '843a7e7affe6f348a7b087c39e7c26b4e0baced492d391dfc955760a1d9c91dc' },
  { name: 'model-00001-of-00003.safetensors', bytes: 5367222327, sha256: 'bf401989345219258b1a9b3eb10e74faa619a626f92d089a9d6c1949d63a2817' },
  { name: 'model-00002-of-00003.safetensors', bytes: 5364501497, sha256: '54117b8658e1d1981b5fcd550992cd72e246bdd7433ec891bdda0033bf204a98' },
  { name: 'model-00003-of-00003.safetensors', bytes: 3125366332, sha256: 'a71aa696d66edbe08972aece48d6304b6ae7a6ce3229dab1b496549c69ce816c' },
  { name: 'model.safetensors.index.json', bytes: 143381, sha256: 'e093ccc6fe564d0613845368ee4e86fc13662b4474253ae8a0abb69d1976af2d' },
  { name: 'scheduler/scheduler_config.json', bytes: 483, sha256: 'b544466124aab333da4874417da0168610067e9c9ff95fcb63d749e4bf891d99' },
  { name: 'tokenizer/chat_template.jinja', bytes: 4168, sha256: 'a55ee1b1660128b7098723e0abcd92caa0788061051c62d51cbe87d9cf1974d8' },
  { name: 'tokenizer/tokenizer.json', bytes: 11423801, sha256: 'b1537fa9e59a537276ecbc2e12d0438edff635a1f4a4948e679774b5feb3e610' },
  { name: 'tokenizer/tokenizer_config.json', bytes: 377, sha256: '1689852cc9c45010de040c8302a8acdc0d2c4c6c740dd7e9dd0a8c704e16eada' },
];

const MUSIC3_MODELS = [
  {
    directory: 'diffusion_models', name: 'minimax_music3_dit_int8_convrot.safetensors', bytes: 2502161682,
    sha256: 'd6b959633e69899f99f3a92d6741c0fe79f26958a30811e50e372ef978b24d5f',
    url: 'https://huggingface.co/Comfy-Org/MiniMax-Music-3/resolve/main/diffusion_models/minimax_music3_dit_int8_convrot.safetensors',
    mirrors: [
      { label: 'ModelScope', url: 'https://modelscope.cn/models/Comfy-Org/MiniMax-Music-3/resolve/master/diffusion_models/minimax_music3_dit_int8_convrot.safetensors' },
    ],
  },
  {
    directory: 'text_encoders', name: 'minimax_music3_text_encoder_pruned_int8_convrot.safetensors', bytes: 9196611886,
    sha256: '010b7416d2336a08c711bc22ee65849c9623069ddb7d89bec011a75699e52014',
    url: 'https://huggingface.co/Comfy-Org/MiniMax-Music-3/resolve/main/text_encoders/minimax_music3_text_encoder_pruned_int8_convrot.safetensors',
    mirrors: [
      { label: 'ModelScope', url: 'https://modelscope.cn/models/Comfy-Org/MiniMax-Music-3/resolve/master/text_encoders/minimax_music3_text_encoder_pruned_int8_convrot.safetensors' },
    ],
  },
  {
    directory: 'vae', name: 'minimax_music3_dav.safetensors', bytes: 216696128,
    sha256: '2a32155b769be01445fcc2a8663b910fc9e1751e18dc1c3ec528064512d9ef0c',
    url: 'https://huggingface.co/Comfy-Org/MiniMax-Music-3/resolve/main/vae/minimax_music3_dav.safetensors',
    mirrors: [
      { label: 'ModelScope', url: 'https://modelscope.cn/models/Comfy-Org/MiniMax-Music-3/resolve/master/vae/minimax_music3_dav.safetensors' },
    ],
  },
];

const MUSIC3_OPTIONAL_MODELS = [
  { directory: 'diffusion_models', name: 'minimax_music3_dit_fp16.safetensors' },
  { directory: 'text_encoders', name: 'minimax_music3_text_encoder_pruned_bf16.safetensors' },
];

const LOCAL_MODEL_PACKS = [
  {
    id: 'minimax-music-3-mlx', family: 'MiniMax Music 3', label: 'MiniMax Music 3 · MLX 高速', runtime: 'minimax-mlx',
    method: 'Apple MLX · MXFP8', downloadBytes: 13868676861,
    license: 'https://huggingface.co/mlx-community/MiniMax-Music3-mxfp8/blob/main/LICENSE', space: '约 22GB 可用空间',
    description: 'Apple Silicon 原生 MLX 推理，避开 PyTorch MPS 的 INT8 逐层反量化；推荐作为 Mac 上的主运行方式。', files: [],
    platforms: [{ platform: 'darwin', arch: 'arm64' }],
  },
  {
    id: 'minimax-music-3', family: 'MiniMax Music 3', label: 'MiniMax Music 3 · Comfy 兼容', runtime: 'comfy',
    method: 'ComfyUI · INT8', downloadBytes: MUSIC3_MODELS.reduce((sum, file) => sum + file.bytes, 0),
    license: MUSIC3_LICENSE, space: '约 20GB 可用空间',
    description: '完整歌曲生成，支持歌词、段落结构和最长 5 分钟音频。', files: MUSIC3_MODELS,
    modelScope: { repository: MUSIC3_COMFY_MODELSCOPE_REPOSITORY, revision: COMFY_MODELSCOPE_REVISION },
  },
  {
    id: 'stable-audio-open-1.0', family: 'Stable Audio', label: 'Stable Audio 1.0', runtime: 'comfy',
    method: 'ComfyUI · Open 1.0', downloadBytes: 5745535406,
    license: 'https://huggingface.co/stabilityai/stable-audio-open-1.0/blob/main/LICENSE', space: '约 10GB 可用空间',
    description: '开放权重的短音频与音效模型，适合器乐、氛围和声音设计。',
    files: [
      { directory: 'checkpoints', name: 'stable-audio-open-1.0.safetensors', bytes: 4853889016, url: 'https://huggingface.co/Comfy-Org/stable-audio-open-1.0_repackaged/resolve/main/stable-audio-open-1.0.safetensors' },
      { directory: 'text_encoders', name: 't5-base.safetensors', bytes: 891646390, url: 'https://huggingface.co/ComfyUI-Wiki/t5-base/resolve/main/t5-base.safetensors' },
    ],
  },
  {
    id: 'stable-audio-3', family: 'Stable Audio', label: 'Stable Audio 3', runtime: 'mlx',
    method: '官方 MLX · Medium', downloadBytes: 7200000000,
    license: 'https://github.com/Stability-AI/stable-audio-3/blob/main/LICENSE.md', space: '约 15GB 可用空间',
    description: 'Apple Silicon 原生 MLX 推理，适合器乐、氛围、配乐与音效；不支持可控歌词。', files: [],
    platforms: [{ platform: 'darwin', arch: 'arm64' }],
  },
  {
    id: 'ace-step-1.0', family: 'ACE-Step', label: 'ACE-Step 1.0', runtime: 'comfy',
    method: 'ComfyUI · 3.5B', downloadBytes: 7699743341,
    license: 'https://github.com/ace-step/ACE-Step/blob/main/LICENSE', space: '约 14GB 可用空间',
    description: 'ACE-Step 第一代 3.5B 歌曲模型，支持风格标签和结构化歌词。',
    files: [
      { directory: 'checkpoints', name: 'ace_step_v1_3.5b.safetensors', bytes: 7699743341, url: 'https://huggingface.co/Comfy-Org/ACE-Step_ComfyUI_repackaged/resolve/main/all_in_one/ace_step_v1_3.5b.safetensors?download=true' },
    ],
  },
  {
    id: 'ace-step-1.5', family: 'ACE-Step', label: 'ACE-Step 1.5', runtime: 'comfy',
    method: 'ComfyUI · Turbo', downloadBytes: 14695999816,
    license: 'https://github.com/ace-step/ACE-Step-1.5/blob/main/LICENSE', space: '约 24GB 可用空间',
    description: '新一代 Turbo 歌曲模型，8 步快速生成，支持完整歌词与音乐属性控制。',
    modelScope: { repository: ACE15_MODELSCOPE_REPOSITORY, revision: COMFY_MODELSCOPE_REVISION, prefix: 'split_files' },
    files: [
      {
        directory: 'diffusion_models', name: 'acestep_v1.5_turbo.safetensors', bytes: 4787825604,
        url: 'https://huggingface.co/Comfy-Org/ace_step_1.5_ComfyUI_files/resolve/main/split_files/diffusion_models/acestep_v1.5_turbo.safetensors',
        mirrors: [{ label: 'ModelScope', url: 'https://modelscope.cn/models/Comfy-Org/ace_step_1.5_ComfyUI_files/resolve/master/split_files/diffusion_models/acestep_v1.5_turbo.safetensors' }],
      },
      {
        directory: 'vae', name: 'ace_1.5_vae.safetensors', bytes: 337431732,
        url: 'https://huggingface.co/Comfy-Org/ace_step_1.5_ComfyUI_files/resolve/main/split_files/vae/ace_1.5_vae.safetensors',
        mirrors: [{ label: 'ModelScope', url: 'https://modelscope.cn/models/Comfy-Org/ace_step_1.5_ComfyUI_files/resolve/master/split_files/vae/ace_1.5_vae.safetensors' }],
      },
      {
        directory: 'text_encoders', name: 'qwen_0.6b_ace15.safetensors', bytes: 1191588248,
        url: 'https://huggingface.co/Comfy-Org/ace_step_1.5_ComfyUI_files/resolve/main/split_files/text_encoders/qwen_0.6b_ace15.safetensors',
        mirrors: [{ label: 'ModelScope', url: 'https://modelscope.cn/models/Comfy-Org/ace_step_1.5_ComfyUI_files/resolve/master/split_files/text_encoders/qwen_0.6b_ace15.safetensors' }],
      },
      {
        directory: 'text_encoders', name: 'qwen_4b_ace15.safetensors', bytes: 8379154232,
        url: 'https://huggingface.co/Comfy-Org/ace_step_1.5_ComfyUI_files/resolve/main/split_files/text_encoders/qwen_4b_ace15.safetensors',
        mirrors: [{ label: 'ModelScope', url: 'https://modelscope.cn/models/Comfy-Org/ace_step_1.5_ComfyUI_files/resolve/master/split_files/text_encoders/qwen_4b_ace15.safetensors' }],
      },
    ],
  },
];

function parseCommandLine(input) {
  const source = String(input || '').trim();
  if (!source) return [];
  const args = [];
  let current = '';
  let quote = null;
  let escaped = false;
  for (const char of source) {
    if (escaped) { current += char; escaped = false; continue; }
    if (char === '\\' && quote !== "'") { escaped = true; continue; }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (/\s/.test(char)) {
      if (current) { args.push(current); current = ''; }
      continue;
    }
    current += char;
  }
  if (escaped) current += '\\';
  if (quote) throw new Error('启动命令中的引号没有闭合');
  if (current) args.push(current);
  return args;
}

function commandFromCandidates(candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (!candidate.includes(path.sep)) return candidate;
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch (_) {}
  }
  return candidates[candidates.length - 1];
}

function proxyScalar(source, key) {
  const escaped = String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(source || '').match(new RegExp(`^\\s*${escaped}\\s*:\\s*(.*?)\\s*$`, 'm'))?.[1]?.trim() || '';
}

function proxyAddress(scheme, host, port) {
  const cleanHost = String(host || '').trim();
  const cleanPort = Number(port);
  if (!cleanHost || !Number.isInteger(cleanPort) || cleanPort < 1 || cleanPort > 65535) return '';
  const addressHost = cleanHost.includes(':') && !cleanHost.startsWith('[') ? `[${cleanHost}]` : cleanHost;
  try { return new URL(`${scheme}://${addressHost}:${cleanPort}`).toString().replace(/\/$/, ''); } catch (_) { return ''; }
}

function safeProxyDisplay(proxyUrl) {
  try {
    const address = new URL(proxyUrl);
    return `${address.hostname}${address.port ? `:${address.port}` : ''}`;
  } catch (_) { return '已配置代理'; }
}

function normalizeProxyEnvironment(environment = {}) {
  const httpProxy = environment.HTTP_PROXY || environment.http_proxy || '';
  const httpsProxy = environment.HTTPS_PROXY || environment.https_proxy || httpProxy;
  const allProxy = environment.ALL_PROXY || environment.all_proxy || '';
  const noProxy = environment.NO_PROXY || environment.no_proxy || '127.0.0.1,localhost,::1';
  if (!httpProxy && !httpsProxy && !allProxy) return null;
  return {
    source: 'environment', display: safeProxyDisplay(httpsProxy || httpProxy || allProxy),
    env: {
      ...(httpProxy ? { HTTP_PROXY: httpProxy, http_proxy: httpProxy } : {}),
      ...(httpsProxy ? { HTTPS_PROXY: httpsProxy, https_proxy: httpsProxy } : {}),
      ...(httpProxy || httpsProxy
        ? { ALL_PROXY: '', all_proxy: '' }
        : allProxy ? { ALL_PROXY: allProxy, all_proxy: allProxy } : {}),
      NO_PROXY: noProxy, no_proxy: noProxy,
    },
  };
}

function parseMacSystemProxy(source) {
  const enabled = (name) => proxyScalar(source, `${name}Enable`) === '1';
  const build = (name, scheme = 'http') => enabled(name)
    ? proxyAddress(scheme, proxyScalar(source, `${name}Proxy`), proxyScalar(source, `${name}Port`))
    : '';
  const httpProxy = build('HTTP');
  const httpsProxy = build('HTTPS') || httpProxy;
  const socksProxy = build('SOCKS', 'socks5');
  if (httpProxy || httpsProxy) {
    const primary = httpsProxy || httpProxy;
    return {
      source: 'macos-system-http', display: safeProxyDisplay(primary),
      env: {
        HTTP_PROXY: httpProxy || primary, http_proxy: httpProxy || primary,
        HTTPS_PROXY: primary, https_proxy: primary,
        NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1',
      },
    };
  }
  if (!socksProxy) return null;
  // Common macOS proxy clients expose one mixed HTTP CONNECT/SOCKS port but
  // register only SOCKS in System Configuration. huggingface_hub/httpx reads
  // HTTP_PROXY without optional SOCKS support, so use that endpoint as an HTTP
  // tunnel. Do not also set ALL_PROXY=socks5 here: httpx may prefer it and
  // then require the optional socksio package before it considers HTTPS_PROXY.
  const httpTunnel = socksProxy.replace(/^socks5:/, 'http:');
  return {
    source: 'macos-system-socks', display: safeProxyDisplay(socksProxy),
    env: {
      HTTP_PROXY: httpTunnel, http_proxy: httpTunnel,
      HTTPS_PROXY: httpTunnel, https_proxy: httpTunnel,
      NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1',
    },
  };
}

function resolveNetworkEnvironment(options = {}) {
  const environment = options.environment || process.env;
  const configured = normalizeProxyEnvironment(environment);
  if (configured) return configured;
  const platform = options.platform || process.platform;
  if (platform !== 'darwin') return { source: 'direct', display: '', env: {} };
  try {
    const source = options.systemProxyText === undefined
      ? execFileSync('/usr/sbin/scutil', ['--proxy'], { encoding: 'utf8', timeout: 3000 })
      : options.systemProxyText;
    return parseMacSystemProxy(source) || { source: 'direct', display: '', env: {} };
  } catch (_) {
    return { source: 'direct', display: '', env: {} };
  }
}

function parseHuggingFaceFile(sourceUrl) {
  try {
    const address = new URL(sourceUrl);
    if (address.hostname !== 'huggingface.co') return null;
    const parts = address.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (parts.length < 5 || parts[2] !== 'resolve') return null;
    return { repoId: `${parts[0]}/${parts[1]}`, revision: parts[3], filename: parts.slice(4).join('/') };
  } catch (_) { return null; }
}

function requestBuffer(target, options = {}) {
  return new Promise((resolve, reject) => {
    const address = target instanceof URL ? target : new URL(target);
    const transport = address.protocol === 'https:' ? https : http;
    const req = transport.request(address, { method: options.method || 'GET', headers: options.headers || {} }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(options.timeout || 5000, () => req.destroy(new Error('timeout')));
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function endpointReady(base, endpoint) {
  try {
    const response = await requestBuffer(new URL(endpoint, base), { timeout: 2500 });
    return response.status >= 200 && response.status < 300;
  } catch (_) { return false; }
}

function hardwareProfile() {
  const cpu = os.cpus()[0] || {};
  const memoryGb = Math.round(os.totalmem() / 1024 / 1024 / 1024);
  const appleSilicon = process.platform === 'darwin' && process.arch === 'arm64';
  return {
    platform: process.platform, arch: process.arch, cpu: cpu.model || process.arch, memoryGb,
    accelerator: appleSilicon ? 'Apple Metal / MLX' : '自动检测 GPU',
    recommendation: appleSilicon
      ? `${memoryGb}GB 统一内存：可使用 ComfyUI MPS；Stable Audio 3 使用原生 MLX`
      : `${memoryGb}GB 内存：可部署 ComfyUI 模型；Stable Audio 3 MLX 仅支持 Apple Silicon`,
  };
}

function localEngineLaunch(base, profile = hardwareProfile()) {
  const address = new URL(base);
  const appleSilicon = profile.platform === 'darwin' && profile.arch === 'arm64';
  const args = ['main.py', '--listen', address.hostname, '--port', address.port || '8189', '--disable-auto-launch'];
  return {
    args,
    env: appleSilicon ? { PYTORCH_ENABLE_MPS_FALLBACK: '1', YYT_MINIMAX_MPS_TEXT_ENCODER: '1' } : {},
    mode: appleSilicon ? 'apple-silicon-staged' : 'default',
    description: appleSilicon
      ? 'Apple Silicon 分阶段模式（MiniMax AR 使用 MPS，完成后允许卸载并回收统一内存）'
      : '标准内存模式',
  };
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function modelDownloadSources(file) {
  return [
    ...(Array.isArray(file.mirrors) ? file.mirrors : []),
    { label: 'Hugging Face', url: file.url },
  ];
}

function modelScopeFileUrl(repository, revision, filename) {
  const filePath = String(filename).split('/').map(encodeURIComponent).join('/');
  return `https://modelscope.cn/models/${repository}/resolve/${encodeURIComponent(revision)}/${filePath}`;
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function verifyDownloadedModelFile(filePath, file) {
  if (!fs.existsSync(filePath)) throw new Error('下载完成但没有找到模型文件');
  const actualBytes = fs.statSync(filePath).size;
  if (actualBytes !== file.bytes) {
    throw new Error(`模型文件大小校验失败：期望 ${file.bytes} 字节，实际 ${actualBytes} 字节`);
  }
  if (file.sha256) {
    const actualSha256 = await sha256File(filePath);
    if (actualSha256 !== file.sha256) {
      const error = new Error(`模型文件 SHA-256 校验失败：${file.name}`);
      error.code = 'MODEL_CHECKSUM_MISMATCH';
      throw error;
    }
  }
  return filePath;
}

function downloadFile(sourceUrl, destination, onProgress, redirects = 0, expectedBytes = 0) {
  if (redirects > 8) return Promise.reject(new Error('模型下载重定向过多'));
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const partial = `${destination}.part`;
    let existing = fs.existsSync(partial) ? fs.statSync(partial).size : 0;
    if (expectedBytes && existing === expectedBytes) {
      fs.renameSync(partial, destination);
      resolve(destination);
      return;
    }
    if (expectedBytes && existing > expectedBytes) {
      fs.unlinkSync(partial);
      existing = 0;
    }
    const headers = {
      'Accept-Encoding': 'identity',
      'User-Agent': 'Yinyuetai-Studio/1.15.8 model-downloader',
      ...(existing ? { Range: `bytes=${existing}-` } : {}),
    };
    const address = new URL(sourceUrl);
    if (address.hostname === 'huggingface.co' && process.env.HF_TOKEN) headers.Authorization = `Bearer ${process.env.HF_TOKEN}`;
    const transport = address.protocol === 'https:' ? https : http;
    const req = transport.get(address, { headers, agent: DOWNLOAD_AGENTS[address.protocol], timeout: DOWNLOAD_INACTIVITY_TIMEOUT }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        downloadFile(new URL(res.headers.location, address).toString(), destination, onProgress, redirects + 1, expectedBytes).then(resolve, reject);
        return;
      }
      if (res.statusCode === 416 && expectedBytes && existing === expectedBytes) {
        res.resume();
        fs.renameSync(partial, destination);
        resolve(destination);
        return;
      }
      if (![200, 206].includes(res.statusCode)) {
        res.resume();
        reject(new Error(`模型下载失败 HTTP ${res.statusCode}`));
        return;
      }
      const resumed = res.statusCode === 206 ? existing : 0;
      const total = resumed + Number(res.headers['content-length'] || 0);
      const stream = fs.createWriteStream(partial, { flags: resumed ? 'a' : 'w' });
      let received = resumed;
      let lastReport = received;
      let lastReportAt = Date.now();
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        stream.destroy();
        reject(error);
      };
      res.on('data', (chunk) => {
        received += chunk.length;
        if (received - lastReport >= 8 * 1024 * 1024 || Date.now() - lastReportAt >= 2000 || received === total) {
          lastReport = received;
          lastReportAt = Date.now();
          onProgress?.({ received, total });
        }
      });
      res.pipe(stream);
      res.on('aborted', () => fail(new Error('下载连接意外中断')));
      res.on('error', fail);
      stream.on('error', fail);
      stream.on('finish', () => stream.close(() => {
        if (settled) return;
        if (expectedBytes && fs.statSync(partial).size !== expectedBytes) {
          fail(new Error(`模型文件大小校验失败：${path.basename(destination)}`));
          return;
        }
        settled = true;
        fs.rename(partial, destination, (error) => error ? reject(error) : resolve(destination));
      }));
    });
    req.on('error', reject);
    req.setTimeout(DOWNLOAD_INACTIVITY_TIMEOUT, () => req.destroy(new Error('模型下载长时间无数据')));
  });
}

async function downloadFileWithRetry(sourceUrl, destination, onProgress, expectedBytes = 0, onRetry, retryLimit = DOWNLOAD_RETRY_LIMIT) {
  let lastError = null;
  for (let attempt = 1; attempt <= retryLimit; attempt++) {
    try {
      return await downloadFile(sourceUrl, destination, onProgress, 0, expectedBytes);
    } catch (error) {
      lastError = error;
      if (attempt >= retryLimit) break;
      const partial = `${destination}.part`;
      const resumeBytes = fs.existsSync(partial) ? fs.statSync(partial).size : 0;
      const waitMs = Math.min(30000, 1500 * (2 ** (attempt - 1)));
      onRetry?.({ attempt, retryLimit, resumeBytes, waitMs, error });
      await delay(waitMs);
    }
  }
  const resumeBytes = fs.existsSync(`${destination}.part`) ? fs.statSync(`${destination}.part`).size : 0;
  throw new Error(`${lastError?.message || '下载失败'}；自动重试 ${retryLimit} 次后仍未恢复，已保留 ${Math.round(resumeBytes / 1024 / 1024)}MB 断点`);
}

function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  return Math.max(min, Math.min(max, Number.isFinite(parsed) ? parsed : fallback));
}

function stableAudio3GenerationRequest(params = {}, output = '') {
  const prompt = String(params.prompt || params.tags || 'instrumental music').trim().slice(0, 4000);
  const negativePrompt = String(params.negativePrompt || '').trim().slice(0, 2000);
  const duration = boundedNumber(params.duration, 30, 5, 360);
  const steps = Math.round(boundedNumber(params.steps, 8, 4, 16));
  const cfg = boundedNumber(params.cfg, 1, 1, 3);
  const seed = Number(params.seed) >>> 0;
  const referenceAudioPath = String(params.referenceAudioPath || '').trim();
  const referenceStrength = boundedNumber(params.referenceStrength, 0.7, 0.4, 0.8);
  const args = [
    'scripts/sa3_mlx.py', '--prompt', prompt, '--dit', 'medium', '--decoder', 'same-l',
    '--seconds', String(duration), '--steps', String(steps), '--seed', String(seed), '--cfg', String(cfg),
  ];
  if (negativePrompt && cfg !== 1) args.push('--negative-prompt', negativePrompt);
  if (referenceAudioPath) args.push('--init-audio', referenceAudioPath, '--init-noise-level', String(referenceStrength));
  args.push('--out', output);
  return { prompt, negativePrompt, duration, steps, cfg, seed, referenceAudioPath, referenceStrength, args };
}

class RuntimeManager {
  constructor(options = {}) {
    this.runtimeDir = path.resolve(options.runtimeDir || path.join(process.cwd(), '.runtime'));
    this.localDir = path.join(this.runtimeDir, 'ComfyUI-Audio');
    this.stableAudio3Dir = path.join(this.runtimeDir, 'stable-audio-3');
    this.stableAudio3Archive = path.join(this.runtimeDir, `stable-audio-3-${STABLE_AUDIO3_REVISION}.tar.gz`);
    this.stableAudio3Staging = path.join(this.runtimeDir, `stable-audio-3-source-${STABLE_AUDIO3_REVISION.slice(0, 8)}.partial`);
    this.music3MlxDir = path.join(this.runtimeDir, 'minimax-music3-mlx');
    this.music3MlxModelDir = path.join(this.music3MlxDir, 'model');
    this.referenceAudioDir = path.join(this.runtimeDir, 'reference-audio');
    this.config = {
      localBase: options.localBase || options.music3Base || process.env.YYT_LOCAL_BASE || 'http://127.0.0.1:8189',
      music3Base: options.localBase || options.music3Base || process.env.YYT_LOCAL_BASE || 'http://127.0.0.1:8189',
      aceBase: options.aceBase || process.env.YYT_ACE_BASE || 'http://127.0.0.1:8001',
      comfyBase: options.comfyBase || process.env.YYT_COMFY_BASE || 'http://127.0.0.1:8188',
      comfyCmd: process.env.YYT_COMFY_CMD || '', comfyCwd: process.env.YYT_COMFY_CWD || '',
    };
    this.processes = { local: null, music3: null, comfy: null, operation: null, generation: null };
    this.music3MlxWorker = null;
    this.music3MlxWorkerReady = null;
    this.music3MlxWorkerReadyResolve = null;
    this.music3MlxWorkerReadyReject = null;
    this.music3MlxWorkerPending = null;
    this.music3MlxWorkerBuffer = '';
    this.music3MlxIdleTimer = null;
    this.music3MlxLastMetrics = null;
    this.activeGenerationModel = null;
    this.phase = { local: 'idle', music3: 'idle', comfy: 'idle' };
    this.logs = { local: [], music3: [], comfy: [] };
    this.progress = { local: null };
    this.activePack = null;
    this.shuttingDown = false;
    this.uv = commandFromCandidates([
      process.env.YYT_UV_PATH,
      path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'uv.exe' : 'uv'),
      '/opt/homebrew/bin/uv', '/usr/local/bin/uv', process.platform === 'win32' ? 'uv.exe' : 'uv',
    ]);
    this.git = commandFromCandidates([process.env.YYT_GIT_PATH, process.platform === 'win32' ? 'git.exe' : '/usr/bin/git', 'git']);
    this.curl = commandFromCandidates([
      process.env.YYT_CURL_PATH,
      process.platform === 'win32' ? 'curl.exe' : '/usr/bin/curl',
      '/opt/homebrew/bin/curl', 'curl',
    ]);
    this.network = resolveNetworkEnvironment();
  }

  pack(id) {
    const pack = LOCAL_MODEL_PACKS.find((item) => item.id === id);
    if (!pack) throw new Error('未知的本地模型');
    return pack;
  }

  pushLog(runtime, message) {
    const safeRuntime = runtime === 'comfy' ? 'comfy' : 'local';
    const line = `[${new Date().toISOString()}] ${message}`;
    this.logs[safeRuntime].push(line);
    if (this.logs[safeRuntime].length > 1200) this.logs[safeRuntime].shift();
    if (safeRuntime === 'local') this.logs.music3 = this.logs.local;
  }

  attachProcess(runtime, child, label) {
    child.stdout?.on('data', (data) => String(data).split(/\r?\n/).forEach((line) => line.trim() && this.pushLog(runtime, line.trim())));
    child.stderr?.on('data', (data) => String(data).split(/\r?\n/).forEach((line) => line.trim() && this.pushLog(runtime, `! ${line.trim()}`)));
    child.on('error', (error) => this.pushLog(runtime, `${label} 启动失败：${error.message}`));
  }

  runStep(runtime, command, args, cwd, label, extraEnv = {}) {
    return new Promise((resolve, reject) => {
      this.pushLog(runtime, `${label}：${command} ${args.join(' ')}`);
      const child = spawn(command, args, { cwd, env: { ...process.env, ...this.network.env, ...extraEnv }, windowsHide: true });
      this.processes.operation = child;
      this.attachProcess(runtime, child, label);
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        if (this.processes.operation === child) this.processes.operation = null;
        code === 0 ? resolve() : reject(new Error(`${label}退出（code=${code}, signal=${signal || 'none'}）`));
      });
    });
  }

  runGenerationStep(modelId, command, args, cwd, label, extraEnv = {}) {
    if (this.processes.generation) return Promise.reject(new Error('已有本地原生生成任务正在运行'));
    return new Promise((resolve, reject) => {
      this.pushLog('local', `${label}：${command} ${args.join(' ')}`);
      const child = spawn(command, args, { cwd, env: { ...process.env, ...this.network.env, ...extraEnv }, windowsHide: true });
      this.processes.generation = child;
      this.activeGenerationModel = modelId;
      this.attachProcess('local', child, label);
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        if (this.processes.generation === child) this.processes.generation = null;
        if (this.activeGenerationModel === modelId) this.activeGenerationModel = null;
        error ? reject(error) : resolve();
      };
      child.once('error', (error) => finish(error));
      child.once('exit', (code, signal) => {
        finish(code === 0 ? null : new Error(`${label}退出（code=${code}, signal=${signal || 'none'}）`));
      });
    });
  }

  localPython() {
    return process.platform === 'win32'
      ? path.join(this.localDir, '.venv', 'Scripts', 'python.exe')
      : path.join(this.localDir, '.venv', 'bin', 'python');
  }

  music3MlxPython() {
    return process.platform === 'win32'
      ? path.join(this.music3MlxDir, '.venv', 'Scripts', 'python.exe')
      : path.join(this.music3MlxDir, '.venv', 'bin', 'python');
  }

  music3MlxHf() {
    return process.platform === 'win32'
      ? path.join(this.music3MlxDir, '.venv', 'Scripts', 'hf.exe')
      : path.join(this.music3MlxDir, '.venv', 'bin', 'hf');
  }

  comfyEnvironmentReady() {
    return fs.existsSync(path.join(this.localDir, 'main.py')) && fs.existsSync(this.localPython());
  }

  music3MlxEnvironmentReady() {
    return fs.existsSync(this.music3MlxPython());
  }

  stableAudio3SourceReady() {
    return fs.existsSync(path.join(this.stableAudio3Dir, 'optimized', 'mlx', 'install.sh'));
  }

  storeReferenceAudio(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 44) throw new Error('参考音频为空或格式无效');
    if (buffer.subarray(0, 4).toString('ascii') !== 'RIFF' || buffer.subarray(8, 12).toString('ascii') !== 'WAVE') {
      throw new Error('参考音频必须转换为 WAV 后上传');
    }
    fs.mkdirSync(this.referenceAudioDir, { recursive: true });
    const id = crypto.randomBytes(16).toString('hex');
    const target = path.join(this.referenceAudioDir, `${id}.wav`);
    fs.writeFileSync(target, buffer, { mode: 0o600 });
    return { id, bytes: buffer.length };
  }

  referenceAudioPath(id) {
    const safeId = String(id || '').trim();
    if (!/^[a-f0-9]{32}$/.test(safeId)) throw new Error('参考音频 ID 无效');
    const target = path.join(this.referenceAudioDir, `${safeId}.wav`);
    if (!fs.existsSync(target)) throw new Error('参考音频已失效，请重新从曲库选择');
    return target;
  }

  removeReferenceAudio(id) {
    const safeId = String(id || '').trim();
    if (!/^[a-f0-9]{32}$/.test(safeId)) return false;
    const target = path.join(this.referenceAudioDir, `${safeId}.wav`);
    try { fs.unlinkSync(target); return true; } catch (error) { if (error.code !== 'ENOENT') throw error; return false; }
  }

  installStableAudio3OutputGuard() {
    const script = path.join(this.stableAudio3Dir, 'optimized', 'mlx', 'scripts', 'sa3_mlx.py');
    if (!fs.existsSync(script)) return false;
    const source = fs.readFileSync(script, 'utf8');
    if (source.includes('# YYT_OUTPUT_GUARD_BEGIN')) return true;
    const anchor = '    save_wav(args.out, audio_np)\n';
    if (!source.includes(anchor)) throw new Error('Stable Audio 3 源码版本不兼容，无法安装输出防削波保护');
    const guarded = source.replace(anchor, [
      '    # YYT_OUTPUT_GUARD_BEGIN',
      '    raw_peak = float(np.abs(audio_np).max())',
      '    target_peak = 10.0 ** (-1.0 / 20.0)  # -1 dBFS headroom',
      '    if raw_peak > target_peak:',
      '        gain = target_peak / raw_peak',
      '        audio_np = audio_np * gain',
      '        sub(f"output guard  peak {raw_peak:.3f} → {target_peak:.3f}  gain {20.0 * np.log10(gain):.1f} dB")',
      '    # YYT_OUTPUT_GUARD_END',
      '    save_wav(args.out, audio_np)',
      '',
    ].join('\n'));
    fs.writeFileSync(script, guarded);
    this.pushLog('local', 'Stable Audio 3 已启用 -1 dBFS 输出防削波保护');
    return true;
  }

  installMusic3MlxRunner() {
    const source = path.join(__dirname, 'runtime-assets', 'minimax_music3_mlx_runner.py');
    const target = path.join(this.music3MlxDir, 'yinyuetai_music3_mlx.py');
    const content = fs.readFileSync(source);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (!fs.existsSync(target) || !fs.readFileSync(target).equals(content)) fs.writeFileSync(target, content, { mode: 0o644 });
    return target;
  }

  scheduleMusic3MlxWorkerIdleStop() {
    if (this.music3MlxIdleTimer) clearTimeout(this.music3MlxIdleTimer);
    this.music3MlxIdleTimer = setTimeout(() => {
      if (!this.processes.generation && this.music3MlxWorker) {
        this.pushLog('local', 'MiniMax Music 3 MLX 常驻引擎空闲 10 分钟，释放模型内存');
        this.stopMusic3MlxWorker();
      }
    }, MUSIC3_MLX_IDLE_TIMEOUT);
    this.music3MlxIdleTimer.unref?.();
  }

  disposeMusic3MlxWorker(child, error = null) {
    if (this.music3MlxWorker !== child) return;
    if (this.music3MlxIdleTimer) clearTimeout(this.music3MlxIdleTimer);
    this.music3MlxIdleTimer = null;
    this.music3MlxWorker = null;
    this.music3MlxWorkerBuffer = '';
    const rejectReady = this.music3MlxWorkerReadyReject;
    this.music3MlxWorkerReady = null;
    this.music3MlxWorkerReadyResolve = null;
    this.music3MlxWorkerReadyReject = null;
    if (rejectReady) rejectReady(error || new Error('MiniMax Music 3 MLX 常驻引擎已停止'));
    const pending = this.music3MlxWorkerPending;
    this.music3MlxWorkerPending = null;
    if (pending) pending.reject(error || new Error('MiniMax Music 3 MLX 常驻引擎已停止'));
    if (this.processes.generation === child) this.processes.generation = null;
    if (this.activeGenerationModel === 'minimax-music-3-mlx') this.activeGenerationModel = null;
  }

  stopMusic3MlxWorker(error = null) {
    const child = this.music3MlxWorker;
    if (!child) return false;
    this.disposeMusic3MlxWorker(child, error);
    try { child.stdin?.end(); } catch (_) {}
    try { child.kill('SIGTERM'); } catch (_) {}
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 5000);
    timer.unref?.();
    return true;
  }

  handleMusic3MlxWorkerLine(child, line) {
    if (!line.startsWith(MUSIC3_MLX_EVENT_PREFIX)) {
      if (line.trim()) this.pushLog('local', line.trim());
      return;
    }
    let event;
    try { event = JSON.parse(line.slice(MUSIC3_MLX_EVENT_PREFIX.length)); }
    catch (_) { this.pushLog('local', `! MLX 常驻引擎返回了无法解析的消息：${line.slice(0, 240)}`); return; }
    if (event.type === 'loading') {
      this.pushLog('local', event.label || '正在载入 MiniMax Music 3 MLX 权重');
      return;
    }
    if (event.type === 'ready') {
      this.pushLog('local', `${event.label || 'MiniMax Music 3 MLX 常驻引擎已就绪'} · 载入 ${Number(event.loadSeconds || 0).toFixed(1)} 秒`);
      this.music3MlxWorkerReadyResolve?.(child);
      this.music3MlxWorkerReadyResolve = null;
      this.music3MlxWorkerReadyReject = null;
      return;
    }
    if (event.type === 'stage') {
      const elapsed = Number(event.elapsedSeconds || 0);
      this.pushLog('local', `${event.label || event.stage}${elapsed ? ` · 已用 ${elapsed.toFixed(1)} 秒` : ''}${event.frames ? ` · ${event.frames} 帧` : ''}`);
      return;
    }
    if (event.type !== 'result') return;
    const pending = this.music3MlxWorkerPending;
    if (!pending || pending.id !== event.id) {
      this.pushLog('local', `! 收到未知 MLX 生成结果：${event.id || '无任务 ID'}`);
      return;
    }
    this.music3MlxWorkerPending = null;
    if (this.processes.generation === child) this.processes.generation = null;
    if (this.activeGenerationModel === pending.modelId) this.activeGenerationModel = null;
    if (event.ok) {
      this.music3MlxLastMetrics = event.metrics || null;
      const metrics = event.metrics || {};
      this.pushLog('local', `MiniMax Music 3 MLX 生成完成 · ${Number(metrics.actualDuration || 0).toFixed(1)} 秒音频 · 耗时 ${Number(metrics.elapsedSeconds || 0).toFixed(1)} 秒 · RTF ${Number(metrics.realTimeFactor || 0).toFixed(2)}x · 峰值 ${Number(metrics.peakMemoryGb || 0).toFixed(1)}GB`);
      pending.resolve(event.metrics || {});
      this.scheduleMusic3MlxWorkerIdleStop();
    } else {
      pending.reject(new Error(event.error || 'MiniMax Music 3 MLX 生成失败'));
      this.scheduleMusic3MlxWorkerIdleStop();
    }
  }

  ensureMusic3MlxWorker() {
    if (this.music3MlxWorker && this.music3MlxWorkerReady) return this.music3MlxWorkerReady;
    const runner = this.installMusic3MlxRunner();
    const child = spawn(this.music3MlxPython(), [runner, '--worker', this.music3MlxModelDir], {
      cwd: this.music3MlxDir,
      env: { ...process.env, ...this.network.env },
      windowsHide: true,
    });
    this.music3MlxWorker = child;
    this.music3MlxWorkerBuffer = '';
    this.pushLog('local', `启动 MiniMax Music 3 MLX 常驻引擎：${child.pid || 'pending'}`);
    this.music3MlxWorkerReady = new Promise((resolve, reject) => {
      this.music3MlxWorkerReadyResolve = resolve;
      this.music3MlxWorkerReadyReject = reject;
    });
    child.stdout?.on('data', (data) => {
      if (this.music3MlxWorker !== child) return;
      this.music3MlxWorkerBuffer += String(data);
      const lines = this.music3MlxWorkerBuffer.split(/\r?\n/);
      this.music3MlxWorkerBuffer = lines.pop() || '';
      lines.forEach((line) => this.handleMusic3MlxWorkerLine(child, line));
    });
    child.stderr?.on('data', (data) => String(data).split(/\r?\n/).forEach((line) => line.trim() && this.pushLog('local', `! ${line.trim()}`)));
    child.once('error', (workerError) => {
      this.pushLog('local', `MiniMax Music 3 MLX 常驻引擎启动失败：${workerError.message}`);
      this.disposeMusic3MlxWorker(child, workerError);
    });
    child.once('exit', (code, signal) => {
      if (this.music3MlxWorker !== child) return;
      const error = new Error(`MiniMax Music 3 MLX 常驻引擎退出（code=${code}, signal=${signal || 'none'}）`);
      this.pushLog('local', error.message);
      this.disposeMusic3MlxWorker(child, error);
    });
    return this.music3MlxWorkerReady;
  }

  async runMusic3MlxWorkerGeneration(modelId, request) {
    if (this.processes.generation) throw new Error('已有本地原生生成任务正在运行');
    const workerReady = this.ensureMusic3MlxWorker();
    const startingChild = this.music3MlxWorker;
    this.processes.generation = startingChild;
    this.activeGenerationModel = modelId;
    let child;
    try { child = await workerReady; }
    catch (workerError) {
      if (this.processes.generation === startingChild) this.processes.generation = null;
      if (this.activeGenerationModel === modelId) this.activeGenerationModel = null;
      throw workerError;
    }
    if (this.processes.generation !== child || this.activeGenerationModel !== modelId) throw new Error('MiniMax Music 3 MLX 生成已停止');
    if (!child.stdin?.writable) throw new Error('MiniMax Music 3 MLX 常驻引擎输入已关闭');
    if (this.music3MlxIdleTimer) clearTimeout(this.music3MlxIdleTimer);
    this.music3MlxIdleTimer = null;
    return new Promise((resolve, reject) => {
      this.music3MlxWorkerPending = { id: request.id, modelId, resolve, reject };
      try { child.stdin.write(`${JSON.stringify(request)}\n`); }
      catch (writeError) {
        this.music3MlxWorkerPending = null;
        this.processes.generation = null;
        this.activeGenerationModel = null;
        reject(writeError);
      }
    });
  }

  installMusic3MlxDownloader() {
    const source = path.join(__dirname, 'runtime-assets', 'modelscope_parallel_downloader.py');
    const target = path.join(this.music3MlxDir, 'yinyuetai_modelscope_downloader.py');
    const content = fs.readFileSync(source);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (!fs.existsSync(target) || !fs.readFileSync(target).equals(content)) fs.writeFileSync(target, content, { mode: 0o644 });
    return target;
  }

  installComfyModelDownloader() {
    const source = path.join(__dirname, 'runtime-assets', 'modelscope_parallel_downloader.py');
    const target = path.join(this.localDir, 'yinyuetai_modelscope_downloader.py');
    const content = fs.readFileSync(source);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (!fs.existsSync(target) || !fs.readFileSync(target).equals(content)) fs.writeFileSync(target, content, { mode: 0o644 });
    return target;
  }

  installMpsInt8Compatibility(profile = hardwareProfile()) {
    if (profile.platform !== 'darwin' || profile.arch !== 'arm64' || !this.comfyEnvironmentReady()) return false;
    const source = path.join(__dirname, 'runtime-assets', 'yinyuetai_mps_int8.py');
    const target = path.join(this.localDir, 'custom_nodes', 'yinyuetai_mps_int8.py');
    const content = fs.readFileSync(source);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (!fs.existsSync(target) || !fs.readFileSync(target).equals(content)) {
      fs.writeFileSync(target, content, { mode: 0o644 });
      this.pushLog('local', '已安装 Apple MPS INT8 兼容层（按层反量化 + Metal 计算）');
    }
    return true;
  }

  modelPath(file) { return path.join(this.localDir, 'models', file.directory, file.name); }

  comfyPackDownloadedBytes(pack) {
    return pack.files.reduce((total, file) => {
      const target = this.modelPath(file);
      const partial = `${target}.part`;
      try {
        if (fs.statSync(target).size === file.bytes) return total + file.bytes;
      } catch (_) {}
      try { return total + Math.min(file.bytes, fs.statSync(partial).size); } catch (_) { return total; }
    }, 0);
  }

  async promoteComfyPackDownloads(pack) {
    for (const file of pack.files) {
      const target = this.modelPath(file);
      const partial = `${target}.part`;
      if (fs.existsSync(target)) {
        try {
          await verifyDownloadedModelFile(target, file);
          continue;
        } catch (_) {
          fs.unlinkSync(target);
        }
      }
      if (!fs.existsSync(partial) || fs.statSync(partial).size !== file.bytes) continue;
      try {
        await verifyDownloadedModelFile(partial, file);
        fs.renameSync(partial, target);
      } catch (error) {
        if (error.code === 'MODEL_CHECKSUM_MISMATCH') fs.unlinkSync(partial);
        throw error;
      }
    }
  }

  async downloadComfyPackFromModelScope(pack) {
    if (!pack.modelScope) return;
    const modelRoot = path.join(this.localDir, 'models');
    fs.mkdirSync(modelRoot, { recursive: true });
    await this.promoteComfyPackDownloads(pack);
    const pending = pack.files.filter((file) => {
      const target = this.modelPath(file);
      try { return fs.statSync(target).size !== file.bytes; } catch (_) { return true; }
    });
    if (!pending.length) return;
    const downloader = this.installComfyModelDownloader();
    const requestPath = path.join(this.localDir, `.yinyuetai-modelscope-${pack.id}.json`);
    const prefix = String(pack.modelScope.prefix || '').replace(/^\/+|\/+$/g, '');
    const files = pending.map((file) => {
      const name = path.posix.join(file.directory, file.name);
      return {
        name,
        sourceName: prefix ? path.posix.join(prefix, name) : name,
        bytes: file.bytes,
        ...(file.sha256 ? { sha256: file.sha256 } : {}),
      };
    });
    fs.writeFileSync(requestPath, `${JSON.stringify({
      root: modelRoot,
      repository: pack.modelScope.repository,
      revision: pack.modelScope.revision || COMFY_MODELSCOPE_REVISION,
      workers: 3,
      files,
    })}\n`, { mode: 0o600 });
    this.progress.local = {
      modelId: pack.id, file: `${pending.length} 个文件（最多 3 路并行）`, fileIndex: pack.files.length - pending.length + 1,
      fileCount: pack.files.length, received: this.comfyPackDownloadedBytes(pack), total: pack.downloadBytes,
      indeterminate: false, downloader: 'python-httpx-parallel', sourceLabel: 'ModelScope',
    };
    const progressTimer = setInterval(() => {
      if (this.progress.local?.modelId === pack.id) {
        this.progress.local = { ...this.progress.local, received: this.comfyPackDownloadedBytes(pack) };
      }
    }, 1000);
    progressTimer.unref?.();
    try {
      await this.runStep('local', this.localPython(), [downloader, requestPath], this.localDir, 'ModelScope 高速镜像 · Python 三路并行断点下载');
      await this.promoteComfyPackDownloads(pack);
    } finally {
      clearInterval(progressTimer);
      try { fs.unlinkSync(requestPath); } catch (_) {}
    }
  }

  music3ModelProfile() {
    const diffusionModels = path.join(this.localDir, 'models', 'diffusion_models');
    const textEncoders = path.join(this.localDir, 'models', 'text_encoders');
    const fp16Diffusion = 'minimax_music3_dit_fp16.safetensors';
    const int8Diffusion = 'minimax_music3_dit_int8_convrot.safetensors';
    const bf16TextEncoder = 'minimax_music3_text_encoder_pruned_bf16.safetensors';
    const int8TextEncoder = 'minimax_music3_text_encoder_pruned_int8_convrot.safetensors';
    const diffusionModel = fs.existsSync(path.join(diffusionModels, fp16Diffusion)) ? fp16Diffusion : int8Diffusion;
    const textEncoder = fs.existsSync(path.join(textEncoders, bf16TextEncoder)) ? bf16TextEncoder : int8TextEncoder;
    return {
      diffusionModel,
      textEncoder,
      diffusionPrecision: diffusionModel === fp16Diffusion ? 'FP16' : 'INT8',
      textEncoderPrecision: textEncoder === bf16TextEncoder ? 'BF16' : 'INT8',
      nativeMpsWeights: diffusionModel === fp16Diffusion && textEncoder === bf16TextEncoder,
    };
  }

  packSupported(pack) {
    return !pack.platforms || pack.platforms.some((item) => item.platform === process.platform && item.arch === process.arch);
  }

  packInstalled(packOrId) {
    const pack = typeof packOrId === 'string' ? this.pack(packOrId) : packOrId;
    if (!this.packSupported(pack)) return false;
    if (pack.runtime === 'minimax-mlx') {
      const marker = path.join(this.music3MlxDir, '.yinyuetai-installed');
      let installedRevision = '';
      try { installedRevision = fs.readFileSync(marker, 'utf8').trim(); } catch (_) {}
      return this.music3MlxEnvironmentReady() && installedRevision === MUSIC3_MLX_REVISION && MUSIC3_MLX_FILES.every((file) => {
        const target = path.join(this.music3MlxModelDir, file.name);
        return fs.existsSync(target) && fs.statSync(target).size === file.bytes;
      });
    }
    if (pack.runtime === 'mlx') {
      return fs.existsSync(path.join(this.stableAudio3Dir, 'optimized', 'mlx', '.yinyuetai-medium-installed'));
    }
    return this.comfyEnvironmentReady() && pack.files.every((file) => {
      const target = this.modelPath(file);
      return fs.existsSync(target) && fs.statSync(target).size === file.bytes;
    });
  }

  packRemovalTargets(packOrId) {
    const pack = typeof packOrId === 'string' ? this.pack(packOrId) : packOrId;
    if (pack.runtime === 'minimax-mlx') return [this.music3MlxDir];
    if (pack.runtime === 'mlx') return [this.stableAudio3Dir, this.stableAudio3Archive, `${this.stableAudio3Archive}.part`, this.stableAudio3Staging];
    const files = pack.files.flatMap((file) => {
      const target = this.modelPath(file);
      return [target, `${target}.part`];
    });
    if (pack.id === 'minimax-music-3') {
      for (const file of MUSIC3_OPTIONAL_MODELS) files.push(this.modelPath(file), `${this.modelPath(file)}.part`);
    }
    return files;
  }

  packHasData(packOrId) {
    return this.packRemovalTargets(packOrId).some((target) => {
      try { fs.lstatSync(target); return true; } catch (_) { return false; }
    });
  }

  removeManagedTarget(target, allowedRoot) {
    const root = path.resolve(allowedRoot);
    const resolved = path.resolve(target);
    if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) throw new Error('拒绝删除本地模型目录之外的路径');
    fs.rmSync(resolved, { recursive: true, force: true });
  }

  uninstallLocalModel(id) {
    const pack = this.pack(id);
    if (this.processes.operation || this.processes.generation || ['installing', 'updating'].includes(this.phase.local)) {
      return { ok: false, error: '已有本地部署或生成任务在进行中，请结束后再卸载' };
    }
    if (pack.runtime === 'comfy' && (this.processes.local || ['ready', 'starting', 'stopping'].includes(this.phase.local))) {
      return { ok: false, error: '请先停止共享本地引擎再卸载 ComfyUI 模型' };
    }
    if (!this.packHasData(pack)) return { ok: false, error: `${pack.label} 没有可卸载的本地文件` };
    if (pack.runtime === 'minimax-mlx') this.stopMusic3MlxWorker();
    const allowedRoot = pack.runtime === 'comfy' ? path.join(this.localDir, 'models') : this.runtimeDir;
    for (const target of this.packRemovalTargets(pack)) this.removeManagedTarget(target, allowedRoot);
    this.phase.local = LOCAL_MODEL_PACKS.some((item) => item.id !== id && this.packInstalled(item)) ? 'installed' : 'idle';
    this.pushLog('local', `已卸载 ${pack.label}；${pack.runtime === 'comfy' ? '共享 ComfyUI 运行时和其他模型已保留' : '专用模型目录和运行环境已删除'}`);
    return { ok: true, modelId: id, estimatedFreedBytes: pack.downloadBytes };
  }

  async ensureComfyRuntime() {
    fs.mkdirSync(this.runtimeDir, { recursive: true });
    if (!fs.existsSync(path.join(this.localDir, '.git'))) {
      if (fs.existsSync(this.localDir)) throw new Error(`发现未完成的运行时目录：${this.localDir}`);
      await this.runStep('local', this.git, ['clone', '--depth', '1', COMFY_REPOSITORY, this.localDir], this.runtimeDir, '安装共享 ComfyUI 运行时');
    }
    if (!fs.existsSync(this.localPython())) {
      await this.runStep('local', this.uv, ['venv', '--python', '3.13', path.join(this.localDir, '.venv')], this.localDir, '创建 Python 3.13 隔离环境');
    }
    await this.runStep('local', this.uv, ['pip', 'install', '--python', this.localPython(), '-r', 'requirements.txt'], this.localDir, '安装本地推理依赖');
  }

  async installComfyPack(pack) {
    await this.ensureComfyRuntime();
    if (this.shuttingDown) throw new Error('应用退出，模型下载已暂停');
    if (pack.modelScope) {
      try {
        this.pushLog('local', `优先使用 ModelScope 高速镜像（三路并行）：${pack.modelScope.repository}`);
        await this.downloadComfyPackFromModelScope(pack);
      } catch (modelScopeError) {
        if (this.shuttingDown) throw modelScopeError;
        this.pushLog('local', `ModelScope 并行下载未完成：${modelScopeError.message}；保留断点并切换逐文件备用链路`);
      }
    }
    fileLoop: for (let index = 0; index < pack.files.length; index++) {
      if (this.shuttingDown) throw new Error('应用退出，模型下载已暂停');
      const file = pack.files[index];
      const destination = this.modelPath(file);
      const sources = modelDownloadSources(file);
      if (fs.existsSync(destination) && fs.statSync(destination).size === file.bytes) continue;
      if (fs.existsSync(destination)) {
        this.pushLog('local', `移除校验不通过的旧文件：${file.name}`);
        fs.unlinkSync(destination);
      }
      this.progress.local = { modelId: pack.id, file: file.name, fileIndex: index + 1, fileCount: pack.files.length, received: 0, total: file.bytes };
      this.pushLog('local', `下载 ${pack.label} ${index + 1}/${pack.files.length}：${file.name}`);
      if (this.curl) {
        for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
          const source = sources[sourceIndex];
          try {
            const partial = `${destination}.part`;
            this.progress.local = { ...this.progress.local, indeterminate: true, downloader: 'curl', sourceLabel: source.label };
            await this.runStep('local', this.curl, [
              '--location', '--fail', '--continue-at', '-', '--retry', sourceIndex ? '20' : '3', '--retry-delay', '3',
              '--retry-all-errors', '--connect-timeout', '30', '--speed-limit', '1024', '--speed-time', '120',
              '--header', 'Accept-Encoding: identity', '--user-agent', 'Yinyuetai-Studio/1.15.8 model-downloader',
              '--progress-bar', '--output', partial, source.url,
            ], this.localDir, `${source.label}${sourceIndex ? ' 备用源' : ''}断点下载 · ${file.name}`);
            await verifyDownloadedModelFile(partial, file);
            fs.renameSync(partial, destination);
            this.progress.local = { ...this.progress.local, indeterminate: false, received: file.bytes, total: file.bytes };
            continue fileLoop;
          } catch (error) {
            if (this.shuttingDown) throw error;
            if (error.code === 'MODEL_CHECKSUM_MISMATCH' && fs.existsSync(`${destination}.part`)) fs.unlinkSync(`${destination}.part`);
            const nextSource = sources[sourceIndex + 1];
            this.pushLog('local', `${source.label} 下载未完成：${error.message}${nextSource ? `；自动切换 ${nextSource.label} 备用源` : '；继续尝试其他下载器'}`);
          }
        }
      }
      const hfFile = parseHuggingFaceFile(file.url);
      const hfCommand = process.platform === 'win32'
        ? path.join(this.localDir, '.venv', 'Scripts', 'hf.exe')
        : path.join(this.localDir, '.venv', 'bin', 'hf');
      if (hfFile && fs.existsSync(hfCommand)) {
        try {
          this.progress.local = { ...this.progress.local, indeterminate: true, downloader: 'huggingface-hub' };
          await this.runStep('local', hfCommand, [
            'download', hfFile.repoId, hfFile.filename, '--revision', hfFile.revision,
            '--local-dir', path.join(this.localDir, 'models'),
          ], this.localDir, `Hugging Face 官方下载器 · ${file.name}`, {
            HF_HUB_DOWNLOAD_TIMEOUT: '120', HF_HUB_ETAG_TIMEOUT: '30', HF_XET_HIGH_PERFORMANCE: '0', HF_XET_NUM_CONCURRENT_RANGE_GETS: '4',
          });
          await verifyDownloadedModelFile(destination, file);
          this.progress.local = { ...this.progress.local, indeterminate: false, received: file.bytes, total: file.bytes };
          continue fileLoop;
        } catch (error) {
          if (this.shuttingDown) throw error;
          if (error.code === 'MODEL_CHECKSUM_MISMATCH' && fs.existsSync(destination)) fs.unlinkSync(destination);
          this.pushLog('local', `官方分块下载器未完成：${error.message}；切换到 HTTP Range 断点续传`);
        }
      }
      let lastError = null;
      for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
        const source = sources[sourceIndex];
        try {
          this.progress.local = { ...this.progress.local, indeterminate: false, downloader: 'http-range', sourceLabel: source.label };
          await downloadFileWithRetry(source.url, destination, ({ received, total }) => {
            this.progress.local = { ...this.progress.local, received, total: total || file.bytes };
          }, file.bytes, ({ attempt, retryLimit, resumeBytes, waitMs, error }) => {
            this.progress.local = { ...this.progress.local, retryAttempt: attempt + 1, retryLimit, received: resumeBytes, total: file.bytes };
            this.pushLog('local', `${source.label} · ${file.name} 下载中断：${error.message}；${Math.round(waitMs / 1000)} 秒后进行第 ${attempt + 1}/${retryLimit} 次连接，从 ${Math.round(resumeBytes / 1024 / 1024)}MB 继续`);
          }, sourceIndex ? DOWNLOAD_RETRY_LIMIT : 3);
          await verifyDownloadedModelFile(destination, file);
          continue fileLoop;
        } catch (error) {
          if (this.shuttingDown) throw error;
          lastError = error;
          if (error.code === 'MODEL_CHECKSUM_MISMATCH' && fs.existsSync(destination)) fs.unlinkSync(destination);
          const nextSource = sources[sourceIndex + 1];
          this.pushLog('local', `${source.label} 内置下载未完成：${error.message}${nextSource ? `；自动切换 ${nextSource.label} 备用源` : ''}`);
        }
      }
      throw lastError || new Error(`${file.name} 的全部下载源均不可用`);
    }
  }

  async installStableAudio3(pack) {
    if (!this.packSupported(pack)) throw new Error('Stable Audio 3 本地 MLX 目前只支持 Apple Silicon Mac');
    fs.mkdirSync(this.runtimeDir, { recursive: true });
    if (!this.stableAudio3SourceReady()) {
      if (fs.existsSync(this.stableAudio3Dir)) {
        this.pushLog('local', '清理上次 Git 中断留下的不完整 Stable Audio 3 源码目录');
        this.removeManagedTarget(this.stableAudio3Dir, this.runtimeDir);
      }
      this.progress.local = { modelId: pack.id, file: 'Stable Audio 3 官方源码', fileIndex: 0, fileCount: 1, received: 0, total: 0, indeterminate: true, downloader: 'official-archive' };
      this.pushLog('local', `下载固定版本官方源码：${STABLE_AUDIO3_ARCHIVE}`);
      if (!fs.existsSync(this.stableAudio3Archive)) {
        const partial = `${this.stableAudio3Archive}.part`;
        try {
          await this.runStep('local', this.curl, [
            '--http1.1', '--location', '--fail', '--continue-at', '-', '--retry', '12', '--retry-delay', '3',
            '--retry-all-errors', '--connect-timeout', '30', '--speed-limit', '1024', '--speed-time', '120',
            '--header', 'Accept-Encoding: identity', '--user-agent', 'Yinyuetai-Studio/1.15.8 source-downloader',
            '--progress-bar', '--output', partial, STABLE_AUDIO3_ARCHIVE,
          ], this.runtimeDir, '官方下载器 · Stable Audio 3 源码（HTTP/1.1 断点续传）');
          fs.renameSync(partial, this.stableAudio3Archive);
        } catch (curlError) {
          this.pushLog('local', `curl 下载未完成：${curlError.message}；切换内置 Range 下载器继续断点`);
          await downloadFileWithRetry(STABLE_AUDIO3_ARCHIVE, this.stableAudio3Archive, ({ received, total }) => {
            this.progress.local = { ...this.progress.local, received, total, indeterminate: !total };
          }, 0, ({ attempt, retryLimit, resumeBytes, waitMs, error }) => {
            this.progress.local = { ...this.progress.local, retryAttempt: attempt + 1, retryLimit, received: resumeBytes };
            this.pushLog('local', `官方源码下载中断：${error.message}；${Math.round(waitMs / 1000)} 秒后第 ${attempt + 1}/${retryLimit} 次续传，已保留 ${Math.round(resumeBytes / 1024 / 1024)}MB`);
          });
        }
      }
      const stagingDir = this.stableAudio3Staging;
      if (fs.existsSync(stagingDir)) this.removeManagedTarget(stagingDir, this.runtimeDir);
      fs.mkdirSync(stagingDir, { recursive: true });
      try {
        await this.runStep('local', '/usr/bin/tar', ['-xzf', this.stableAudio3Archive, '-C', stagingDir, '--strip-components=1'], this.runtimeDir, '解压 Stable Audio 3 官方源码');
        if (!fs.existsSync(path.join(stagingDir, 'optimized', 'mlx', 'install.sh'))) throw new Error('官方源码包缺少 MLX 安装脚本');
        fs.renameSync(stagingDir, this.stableAudio3Dir);
        fs.writeFileSync(path.join(this.stableAudio3Dir, '.yinyuetai-source'), `${STABLE_AUDIO3_REVISION}\n`);
        fs.rmSync(this.stableAudio3Archive, { force: true });
        this.pushLog('local', `Stable Audio 3 官方源码准备完成（${STABLE_AUDIO3_REVISION.slice(0, 8)}）`);
      } catch (error) {
        if (fs.existsSync(stagingDir)) this.removeManagedTarget(stagingDir, this.runtimeDir);
        fs.rmSync(this.stableAudio3Archive, { force: true });
        throw error;
      }
    }
    const mlxDir = path.join(this.stableAudio3Dir, 'optimized', 'mlx');
    this.installStableAudio3OutputGuard();
    const venvDir = path.join(mlxDir, '.venv');
    const python = path.join(venvDir, 'bin', 'python');
    if (!fs.existsSync(python)) {
      await this.runStep('local', this.uv, ['venv', '--python', '3.12', venvDir], mlxDir, '创建 Stable Audio 3 Python 3.12 环境');
    }
    this.progress.local = { modelId: pack.id, file: 'Stable Audio 3 MLX 依赖', fileIndex: 1, fileCount: 2, received: 0, total: 0, indeterminate: true, downloader: 'aliyun-pypi' };
    await this.runStep('local', this.uv, [
      'pip', 'install', '--python', python,
      '--index-url', 'https://mirrors.aliyun.com/pypi/simple', '--extra-index-url', 'https://pypi.org/simple',
      '-r', path.join(mlxDir, 'requirements.txt'),
    ], mlxDir, '安装 Stable Audio 3 MLX 依赖（阿里云镜像，官方源备用）', {
      UV_HTTP_TIMEOUT: '120', UV_CONCURRENT_DOWNLOADS: '2',
    });
    this.progress.local = { modelId: pack.id, file: 'Stable Audio 3 Medium + codec', fileIndex: 2, fileCount: 2, received: 0, total: pack.downloadBytes, indeterminate: true, downloader: 'huggingface-hub' };
    await this.runStep('local', python, ['scripts/install.py', '--download', 'medium'], mlxDir, '下载 Stable Audio 3 Medium 权重并完成部署', {
      INSTALL_SKIP_PIP: '1', HF_HOME: path.join(this.stableAudio3Dir, '.hf-cache'),
      HF_HUB_DOWNLOAD_TIMEOUT: '120', HF_HUB_ETAG_TIMEOUT: '30', HF_XET_HIGH_PERFORMANCE: '0', HF_HUB_DISABLE_XET: '1',
    });
    const marker = path.join(this.stableAudio3Dir, 'optimized', 'mlx', '.yinyuetai-medium-installed');
    fs.writeFileSync(marker, `${new Date().toISOString()}\n`);
  }

  mlxDownloadedBytes() {
    return MUSIC3_MLX_FILES.reduce((total, file) => {
      const target = path.join(this.music3MlxModelDir, file.name);
      const partial = `${target}.part`;
      try {
        if (fs.statSync(target).size === file.bytes) return total + file.bytes;
      } catch (_) {}
      try { return total + Math.min(file.bytes, fs.statSync(partial).size); } catch (_) { return total; }
    }, 0);
  }

  async promoteMiniMaxMlxDownloads() {
    for (const file of MUSIC3_MLX_FILES) {
      const target = path.join(this.music3MlxModelDir, file.name);
      const partial = `${target}.part`;
      if (fs.existsSync(target)) {
        try {
          await verifyDownloadedModelFile(target, file);
          continue;
        } catch (_) {
          fs.unlinkSync(target);
        }
      }
      if (!fs.existsSync(partial) || fs.statSync(partial).size !== file.bytes) continue;
      try {
        await verifyDownloadedModelFile(partial, file);
        fs.renameSync(partial, target);
      } catch (error) {
        if (error.code === 'MODEL_CHECKSUM_MISMATCH') fs.unlinkSync(partial);
        throw error;
      }
    }
  }

  async downloadMiniMaxMlxFromModelScope(pack) {
    fs.mkdirSync(this.music3MlxModelDir, { recursive: true });
    await this.promoteMiniMaxMlxDownloads();
    const pending = MUSIC3_MLX_FILES.filter((file) => {
      const target = path.join(this.music3MlxModelDir, file.name);
      try { return fs.statSync(target).size !== file.bytes; } catch (_) { return true; }
    });
    if (!pending.length) return;
    const downloader = this.installMusic3MlxDownloader();
    const requestPath = path.join(this.music3MlxDir, '.yinyuetai-modelscope-download.json');
    fs.writeFileSync(requestPath, `${JSON.stringify({
      root: this.music3MlxModelDir,
      repository: MUSIC3_MLX_MODELSCOPE_REPOSITORY,
      revision: MUSIC3_MLX_MODELSCOPE_REVISION,
      workers: 3,
      files: pending,
    })}\n`, { mode: 0o600 });
    this.progress.local = {
      modelId: pack.id, file: `${pending.length} 个文件（最多 3 路并行）`, fileIndex: MUSIC3_MLX_FILES.length - pending.length + 1,
      fileCount: MUSIC3_MLX_FILES.length, received: this.mlxDownloadedBytes(), total: pack.downloadBytes,
      indeterminate: false, downloader: 'python-httpx-parallel', sourceLabel: 'ModelScope',
    };
    const progressTimer = setInterval(() => {
      if (this.progress.local?.modelId === pack.id) {
        this.progress.local = { ...this.progress.local, received: this.mlxDownloadedBytes() };
      }
    }, 1000);
    progressTimer.unref?.();
    try {
      await this.runStep('local', this.music3MlxPython(), [downloader, requestPath], this.music3MlxDir, 'ModelScope 高速镜像 · Python 三路并行断点下载');
      await this.promoteMiniMaxMlxDownloads();
    } finally {
      clearInterval(progressTimer);
      try { fs.unlinkSync(requestPath); } catch (_) {}
    }
  }

  async installMiniMaxMlx(pack) {
    if (!this.packSupported(pack)) throw new Error('MiniMax Music 3 MLX 仅支持 Apple Silicon Mac');
    fs.mkdirSync(this.music3MlxDir, { recursive: true });
    if (!this.music3MlxEnvironmentReady()) {
      await this.runStep('local', this.uv, ['venv', '--python', '3.12', path.join(this.music3MlxDir, '.venv')], this.music3MlxDir, '创建 MiniMax MLX Python 3.12 环境');
    }
    await this.runStep('local', this.uv, ['pip', 'install', '--python', this.music3MlxPython(), MLX_AUDIO_SPEC], this.music3MlxDir, '安装固定版本 mlx-audio');
    this.installMusic3MlxRunner();
    this.installMusic3MlxDownloader();
    try {
      this.pushLog('local', `优先使用 ModelScope 高速镜像：${MUSIC3_MLX_MODELSCOPE_REPOSITORY}`);
      await this.downloadMiniMaxMlxFromModelScope(pack);
    } catch (modelScopeError) {
      if (this.shuttingDown) throw modelScopeError;
      this.pushLog('local', `ModelScope 镜像未完成：${modelScopeError.message}；切换 Hugging Face 标准 HTTP 下载`);
      this.progress.local = {
        modelId: pack.id, file: MUSIC3_MLX_REPOSITORY, fileIndex: 1, fileCount: 1,
        received: this.mlxDownloadedBytes(), total: pack.downloadBytes, indeterminate: true, downloader: 'huggingface-hub', sourceLabel: 'Hugging Face',
      };
      await this.runStep('local', this.music3MlxHf(), [
        'download', MUSIC3_MLX_REPOSITORY, '--revision', MUSIC3_MLX_REVISION, '--local-dir', this.music3MlxModelDir,
      ], this.music3MlxDir, `下载 MiniMax Music 3 MLX MXFP8 · ${MUSIC3_MLX_REPOSITORY}`, {
        HF_HUB_DISABLE_XET: '1', HF_HUB_DOWNLOAD_TIMEOUT: '120', HF_HUB_ETAG_TIMEOUT: '30',
      });
    }
    for (const file of MUSIC3_MLX_FILES) {
      const target = path.join(this.music3MlxModelDir, file.name);
      if (!fs.existsSync(target) || fs.statSync(target).size !== file.bytes) {
        throw new Error(`MiniMax MLX 文件校验失败：${file.name}`);
      }
    }
    fs.writeFileSync(path.join(this.music3MlxDir, '.yinyuetai-installed'), `${MUSIC3_MLX_REVISION}\n`, { mode: 0o644 });
    this.progress.local = { ...this.progress.local, indeterminate: false, received: pack.downloadBytes, total: pack.downloadBytes };
  }

  installLocalModel(id) {
    const pack = this.pack(id);
    if (!this.packSupported(pack)) return { ok: false, error: '当前系统不支持这个本地运行方式' };
    if (this.processes.operation || this.processes.generation || ['installing', 'updating'].includes(this.phase.local)) return { ok: false, error: '已有本地部署或原生生成任务在进行中' };
    if (this.packInstalled(pack)) return { ok: false, error: `${pack.label} 已安装` };
    this.phase.local = 'installing';
    this.activePack = id;
    const installDir = pack.runtime === 'mlx' ? this.stableAudio3Dir
      : pack.runtime === 'minimax-mlx' ? this.music3MlxDir : this.localDir;
    this.pushLog('local', `开始部署 ${pack.label}，目录：${installDir}`);
    if (this.network.source.startsWith('macos-system')) {
      this.pushLog('local', `已自动接入 macOS 系统代理 ${this.network.display}；从 Finder 启动也可下载模型`);
    }
    (async () => {
      try {
        if (pack.runtime === 'minimax-mlx') await this.installMiniMaxMlx(pack);
        else if (pack.runtime === 'mlx') await this.installStableAudio3(pack);
        else await this.installComfyPack(pack);
        this.phase.local = 'installed';
        this.pushLog('local', `${pack.label} 本地部署完成。`);
      } catch (error) {
        this.phase.local = 'error';
        this.pushLog('local', `${pack.label} 部署失败：${error.message}`);
      } finally {
        this.progress.local = null;
        this.activePack = null;
      }
    })();
    return { ok: true, started: true, modelId: id, downloadBytes: pack.downloadBytes, license: pack.license };
  }

  async startLocal() {
    if (await endpointReady(this.config.localBase, '/system_stats')) return { ok: true, ready: true, managed: Boolean(this.processes.local) };
    if (!this.comfyEnvironmentReady()) return { ok: false, error: '请先安装一个 ComfyUI 本地模型' };
    if (this.processes.local) return { ok: true, ready: false, pid: this.processes.local.pid };
    const profile = hardwareProfile();
    const launch = localEngineLaunch(this.config.localBase, profile);
    this.installMpsInt8Compatibility(profile);
    const child = spawn(this.localPython(), launch.args, { cwd: this.localDir, env: { ...process.env, ...launch.env }, windowsHide: true });
    this.processes.local = child;
    this.processes.music3 = child;
    this.phase.local = 'starting';
    this.pushLog('local', `启动共享本地引擎：${this.config.localBase}`);
    this.pushLog('local', `推理优化：${launch.description}`);
    this.attachProcess('local', child, '本地音频引擎');
    child.on('exit', (code, signal) => {
      if (this.processes.local === child) this.processes.local = null;
      if (this.processes.music3 === child) this.processes.music3 = null;
      if (this.phase.local !== 'stopping') this.phase.local = code === 0 ? 'installed' : 'error';
      this.pushLog('local', `本地引擎已退出（code=${code}, signal=${signal || 'none'}）`);
    });
    return { ok: true, ready: false, pid: child.pid };
  }

  updateLocal() {
    if (this.processes.local) return { ok: false, error: '请先停止本地引擎再更新' };
    if (!this.comfyEnvironmentReady() && !this.stableAudio3SourceReady() && !this.music3MlxEnvironmentReady()) return { ok: false, error: '尚未安装本地运行时' };
    if (this.processes.operation || this.processes.generation) return { ok: false, error: '已有本地部署或原生生成任务在进行中' };
    this.stopMusic3MlxWorker();
    this.phase.local = 'updating';
    (async () => {
      try {
        if (this.comfyEnvironmentReady()) {
          await this.runStep('local', this.git, ['pull', '--ff-only'], this.localDir, '更新 ComfyUI');
          await this.runStep('local', this.uv, ['pip', 'install', '--python', this.localPython(), '-r', 'requirements.txt'], this.localDir, '同步 ComfyUI 依赖');
        }
        if (fs.existsSync(path.join(this.stableAudio3Dir, '.git'))) {
          await this.runStep('local', this.git, ['-c', 'http.version=HTTP/1.1', 'pull', '--ff-only'], this.stableAudio3Dir, '更新 Stable Audio 3');
        } else if (this.stableAudio3SourceReady()) {
          this.pushLog('local', `Stable Audio 3 使用应用锁定的官方源码版本 ${STABLE_AUDIO3_REVISION.slice(0, 8)}，无需 Git 更新`);
        }
        if (this.stableAudio3SourceReady()) this.installStableAudio3OutputGuard();
        if (this.music3MlxEnvironmentReady()) {
          await this.runStep('local', this.uv, ['pip', 'install', '--python', this.music3MlxPython(), MLX_AUDIO_SPEC], this.music3MlxDir, '校准 MiniMax Music 3 MLX 运行时');
          this.installMusic3MlxRunner();
        }
        this.phase.local = 'installed';
        this.pushLog('local', '本地运行时更新完成。');
      } catch (error) {
        this.phase.local = 'error';
        this.pushLog('local', `更新失败：${error.message}`);
      }
    })();
    return { ok: true, started: true };
  }

  async generateLocal(id, params = {}) {
    const pack = this.pack(id);
    if (!['mlx', 'minimax-mlx'].includes(pack.runtime)) throw new Error('该模型由共享 ComfyUI 本地引擎生成');
    if (!this.packInstalled(pack)) throw new Error(`${pack.label} 尚未安装`);
    if (pack.runtime === 'minimax-mlx') return this.generateMiniMaxMlx(id, params);
    const mlxDir = path.join(this.stableAudio3Dir, 'optimized', 'mlx');
    const python = path.join(mlxDir, '.venv', 'bin', 'python');
    const outputDir = path.join(this.runtimeDir, 'generated');
    fs.mkdirSync(outputDir, { recursive: true });
    const output = path.join(outputDir, `stable-audio-3-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.wav`);
    const referenceAudioId = String(params.referenceAudioId || '').trim();
    const referenceAudioPath = referenceAudioId ? this.referenceAudioPath(referenceAudioId) : '';
    const request = stableAudio3GenerationRequest({ ...params, referenceAudioPath }, output);
    try {
      this.installStableAudio3OutputGuard();
      if (request.duration > 120) this.pushLog('local', `Stable Audio 3 长音频提示：${request.duration} 秒可能降低结构一致性，推荐拆分为 30–120 秒片段`);
      const referenceLabel = referenceAudioPath ? ` · 参考变奏 ${request.referenceStrength}` : '';
      this.pushLog('local', `Stable Audio 3 质量参数：${request.steps} 步 · CFG ${request.cfg}${referenceLabel} · 输出防削波已开启`);
      await this.runGenerationStep(id, python, request.args, mlxDir, 'Stable Audio 3 生成', {
        HF_HOME: path.join(this.stableAudio3Dir, '.hf-cache'),
      });
      return { buffer: fs.readFileSync(output), contentType: 'audio/wav' };
    } finally {
      try { fs.unlinkSync(output); } catch (_) {}
      if (referenceAudioId) this.removeReferenceAudio(referenceAudioId);
    }
  }

  async generateMiniMaxMlx(id, params = {}) {
    const outputDir = path.join(this.runtimeDir, 'generated');
    fs.mkdirSync(outputDir, { recursive: true });
    const nonce = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const output = path.join(outputDir, `minimax-music3-mlx-${nonce}.wav`);
    const request = {
      id: nonce,
      model: this.music3MlxModelDir,
      caption: String(params.prompt || params.tags || '').trim().slice(0, 5000),
      lyrics: String(params.lyrics || '').trim().slice(0, 16000),
      duration: Math.max(1, Math.min(300, Number(params.duration) || 30)),
      steps: Math.max(1, Math.min(30, Math.round(Number(params.steps) || 8))),
      cfg: Math.max(0.5, Math.min(5, Number(params.cfg) || 1.7)),
      fastAr: params.speedMode === 'draft',
      seed: Number(params.seed) >>> 0,
      output,
    };
    if (!request.caption) throw new Error('MiniMax Music 3 MLX 需要音乐描述');
    if (!request.lyrics) throw new Error('MiniMax Music 3 MLX 需要歌词；纯音乐可填写 [Instrumental]');
    try {
      const warm = Boolean(this.music3MlxWorker);
      this.pushLog('local', `${warm ? '复用' : '准备'} MiniMax Music 3 MLX 常驻引擎 · ${request.duration} 秒 · ${request.steps} 步 · CFG ${request.cfg}${request.fastAr ? ' · 极速单路编曲' : request.cfg === 1 ? ' · 单路声学生成' : ''}`);
      const metrics = await this.runMusic3MlxWorkerGeneration(id, request);
      const buffer = fs.readFileSync(output);
      return { buffer, contentType: 'audio/wav', metrics };
    } finally {
      try { fs.unlinkSync(output); } catch (_) {}
    }
  }

  cancelLocalGeneration(id) {
    const child = this.processes.generation;
    if (!child) return { ok: false, error: '当前没有本地原生生成任务' };
    if (id && this.activeGenerationModel && id !== this.activeGenerationModel) return { ok: false, error: '当前运行的是另一个本地模型' };
    if (child === this.music3MlxWorker) {
      this.pushLog('local', '正在中断 MiniMax Music 3 MLX；常驻权重会一并释放');
      this.stopMusic3MlxWorker(new Error('MiniMax Music 3 MLX 生成已停止'));
      return { ok: true };
    }
    this.processes.generation = null;
    this.activeGenerationModel = null;
    try { child.kill('SIGTERM'); } catch (_) {}
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 5000);
    timer.unref?.();
    this.pushLog('local', '已停止本地原生生成任务');
    return { ok: true };
  }

  stopLocalModelService(id) {
    const pack = this.pack(id);
    if (this.processes.generation) {
      const active = this.activeGenerationModel ? this.pack(this.activeGenerationModel).label : '本地模型';
      return { ok: false, error: `${active} 正在生成，请先在创作台停止当前任务` };
    }
    if (pack.runtime === 'minimax-mlx') {
      const stopped = this.stopMusic3MlxWorker();
      if (stopped) this.pushLog('local', '已手动停止 MiniMax Music 3 MLX 常驻服务并释放模型内存');
      return {
        ok: true,
        stopped,
        message: stopped ? 'MiniMax Music 3 MLX 服务已停止，模型内存正在释放' : 'MiniMax Music 3 MLX 服务当前未运行',
      };
    }
    if (pack.runtime === 'comfy') {
      if (this.processes.local) return { ...this.stop('local'), message: '共享 ComfyUI 引擎已停止' };
      return {
        ok: false,
        error: this.phase.local === 'ready'
          ? '当前共享 ComfyUI 不是由音悦台启动，请在它原来的终端中停止'
          : '共享 ComfyUI 引擎当前未运行',
      };
    }
    return { ok: true, stopped: false, notRequired: true, message: `${pack.label} 按任务启动，完成后已自动退出` };
  }

  configureComfy(body = {}) {
    if (typeof body.comfyBase === 'string' && body.comfyBase.trim()) {
      const parsed = new URL(body.comfyBase.trim());
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('ComfyUI 地址必须使用 http 或 https');
      this.config.comfyBase = parsed.toString().replace(/\/$/, '');
    }
    if (typeof body.comfyCmd === 'string') this.config.comfyCmd = body.comfyCmd.trim();
    if (typeof body.comfyCwd === 'string') this.config.comfyCwd = body.comfyCwd.trim();
    return { ...this.config };
  }

  configureAce(body = {}) {
    if (typeof body.aceBase === 'string' && body.aceBase.trim()) {
      const parsed = new URL(body.aceBase.trim());
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('ACE-Step 地址必须使用 http 或 https');
      this.config.aceBase = parsed.toString().replace(/\/$/, '');
    }
    return { ...this.config };
  }

  async startComfy(body = {}) {
    this.configureComfy(body);
    if (await endpointReady(this.config.comfyBase, '/system_stats')) return { ok: true, ready: true, external: !this.processes.comfy };
    if (this.processes.comfy) return { ok: true, ready: false, pid: this.processes.comfy.pid };
    const parts = parseCommandLine(this.config.comfyCmd);
    if (!parts.length) return { ok: false, error: '未配置 ComfyUI 启动命令' };
    const cwd = this.config.comfyCwd || process.cwd();
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) return { ok: false, error: `目录不存在：${cwd}` };
    const child = spawn(parts[0], parts.slice(1), { cwd, env: process.env, windowsHide: true });
    this.processes.comfy = child;
    this.phase.comfy = 'starting';
    this.pushLog('comfy', `启动：${parts.join(' ')}（cwd=${cwd}）`);
    this.attachProcess('comfy', child, 'ComfyUI');
    child.on('exit', (code, signal) => {
      if (this.processes.comfy === child) this.processes.comfy = null;
      this.phase.comfy = code === 0 ? 'idle' : 'error';
      this.pushLog('comfy', `进程已退出（code=${code}, signal=${signal || 'none'}）`);
    });
    return { ok: true, ready: false, pid: child.pid };
  }

  stop(runtime) {
    const target = runtime === 'music3' ? 'local' : runtime;
    const child = this.processes[target];
    if (!child) return { ok: false, error: '当前没有由音悦台托管的进程' };
    this.phase[target] = 'stopping';
    this.processes[target] = null;
    if (target === 'local') this.processes.music3 = null;
    try { child.kill('SIGTERM'); } catch (_) {}
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 5000);
    timer.unref?.();
    this.pushLog(target, '已发送停止信号');
    return { ok: true };
  }

  async status() {
    const [localReady, aceReady, comfyReady] = await Promise.all([
      endpointReady(this.config.localBase, '/system_stats'), endpointReady(this.config.aceBase, '/health'), endpointReady(this.config.comfyBase, '/system_stats'),
    ]);
    if (localReady && !['installing', 'updating'].includes(this.phase.local)) this.phase.local = 'ready';
    else if (this.processes.local && this.phase.local !== 'stopping') this.phase.local = 'starting';
    else if (LOCAL_MODEL_PACKS.some((pack) => this.packInstalled(pack)) && !['installing', 'updating', 'error'].includes(this.phase.local)) this.phase.local = 'installed';
    if (comfyReady) this.phase.comfy = 'ready';
    else if (this.processes.comfy && this.phase.comfy !== 'stopping') this.phase.comfy = 'starting';
    const packs = LOCAL_MODEL_PACKS.map((pack) => ({
      ...pack, files: undefined, installed: this.packInstalled(pack), supported: this.packSupported(pack),
      removable: this.packHasData(pack),
      active: this.activePack === pack.id, progress: this.activePack === pack.id ? this.progress.local : null,
    }));
    const local = {
      ready: localReady, runtimeInstalled: this.comfyEnvironmentReady(), running: Boolean(this.processes.local), managed: Boolean(this.processes.local),
      pid: this.processes.local?.pid || null, phase: this.phase.local, base: this.config.localBase, path: this.localDir,
      activePack: this.activePack, progress: this.progress.local, packs, music3Profile: this.music3ModelProfile(),
      generating: Boolean(this.processes.generation), activeGenerationModel: this.activeGenerationModel,
      music3MlxWorker: {
        running: Boolean(this.music3MlxWorker), pid: this.music3MlxWorker?.pid || null,
        warm: Boolean(this.music3MlxWorker && !this.music3MlxWorkerReadyResolve),
        idleTimeoutMinutes: MUSIC3_MLX_IDLE_TIMEOUT / 60000,
        lastMetrics: this.music3MlxLastMetrics,
      },
    };
    return {
      hardware: hardwareProfile(), local,
      music3: {
        installed: this.packInstalled('minimax-music-3'), environmentReady: this.comfyEnvironmentReady(), ready: localReady,
        running: local.running, managed: local.managed, pid: local.pid, phase: local.phase, base: local.base, path: local.path,
        progress: this.activePack === 'minimax-music-3' ? this.progress.local : null,
        downloadBytes: this.pack('minimax-music-3').downloadBytes, license: MUSIC3_LICENSE, profile: local.music3Profile,
      },
      ace: { ready: aceReady, base: this.config.aceBase, managed: false, deployable: true },
      comfy: { ready: comfyReady, running: Boolean(this.processes.comfy), managed: Boolean(this.processes.comfy), pid: this.processes.comfy?.pid || null, phase: this.phase.comfy, base: this.config.comfyBase, cmd: this.config.comfyCmd, cwd: this.config.comfyCwd },
    };
  }

  getLogs(runtime, tail = 200) {
    const safeRuntime = runtime === 'comfy' ? 'comfy' : 'local';
    return this.logs[safeRuntime].slice(-Math.max(1, Math.min(1000, Number(tail) || 200)));
  }

  music3EnvironmentReady() { return this.comfyEnvironmentReady(); }
  music3Installed() { return this.packInstalled('minimax-music-3'); }
  installMusic3() { return this.installLocalModel('minimax-music-3'); }
  startMusic3() { return this.startLocal(); }
  updateMusic3() { return this.updateLocal(); }

  stopAll() {
    this.shuttingDown = true;
    if (this.processes.operation) { try { this.processes.operation.kill('SIGTERM'); } catch (_) {} }
    if (this.processes.generation) this.cancelLocalGeneration(this.activeGenerationModel);
    else this.stopMusic3MlxWorker();
    if (this.processes.local) this.stop('local');
    if (this.processes.comfy) this.stop('comfy');
  }
}

module.exports = {
  RuntimeManager, COMFY_REPOSITORY, STABLE_AUDIO3_REPOSITORY, STABLE_AUDIO3_REVISION, STABLE_AUDIO3_ARCHIVE, MUSIC3_LICENSE, MUSIC3_MODELS,
  MUSIC3_OPTIONAL_MODELS, MUSIC3_MLX_REPOSITORY, MUSIC3_MLX_REVISION, MUSIC3_MLX_MODELSCOPE_REPOSITORY,
  MUSIC3_MLX_MODELSCOPE_REVISION, MUSIC3_MLX_FILES, MUSIC3_COMFY_MODELSCOPE_REPOSITORY, ACE15_MODELSCOPE_REPOSITORY,
  COMFY_MODELSCOPE_REVISION, MLX_AUDIO_SPEC, MUSIC3_MLX_EVENT_PREFIX, MUSIC3_MLX_IDLE_TIMEOUT, LOCAL_MODEL_PACKS,
  DOWNLOAD_INACTIVITY_TIMEOUT, DOWNLOAD_RETRY_LIMIT,
  PROXY_ENV_KEYS, parseCommandLine, parseHuggingFaceFile, parseMacSystemProxy, resolveNetworkEnvironment,
  modelDownloadSources, modelScopeFileUrl, requestBuffer, endpointReady, hardwareProfile, localEngineLaunch, stableAudio3GenerationRequest,
  downloadFile, downloadFileWithRetry,
};
