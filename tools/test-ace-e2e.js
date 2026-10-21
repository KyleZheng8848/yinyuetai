/* Optional heavy smoke test: run against an isolated Chromium profile and an already-running local ACE engine. */
'use strict';

const port = Number(process.argv[2] || 9230);
const TITLE = 'ACE 流程验收样本';
const LYRICS = ['Intro', 'Verse 1', 'Pre-Chorus', 'Chorus 1', 'Verse 2', 'Chorus 2', 'Bridge', 'Outro']
  .map((tag, index) => `[${tag}]\n第${index + 1}段晚风经过\n第${index + 1}段灯火还在`).join('\n\n');

async function connect() {
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = pages.find((item) => item.type === 'page' && /音悦台 Studio/.test(item.title));
  if (!page) throw new Error(`端口 ${port} 没有音悦台页面`);
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else if (message.result?.exceptionDetails) request.reject(new Error(message.result.exceptionDetails.text));
    else request.resolve(message.result);
  });
  return {
    socket,
    call: (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    }),
  };
}

(async () => {
  const { socket, call } = await connect();
  const evaluate = async (expression) => {
    const response = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
    return response.result?.value;
  };
  try {
    const setup = await evaluate(`(async () => {
      const set = (id, value) => { const input = document.getElementById(id); input.value = String(value); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); };
      set('model', 'ace-step-1.5');
      await new Promise((resolve) => setTimeout(resolve, 150));
      set('ace-long-mode', 'compat');
      set('song-title', ${JSON.stringify(TITLE)});
      set('prompt', '忧伤但温柔的华语民谣，男声清晰靠前，钢琴和木吉他支撑旋律，副歌逐渐加入轻弦乐，段落间保留呼吸感，结尾收束。');
      set('tags', 'sad pop, folk rock, clear male vocal, piano, acoustic guitar, restrained strings');
      set('lyrics', ${JSON.stringify(LYRICS)});
      set('creation-album', '验收测试');
      set('duration-val', 120);
      set('steps-val', 8);
      set('cfg-val', 2);
      set('seed', 420260915);
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { model: document.getElementById('model').value, mode: document.getElementById('ace-long-mode').value, count: document.getElementById('ace-segment-count').textContent, duration: document.getElementById('duration-val').value };
    })()`);
    console.log('[setup]', JSON.stringify(setup));
    if (setup.model !== 'ace-step-1.5' || setup.mode !== 'compat' || !/4/.test(setup.count)) {
      throw new Error('验收前未显示四段规划');
    }
    const submitted = await evaluate(`(() => { document.getElementById('generate').click(); return [...document.querySelectorAll('.queue-job')].map((job) => ({ title: job.querySelector('strong')?.textContent, status: job.className })); })()`);
    console.log('[submitted]', JSON.stringify(submitted));
    if (submitted.length !== 4) throw new Error(`预期四段队列，实际 ${submitted.length}`);

    const deadline = Date.now() + 15 * 60 * 1000;
    let last = '';
    while (Date.now() < deadline) {
      const snapshot = await evaluate(`(async () => {
        const jobs = [...document.querySelectorAll('.queue-job')].map((job) => ({ title: job.querySelector('strong')?.textContent, state: job.querySelector('.queue-state span')?.textContent, detail: job.querySelector('.queue-copy span')?.textContent }));
        const tracks = await LibraryStore.list();
        const whole = tracks.find((track) => track.title === ${JSON.stringify(TITLE)} && track.suiteAssembled);
        return { jobs, whole: whole ? { title: whole.title, album: whole.album, duration: whole.duration, bytes: whole.blob?.size, segmentCount: whole.generation?.output?.metadata?.segmentCount } : null, leftoverParts: tracks.filter((track) => track.suitePart && track.suiteTitle === ${JSON.stringify(TITLE)}).length };
      })()`);
      const compact = snapshot.jobs.map((job) => job.state).join(' / ');
      if (compact !== last) { console.log('[queue]', compact); last = compact; }
      if (snapshot.jobs.some((job) => /失败/.test(job.state))) throw new Error(`队列失败：${JSON.stringify(snapshot.jobs)}`);
      if (snapshot.whole) {
        console.log('[whole]', JSON.stringify(snapshot.whole), 'leftoverParts=', snapshot.leftoverParts);
        if (snapshot.whole.duration < 100 || snapshot.whole.duration > 130 || snapshot.whole.segmentCount !== 4 || snapshot.leftoverParts !== 0) {
          throw new Error('合轨结果的时长、段数或缓存清理不正确');
        }
        console.log('PASS: 四段真实生成、自动合轨并存入隔离曲库');
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    throw new Error('15 分钟内没有得到完整合轨歌曲');
  } finally {
    socket.close();
  }
})().catch((error) => { console.error('FAIL:', error.message); process.exitCode = 1; });
