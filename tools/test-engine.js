#!/usr/bin/env node
/*
 * 音悦台 · 音频引擎离线测试
 * 生成一段 WAV 到 outputs/，并校验：
 *   - WAV 头合法（RIFF/WAVE, 16-bit, 立体声）
 *   - 采样非静音（RMS 有效）
 *   - 同 seed 可复现（两次生成字节完全一致）
 *   - 不同 seed 结果不同
 */
const fs = require('fs');
const path = require('path');
const Engine = require('../js/audio-engine.js');
const Providers = require('../js/providers.js');
const AceApi = require('../js/ace-api.js');
const VocalGuard = require('../js/vocal-guard.js');
const AudioQuality = require('../js/audio-quality.js');

function rms16(buf) {
  let sum = 0, n = 0;
  for (let off = 44; off + 1 < buf.length; off += 2) {
    const v = buf.readInt16LE(off) / 32768;
    sum += v * v; n++;
  }
  return Math.sqrt(sum / n);
}

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { console.log('  \u2713 ' + name); pass++; }
  else { console.log('  \u2717 ' + name); fail++; }
}

const outDir = path.join(__dirname, '..', 'outputs');
fs.mkdirSync(outDir, { recursive: true });

console.log('[1] 基本合成 (lo-fi, 6s)');
const p1 = { tags: 'lo-fi 慵懒 钢琴', lyrics: '第一行\n第二行', duration: 6, steps: 28, cfg: 5, seed: 12345 };
const r1 = Engine.generateWavBuffer(p1);
const b1 = Buffer.from(r1.wav);
fs.writeFileSync(path.join(outDir, 'test-lofi.wav'), b1);
check('WAV 头 = RIFF', b1.slice(0, 4).toString() === 'RIFF');
check('格式 = WAVE', b1.slice(8, 12).toString() === 'WAVE');
check('声道 = 2', b1.readUInt16LE(22) === 2);
check('位深 = 16', b1.readUInt16LE(34) === 16);
check('采样率 = 44100', b1.readUInt32LE(24) === 44100);
const rms1 = rms16(b1);
check('非静音 (RMS=' + rms1.toFixed(4) + ' > 0.02)', rms1 > 0.02);
check('时长约 6s (' + (b1.length / 4 / 44100).toFixed(2) + 's)', Math.abs(b1.length / 4 / 44100 - 6) < 0.2);

console.log('[2] 可复现性 (同 seed 字节一致)');
const r1b = Buffer.from(Engine.generateWavBuffer(p1).wav);
check('两次生成完全一致', Buffer.compare(b1, r1b) === 0);

console.log('[3] 种子敏感性 (不同 seed 不同)');
const r2 = Buffer.from(Engine.generateWavBuffer(Object.assign({}, p1, { seed: 99 })).wav);
check('不同 seed → 不同结果', Buffer.compare(b1, r2) !== 0);

console.log('[4] 曲风命中');
check('lo-fi → lofi', Engine.presetForTags('lo-fi chill').key === 'lofi');
check('电子舞曲 → edm', Engine.presetForTags('电子舞曲').key === 'edm');
check('默认 → pop', Engine.presetForTags('随便什么').key === 'pop');

console.log('[5] EDM 曲风也能出声 & 落盘');
const rEdm = Engine.generateWavBuffer({ tags: 'EDM 电子', duration: 5, steps: 40, cfg: 6, seed: 7 });
const bEdm = Buffer.from(rEdm.wav);
fs.writeFileSync(path.join(outDir, 'test-edm.wav'), bEdm);
check('EDM 非静音 (RMS=' + rms16(bEdm).toFixed(4) + ')', rms16(bEdm) > 0.02);

