#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const {
  parseCommandLine, parseHuggingFaceFile, parseMacSystemProxy, resolveNetworkEnvironment, modelScopeFileUrl,
  RuntimeManager, MUSIC3_MODELS, MUSIC3_MLX_FILES, MUSIC3_MLX_REPOSITORY, MUSIC3_MLX_REVISION,
  MUSIC3_MLX_MODELSCOPE_REPOSITORY, MUSIC3_MLX_MODELSCOPE_REVISION,
  MUSIC3_COMFY_MODELSCOPE_REPOSITORY, ACE15_MODELSCOPE_REPOSITORY, COMFY_MODELSCOPE_REVISION,
  STABLE_AUDIO3_REVISION, STABLE_AUDIO3_ARCHIVE,
  MLX_AUDIO_SPEC, MUSIC3_MLX_EVENT_PREFIX, MUSIC3_MLX_IDLE_TIMEOUT, LOCAL_MODEL_PACKS, modelDownloadSources, localEngineLaunch, stableAudio3GenerationRequest, downloadFileWithRetry,
} = require('../server/runtime-manager');
const {
  RemoteProviderManager, safeUrl, MINIMAX_FREE_MODEL, MINIMAX_PAID_MODEL,
  isMiniMaxPaidAccessError, miniMaxFriendlyError,
} = require('../server/remote-provider-manager');
const { SmartComposerManager, normalizeDraft, normalizeContext, durationTargets, lyricMetrics, repairAceLyrics } = require('../server/smart-composer-manager');
const { createLauncher } = require('../server/launcher');
const { createLocalSecretCodec, PREFIX: LOCAL_SECRET_PREFIX } = require('../server/local-secret-codec');
const Providers = require('../js/providers');
const AceSegment = require('../js/ace-segment');
const AudioQuality = require('../js/audio-quality');
const Engine = require('../js/audio-engine');
const QueuePersistence = require('../js/queue-persistence');
const Models = require('../js/models');

function richCaption(topic = '夜归') {
  return [
    `Global Metadata: 现代独立流行融合电影感电子氛围，主题围绕${topic}展开，速度约九十二拍，四四拍，小调主歌逐渐转向明亮副歌；整体从克制、疲惫和自省推进到释然，保留真实乐手动态、温暖模拟质感和宽阔但不过度压缩的现代制作审美。`,
    'Vocal Details: 自然清澈的中性主唱近距离演唱，主歌使用轻声和清楚咬字，预副歌增加气息张力，副歌打开胸声并加入左右叠录和声，桥段短暂回落为独唱，最终副歌加入高八度回应与群唱，但始终保留自然呼吸和情绪细节。',
    'Arrangement: 前奏以带房间感的木吉他泛音、柔和钢琴和远处环境声建立空间；第一主歌只保留低密度贝斯与边鼓，预副歌加入上行弦乐和渐强镲片，第一次副歌让完整鼓组、宽阔合成器和和声进入。第二主歌增加切分吉他与反拍打击乐，后副歌用短促器乐动机连接间奏；桥段抽掉底鼓并降低和声密度，随后以鼓花、低频提升和弦乐反向吸气推入最终副歌。尾奏逐件移除鼓、贝斯与和声，只留下主旋律的钢琴变奏和自然残响结束，同时给最后一句人声留出完整呼吸空间。',
  ].join('\n');
}

function richPlainDescription(topic = '重逢') {
  return `现代独立流行融合温暖电影配乐，围绕${topic}从迟疑到释然的情绪弧线展开，九十拍四四拍，清澈中性主唱以贴耳轻声开始，预副歌增加气息和张力，副歌打开胸声并加入左右叠录和声。木吉他泛音与钢琴先建立空间，主歌只保留低密度贝斯和边鼓，预副歌加入上行弦乐，副歌让完整鼓组与宽阔合成器进入；第二主歌增加切分吉他，桥段抽掉底鼓回到独唱，最后用鼓花和低频提升推入完整终章，尾奏逐件移除声部，只留下钢琴主题与自然残响，整体保持真实动态、清楚人声位置和温暖模拟质感。`;
}

function richLyrics() {
  const sections = ['Intro', 'Verse 1', 'Pre-Chorus 1', 'Chorus 1', 'Post-Chorus', 'Verse 2', 'Pre-Chorus 2', 'Chorus 2', 'Verse 3', 'Bridge', 'Chorus 3', 'Bridge 2', 'Chorus 4', 'Outro'];
  return sections.map((section, sectionIndex) => {
    const lines = Array.from({ length: 5 }, (_, lineIndex) => `第${sectionIndex + 1}段第${lineIndex + 1}句沿着夜色走向仍然亮着的窗`);
    return `[${section}]\n${lines.join('\n')}`;
  }).join('\n\n');
}

function aceFullSongLyrics() {
  const sections = ['Intro', 'Verse 1', 'Pre-Chorus 1', 'Chorus 1', 'Verse 2', 'Pre-Chorus 2', 'Chorus 2', 'Verse 3', 'Bridge', 'Chorus 3', 'Bridge 2', 'Outro'];
  return sections.map((section, sectionIndex) => {
    const lines = Array.from({ length: 5 }, (_, lineIndex) => `夜色第${sectionIndex + 1}段${lineIndex + 1}句`);
    return `[${section}]\n${lines.join('\n')}`;
  }).join('\n\n');
}

