/* Optional browser integration test. Requires a private Chrome profile on port 9231 and source server on 18803. */
'use strict';

async function connect() {
  const pages = await (await fetch('http://127.0.0.1:9231/json/list')).json();
  const page = pages.find((item) => item.type === 'page' && /音悦台 Studio/.test(item.title));
  if (!page) throw new Error('找不到隔离浏览器页面');
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const target = pending.get(message.id);
    if (!target) return;
    pending.delete(message.id);
    if (message.error) target.reject(new Error(message.error.message));
    else if (message.result?.exceptionDetails) target.reject(new Error(message.result.exceptionDetails.text));
    else target.resolve(message.result);
  });
  const send = (method, params) => new Promise((resolve, reject) => {
    const requestId = ++id;
    pending.set(requestId, { resolve, reject });
    socket.send(JSON.stringify({ id: requestId, method, params }));
  });
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.value;
  return { socket, evaluate, send };
}

async function waitFor(evaluate, expression, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const result = await evaluate(expression);
      last = result;
      if (result?.ready) return result;
    } catch (error) {
      if (!/Cannot find context|Execution context was destroyed/.test(error.message)) throw error;
      last = { error: error.message };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`浏览器集成测试超时: ${JSON.stringify(last)}`);
}

async function reloadWithSnapshot(send, evaluate, snapshot) {
  const token = `queue-test-${Date.now()}-${Math.random()}`;
  const source = `window.__queueTestRan = ${JSON.stringify(token)}; try { localStorage.setItem('yinyuetai.generation.queue.v1', ${JSON.stringify(snapshot)}); sessionStorage.setItem('__queue_test_reload', ${JSON.stringify(token)}); } catch (error) { window.__queueTestError = error.message; }`;
  await send('Page.enable');
  const injected = await send('Page.addScriptToEvaluateOnNewDocument', { source });
  await send('Page.navigate', { url: `http://127.0.0.1:18803/?queue-test=${encodeURIComponent(token)}` });
  await waitFor(evaluate, `({ ready: sessionStorage.getItem('__queue_test_reload') === ${JSON.stringify(token)} && Boolean(window.LibraryStore && window.QueuePersistence && document.getElementById('queue-resume')), state: document.readyState, marker: sessionStorage.getItem('__queue_test_reload'), ran: window.__queueTestRan, error: window.__queueTestError, href: location.href })`);
  await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: injected.identifier });
}