console.log('[6] 各模型 ComfyUI 工作流生成合法');
const Models = require('../js/models.js');
const wfP = { tags: 'lo-fi chill', lyrics: '第一行', prompt: 'warm ambient piano', duration: 6, steps: 28, cfg: 5, seed: 12345, bpm: 82, keyscale: 'A minor', timesignature: '3', language: 'zh' };
// ACE-Step 1.5（原生长歌构建器）
const wf = Models.builders.aceStep15(wfP);
check('ACE1.5 含 KSampler 节点', wf['3'].class_type === 'KSampler');
check('ACE1.5 KSampler 引用 seed', wf['3'].inputs.seed === 12345);
check('ACE1.5 时长写入 latent', wf['98'].inputs.seconds === 6);
check('ACE1.5 时长可原生达到 240 秒', Models.builders.aceStep15({ ...wfP, duration: 240 })['98'].inputs.seconds === 240);
check('ACE1.5 caption 合并描述与风格标签', wf['94'].inputs.tags.includes('warm ambient piano') && wf['94'].inputs.tags.includes('lo-fi chill'));
check('ACE1.5 BPM/调式/拍号/语言写入编码节点', wf['94'].inputs.bpm === 82 && wf['94'].inputs.keyscale === 'A minor' && wf['94'].inputs.timesignature === '3' && wf['94'].inputs.language === 'zh');
check('ACE1.5 SaveAudioAdvanced 引用 VAEDecode', wf['111'].inputs.audio[0] === '18');
const continuityWf = Models.builders.aceStep15({ ...wfP, continuityReferenceFilename: 'yinyuetai-continuity/previous-tail.wav' });
check('ACE1.5 后续分段载入上一段尾部参考', continuityWf['112'].class_type === 'LoadAudio' && continuityWf['113'].class_type === 'VAEEncodeAudio');
check('ACE1.5 连续性参考进入音色条件并关闭重复规划', continuityWf['114'].class_type === 'ReferenceTimbreAudio' && continuityWf['3'].inputs.positive[0] === '114' && continuityWf['94'].inputs.generate_audio_codes === false);
// Stable Audio 1.0
const sa = Models.byId('stable-audio-open-1.0').buildPrompt(wfP);
check('StableAudio1.0 含 EmptyLatentAudio', sa['11'].class_type === 'EmptyLatentAudio');
check('StableAudio1.0 输出 SaveAudioMP3', Object.values(sa).some((n) => n.class_type === 'SaveAudioMP3'));
check('StableAudio3 走独立本地 MLX 路径', Models.byId('stable-audio-3').provider === 'local-cli');
check('StableAudio3 默认使用官方推荐 8 步 / CFG 1', Models.byId('stable-audio-3').defaults.steps === 8 && Models.byId('stable-audio-3').defaults.cfg === 1);
check('StableAudio3 防止误用过高采样与 CFG', Models.byId('stable-audio-3').ranges.steps[1] === 16 && Models.byId('stable-audio-3').ranges.cfg[1] === 3);
check('StableAudio3 可配置排除内容', Models.byId('stable-audio-3').fields.includes('negativePrompt'));
check('StableAudio3 声明支持曲库参考音乐', Models.byId('stable-audio-3').supportsReferenceAudio === true && Models.byId('stable-audio-3').fields.includes('referenceAudio'));
const ReferenceAudio = require('../js/reference-audio.js');
const referenceWav = Buffer.from(ReferenceAudio.encodePcm16Wav([new Float32Array([0, 0.5, -0.5])], 44100));
check('参考音乐转换为 44.1kHz 16-bit 立体声 WAV', referenceWav.subarray(0, 4).toString() === 'RIFF' && referenceWav.readUInt16LE(22) === 2 && referenceWav.readUInt32LE(24) === 44100 && referenceWav.readUInt16LE(34) === 16);
// MiniMax Music 3（本地 ComfyUI 原生节点）
const mm = Models.byId('minimax-music-3').buildPrompt(wfP);
check('Music 3 使用 INT8 DiT', mm['1'].inputs.unet_name === 'minimax_music3_dit_int8_convrot.safetensors');
check('Music 3 含原生文本编码节点', mm['4'].class_type === 'MiniMaxMusic3TextEncode');
check('Music 3 文本编码由运行时选择加速设备', mm['2'].inputs.device === 'default');
check('Music 3 使用分块音频解码', mm['8'].class_type === 'VAEDecodeAudioTiled');
check('Music 3 输出 SaveAudioAdvanced', mm['9'].class_type === 'SaveAudioAdvanced');
const mmNative = Models.byId('minimax-music-3').buildPrompt({ ...wfP, music3DiffusionModel: 'minimax_music3_dit_fp16.safetensors', music3TextEncoder: 'minimax_music3_text_encoder_pruned_bf16.safetensors' });
check('Music 3 自动选用已发现的原生 MPS 权重', mmNative['1'].inputs.unet_name.endsWith('_fp16.safetensors') && mmNative['2'].inputs.clip_name.endsWith('_bf16.safetensors'));
check('Music 3 拒绝任意模型文件名', Models.byId('minimax-music-3').buildPrompt({ ...wfP, music3DiffusionModel: '../../bad.safetensors' })['1'].inputs.unet_name === 'minimax_music3_dit_int8_convrot.safetensors');