async function main() {
  console.log('[runtime] ACE 三段全部完成后真正合轨');
  const originalAudioContext = globalThis.AudioContext;
  class MockAudioContext {
    async decodeAudioData(data) {
      const level = new Uint8Array(data)[0] / 10;
      const samples = new Float32Array(1000).fill(level);
      return { sampleRate: 1000, length: samples.length, numberOfChannels: 2, getChannelData: () => samples };
    }
    close() { return Promise.resolve(); }
  }
  try {
    globalThis.AudioContext = MockAudioContext;
    const pieces = [1, 2, 3].map((value) => new Blob([new Uint8Array([value])], { type: 'audio/mpeg' }));
    const merged = await AceSegment.concatBlobs(pieces, Engine.encodeWav);
    const wav = Buffer.from(await merged.arrayBuffer());
    assert.strictEqual(wav.subarray(0, 4).toString(), 'RIFF');
    assert.strictEqual(wav.subarray(8, 12).toString(), 'WAVE');
    assert.strictEqual(wav.readUInt32LE(24), 1000);
    assert.strictEqual(wav.readUInt32LE(40), 2920 * 4);
    console.log('  ✓ 3 个 MP3 分段解码后合成 2.92 秒 WAV，40ms 接缝交叉淡化');

    const handled = await AceSegment.concatBlobs(pieces, Engine.encodeWav, { crossfadeSeconds: [0, 0.2, 0.2] });
    const handledWav = Buffer.from(await handled.arrayBuffer());
    assert.strictEqual(handledWav.readUInt32LE(40), 2600 * 4);
    console.log('  ✓ 每个接缝可按分段计划完整消化独立承接区');

    class PlannedAudioContext {
      async decodeAudioData(data) {
        const seconds = new Uint8Array(data)[0];
        const samples = new Float32Array(seconds * 100).fill(0.1);
        return { sampleRate: 100, length: samples.length, numberOfChannels: 2, getChannelData: () => samples };
      }
      close() { return Promise.resolve(); }
    }
    globalThis.AudioContext = PlannedAudioContext;
    const plannedPieces = [30, 38, 38, 38].map((seconds) => new Blob([new Uint8Array([seconds])], { type: 'audio/mpeg' }));
    const plannedMerge = await AceSegment.concatBlobs(plannedPieces, Engine.encodeWav, { crossfadeSeconds: [0, 8, 8, 8] });
    const plannedWav = Buffer.from(await plannedMerge.arrayBuffer());
    assert.strictEqual(plannedWav.readUInt32LE(40) / 4 / 100, 120);
    console.log('  ✓ 30 + 38 + 38 + 38 秒分段扣除三个 8 秒承接区后精确保留 120 秒');
  } finally {
    if (originalAudioContext === undefined) delete globalThis.AudioContext;
    else globalThis.AudioContext = originalAudioContext;
  }

  console.log('[runtime] 有唱词歌曲的尾部静音自动裁剪');
  class QualityAudioContext {
    async decodeAudioData() {
      const rate = 4000;
      const samples = new Float32Array(rate * 40);
      for (let index = 0; index < rate * 33; index++) samples[index] = Math.sin(index * 0.12) * 0.2;
      return { sampleRate: rate, length: samples.length, numberOfChannels: 1, getChannelData: () => samples };
    }
    close() { return Promise.resolve(); }
  }
  try {
    globalThis.AudioContext = QualityAudioContext;
    const original = new Blob([new Uint8Array([1])], { type: 'audio/mpeg' });
    const processed = await AudioQuality.processVocalBlob(original, Engine.encodeWav);
    const bytes = Buffer.from(await processed.blob.arrayBuffer());
    assert.strictEqual(processed.blob.type, 'audio/wav');
    assert.strictEqual(bytes.subarray(0, 4).toString(), 'RIFF');
    assert(processed.quality.trimmedTailSeconds > 6 && processed.quality.duration < 34);
    assert.strictEqual(processed.quality.warnings.length, 0);
    const tail = await AudioQuality.extractTailBlob(processed.blob, 10, Engine.encodeWav);
    const tailBytes = Buffer.from(await tail.arrayBuffer());
    assert.strictEqual(tailBytes.subarray(0, 4).toString(), 'RIFF');
    assert(tailBytes.readUInt32LE(40) / 4 / 4000 >= 9.9);
    console.log('  ✓ 40 秒音频裁掉约 6.5 秒静音，并提取 10 秒上一段尾部连续性参考');
  } finally {
    if (originalAudioContext === undefined) delete globalThis.AudioContext;
    else globalThis.AudioContext = originalAudioContext;
  }

  console.log('[runtime] 生成队列跨重启恢复');
  const aceModel = Models.byId('ace-step-1.5');
  const queueSnapshot = QueuePersistence.serialize([
    { id: 'suite-a-0', model: aceModel, params: { duration: 30, lyrics: '[Verse]\n晚风经过', referenceBlob: new Blob(['audio']) }, status: 'completed', suiteId: 'suite-a', suiteIndex: 0, suiteTotal: 4, trackId: 'part-0' },
    { id: 'suite-a-1', model: aceModel, params: { duration: 30, lyrics: '[Chorus]\n灯火还在', continuityReferenceBlob: new Blob(['tail']), continuityReferenceFilename: 'temporary.wav' }, status: 'running', suiteId: 'suite-a', suiteIndex: 1, suiteTotal: 4 },
    { id: 'suite-a-2', model: aceModel, params: { duration: 30 }, status: 'queued', suiteId: 'suite-a', suiteIndex: 2, suiteTotal: 4 },
  ]);
  assert(!queueSnapshot.includes('referenceBlob'));
  assert(!queueSnapshot.includes('continuityReferenceBlob') && !queueSnapshot.includes('temporary.wav'));
  const recoveredQueue = QueuePersistence.restore(queueSnapshot, (id) => Models.MODELS.find((model) => model.id === id));
  assert.deepStrictEqual(recoveredQueue.jobs.map((job) => job.status), ['completed', 'interrupted', 'queued']);
  assert.strictEqual(recoveredQueue.jobs[0].trackId, 'part-0');
  assert.strictEqual(recoveredQueue.jobs[1].suiteId, 'suite-a');
  assert.strictEqual(typeof recoveredQueue.jobs[1].model.buildPrompt, 'function');
  assert.strictEqual(QueuePersistence.restore('{bad', () => aceModel).jobs.length, 0);
  console.log('  ✓ 已完成分段、运行中断项和等待项均按模型 ID 恢复；音频 Blob 不写入队列快照');

  console.log('[runtime] 命令解析与模型清单');
  assert.deepStrictEqual(parseCommandLine('python main.py --name "Music Studio"'), ['python', 'main.py', '--name', 'Music Studio']);
  assert.throws(() => parseCommandLine('python "main.py'), /引号没有闭合/);
  assert.strictEqual(MUSIC3_MODELS.length, 3);
  assert(MUSIC3_MODELS.reduce((sum, model) => sum + model.bytes, 0) > 10 * 1024 ** 3);
  assert(MUSIC3_MODELS.every((model) => /^[a-f0-9]{64}$/.test(model.sha256)));
  assert(MUSIC3_MODELS.every((model) => model.mirrors?.[0]?.label === 'ModelScope'));
  assert(MUSIC3_MODELS.every((model) => model.mirrors[0].url.startsWith('https://modelscope.cn/models/Comfy-Org/MiniMax-Music-3/resolve/master/')));
  assert.strictEqual(modelDownloadSources(MUSIC3_MODELS[0])[0].label, 'ModelScope');
  assert.strictEqual(modelDownloadSources(MUSIC3_MODELS[0]).at(-1).label, 'Hugging Face');
  assert.strictEqual(LOCAL_MODEL_PACKS.length, 6);
  assert.strictEqual(LOCAL_MODEL_PACKS.filter((pack) => pack.runtime === 'comfy').length, 4);
  assert.strictEqual(LOCAL_MODEL_PACKS.find((pack) => pack.id === 'minimax-music-3-mlx').runtime, 'minimax-mlx');
  assert.strictEqual(MUSIC3_MLX_FILES.filter((file) => file.name.endsWith('.safetensors')).length, 3);
  assert(MUSIC3_MLX_FILES.reduce((sum, file) => sum + file.bytes, 0) > 12 * 1024 ** 3);
  assert.strictEqual(MUSIC3_MLX_REPOSITORY, 'mlx-community/MiniMax-Music3-mxfp8');
  assert.strictEqual(MUSIC3_MLX_MODELSCOPE_REPOSITORY, MUSIC3_MLX_REPOSITORY);
  assert.strictEqual(MUSIC3_MLX_MODELSCOPE_REVISION, 'master');
  assert.strictEqual(MUSIC3_COMFY_MODELSCOPE_REPOSITORY, 'Comfy-Org/MiniMax-Music-3');
  assert.strictEqual(ACE15_MODELSCOPE_REPOSITORY, 'Comfy-Org/ace_step_1.5_ComfyUI_files');
  assert.strictEqual(COMFY_MODELSCOPE_REVISION, 'master');
  const ace15Pack = LOCAL_MODEL_PACKS.find((pack) => pack.id === 'ace-step-1.5');
  assert.strictEqual(ace15Pack.modelScope.repository, ACE15_MODELSCOPE_REPOSITORY);
  assert.strictEqual(ace15Pack.modelScope.prefix, 'split_files');
  assert(ace15Pack.files.every((file) => file.mirrors?.[0]?.label === 'ModelScope'));
  assert(ace15Pack.files.every((file) => file.mirrors[0].url.includes('/resolve/master/split_files/')));
  assert(/^[a-f0-9]{40}$/.test(STABLE_AUDIO3_REVISION));
  assert.strictEqual(STABLE_AUDIO3_ARCHIVE, `https://codeload.github.com/Stability-AI/stable-audio-3/tar.gz/${STABLE_AUDIO3_REVISION}`);
  assert(/^[a-f0-9]{40}$/.test(MUSIC3_MLX_REVISION));
  assert(MUSIC3_MLX_FILES.every((file) => /^[a-f0-9]{64}$/.test(file.sha256)));
  assert.strictEqual(
    modelScopeFileUrl(MUSIC3_MLX_MODELSCOPE_REPOSITORY, MUSIC3_MLX_MODELSCOPE_REVISION, 'tokenizer/tokenizer.json'),
    'https://modelscope.cn/models/mlx-community/MiniMax-Music3-mxfp8/resolve/master/tokenizer/tokenizer.json',
  );
  assert(MLX_AUDIO_SPEC.includes('784b29e2691a93ca7483147d86f61859dfaa6296'));
  assert.strictEqual(MUSIC3_MLX_EVENT_PREFIX, 'YYT_MUSIC3_EVENT ');
  assert.strictEqual(MUSIC3_MLX_IDLE_TIMEOUT, 10 * 60 * 1000);
  assert.deepStrictEqual(parseHuggingFaceFile(MUSIC3_MODELS[0].url), { repoId: 'Comfy-Org/MiniMax-Music-3', revision: 'main', filename: 'diffusion_models/minimax_music3_dit_int8_convrot.safetensors' });
  const appleLaunch = localEngineLaunch('http://127.0.0.1:8189', { platform: 'darwin', arch: 'arm64', memoryGb: 48 });
  assert(!appleLaunch.args.includes('--gpu-only'));
  assert.strictEqual(appleLaunch.env.PYTORCH_ENABLE_MPS_FALLBACK, '1');
  assert.strictEqual(appleLaunch.env.YYT_MINIMAX_MPS_TEXT_ENCODER, '1');
  assert(!localEngineLaunch('http://127.0.0.1:8189', { platform: 'darwin', arch: 'arm64', memoryGb: 16 }).args.includes('--gpu-only'));
  assert.strictEqual(parseHuggingFaceFile('https://example.com/model.bin'), null);
  const socksProxy = parseMacSystemProxy(`\n<dictionary> {\n  SOCKSEnable : 1\n  SOCKSPort : 13659\n  SOCKSProxy : 127.0.0.1\n}\n`);
  assert.strictEqual(socksProxy.source, 'macos-system-socks');
  assert.strictEqual(socksProxy.env.HTTPS_PROXY, 'http://127.0.0.1:13659');
  assert.strictEqual(socksProxy.env.ALL_PROXY, undefined);
  assert.strictEqual(socksProxy.env.NO_PROXY, '127.0.0.1,localhost,::1');
  const httpProxy = parseMacSystemProxy(`HTTPEnable : 1\nHTTPProxy : proxy.local\nHTTPPort : 8080\n`);
  assert.strictEqual(httpProxy.source, 'macos-system-http');
  assert.strictEqual(httpProxy.env.HTTP_PROXY, 'http://proxy.local:8080');
  assert.strictEqual(resolveNetworkEnvironment({
    platform: 'darwin', environment: {}, systemProxyText: 'SOCKSEnable : 0',
  }).source, 'direct');
  const inheritedProxy = resolveNetworkEnvironment({
    platform: 'darwin', environment: { https_proxy: 'http://127.0.0.1:9999', ALL_PROXY: 'socks5://127.0.0.1:9999' }, systemProxyText: 'SOCKSEnable : 0',
  });
  assert.strictEqual(inheritedProxy.source, 'environment');
  assert.strictEqual(inheritedProxy.env.HTTPS_PROXY, 'http://127.0.0.1:9999');
  assert.strictEqual(inheritedProxy.env.https_proxy, 'http://127.0.0.1:9999');
  assert.strictEqual(inheritedProxy.env.ALL_PROXY, '');
  assert.throws(() => safeUrl('http://example.com'), /HTTPS/);
  assert.strictEqual(safeUrl('http://127.0.0.1:9000'), 'http://127.0.0.1:9000');

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yinyuetai-runtime-test-'));
  const manager = new RuntimeManager({ runtimeDir: temporaryRoot, music3Base: 'http://127.0.0.1:1', aceBase: 'http://127.0.0.1:2', comfyBase: 'http://127.0.0.1:3' });
  assert.strictEqual(manager.shuttingDown, false);
  assert.strictEqual(manager.music3Installed(), false);
  assert.strictEqual(manager.packInstalled('minimax-music-3-mlx'), false);
  assert.strictEqual(manager.packInstalled('ace-step-1.5'), false);
  assert.strictEqual(manager.stableAudio3SourceReady(), false);
  fs.mkdirSync(path.join(manager.stableAudio3Dir, 'optimized', 'mlx'), { recursive: true });
  fs.writeFileSync(path.join(manager.stableAudio3Dir, 'optimized', 'mlx', 'install.sh'), '#!/bin/sh\n');
  const stableScript = path.join(manager.stableAudio3Dir, 'optimized', 'mlx', 'scripts', 'sa3_mlx.py');
  fs.mkdirSync(path.dirname(stableScript), { recursive: true });
  fs.writeFileSync(stableScript, 'import numpy as np\n\ndef run(audio_np, args):\n    save_wav(args.out, audio_np)\n');
  assert.strictEqual(manager.installStableAudio3OutputGuard(), true);
  const guardedSource = fs.readFileSync(stableScript, 'utf8');
  assert(guardedSource.includes('target_peak = 10.0 ** (-1.0 / 20.0)'));
  assert.strictEqual((guardedSource.match(/YYT_OUTPUT_GUARD_BEGIN/g) || []).length, 1);
  assert.strictEqual(manager.installStableAudio3OutputGuard(), true);
  assert.strictEqual((fs.readFileSync(stableScript, 'utf8').match(/YYT_OUTPUT_GUARD_BEGIN/g) || []).length, 1);
  const safeDefaults = stableAudio3GenerationRequest({}, '/tmp/out.wav');
  assert.strictEqual(safeDefaults.steps, 8);
  assert.strictEqual(safeDefaults.cfg, 1);
  const safeLimits = stableAudio3GenerationRequest({ duration: 999, steps: 50, cfg: 7, negativePrompt: 'noise' }, '/tmp/out.wav');
  assert.strictEqual(safeLimits.duration, 360);
  assert.strictEqual(safeLimits.steps, 16);
  assert.strictEqual(safeLimits.cfg, 3);
  assert.deepStrictEqual(safeLimits.args.slice(-4), ['--negative-prompt', 'noise', '--out', '/tmp/out.wav']);
  const referenceBuffer = Buffer.alloc(48);
  referenceBuffer.write('RIFF', 0); referenceBuffer.write('WAVE', 8);
  const storedReference = manager.storeReferenceAudio(referenceBuffer);
  const storedReferencePath = manager.referenceAudioPath(storedReference.id);
  assert.strictEqual(fs.existsSync(storedReferencePath), true);
  const referenceRequest = stableAudio3GenerationRequest({ referenceAudioPath: storedReferencePath, referenceStrength: 0.7 }, '/tmp/out.wav');
  assert.deepStrictEqual(referenceRequest.args.slice(-6), ['--init-audio', storedReferencePath, '--init-noise-level', '0.7', '--out', '/tmp/out.wav']);
  assert.strictEqual(manager.removeReferenceAudio(storedReference.id), true);
  fs.writeFileSync(`${manager.stableAudio3Archive}.part`, 'partial source');
  assert.strictEqual(manager.stableAudio3SourceReady(), true);
  assert.strictEqual(manager.packHasData('stable-audio-3'), true);
  assert.strictEqual(manager.uninstallLocalModel('stable-audio-3').ok, true);
  assert.strictEqual(manager.stableAudio3SourceReady(), false);
  assert.strictEqual(fs.existsSync(`${manager.stableAudio3Archive}.part`), false);
  fs.mkdirSync(path.dirname(manager.localPython()), { recursive: true });
  fs.writeFileSync(path.join(manager.localDir, 'main.py'), '');
  fs.writeFileSync(manager.localPython(), '');
  assert.strictEqual(manager.installMpsInt8Compatibility({ platform: 'darwin', arch: 'arm64' }), true);
  const compatibilitySource = fs.readFileSync(path.join(manager.localDir, 'custom_nodes', 'yinyuetai_mps_int8.py'), 'utf8');
  assert(compatibilitySource.includes('mps_int8_linear'));
  assert(compatibilitySource.includes('YYT_MINIMAX_MPS_TEXT_ENCODER'));
  assert.strictEqual(manager.music3ModelProfile().diffusionPrecision, 'INT8');
  const mlxRunnerSource = fs.readFileSync(manager.installMusic3MlxRunner(), 'utf8');
  assert(mlxRunnerSource.includes('load_model(model_path)'));
  assert(mlxRunnerSource.includes('for raw_line in sys.stdin'));
  assert(mlxRunnerSource.includes('YYT_MUSIC3_EVENT'));
  assert(mlxRunnerSource.includes('fast_ar_one_frame'));
  assert(mlxRunnerSource.includes('fastAr'));
  const mlxDownloaderSource = fs.readFileSync(manager.installMusic3MlxDownloader(), 'utf8');
  assert(mlxDownloaderSource.includes('ThreadPoolExecutor'));
  assert(mlxDownloaderSource.includes('httpx.Client'));
  assert(mlxDownloaderSource.includes('SHA-256'));
  assert(mlxDownloaderSource.includes('entry.get("sourceName")'));
  assert(mlxDownloaderSource.includes('entry.get("sha256")'));
  const comfyDownloaderSource = fs.readFileSync(manager.installComfyModelDownloader(), 'utf8');
  assert.strictEqual(comfyDownloaderSource, mlxDownloaderSource);
  assert.strictEqual(manager.packHasData('minimax-music-3-mlx'), true);
  assert.strictEqual(manager.uninstallLocalModel('minimax-music-3-mlx').ok, true);
  assert.strictEqual(fs.existsSync(manager.music3MlxDir), false);
  const partialModel = `${manager.modelPath(MUSIC3_MODELS[0])}.part`;
  fs.mkdirSync(path.dirname(partialModel), { recursive: true });
  fs.writeFileSync(partialModel, 'partial');
  assert.strictEqual(manager.packHasData('minimax-music-3'), true);
  assert.strictEqual(manager.uninstallLocalModel('minimax-music-3').ok, true);
  assert.strictEqual(fs.existsSync(partialModel), false);
  assert.strictEqual(manager.comfyEnvironmentReady(), true);

  const persistentSecretCodec = createLocalSecretCodec(path.join(temporaryRoot, 'encrypted-credentials'));
  const encryptedSecret = persistentSecretCodec.encrypt('local-secret-value');
  assert(encryptedSecret.startsWith(LOCAL_SECRET_PREFIX));
  assert(!encryptedSecret.includes('local-secret-value'));
  assert.strictEqual(persistentSecretCodec.decrypt(encryptedSecret), 'local-secret-value');
  assert.strictEqual(fs.statSync(path.join(temporaryRoot, 'encrypted-credentials', '.credential-key')).mode & 0o777, 0o600);
  assert.throws(() => persistentSecretCodec.decrypt(Buffer.from('legacy').toString('base64')), (error) => error.code === 'LEGACY_SECRET');

  const secretCodec = {
    encrypt(value) { return Buffer.from(`secret:${value}`).toString('base64'); },
    decrypt(value) { return Buffer.from(value, 'base64').toString().replace(/^secret:/, ''); },
  };
  const remoteManager = new RemoteProviderManager({ runtimeDir: temporaryRoot, secretCodec });
  assert.strictEqual(remoteManager.list().find((item) => item.id === 'minimax').model, MINIMAX_FREE_MODEL);
  remoteManager.configure('suno', { baseUrl: 'http://127.0.0.1:9000', apiKey: 'test-secret-1234', model: 'custom-v1' });
  assert.strictEqual(remoteManager.list().find((item) => item.id === 'suno').keyHint, '••••1234');
  assert(!JSON.stringify(remoteManager.list()).includes('test-secret-1234'));
  assert(!fs.readFileSync(path.join(temporaryRoot, 'remote-providers.json'), 'utf8').includes('test-secret-1234'));

  console.log('[runtime] MiniMax 新用户自动回退免费音乐模型');
  assert.strictEqual(isMiniMaxPaidAccessError('This Music API is no longer available to new users. Existing paying customers can continue to use the service.'), true);
  assert(miniMaxFriendlyError('This Music API is no longer available to new users.', MINIMAX_PAID_MODEL).includes(MINIMAX_FREE_MODEL));
  const attemptedMiniMaxModels = [];
  const minimaxMock = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      attemptedMiniMaxModels.push(body.model);
      res.setHeader('Content-Type', 'application/json');
      if (body.model === MINIMAX_PAID_MODEL) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: { message: 'This Music API is no longer available to new users. Existing paying customers can continue to use the service.' } }));
        return;
      }
      res.end(JSON.stringify({ data: { audio: '49443300' }, base_resp: { status_code: 0, status_msg: 'success' } }));
    });
  });
  await new Promise((resolve) => minimaxMock.listen(0, '127.0.0.1', resolve));
  const minimaxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yinyuetai-minimax-fallback-'));
  const fallbackManager = new RemoteProviderManager({ runtimeDir: minimaxRoot, secretCodec });
  fallbackManager.configure('minimax', {
    baseUrl: `http://127.0.0.1:${minimaxMock.address().port}`,
    apiKey: 'test-minimax-key', model: MINIMAX_PAID_MODEL,
  });
  const fallbackAudio = await fallbackManager.generate('minimax', { prompt: 'lo-fi', lyrics: '[Verse]\n雨落下来' });
  await new Promise((resolve) => minimaxMock.close(resolve));
  assert.deepStrictEqual(attemptedMiniMaxModels, [MINIMAX_PAID_MODEL, MINIMAX_FREE_MODEL]);
  assert.strictEqual(fallbackAudio.buffer.toString('hex'), '49443300');
  assert.strictEqual(fallbackManager.list().find((item) => item.id === 'minimax').model, MINIMAX_FREE_MODEL);

  console.log('[runtime] 智能创作仅走模型 API 与凭据保护');
  assert.strictEqual(durationTargets(60).minLyricLines, 12);
  assert.strictEqual(durationTargets(300).minLyricLines, 60);
  assert.strictEqual(durationTargets(300).minSections, 12);
  assert.strictEqual(durationTargets(60, { id: 'ace-step-1.5', playbook: 'ace-native' }).playbook, 'ace-native');
  assert.strictEqual(durationTargets(60, { id: 'ace-step-1.5', playbook: 'ace-native' }).segmentCount, 1);
  assert.strictEqual(durationTargets(60, { id: 'ace-step-1.5', playbook: 'ace-native' }).minSections, 3);
  assert.strictEqual(durationTargets(240, { id: 'ace-step-1.5', playbook: 'ace-native' }).segmentCount, 1);
  assert.strictEqual(durationTargets(240, { id: 'ace-step-1.5' }).duration, 240);
  assert.strictEqual(durationTargets(600, { id: 'ace-step-1.5', playbook: 'ace-native' }).duration, 600);
  assert.strictEqual(durationTargets(240, { id: 'ace-step-1.5', playbook: 'ace-segment' }).segmentCount, 7);
  const eightSectionLyrics = ['Intro', 'Verse 1', 'Pre-Chorus', 'Chorus 1', 'Verse 2', 'Chorus 2', 'Bridge', 'Outro']
    .map((tag, index) => `[${tag}]\n第${index + 1}段灯火还在\n第${index + 1}段晚风经过\n第${index + 1}段梦醒之前`).join('\n\n');
  const structuredTargets = durationTargets(120, { id: 'ace-step-1.5', playbook: 'ace-segment', existingLyrics: eightSectionLyrics });
  assert.strictEqual(structuredTargets.segmentCount, 4);
  assert.strictEqual(structuredTargets.maxSections, 12);
  const rewrittenEightSectionLyrics = eightSectionLyrics.replace('第1段灯火还在', '第一段晨光还在');
  const structuredDraft = normalizeDraft(JSON.stringify({
    title: '四段新歌', tags: ['华语流行', '人声靠前'], lyrics: rewrittenEightSectionLyrics, duration: 121,
  }), '生成 120 秒歌曲', 'openai', {
    model: { id: 'ace-step-1.5', playbook: 'ace-segment', fields: ['tags', 'lyrics', 'duration'] },
    existing: { duration: 120, lyrics: eightSectionLyrics },
  });
  assert.strictEqual(lyricMetrics(structuredDraft.lyrics).sections, 8);
  assert(lyricMetrics(richLyrics()).lyricLines >= 60);
  function aceSegmentLyrics() {
    return '[Verse]\n夜色落在窗台\n风吹过旧街牌\n我把沉默打开\n\n[Pre-Chorus]\n如果回忆还在\n别让梦醒太快';
  }
  assert.strictEqual(normalizeContext({ existing: { title: '  城市   夜归  ' } }).existing.title, '城市 夜归');
  assert.strictEqual(normalizeContext({ existing: { negativePrompt: '  clipping, harsh highs  ' } }).existing.negativePrompt, 'clipping, harsh highs');
  const lockedContext = normalizeContext({
    model: { fields: ['prompt', 'lyrics', 'duration'] },
    lockedFields: ['title', 'description', 'duration', 'unknown'],
    avoidDrafts: ['上一首创作单'], requireUnique: true, iteration: 3,
  });
  assert.deepStrictEqual(lockedContext.lockedFields, ['title', 'description', 'duration']);
  assert.deepStrictEqual(lockedContext.avoidDrafts, ['上一首创作单']);
  assert.strictEqual(lockedContext.requireUnique, true);
  assert.strictEqual(lockedContext.iteration, 3);
  const normalizedDraft = normalizeDraft(JSON.stringify({
    title: '远方',
    description: richCaption('远方'),
    negativePrompt: 'clipping, harsh distortion',
    lyrics: richLyrics(),
    tags: ['电影感', '女声'],
    duration: 280, steps: 24, cfg: 2,
  }), '关于远方', 'ollama', { model: { id: 'minimax-music-3' }, existing: { duration: 300 } });
  assert(normalizedDraft.lyrics.startsWith('[Intro]'));
  assert(normalizedDraft.description.includes('Vocal Details:'));
  assert.strictEqual(normalizedDraft.negativePrompt, 'clipping, harsh distortion');
  const plainDraft = normalizeDraft(JSON.stringify({
    title: '夜归',
    description: richPlainDescription('夜归'),
    negativePrompt: 'clipping, muddy bass',
    lyrics: richLyrics(),
    tags: ['独立流行', '夜归'],
    duration: 31, steps: 24, cfg: 2,
  }), '夜归', 'openai', { existing: { duration: 30 } });
  assert.strictEqual(plainDraft.title, '夜归');
  assert(!plainDraft.lyrics.startsWith('[Verse]'));
  assert.throws(() => normalizeDraft(JSON.stringify({
    description: richPlainDescription('旧城'), lyrics: richLyrics(), tags: ['独立流行'],
  }), '只优化编曲', 'openai', { existing: { title: '已有歌名', duration: 30 } }), /title/);
  assert.throws(() => normalizeDraft(JSON.stringify({ title: '已有歌名', duration: 30 }), '照抄', 'openai', {
    model: { fields: ['duration'] }, existing: { title: '已有歌名', duration: 30 },
  }), /未锁定字段没有改写：title、duration/);
  const lockedOmissionDraft = normalizeDraft(JSON.stringify({ steps: 20 }), '只改采样', 'openai', {
    model: { fields: ['duration', 'steps'] }, existing: { title: '锁定标题', duration: 30, steps: 10 }, lockedFields: ['title', 'duration'],
  });
  assert.strictEqual(lockedOmissionDraft.title, '锁定标题');
  assert.strictEqual(lockedOmissionDraft.duration, 30);
  assert.strictEqual(lockedOmissionDraft.steps, 20);
  const protectedDraft = normalizeDraft(JSON.stringify({
    title: '不应写入的新标题', description: '太短也不应替换锁定描述', negativePrompt: 'changed',
    lyrics: richLyrics(), tags: ['电子'], duration: 180, steps: 20, cfg: 3,
  }), '优化其他字段', 'openai', {
    model: { id: 'minimax-music-3', fields: ['prompt', 'lyrics', 'duration', 'steps', 'cfg'] },
    existing: { title: '锁定标题', description: richCaption('锁定主题'), lyrics: '[Verse]\n旧城旧梦落在窗边', duration: 90, steps: 14, cfg: 1.8 },
    lockedFields: ['title', 'description', 'duration'],
  });
  assert.strictEqual(protectedDraft.title, '锁定标题');
  assert.strictEqual(protectedDraft.description, richCaption('锁定主题'));
  assert.strictEqual(protectedDraft.duration, 90);
  const stableSpecificDraft = normalizeDraft(JSON.stringify({
    title: '无歌词配乐', description: richPlainDescription('荒原'), negativePrompt: 'clipping', duration: 46, steps: 8, cfg: 1,
  }), '电影配乐', 'openai', {
    model: { id: 'stable-audio-3', fields: ['prompt', 'negativePrompt', 'duration', 'steps', 'cfg'] }, existing: { duration: 45 },
  });
  assert.strictEqual(stableSpecificDraft.lyrics, '[Instrumental]');
  assert.deepStrictEqual(stableSpecificDraft.tags, []);
  const aceSpecificDraft = normalizeDraft(JSON.stringify({
    title: '窗台夜色', description: 'ACE-Step 不读取这个字段',
    tags: ['华语流行', '女声', '中慢速', '人声靠前', '歌词清晰', '旋律简单'],
    lyrics: aceSegmentLyrics(), duration: 39, steps: 10, cfg: 2.2,
  }), '雨夜女声第一段', 'openai', {
    model: { id: 'ace-step-1.5', label: 'ACE-Step 1.5 · 本地', playbook: 'ace-segment', fields: ['tags', 'lyrics', 'duration', 'steps', 'cfg', 'seed'] },
    existing: { duration: 40, steps: 8, cfg: 2 },
  });
  assert.strictEqual(aceSpecificDraft.title, '窗台夜色');
  assert.strictEqual(aceSpecificDraft.playbook, 'ace-segment');
  assert.deepStrictEqual(aceSpecificDraft.tags, ['华语流行', '女声', '中慢速', '人声靠前', '歌词清晰', '旋律简单']);
  assert(aceSpecificDraft.lyrics.startsWith('[Verse]'));
  assert.strictEqual(aceSpecificDraft.description, '');
  const aceFullSongDraft = normalizeDraft(JSON.stringify({
    title: '四分钟长歌', description: richPlainDescription('远行'),
    tags: ['华语流行', '清晰人声', '中慢速'], lyrics: aceFullSongLyrics(), duration: 250, steps: 10, cfg: 2.2,
    bpm: 82, keyscale: 'A minor', timesignature: '3/4', language: 'zh',
  }), '生成一首四分钟完整歌曲', 'openai', {
    model: { id: 'ace-step-1.5', label: 'ACE-Step 1.5 · 本地', playbook: 'ace-native', fields: ['prompt', 'tags', 'lyrics', 'bpm', 'keyscale', 'timesignature', 'language', 'duration', 'steps', 'cfg', 'seed'] },
    existing: { duration: 240, steps: 8, cfg: 2, bpm: 96, keyscale: 'C major', timesignature: '4', language: 'auto' }, ranges: { duration: [20, 600, 1], steps: [1, 20, 1], cfg: [0.5, 5, 0.1], bpm: [30, 300, 1] },
  });
  assert.strictEqual(aceFullSongDraft.duration, 250);
  assert.strictEqual(aceFullSongDraft.playbook, 'ace-native');
  assert.strictEqual(aceFullSongDraft.bpm, 82);
  assert.strictEqual(aceFullSongDraft.keyscale, 'A minor');
  assert.strictEqual(aceFullSongDraft.timesignature, '3');
  assert.strictEqual(aceFullSongDraft.language, 'zh');
  assert(lyricMetrics(aceFullSongDraft.lyrics).sections >= 8);
  assert.throws(() => normalizeDraft(JSON.stringify({
    title: '太长', tags: ['流行'], lyrics: richLyrics(), duration: 41,
  }), '整首', 'openai', {
    model: { id: 'ace-step-1.5', playbook: 'ace-segment', fields: ['tags', 'lyrics', 'duration'] },
    existing: { duration: 40 },
  }), /最多 2 个段落/);
  const repairedProseDraft = normalizeDraft(JSON.stringify({
    title: '散文', tags: ['流行'],
    lyrics: '[Verse]\n我在那个下过雨的傍晚又一次想起我们曾经一起走过的街道\n那些没有说出口的话像潮水一样涌上来\n让我无法呼吸',
    duration: 29,
  }), '散文', 'openai', {
    model: { id: 'ace-step-1.5', playbook: 'ace-segment', fields: ['tags', 'lyrics', 'duration'] },
    existing: { duration: 30 },
  });
  assert(lyricMetrics(repairedProseDraft.lyrics).maxLineChars <= 10);
  assert.deepStrictEqual(repairedProseDraft.warnings, ['已自动整理 ACE-Step 歌词断行']);
  assert.strictEqual(repairAceLyrics('[Verse]\n短句', { maxLineChars: 10 }).changed, false);
  assert.throws(() => normalizeDraft(JSON.stringify({
    title: '误写间奏', description: richCaption('误写间奏'), lyrics: `${richLyrics()}\n\n[Instrumental]\n我还在唱`, tags: ['华语流行'], duration: 121,
  }), '有人声的长歌', 'openai', {
    model: { id: 'minimax-music-3', fields: ['prompt', 'lyrics', 'duration'] }, existing: { duration: 120 },
  }), /歌词结构与演唱目标冲突/);
  assert.throws(() => normalizeDraft(JSON.stringify({ title: '模板不应补写', tags: [] }), '关于远方', 'openai', { model: { fields: ['tags'] } }), /tags/);
  assert.throws(() => normalizeDraft('{"title":"空描述","description":"短"}', '关于远方', 'openai', { model: { fields: ['prompt'] } }), /太短/);
  const smartManager = new SmartComposerManager({ runtimeDir: temporaryRoot, secretCodec });
  assert.strictEqual(smartManager.status().engine, 'openai');
  assert.strictEqual(smartManager.status().configured, false);
  await assert.rejects(smartManager.complete({ idea: '写一首雨夜的歌' }), /配置并测试模型 API/);
  smartManager.configure({ engine: 'openai', baseUrl: 'https://api.example.com/v1', model: 'writer-v1', apiKey: 'smart-secret-5678' });
  assert.strictEqual(smartManager.status().keyHint, '••••5678');
  assert(!fs.readFileSync(path.join(temporaryRoot, 'smart-composer.json'), 'utf8').includes('smart-secret-5678'));
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(temporaryRoot, 'smart-composer.json'), 'utf8')).version, 2);
  console.log('  ✓ 未配置时拒绝生成，API Key 未明文落盘');

  console.log('[runtime] Ollama / OpenAI-compatible 智能引擎协议');
  const smartRequests = [];
  const smartServer = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
      smartRequests.push({ url: req.url, authorization: req.headers.authorization, body });
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'qwen-test' }] }));
      if (req.url === '/api/chat') return res.end(JSON.stringify({
        message: { content: JSON.stringify({ title: '本地夜曲', description: richCaption('城市夜归'), negativePrompt: 'clipping, harsh highs', lyrics: richLyrics(), tags: ['电子', '女声'], steps: 18, cfg: 2.2 }) },
      }));
      if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'writer-test' }] }));
      if (req.url === '/v1/chat/completions') {
        const repairing = body.messages.some((message) => String(message.content).includes('上一次输出无法写入创作单'));
        const content = repairing
          ? { title: '远端草稿', description: richPlainDescription('重逢'), lyrics: richLyrics(), tags: ['独立流行', '温暖'], duration: 75, steps: 12, cfg: 1.2 }
          : { title: '格式错误草稿', description: '太短', lyrics: '风穿过街道', tags: [] };
        return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
      }
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: 'not found' }));
    });
  });
  await new Promise((resolve) => smartServer.listen(0, '127.0.0.1', resolve));
  try {
    const address = smartServer.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    smartManager.configure({ engine: 'ollama', baseUrl, model: 'qwen-test' });
    assert.strictEqual((await smartManager.test()).ok, true);
    const ollamaDraft = await smartManager.complete({
      idea: '保留副歌，把城市夜归改得更温暖',
      model: { id: 'minimax-music-3', label: 'MiniMax Music 3' },
      existing: { title: '城市夜归', description: '城市流行', lyrics: '[Chorus]\n我会在夜里回家', duration: 90, steps: 14, cfg: 1.8 },
      lockedFields: ['duration'], avoidDrafts: ['旧创作单'], requireUnique: true, iteration: 2,
      ranges: { duration: [10, 300, 1], steps: [8, 50, 1], cfg: [0.5, 5, 0.1] },
    });
    assert.strictEqual(ollamaDraft.title, '本地夜曲');
    const ollamaRequest = smartRequests.find((item) => item.url === '/api/chat').body;
    assert.strictEqual(ollamaRequest.stream, false);
    assert.strictEqual(ollamaRequest.options.num_predict, durationTargets(90).maxOutputTokens);
    assert.strictEqual(ollamaRequest.options.temperature, 1);
    assert.strictEqual(JSON.parse(ollamaRequest.messages[1].content).task, 'optimize_existing_draft');
    assert.strictEqual(JSON.parse(ollamaRequest.messages[1].content).existing.title, '城市夜归');
    assert.deepStrictEqual(JSON.parse(ollamaRequest.messages[1].content).lockedFields, ['duration']);
    assert.deepStrictEqual(JSON.parse(ollamaRequest.messages[1].content).avoidDrafts, ['旧创作单']);
    assert(ollamaRequest.messages[0].content.includes('所有创意内容必须由你'));
    assert(ollamaRequest.messages[0].content.includes('Global Metadata'));
    assert(ollamaRequest.messages[0].content.includes('已被用户锁定'));
    assert(ollamaRequest.messages[0].content.includes('持续生成第 2 轮'));
    assert(ollamaRequest.messages[0].content.includes('每个字段都必须返回有效的新值'));
    assert.strictEqual(ollamaDraft.duration, 90);
    assert.strictEqual(ollamaDraft.steps, 18);
    assert.strictEqual(ollamaDraft.cfg, 2.2);

    smartManager.configure({ engine: 'openai', baseUrl: `${baseUrl}/v1`, model: 'writer-test', apiKey: 'compatible-secret' });
    assert.strictEqual((await smartManager.test()).ok, true);
    const remoteDraft = await smartManager.complete({ idea: '写一首关于重逢的歌', duration: 70, model: { id: 'remote-stability', label: 'Stable Audio', fields: ['prompt', 'duration', 'steps', 'cfg'] } });
    assert.strictEqual(remoteDraft.title, '远端草稿');
    assert.strictEqual(remoteDraft.duration, 75);
    assert.strictEqual(remoteDraft.steps, 12);
    assert.strictEqual(remoteDraft.cfg, 1.2);
    assert.strictEqual(remoteDraft.lyrics, '[Instrumental]');
    assert.deepStrictEqual(remoteDraft.tags, []);
    const completionRequest = smartRequests.find((item) => item.url === '/v1/chat/completions');
    assert.strictEqual(completionRequest.authorization, 'Bearer compatible-secret');
    assert.strictEqual(completionRequest.body.response_format.type, 'json_object');
    assert.strictEqual(completionRequest.body.max_tokens, durationTargets(70).maxOutputTokens);
    assert(!completionRequest.body.messages[0].content.includes('Global Metadata'));
    const completionRequests = smartRequests.filter((item) => item.url === '/v1/chat/completions');
    assert.strictEqual(completionRequests.length, 2);
    assert(completionRequests[1].body.messages.at(-1).content.includes('所有创意内容必须由你生成'));
    assert(!JSON.stringify(smartManager.status()).includes('compatible-secret'));
    assert.strictEqual(smartManager.status().configs.ollama.model, 'qwen-test');
  } finally {
    await new Promise((resolve) => smartServer.close(resolve));
  }
  console.log('  ✓ 本地与远端 API 调用、格式修复重试均通过');

  console.log('[runtime] 大文件中断后自动续传');
  const payload = Buffer.alloc(1024 * 1024, 0x5a);
  let requestCount = 0;
  const downloadServer = http.createServer((req, res) => {
    requestCount++;
    const range = String(req.headers.range || '');
    const start = range ? Number(range.match(/bytes=(\d+)-/)?.[1] || 0) : 0;
    const remaining = payload.subarray(start);
    res.writeHead(start ? 206 : 200, {
      'Content-Length': remaining.length,
      ...(start ? { 'Content-Range': `bytes ${start}-${payload.length - 1}/${payload.length}` } : {}),
    });
    if (requestCount === 1) {
      res.write(remaining.subarray(0, Math.floor(remaining.length / 2)));
      setTimeout(() => res.socket?.destroy(), 20);
    } else {
      res.end(remaining);
    }
  });
  await new Promise((resolve) => downloadServer.listen(0, '127.0.0.1', resolve));
  const downloadTarget = path.join(temporaryRoot, 'resume-test.bin');
  try {
    const address = downloadServer.address();
    await downloadFileWithRetry(`http://127.0.0.1:${address.port}/model.bin`, downloadTarget, null, payload.length, null, 3);
    assert.strictEqual(requestCount, 2);
    assert.deepStrictEqual(fs.readFileSync(downloadTarget), payload);
  } finally {
    await new Promise((resolve) => downloadServer.close(resolve));
  }
  console.log('  ✓ 连接中断后从 .part 断点自动恢复');

  console.log('[runtime] ComfyUI 生成任务可真正中断');
  let interruptRequests = 0;
  let deletedPrompt = null;
  const cancelServer = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/prompt') return res.end(JSON.stringify({ prompt_id: 'prompt-cancel-test' }));
    if (req.url === '/interrupt') { interruptRequests++; return res.end('{}'); }
    if (req.url === '/queue') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        deletedPrompt = JSON.parse(Buffer.concat(chunks).toString()).delete?.[0] || null;
        res.end('{}');
      });
      return;
    }
    if (req.url?.startsWith('/history/')) return res.end('{}');
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((resolve) => cancelServer.listen(0, '127.0.0.1', resolve));
  try {
    const address = cancelServer.address();
    const provider = Providers.makeComfyUIProvider({ proxyBase: `http://127.0.0.1:${address.port}` });
    const generation = provider.generate({
      id: 'minimax-music-3', stages: [{ id: 'load' }, { id: 'encode' }, { id: 'sample' }, { id: 'decode' }, { id: 'save' }],
      buildPrompt: () => ({ '1': { class_type: 'TestNode', inputs: {} } }),
    }, { duration: 10 }, null);
    await new Promise((resolve) => setTimeout(resolve, 80));
    await provider.cancel();
    await assert.rejects(generation, /生成已停止/);
    assert.strictEqual(interruptRequests, 1);
    assert.strictEqual(deletedPrompt, 'prompt-cancel-test');
  } finally {
    await new Promise((resolve) => cancelServer.close(resolve));
  }
  console.log('  ✓ /interrupt 与队列删除均已调用');

  console.log('[runtime] MLX 原生生成任务可真正中断');
  const nativeGeneration = manager.runGenerationStep(
    'minimax-music-3-mlx', process.execPath, ['-e', 'setInterval(() => {}, 1000)'], temporaryRoot, 'MLX 中断测试',
  );
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.strictEqual(manager.activeGenerationModel, 'minimax-music-3-mlx');
  assert.strictEqual(manager.cancelLocalGeneration('minimax-music-3-mlx').ok, true);
  await assert.rejects(nativeGeneration, /退出/);
  assert.strictEqual(manager.processes.generation, null);
  assert.strictEqual(manager.activeGenerationModel, null);
  console.log('  ✓ 子进程停止、状态清理与 Promise 结束均已验证');

  console.log('[runtime] 本地伴生服务冒烟');
  fs.rmSync(path.join(temporaryRoot, 'smart-composer.json'), { force: true });
  const launcher = createLauncher({ port: 0, runtimeDir: temporaryRoot, music3Base: 'http://127.0.0.1:1', aceBase: 'http://127.0.0.1:2', comfyBase: 'http://127.0.0.1:3', desktop: true, secretCodec });
  try {
    const { baseUrl } = await launcher.listen();
    const statusResponse = await fetch(`${baseUrl}/api/status`);
    assert.strictEqual(statusResponse.status, 200);
    const status = await statusResponse.json();
    assert.strictEqual(status.app.mode, 'desktop');
    assert.strictEqual(status.app.version, require('../package.json').version);
    assert.strictEqual(status.music3.installed, false);
    assert.strictEqual(status.ace.deployable, true);
    assert.strictEqual(status.local.packs.length, 6);
    assert(status.local.packs.every((pack) => typeof pack.removable === 'boolean'));
    assert.strictEqual(status.remote.providers.length, 3);
    assert.strictEqual(status.smart.engine, 'openai');
    assert.strictEqual(status.smart.configured, false);
    assert.deepStrictEqual(status.smart.engines.map((engine) => engine.id), ['openai', 'ollama']);
    assert.strictEqual(status.remote.providers.find((item) => item.id === 'suno').configured, true);
    assert(!JSON.stringify(status).includes('test-secret-1234'));

    launcher.manager.phase.local = 'installing';
    launcher.manager.activePack = 'minimax-music-3-mlx';
    const installingStatus = await (await fetch(`${baseUrl}/api/status`)).json();
    assert.strictEqual(installingStatus.local.phase, 'installing');
    assert.strictEqual(installingStatus.local.activePack, 'minimax-music-3-mlx');
    launcher.manager.phase.local = 'idle';
    launcher.manager.activePack = null;

    const statelessStopResponse = await fetch(`${baseUrl}/api/local/models/stable-audio-3/stop`, { method: 'POST' });
    const statelessStop = await statelessStopResponse.json();
    assert.strictEqual(statelessStop.ok, true);
    assert.strictEqual(statelessStop.notRequired, true);

    const workerSignals = [];
    let workerInputClosed = false;
    launcher.manager.music3MlxWorker = {
      pid: 4242,
      stdin: { end() { workerInputClosed = true; } },
      kill(signal) { workerSignals.push(signal); },
    };
    const modelStopResponse = await fetch(`${baseUrl}/api/local/models/minimax-music-3-mlx/stop`, { method: 'POST' });
    const modelStop = await modelStopResponse.json();
    assert.strictEqual(modelStop.ok, true);
    assert.strictEqual(modelStop.stopped, true);
    assert.strictEqual(launcher.manager.music3MlxWorker, null);
    assert.strictEqual(workerInputClosed, true);
    assert(workerSignals.includes('SIGTERM'));

    const configured = await fetch(`${baseUrl}/api/remote/providers/minimax/config`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'minimax-secret-9876', model: 'music-2.6' }),
    });
    assert.strictEqual(configured.status, 200);
    assert(!(await configured.text()).includes('minimax-secret-9876'));

    const smartCompleted = await fetch(`${baseUrl}/api/smart/complete`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idea: '一首关于海边重逢的歌，温暖女声', duration: 60 }),
    });
    assert.strictEqual(smartCompleted.status, 400);
    assert((await smartCompleted.json()).error.includes('配置并测试模型 API'));

    const indexResponse = await fetch(`${baseUrl}/`);
    assert.strictEqual(indexResponse.status, 200);
    const indexHtml = await indexResponse.text();
    assert(indexHtml.includes('MiniMax Music 3'));
    assert(indexHtml.includes('id="app-version"'));
    assert(indexHtml.includes('id="model-badge" class="badge model-badge-link"'));
    assert(indexHtml.includes('data-model-source-panel="builtin"'));
    assert(indexHtml.includes('id="song-title"'));
    assert(indexHtml.includes('id="remote-model-hint"'));
    assert(indexHtml.includes('id="remote-model-suggestions"'));
    assert(indexHtml.includes('id="local-model-uninstall"'));
    assert(indexHtml.includes('generation-queue'));
    assert(indexHtml.includes('smart-composer'));
    assert(indexHtml.includes('id="smart-impact"'));
    assert(indexHtml.includes('id="smart-impact-title"'));
    assert(indexHtml.includes('id="smart-impact-summary"'));
    assert(indexHtml.includes('id="creation-album"'));
    assert(indexHtml.includes('id="continuous-toggle"'));
    assert(indexHtml.includes('id="completion-notices"'));
    assert(indexHtml.includes('<textarea id="neg"'));
    assert(indexHtml.includes('id="library-search"'));
    assert(indexHtml.includes('id="library-import"'));
    assert(indexHtml.includes('id="track-detail"'));
    assert(indexHtml.includes('id="lyric-editor"'));
    assert(indexHtml.includes(`js/timed-lyrics.js?v=${require('../package.json').version}`));
    assert(indexHtml.includes('id="duration-val" class="parameter-number" type="number"'));
    assert(indexHtml.includes('id="steps-val" class="parameter-number" type="number"'));
    assert(indexHtml.includes('id="cfg-val" class="parameter-number" type="number"'));
    assert(indexHtml.includes('id="reference-strength-val" class="compact-number" type="number"'));
    assert(indexHtml.includes('id="creation-album-trigger"'));
    assert(indexHtml.includes('id="album-picker-dialog"'));
    assert(indexHtml.includes('id="album-picker-search"'));
    assert(indexHtml.includes('id="album-create-option"'));
    assert(indexHtml.includes('id="completion-policy"'));
    assert(indexHtml.includes('data-completion-policy="follow"'));
    assert(indexHtml.includes('data-completion-policy="play"'));
    assert(indexHtml.includes('data-completion-policy="none"'));
    assert(indexHtml.includes('id="library-albums"'));
    assert(indexHtml.includes('id="field-reference"'));
    assert(indexHtml.includes('id="ace-long-mode"'));
    assert(indexHtml.includes('<option value="auto">智能分段（推荐）</option>'));
    assert(indexHtml.includes('id="ace-bpm"'));
    assert(indexHtml.includes('id="ace-keyscale"'));
    assert(indexHtml.includes('id="ace-timesignature"'));
    assert(indexHtml.includes('id="ace-language"'));
    assert(indexHtml.includes('id="now-playing"'));
    assert(indexHtml.includes('id="player-lyrics"'));
    assert(indexHtml.includes('id="transport-prev"'));
    assert(!indexHtml.includes('本机基础补全'));
    const appSource = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');
    const styleSource = fs.readFileSync(path.join(__dirname, '..', 'css', 'style.css'), 'utf8');
    assert(appSource.includes("? 'prompt-tags-lyrics'"));
    assert(appSource.includes("setText('title', draft.title || '')"));
    assert(appSource.includes("setText('tags', Array.isArray(draft.tags)"));
    assert(appSource.includes("setText('lyrics', draft.lyrics || '')"));
    assert(appSource.includes('function aceGenerationStrategy('));
    assert(appSource.includes('function smartPlaybookFor('));
    assert(appSource.includes('async function recoverPersistedAceSuites()'));
    assert(appSource.includes('data-queue-action="retry-suite"'));
    assert(appSource.includes('await persistTrack(track);'));
    assert(appSource.includes('function openCurrentModelSettings()'));
    assert(appSource.includes('Sidecar.stopLocalModel(state.localModelId)'));
    assert(appSource.includes("element.dispatchEvent(new Event('input', { bubbles: true }))"));
    assert(styleSource.includes('.composer-scroll[data-model-layout="tags-lyrics"]'));
    assert(styleSource.includes('.composer-scroll[data-model-layout="prompt-tags-lyrics"]'));
    assert(styleSource.includes('.smart-impact { min-width: 0; flex-wrap: nowrap;'));
    assert(indexHtml.indexOf('id="smart-complete"') < indexHtml.indexOf('class="smart-composer-body"'));
    assert(!indexHtml.includes('class="smart-composer-submit"'));
    assert(indexHtml.indexOf('id="ace-segment-plan"') > indexHtml.indexOf('id="creation-album-field"'));

    const routeReference = Buffer.alloc(48);
    routeReference.write('RIFF', 0); routeReference.write('WAVE', 8);
    const uploadedReference = await fetch(`${baseUrl}/api/local/references`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: routeReference });
    assert.strictEqual(uploadedReference.status, 201);
    const uploadedReferenceId = (await uploadedReference.json()).reference.id;
    assert.strictEqual(fs.existsSync(launcher.manager.referenceAudioPath(uploadedReferenceId)), true);
    const removedReference = await fetch(`${baseUrl}/api/local/references/${uploadedReferenceId}`, { method: 'DELETE' });
    assert.strictEqual(removedReference.status, 200);
    assert.strictEqual((await removedReference.json()).removed, true);

    const routePartial = `${launcher.manager.modelPath(MUSIC3_MODELS[0])}.part`;
    fs.mkdirSync(path.dirname(routePartial), { recursive: true });
    fs.writeFileSync(routePartial, 'partial');
    const uninstalled = await fetch(`${baseUrl}/api/local/models/minimax-music-3/uninstall`, { method: 'POST' });
    assert.strictEqual(uninstalled.status, 200);
    assert.strictEqual((await uninstalled.json()).ok, true);
    assert.strictEqual(fs.existsSync(routePartial), false);

    const blocked = await fetch(`${baseUrl}/api/status`, { headers: { Origin: 'https://malicious.example' } });
    assert.strictEqual(blocked.status, 403);
    const privateFile = await fetch(`${baseUrl}/server/launcher.js`);
    assert.strictEqual(privateFile.status, 404);
  } finally {
    await launcher.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
  console.log('  ✓ runtime manager 与 sidecar 路由通过');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