(async () => {
  const { socket, evaluate, send } = await connect();
  try {
    console.log('[phase] browser ready');
    await waitFor(evaluate, `({ ready: Boolean(window.LibraryStore && window.AudioEngine && window.QueuePersistence && window.Models && document.getElementById('queue-resume')) })`);
    console.log('[phase] injecting partial suite');
    const injected = await evaluate(`(async () => {
      const model = Models.MODELS.find((item) => item.id === 'ace-step-1.5');
      const samples = new Float32Array(44100);
      for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i * .02) * .05;
      const wav = new Blob([AudioEngine.encodeWav(samples, samples, 44100)], { type: 'audio/wav' });
      const partialTrack = { id: 'queue-browser-partial-0', title: '待续歌曲 · Intro', modelId: model.id, modelLabel: model.label, provider: 'local-comfy', album: '验收测试', category: '华语流行', createdAt: 101, duration: 1, requestedDuration: 30, seed: 111, lyrics: '[Intro]\\n晚风经过', suiteId: 'queue-browser-partial', suiteIndex: 0, suiteTotal: 4, suiteTitle: '待续歌曲', suiteFullLyrics: '[Intro]\\n晚风经过', suitePart: true, blob: wav };
      await LibraryStore.put(partialTrack);
      const jobs = Array.from({ length: 4 }, (_, index) => ({ id: 'qpartial-' + index, model, params: { duration: 30, album: '验收测试', seed: 111 + index }, title: '待续歌曲 · ' + index, status: index === 0 ? 'completed' : index === 1 ? 'running' : 'queued', trackId: index === 0 ? partialTrack.id : '', suiteId: partialTrack.suiteId, suiteIndex: index, suiteTotal: 4, suiteTitle: '待续歌曲', suiteFullLyrics: partialTrack.suiteFullLyrics }));
      return QueuePersistence.serialize(jobs);
    })()`);
    if (!injected) throw new Error('无法建立部分完成的套件');
    console.log('[phase] waiting for partial suite reload');
    await reloadWithSnapshot(send, evaluate, injected);
    const partial = await waitFor(evaluate, `(async () => {
      if (!document.getElementById('queue-summary')) return { ready: false };
      const rows = [...document.querySelectorAll('.queue-job')].map((row) => row.querySelector('.queue-state span')?.textContent);
      const saved = await LibraryStore.list();
      return { ready: rows.length === 4, rows, visible: document.getElementById('library-count').textContent, storedParts: saved.filter((track) => track.suiteId === 'queue-browser-partial').length, resumeEnabled: !document.getElementById('queue-resume').disabled };
    })()`);
    console.log('[partial]', JSON.stringify(partial));
    if (!partial.rows.includes('已中断') || !partial.rows.includes('等待中') || partial.storedParts !== 1 || partial.visible !== '0 首作品' || partial.resumeEnabled) {
      throw new Error('部分完成的套件未正确恢复或被误显示在曲库');
    }

    const injectedComplete = await evaluate(`(async () => {
      const model = Models.MODELS.find((item) => item.id === 'ace-step-1.5');
      const samples = new Float32Array(44100);
      for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i * .02) * .05;
      const wav = new Blob([AudioEngine.encodeWav(samples, samples, 44100)], { type: 'audio/wav' });
      const parts = Array.from({ length: 4 }, (_, index) => ({ id: 'queue-browser-complete-' + index, title: '重启合轨样本 · ' + index, modelId: model.id, modelLabel: model.label, provider: 'local-comfy', album: '验收测试', category: '华语流行', createdAt: 200 + index, duration: 1, requestedDuration: 30, seed: 221 + index, lyrics: '[Verse]\\n灯火还在', suiteId: 'queue-browser-complete', suiteIndex: index, suiteTotal: 4, suiteTitle: '重启合轨样本', suiteFullLyrics: '[Verse]\\n灯火还在', suitePart: true, blob: wav }));
      await LibraryStore.putMany(parts);
      const prior = QueuePersistence.restore(localStorage.getItem('yinyuetai.generation.queue.v1'), (id) => Models.MODELS.find((item) => item.id === id)).jobs;
      const completeJobs = parts.map((part, index) => ({ id: 'qcomplete-' + index, model, params: { duration: 30, album: '验收测试', seed: part.seed }, title: part.title, status: 'completed', trackId: part.id, suiteId: part.suiteId, suiteIndex: index, suiteTotal: 4, suiteTitle: part.suiteTitle, suiteFullLyrics: part.suiteFullLyrics }));
      return QueuePersistence.serialize([...prior, ...completeJobs]);
    })()`);
    if (!injectedComplete) throw new Error('无法建立完整套件');
    console.log('[phase] waiting for complete suite reload');
    await reloadWithSnapshot(send, evaluate, injectedComplete);
    const complete = await waitFor(evaluate, `(async () => {
      const tracks = await LibraryStore.list();
      const whole = tracks.find((track) => track.suiteId === 'queue-browser-complete' && track.suiteAssembled);
      return { ready: Boolean(whole), whole: whole ? { title: whole.title, duration: whole.duration, parts: whole.generation?.output?.metadata?.segmentCount } : null, leftover: tracks.filter((track) => track.suiteId === 'queue-browser-complete' && track.suitePart).length, partialParts: tracks.filter((track) => track.suiteId === 'queue-browser-partial').length };
    })()`, 45000);
    console.log('[complete]', JSON.stringify(complete));
    if (complete.whole.parts !== 4 || complete.leftover !== 0 || complete.partialParts !== 1) throw new Error('重启后合轨或部分分段保留错误');
    console.log('PASS: 完整套件重启后合轨，部分套件保持可续状态');
  } finally {
    socket.close();
  }
})().catch((error) => { console.error('FAIL:', error.message); process.exitCode = 1; });