console.log('[7] 模型注册表结构');
check('共 10 个模型入口', Models.MODELS.length === 10);
check('本地部署含 6 个可选模型', Models.MODELS.filter((model) => model.source === 'local').length === 6);
check('远端 API 含 3 个 BYOK 入口', Models.MODELS.filter((model) => model.source === 'remote').length === 3);
check('demo 无需后端', Models.byId('demo').needsBackend === false);
check('ace-step-1.5 需后端', Models.byId('ace-step-1.5').needsBackend === true);
check('4 个本地模型共享 ComfyUI', Models.MODELS.filter((model) => model.provider === 'local-comfy').length === 4);
check('MiniMax MLX 使用原生本地 Provider', Models.byId('minimax-music-3-mlx').provider === 'local-cli');
check('MiniMax MLX 采样限制符合后端', Models.byId('minimax-music-3-mlx').ranges.steps[1] === 30);
check('MiniMax MLX 可配置 CFG 加速', Models.byId('minimax-music-3-mlx').fields.includes('cfg') && Models.byId('minimax-music-3-mlx').defaults.cfg === 1.7);

console.log('[8] Demo Provider（模型驱动接口）生成音频');
const demoModel = Models.byId('demo');
check('demo 有 6 段节点链', demoModel.stages.length === 6);

console.log('[9] ACE-Step REST 兼容协议');
const acePayload = AceApi.buildGenerationPayload({ tags: 'jazz', lyrics: 'hello', duration: 30, steps: 8, cfg: 7, seed: 42 });
check('ACE payload 固定 seed', acePayload.seed === 42 && acePayload.use_random_seed === false);
check('ACE payload 限制在官方时长范围', AceApi.buildGenerationPayload({ duration: 2 }).audio_duration === 10);
check('ACE release 解析 task_id', AceApi.releaseTaskId({ code: 200, data: { task_id: 'task-1' } }) === 'task-1');
const aceDone = AceApi.parseTaskResult({ data: [{ task_id: 'task-1', status: 1, result: '[{"file":"/v1/audio?path=x","status":1}]' }] }, 'task-1');
check('ACE query 解析音频文件', aceDone.output.file.includes('/v1/audio'));

console.log('[10] 歌词时间轴解析与微调');
const TimedLyrics = require('../js/timed-lyrics.js');
const parsedLyrics = TimedLyrics.parseLrc('[00:01.20]第一行\n[00:05.50]第二行');
check('LRC 时间戳解析到百分之一秒', parsedLyrics.length === 2 && parsedLyrics[0].time === 1.2 && parsedLyrics[1].time === 5.5);
check('结构标签不会变成歌词行', TimedLyrics.plainLines('[Verse]\n第一行\n[Chorus]\n第二行').join('|') === '第一行|第二行');
const distributedLyrics = TimedLyrics.timelineFor('[Verse]\n第一行\n第二行\n第三行', 60, []);
check('无时间戳歌词按成品时长自动排布', distributedLyrics.length === 3 && distributedLyrics[0].time >= 0 && distributedLyrics[2].time <= 60);
check('当前歌词按真实时间戳定位', TimedLyrics.activeIndex(parsedLyrics, 5.6) === 1 && TimedLyrics.activeIndex(parsedLyrics, 1.3) === 0);
check('时间轴可序列化为标准 LRC', TimedLyrics.serializeLrc(parsedLyrics).includes('[00:05.50]第二行'));

