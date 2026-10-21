/* 音悦台模型注册表：本地权重与远端 API 是两条完全独立的运行路径。 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Models = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const clampSeconds = (value, max = 300) => Math.max(1, Math.min(max, Number(value) || 30));
  const seedOf = (params) => Number(params.seed) >>> 0;
  const selectedName = (value, allowed, fallback) => allowed.includes(value) ? value : fallback;

  function aceLanguage(params) {
    const configured = String(params.language || '').trim().toLowerCase();
    if (configured && configured !== 'auto') return configured;
    const source = `${params.lyrics || ''}${params.tags || ''}${params.prompt || ''}`;
    if (/[\u3040-\u30ff]/.test(source)) return 'ja';
    if (/[\uac00-\ud7af]/.test(source)) return 'ko';
    if (/[\u3400-\u9fff]/.test(source)) return 'zh';
    return 'en';
  }

  function aceCaption(params) {
    const description = String(params.prompt || '').trim();
    const tags = String(params.tags || '').trim();
    if (description && tags) return `${description}\nStyle tags: ${tags}`;
    return description || tags;
  }

  function miniMaxMusic3(params) {
    const seconds = clampSeconds(params.duration, 300);
    const seed = seedOf(params);
    const diffusionModel = selectedName(params.music3DiffusionModel, [
      'minimax_music3_dit_fp16.safetensors', 'minimax_music3_dit_int8_convrot.safetensors',
    ], 'minimax_music3_dit_int8_convrot.safetensors');
    const textEncoder = selectedName(params.music3TextEncoder, [
      'minimax_music3_text_encoder_pruned_bf16.safetensors', 'minimax_music3_text_encoder_pruned_int8_convrot.safetensors',
    ], 'minimax_music3_text_encoder_pruned_int8_convrot.safetensors');
    // Larger tiles = fewer decode passes. Cap by duration so short clips stay light on memory.
    const tileSize = seconds <= 45 ? 4096 : seconds <= 120 ? 3072 : 2048;
    return {
      '1': { class_type: 'UNETLoader', inputs: { unet_name: diffusionModel, weight_dtype: 'default' } },
      '2': { class_type: 'CLIPLoader', inputs: { clip_name: textEncoder, type: 'minimax', device: 'default' } },
      '3': { class_type: 'VAELoader', inputs: { vae_name: 'minimax_music3_dav.safetensors' } },
      '4': { class_type: 'MiniMaxMusic3TextEncode', inputs: {
        clip: ['2', 0], caption: params.prompt || params.tags || '', lyrics: params.lyrics || '[Instrumental]',
        seed, max_duration: seconds, cfg_scale: params.cfg == null ? 1.7 : Number(params.cfg), top_k: 50,
      } },
      '5': { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['4', 0] } },
      '6': { class_type: 'EmptyMiniMaxMusic3LatentAudio', inputs: { seconds: ['4', 1], batch_size: 1 } },
      '7': { class_type: 'KSampler', inputs: {
        seed, steps: Number(params.steps) || 20, cfg: params.cfg == null ? 1.7 : Number(params.cfg),
        sampler_name: 'euler', scheduler: 'simple', denoise: 1,
        model: ['1', 0], positive: ['4', 0], negative: ['5', 0], latent_image: ['6', 0],
      } },
      '8': { class_type: 'VAEDecodeAudioTiled', inputs: { samples: ['7', 0], vae: ['3', 0], tile_size: tileSize, overlap: 64 } },
      '9': { class_type: 'SaveAudioAdvanced', inputs: { audio: ['8', 0], filename_prefix: 'audio/yinyuetai_music3', format: 'mp3', 'format.quality': 'V0' } },
    };
  }

  function stableAudio10(params) {
    const prompt = params.prompt || params.tags || '';
    return {
      '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'stable-audio-open-1.0.safetensors' } },
      '10': { class_type: 'CLIPLoader', inputs: { clip_name: 't5-base.safetensors', type: 'stable_audio', device: 'default' } },
      '6': { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['10', 0] } },
      '7': { class_type: 'CLIPTextEncode', inputs: { text: params.negativePrompt || '', clip: ['10', 0] } },
      '11': { class_type: 'EmptyLatentAudio', inputs: { seconds: clampSeconds(params.duration, 47), batch_size: 1 } },
      '3': { class_type: 'KSampler', inputs: {
        seed: seedOf(params), steps: Number(params.steps) || 28, cfg: params.cfg == null ? 5 : Number(params.cfg),
        sampler_name: 'dpmpp_3m_sde_gpu', scheduler: 'exponential', denoise: 1,
        model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['11', 0],
      } },
      '12': { class_type: 'VAEDecodeAudio', inputs: { samples: ['3', 0], vae: ['4', 2] } },
      '19': { class_type: 'SaveAudioMP3', inputs: { audio: ['12', 0], filename_prefix: 'audio/yinyuetai_stable1', quality: 'V0' } },
    };
  }

  function aceStep10(params) {
    const seconds = clampSeconds(params.duration, 240);
    return {
      '14': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'ace_step_v1_3.5b.safetensors' } },
      '17': { class_type: 'EmptyAceStepLatentAudio', inputs: { seconds, batch_size: 1 } },
      '18': { class_type: 'TextEncodeAceStepAudio', inputs: { tags: params.tags || params.prompt || '', lyrics: params.lyrics || '[Instrumental]', lyrics_strength: 0.99, clip: ['14', 1] } },
      '44': { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['18', 0] } },
      '51': { class_type: 'ModelSamplingSD3', inputs: { shift: 5, model: ['14', 0] } },
      '52': { class_type: 'KSampler', inputs: {
        seed: seedOf(params), steps: Number(params.steps) || 28, cfg: params.cfg == null ? 5 : Number(params.cfg),
        sampler_name: 'euler', scheduler: 'simple', denoise: 1,
        model: ['51', 0], positive: ['18', 0], negative: ['44', 0], latent_image: ['17', 0],
      } },
      '19': { class_type: 'VAEDecodeAudio', inputs: { samples: ['52', 0], vae: ['14', 2] } },
      '59': { class_type: 'SaveAudioMP3', inputs: { audio: ['19', 0], filename_prefix: 'audio/yinyuetai_ace1', quality: 'V0' } },
    };
  }

  function aceStep15(params) {
    const seconds = clampSeconds(params.duration, 600);
    const seed = seedOf(params);
    const language = aceLanguage(params);
    const caption = aceCaption(params);
    const bpm = Math.max(30, Math.min(300, Math.round(Number(params.bpm) || 96)));
    const timesignature = ['2', '3', '4', '6'].includes(String(params.timesignature)) ? String(params.timesignature) : '4';
    const keyscale = String(params.keyscale || 'C major');
    const referenceFilename = String(params.continuityReferenceFilename || '').trim();
    const workflow = {
      '104': { class_type: 'UNETLoader', inputs: { unet_name: 'acestep_v1.5_turbo.safetensors', weight_dtype: 'default' } },
      '106': { class_type: 'VAELoader', inputs: { vae_name: 'ace_1.5_vae.safetensors' } },
      '105': { class_type: 'DualCLIPLoader', inputs: { clip_name1: 'qwen_0.6b_ace15.safetensors', clip_name2: 'qwen_4b_ace15.safetensors', type: 'ace', device: 'default' } },
      '94': { class_type: 'TextEncodeAceStepAudio1.5', inputs: {
        clip: ['105', 0], tags: caption, lyrics: params.lyrics || '[Instrumental]', seed,
        bpm, duration: seconds, timesignature, language, keyscale,
        generate_audio_codes: !referenceFilename, cfg_scale: params.cfg == null ? 2 : Number(params.cfg), temperature: 0.85,
        top_p: 0.9, top_k: 0, min_p: 0,
      } },
      '98': { class_type: 'EmptyAceStep1.5LatentAudio', inputs: { seconds, batch_size: 1 } },
      '47': { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['94', 0] } },
      '78': { class_type: 'ModelSamplingAuraFlow', inputs: { shift: 3, model: ['104', 0] } },
      '3': { class_type: 'KSampler', inputs: {
        seed, steps: Number(params.steps) || 8, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1,
        model: ['78', 0], positive: ['94', 0], negative: ['47', 0], latent_image: ['98', 0],
      } },
      '18': { class_type: 'VAEDecodeAudio', inputs: { samples: ['3', 0], vae: ['106', 0] } },
      '111': { class_type: 'SaveAudioAdvanced', inputs: { audio: ['18', 0], filename_prefix: 'audio/yinyuetai_ace15', format: 'mp3', 'format.quality': 'V0' } },
    };
    if (referenceFilename) {
      workflow['112'] = { class_type: 'LoadAudio', inputs: { audio: referenceFilename } };
      workflow['113'] = { class_type: 'VAEEncodeAudio', inputs: { audio: ['112', 0], vae: ['106', 0] } };
      workflow['114'] = { class_type: 'ReferenceTimbreAudio', inputs: { conditioning: ['94', 0], latent: ['113', 0] } };
      workflow['3'].inputs.positive = ['114', 0];
    }
    return workflow;
  }

  const F = {
    TAGS: 'tags', LYRICS: 'lyrics', PROMPT: 'prompt', NEG: 'negativePrompt',
    DURATION: 'duration', STEPS: 'steps', CFG: 'cfg', SEED: 'seed', REFERENCE: 'referenceAudio',
    BPM: 'bpm', KEYSCALE: 'keyscale', TIMESIGNATURE: 'timesignature', LANGUAGE: 'language',
  };

  const CHAIN_SONG = [
    { id: 'load', label: '加载模型', node: 'LocalWeights' }, { id: 'encode', label: '理解创作意图', node: 'TextEncode' },
    { id: 'latent', label: '建立音频空间', node: 'LatentAudio' }, { id: 'sample', label: '扩散采样', node: 'KSampler' },
    { id: 'decode', label: '解码母带', node: 'AudioDecode' }, { id: 'save', label: '写入曲库', node: 'LocalArchive' },
  ];
  const CHAIN_MLX = [
    { id: 'load', label: '加载 MLX 权重', node: 'SA3 Medium' }, { id: 'encode', label: '编码音乐描述', node: 'T5 Encoder' },
    { id: 'sample', label: 'MLX 生成', node: 'MMDiT' }, { id: 'decode', label: '音频解码', node: 'StableCodec' },
    { id: 'save', label: '写入曲库', node: 'LocalArchive' },
  ];
  const CHAIN_MUSIC3_MLX = [
    { id: 'load', label: '加载 MLX 权重', node: 'MXFP8 / Metal' }, { id: 'encode', label: '自回归编曲', node: 'Qwen3 + RVQ' },
    { id: 'sample', label: '声学生成', node: 'Flow DiT' }, { id: 'decode', label: '解码母带', node: 'MLX Vocoder' },
    { id: 'save', label: '写入曲库', node: 'LocalArchive' },
  ];
  const CHAIN_REMOTE = [
    { id: 'load', label: '验证服务', node: 'API Connect' }, { id: 'encode', label: '提交创作参数', node: 'HTTPS Request' },
    { id: 'sample', label: '远端生成', node: 'Remote Inference' }, { id: 'decode', label: '获取音频', node: 'Audio Fetch' },
    { id: 'save', label: '保存到本机', node: 'LocalArchive' },
  ];
  const CHAIN_DEMO = [
    { id: 'load', label: '加载合成器', node: 'DemoSynth' }, { id: 'latent', label: '设置时长', node: 'AllocBuffer' },
    { id: 'encode', label: '解析标签', node: 'TagToPreset' }, { id: 'sample', label: '程序化合成', node: 'Synthesize' },
    { id: 'decode', label: '编码 WAV', node: 'WavEncode' }, { id: 'save', label: '保存 / 播放', node: 'Play' },
  ];

  const localModel = (config) => ({
    source: 'local', needsBackend: true, stages: CHAIN_SONG,
    fields: [F.TAGS, F.LYRICS, F.DURATION, F.STEPS, F.CFG, F.SEED],
    defaults: { duration: 60, steps: 30, cfg: 2 },
    ranges: { duration: [10, 240, 1], steps: [1, 60, 1], cfg: [0.5, 9, 0.1] },
    ...config,
  });
  const remoteModel = (config) => ({
    source: 'remote', provider: 'remote', needsBackend: true, stages: CHAIN_REMOTE,
    fields: [F.PROMPT, F.LYRICS, F.DURATION, F.SEED],
    defaults: { duration: 60, steps: 8, cfg: 7 },
    ranges: { duration: [10, 360, 1], steps: [1, 60, 1], cfg: [0.5, 12, 0.5] },
    ...config,
  });

  const MODELS = [
    localModel({ id: 'minimax-music-3-mlx', label: 'MiniMax Music 3 · MLX 高速', family: 'MiniMax Music 3', group: '本地部署 / MiniMax', provider: 'local-cli', buildPrompt: null, stages: CHAIN_MUSIC3_MLX, fields: [F.PROMPT, F.LYRICS, F.DURATION, F.STEPS, F.CFG, F.SEED], defaults: { duration: 30, steps: 8, cfg: 1.7 }, ranges: { duration: [10, 300, 1], steps: [1, 30, 1], cfg: [0.5, 5, 0.1] }, hint: 'Apple Silicon 原生 MLX 路径；模型会常驻复用 10 分钟。要最快预览可选 20 秒 / 4 步 / CFG 1，CFG 1 会把声学生成从双路计算降为单路。' }),
    localModel({ id: 'minimax-music-3', label: 'MiniMax Music 3 · Comfy 兼容', family: 'MiniMax Music 3', group: '本地部署 / MiniMax', provider: 'local-comfy', buildPrompt: miniMaxMusic3, fields: [F.PROMPT, F.LYRICS, F.DURATION, F.STEPS, F.CFG, F.SEED], defaults: { duration: 30, steps: 8, cfg: 1.7 }, ranges: { duration: [10, 300, 1], steps: [8, 50, 1], cfg: [0.5, 5, 0.1] }, hint: '兼容现有三个 ComfyUI INT8 文件；该路径在 Apple MPS 上明显偏慢，建议改用 MLX 高速选项。' }),
    localModel({ id: 'stable-audio-open-1.0', label: 'Stable Audio 1.0 · 本地', family: 'Stable Audio', group: '本地部署 / Stable Audio', provider: 'local-comfy', buildPrompt: stableAudio10, fields: [F.PROMPT, F.NEG, F.DURATION, F.STEPS, F.CFG, F.SEED], defaults: { duration: 30, steps: 28, cfg: 5 }, ranges: { duration: [1, 47, 0.1], steps: [10, 100, 1], cfg: [1, 12, 0.1] }, hint: 'Stable Audio Open 1.0 本地权重，适合音效、氛围和短器乐。' }),
    localModel({ id: 'stable-audio-3', label: 'Stable Audio 3 · 配乐/音效 MLX', family: 'Stable Audio', group: '本地部署 / Stable Audio', provider: 'local-cli', buildPrompt: null, stages: CHAIN_MLX, fields: [F.PROMPT, F.NEG, F.REFERENCE, F.DURATION, F.STEPS, F.CFG, F.SEED], supportsReferenceAudio: true, defaults: { duration: 30, steps: 8, cfg: 1, referenceStrength: 0.7 }, ranges: { duration: [5, 360, 1], steps: [4, 16, 1], cfg: [1, 3, 0.1], referenceStrength: [0.4, 0.8, 0.05] }, hint: '支持从曲库选择参考音乐做变奏；适合器乐、氛围、配乐与音效，不支持可控歌词。推荐 8 步 / CFG 1。' }),
    localModel({ id: 'ace-step-1.0', label: 'ACE-Step 1.0 · 本地', family: 'ACE-Step', group: '本地部署 / ACE-Step', provider: 'local-comfy', buildPrompt: aceStep10, playbook: 'ace-segment', defaults: { duration: 40, steps: 28, cfg: 5 }, ranges: { duration: [20, 240, 1], steps: [1, 60, 1], cfg: [0.5, 9, 0.1] }, hint: '可贴整首歌词自动分段生成并合轨；单段仍建议短行、简单编曲。' }),
    localModel({ id: 'ace-step-1.5', label: 'ACE-Step 1.5 · 本地', family: 'ACE-Step', group: '本地部署 / ACE-Step', provider: 'local-comfy', buildPrompt: aceStep15, playbook: 'ace-native', fields: [F.PROMPT, F.TAGS, F.LYRICS, F.BPM, F.KEYSCALE, F.TIMESIGNATURE, F.LANGUAGE, F.DURATION, F.STEPS, F.CFG, F.SEED], defaults: { duration: 120, steps: 8, cfg: 2, bpm: 96, keyscale: 'C major', timesignature: '4', language: 'auto' }, ranges: { duration: [20, 600, 1], steps: [1, 20, 1], cfg: [0.5, 5, 0.1], bpm: [30, 300, 1] }, hint: 'Turbo 长歌。智能策略在 120 秒内优先原生整首，超过 120 秒或歌词结构过密时自动分段并合轨；也可手动强制策略。' }),
    remoteModel({ id: 'remote-minimax', label: 'MiniMax API · 远端', group: '远端 API', remoteId: 'minimax', hint: '使用你自己的 MiniMax API Key；默认调用所有 Key 可用的 music-2.6-free，付费或 Token Plan 可切换 music-2.6。' }),
    remoteModel({ id: 'remote-stability', label: 'Stable Audio 3 API · 远端', group: '远端 API', remoteId: 'stability', fields: [F.PROMPT, F.DURATION, F.SEED], hint: '使用你自己的 Stability AI API Key 和官方 Stable Audio 音频端点。' }),
    remoteModel({ id: 'remote-suno', label: 'Suno / 自定义 API · 远端', group: '远端 API', remoteId: 'suno', hint: '兼容用户提供的 Suno 第三方服务或自建音乐 API；服务地址和接口路径均可配置。' }),
    { id: 'demo', label: '即时 Demo 合成器', group: '内置引擎', source: 'builtin', provider: 'demo', needsBackend: false, fields: [F.TAGS, F.LYRICS, F.DURATION, F.STEPS, F.CFG, F.SEED], stages: CHAIN_DEMO, buildPrompt: null, defaults: { duration: 24, steps: 28, cfg: 5 }, ranges: { duration: [8, 120, 1], steps: [6, 60, 1], cfg: [1, 9, 0.5] }, hint: '浏览器内纯 JS 即时合成，无需模型和网络。' },
  ];

  function byId(id) { return MODELS.find((model) => model.id === id) || MODELS[0]; }
  function grouped() {
    const result = [];
    for (const model of MODELS) {
      let group = result.find((item) => item.group === model.group);
      if (!group) { group = { group: model.group, items: [] }; result.push(group); }
      group.items.push(model);
    }
    return result;
  }

  return { MODELS, FIELDS: F, byId, grouped, builders: { miniMaxMusic3, stableAudio10, aceStep10, aceStep15 } };
});