console.log('[11] ACE 智能长歌与固定分段编排');
const AceSegment = require('../js/ace-segment.js');
const fullSong = `[Verse]
夜色落在窗台
风吹过旧街牌

[Pre-Chorus]
如果回忆还在
别让梦醒太快

[Chorus]
我还在等你
等风经过这里

[Verse]
走到路口才想起
钥匙还在桌上

[Bridge]
如果时间能重来
我会坦白期待

[Chorus]
我还在等你
回到我心底`;
check('ACE 1.5 原生长歌不会自动分段', AceSegment.shouldAutomate({ id: 'ace-step-1.5', playbook: 'ace-native' }, fullSong, 180) === false);
check('兼容模式仍可触发自动分段', AceSegment.shouldAutomate({ id: 'ace-step-1.5', playbook: 'ace-segment' }, fullSong, 180) === true);
check('智能策略 120 秒以内采用原生整首', AceSegment.smartStrategy(fullSong, 120).strategy === 'native');
const smartLongPlan = AceSegment.smartStrategy(fullSong, 240);
check('智能策略 240 秒切换为 7 段并为承接区留足余量', smartLongPlan.strategy === 'segment' && smartLongPlan.segmentCount === 7);
const smartTenMinutePlan = AceSegment.smartStrategy(fullSong, 600);
check('智能策略 600 秒切换为 17 段', smartTenMinutePlan.strategy === 'segment' && smartTenMinutePlan.segmentCount === 17);
const denseLyrics = Array.from({ length: 61 }, (_, index) => `第${index + 1}行歌词`).join('\n');
check('智能策略会拆分结构过密的短时长歌词', AceSegment.smartStrategy(denseLyrics, 120).strategy === 'segment');
const eightSectionSong = ['Intro', 'Verse 1', 'Pre-Chorus', 'Chorus 1', 'Verse 2', 'Chorus 2', 'Bridge', 'Outro']
  .map((tag, index) => `[${tag}]\n第${index + 1}段灯火还在\n第${index + 1}段晚风经过\n第${index + 1}段梦醒之前`).join('\n\n');
const structuredPlan = AceSegment.plan(eightSectionSong, { duration: 120 });
check('120 秒八个歌词段落动态拆成四段', structuredPlan.segments.length === 4 && structuredPlan.plannedDuration === 120);
check('动态分段保持每段两个 section 和 30 秒', structuredPlan.segments.every((segment) => AceSegment.parseSections(segment.lyrics).length <= 2 && segment.duration === 30));
check('后续段多生成 8 秒承接区，首段不重叠', structuredPlan.segments.every((segment, index) => segment.overlapSeconds === (index ? 8 : 0) && segment.generationDuration === (index ? 38 : 30)));
check('承接区同时携带上一段末两句歌词，避免新歌词被重叠裁掉', structuredPlan.segments[1].generationLyrics.includes('第2段晚风经过') && !structuredPlan.segments[1].lyrics.includes('第2段晚风经过'));
check('生成时长扣除承接区后精确回到 120 秒目标', structuredPlan.segments.reduce((sum, segment) => sum + segment.generationDuration - segment.overlapSeconds, 0) === 120);
check('原有 12 行唱词不足以覆盖 180 秒的逐段演唱', Boolean(AceSegment.plan(fullSong, { duration: 180 }).invalidReason));
const expandedFullSong = fullSong.replace(/^(?!\[)([^\n]+)$/gm, '$1\n$1');
const planned = AceSegment.plan(expandedFullSong, { duration: 180 });
check('自动拆成多段', planned.auto === true && planned.segments.length >= 3);
check('每段最多两个 section', planned.segments.every((segment) => AceSegment.parseSections(segment.lyrics).length <= 2));
check('每段新内容不超过 37 秒且生成请求不超过 45 秒', planned.segments.every((segment) => segment.duration >= 28 && segment.duration <= 37 && segment.generationDuration <= 45));
check('短片段不强制拆', AceSegment.plan('[Verse]\n夜色落在窗台\n风吹过旧街牌', { duration: 35 }).auto === false);
const sparseLongPlan = AceSegment.plan('[Verse]\n夜色落在窗台\n风吹过旧街牌\n\n[Chorus]\n我仍然等你\n直到天亮', { duration: 240 });
check('兼容模式仍识别 240 秒长歌', AceSegment.shouldAutomate({ id: 'ace-step-1.5', playbook: 'ace-segment' }, fullSong, 240) === true);
check('歌词太少时拒绝 240 秒分段而不凭空补纯器乐', sparseLongPlan.segments.length === 0 && /歌词/.test(sparseLongPlan.invalidReason));
const denseLongSong = Array.from({ length: 6 }, (_, index) => `[Verse ${index + 1}]\n${Array.from({ length: 5 }, (_, line) => `第${index + 1}段第${line + 1}句真实歌词`).join('\n')}`).join('\n\n');
const denseLongPlan = AceSegment.plan(denseLongSong, { duration: 240 });
check('歌词充足时 240 秒拆成 7 个有唱词的承接分段', denseLongPlan.segments.length === 7 && denseLongPlan.segments.every((segment) => segment.duration <= 37 && segment.generationDuration <= 45 && !/^\[Instrumental\]$/.test(segment.lyrics)));
check('分段时长总和保持整首目标', denseLongPlan.plannedDuration === 240 && denseLongPlan.segments.reduce((sum, segment) => sum + segment.duration, 0) === 240);
const instrumentalPlan = AceSegment.plan('[Instrumental]', { duration: 240 });
check('240 秒纯音乐同样使用承接分段', instrumentalPlan.auto === true && instrumentalPlan.segments.length === 7 && instrumentalPlan.plannedDuration === 240 && instrumentalPlan.segments.slice(1).every((segment) => segment.overlapSeconds === 8));

console.log('[12] 人声歌词预检和静音质量检查');
check('器乐标签下的唱词不能提交', /器乐/.test(VocalGuard.preflight('[Verse]\n第一句\n[Instrumental]\n第二句').error));
check('独奏标签下的唱词不能提交', Boolean(VocalGuard.preflight('[Solo]\n我还在唱').error));
check('被折断的段落标签不能提交', Boolean(VocalGuard.preflight('[Guitar Sol\no]\n歌词').error));
check('长歌可演唱歌词过少不能提交', Boolean(VocalGuard.preflight('[Verse]\n第一句\n第二句', { duration: 240, segmented: true }).error));
check('真正的纯音乐仍可提交', VocalGuard.preflight('[Instrumental]', { duration: 240, segmented: true }).error === '');
const briefInterlude = `[Verse]\n${Array.from({ length: 10 }, (_, index) => `第一段第${index + 1}句`).join('\n')}\n\n[Instrumental]\n\n[Chorus]\n${Array.from({ length: 10 }, (_, index) => `第二段第${index + 1}句`).join('\n')}`;
const interludePlan = AceSegment.plan(briefInterlude, { duration: 80 });
check('短间奏只随唱词同行，不会拆成整段器乐', interludePlan.segments.length >= 2 && interludePlan.segments.every((segment) => AceSegment.parseSections(segment.lyrics).some((section) => !AceSegment.isNonVocal(section.tag) && section.body.length)));
check('96 BPM 四拍歌曲按一小节做 2.5 秒衔接', AceSegment.crossfadeSecondsForMusic(96, '4') === 2.5);
const pcmRate = 4000;
function testPcm(seconds, mutedRanges = []) {
  const samples = new Float32Array(pcmRate * seconds);
  for (let index = 0; index < samples.length; index++) {
    const at = index / pcmRate;
    if (!mutedRanges.some(([from, to]) => at >= from && at < to)) samples[index] = Math.sin(index * 0.12) * 0.2;
  }
  return AudioQuality.analyzeSamples(samples, samples, pcmRate);
}
check('音频尾部 7 秒静音有明确告警', testPcm(40, [[33, 40]]).warnings.some((warning) => warning.includes('尾部')));
check('音频中途 10 秒静音有明确告警', testPcm(40, [[15, 25]]).warnings.some((warning) => warning.includes('中途')));
check('完整非静音音频不误报警', testPcm(40).warnings.length === 0);
const silentTailPcm = new Float32Array(pcmRate * 40);
for (let index = 0; index < pcmRate * 33; index++) silentTailPcm[index] = Math.sin(index * 0.12) * 0.2;
const silentTailTrim = AudioQuality.trimSilentTail(silentTailPcm, silentTailPcm, pcmRate, AudioQuality.analyzeSamples(silentTailPcm, silentTailPcm, pcmRate));
check('明显静音尾巴被裁掉并保留半秒缓冲', silentTailTrim && silentTailTrim.duration > 33 && silentTailTrim.duration < 34 && silentTailTrim.left.length === silentTailTrim.right.length);
check('正常音频不会被裁剪', AudioQuality.trimSilentTail(silentTailPcm, silentTailPcm, pcmRate, testPcm(40)) === null);

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
console.log('产物: ' + outDir);
process.exit(fail ? 1 : 0);
