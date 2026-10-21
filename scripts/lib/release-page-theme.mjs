/** 子创的神奇口袋 · 统一发布页视觉（与各 app index.html 自包含内联） */

export const APP_ACCENTS = {
  cpet: '#14b37a',
  yinyuetai: '#e07a3d',
  musepaper: '#ed8c33',
  freeall: '#c9a25a',
  mas: '#4f8cff'
}

export function releasePageDecor() {
  return `<div class="sky" aria-hidden="true"></div>
<div class="orbs" aria-hidden="true"><i></i><i></i><i></i><i></i></div>`
}

export function releasePageCss(accent = '#14b37a') {
  return `
  :root {
    --ink: #163028;
    --muted: #5d7268;
    --paper: #fffdf8;
    --sky: #eef8f3;
    --peach: #fff3e4;
    --coral: #ff5a3c;
    --leaf: ${accent};
    --accent: ${accent};
    --accent-ink: #fff;
    --sun: #ffd36a;
    --line: rgba(22, 48, 40, 0.1);
    --shadow: 0 18px 40px rgba(44, 78, 62, 0.1);
    --panel: #fffdf8;
    --bg: transparent;
    --display: "Hiragino Maru Gothic ProN", "Yuanti SC", "Songti SC", "Iowan Old Style", serif;
    --sans: "Avenir Next", "PingFang SC", "Hiragino Sans GB", sans-serif;
    --mono: "SFMono-Regular", ui-monospace, Menlo, monospace;
  }
  * { box-sizing: border-box; }
  html { color-scheme: light; }
  html, body { margin: 0; min-height: 100%; }
  body {
    min-height: 100vh;
    color: var(--ink);
    font: 16px/1.65 var(--sans);
    background:
      radial-gradient(900px 420px at 12% -8%, rgba(20, 179, 122, 0.16), transparent 58%),
      radial-gradient(720px 380px at 100% 0%, rgba(255, 90, 60, 0.12), transparent 52%),
      linear-gradient(180deg, var(--sky) 0%, var(--peach) 46%, #fffaf2 100%);
  }
  .sky {
    position: fixed; inset: 0; pointer-events: none;
    background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.8' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%' height='100%' filter='url(%23n)' opacity='.18'/></svg>");
    opacity: 0.22; mix-blend-mode: multiply;
  }
  .orbs { position: fixed; inset: 0; pointer-events: none; overflow: hidden; }
  .orbs i {
    position: absolute; border-radius: 50%; filter: blur(2px);
    animation: pocket-float 9s ease-in-out infinite;
  }
  .orbs i:nth-child(1) { width: 18px; height: 18px; left: 12%; top: 18%; background: #ffd36a; }
  .orbs i:nth-child(2) { width: 12px; height: 12px; left: 78%; top: 14%; background: #14b37a; animation-delay: -2s; }
  .orbs i:nth-child(3) { width: 10px; height: 10px; left: 64%; top: 28%; background: #ff5a3c; animation-delay: -4s; }
  .orbs i:nth-child(4) { width: 14px; height: 14px; left: 22%; top: 36%; background: #7ad7ff; animation-delay: -1.4s; }
  @keyframes pocket-float {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(-14px); }
  }
  .page {
    position: relative; z-index: 1;
    width: min(760px, calc(100% - 40px));
    margin: 0 auto;
    padding: 36px 0 72px;
  }
  .app-head { margin-bottom: 8px; }
  .app-head-row { display: flex; align-items: center; gap: 16px; }
  .app-icon {
    width: 64px; height: 64px; border-radius: 18px; object-fit: cover;
    box-shadow: 0 8px 18px rgba(22, 48, 40, 0.12); background: #fff;
  }
  .kicker {
    margin: 0 0 6px;
    font: 700 11px/1 var(--mono);
    letter-spacing: 0.22em;
    color: var(--coral);
    text-transform: uppercase;
  }
  h1 {
    margin: 0;
    font: 750 34px/1.08 var(--display);
    letter-spacing: 0.02em;
  }
  .badge {
    display: inline-block; margin-left: 10px; padding: 3px 10px; border-radius: 999px;
    background: var(--ink); color: #fff8ee;
    font: 700 12px/1 var(--mono); vertical-align: middle;
  }
  .tagline, header .sub, .sub { color: var(--muted); margin: 6px 0 0; font-size: 14px; }
  .intro {
    margin: 16px 0 0; padding: 16px 18px; line-height: 1.75;
    background: color-mix(in srgb, var(--paper) 88%, white);
    border: 1px solid rgba(255,255,255,.7);
    border-radius: 20px;
    box-shadow: var(--shadow);
  }
  section { margin-top: 36px; }
  h2 {
    margin: 0 0 12px;
    font: 700 12px/1 var(--mono);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--muted);
  }
  .shots { display: grid; gap: 16px; }
  .shots figure {
    margin: 0; overflow: hidden; border-radius: 20px;
    border: 1px solid rgba(255,255,255,.7);
    background: color-mix(in srgb, var(--paper) 88%, white);
    box-shadow: var(--shadow);
  }
  .shots img { display: block; width: 100%; height: auto; }
  .shots figcaption { padding: 10px 14px; color: var(--muted); font-size: 13px; }
  .demos { display: grid; gap: 16px; }
  .demo {
    border-radius: 20px; padding: 14px; overflow: hidden;
    border: 1px solid rgba(255,255,255,.7);
    background: color-mix(in srgb, var(--paper) 88%, white);
    box-shadow: var(--shadow);
  }
  .demo video {
    display: block; width: 100%; max-height: 420px; border-radius: 12px;
    background: #000; aspect-ratio: 16 / 9; object-fit: contain;
  }
  .demo .cap { margin: 10px 2px 0; color: var(--muted); font-size: 13px; }
  .grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }
  .card {
    border-radius: 22px; padding: 18px;
    border: 1px solid rgba(255,255,255,.7);
    background: color-mix(in srgb, var(--paper) 88%, white);
    box-shadow: var(--shadow);
    position: relative; overflow: hidden;
  }
  .card::before {
    content: ""; position: absolute; width: 120px; height: 120px; right: -36px; top: -40px;
    border-radius: 50%; background: color-mix(in srgb, var(--accent) 18%, transparent);
  }
  .card.recommended { border-color: color-mix(in srgb, var(--accent) 45%, white); }
  .card-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 14px; position: relative; }
  .card-title { font-weight: 650; }
  .card-hint { color: var(--muted); font-size: 13px; }
  .fit {
    display: none; width: fit-content; margin: 0 0 10px;
    font: 700 11px/1 var(--mono); color: var(--accent-ink); background: var(--accent);
    border-radius: 999px; padding: 3px 9px;
  }
  .card.recommended .fit { display: inline-block; }
  .btn {
    display: flex; justify-content: space-between; align-items: center; gap: 8px;
    background: var(--accent); color: var(--accent-ink); text-decoration: none;
    padding: 11px 16px; border-radius: 999px; font-weight: 650;
  }
  .btn:hover { filter: brightness(1.05); }
  .size { font-weight: 400; opacity: .88; font-size: 13px; }
  .alt { display: block; margin-top: 10px; color: var(--muted); font-size: 13px; text-decoration: none; }
  .alt:hover { color: var(--coral); }
  ul { margin: 0; padding-left: 20px; }
  li { margin-bottom: 6px; }
  code, pre { font-family: var(--mono); font-size: 13px; }
  pre {
    background: rgba(255,255,255,.72); border: 1px solid var(--line); border-radius: 14px;
    padding: 12px 14px; overflow-x: auto; margin: 10px 0 0;
  }
  .note, .panel {
    border-radius: 20px; padding: 18px;
    border: 1px solid rgba(255,255,255,.7);
    background: color-mix(in srgb, var(--paper) 88%, white);
    box-shadow: var(--shadow);
  }
  .muted { color: var(--muted); }
  .history { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
  .history li {
    display: grid; grid-template-columns: 88px 1fr; gap: 10px 14px; align-items: start;
    padding-bottom: 10px; border-bottom: 1px dashed var(--line);
  }
  .history li:last-child { padding-bottom: 0; border-bottom: 0; }
  .hv {
    font: 12px/1.4 var(--mono); color: var(--muted);
    display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding-top: 4px;
  }
  .hv .now {
    font-size: 11px; padding: 2px 7px; border-radius: 999px;
    background: var(--coral); color: #fff; font-weight: 700;
  }
  .hfiles { display: flex; flex-wrap: wrap; gap: 8px; }
  .hchip {
    display: inline-flex; align-items: baseline; gap: 6px;
    padding: 4px 10px; border-radius: 999px; border: 1px solid var(--line);
    background: rgba(255,255,255,.72);
    color: var(--accent); text-decoration: none; font-size: 13px; white-space: nowrap;
  }
  .hchip:hover { border-color: var(--accent); color: var(--coral); }
  .hchip .size { color: var(--muted); font-size: 12px; }
  .packs { display: grid; gap: 10px; }
  .pack {
    display: grid; grid-template-columns: 1fr auto; gap: 8px 12px; align-items: baseline;
    padding-bottom: 10px; border-bottom: 1px dashed var(--line);
  }
  .pack:last-child { padding-bottom: 0; border-bottom: 0; }
  .page-foot { margin-top: 48px; color: var(--muted); font-size: 13px; }
  .page-foot p { margin: 0 0 8px; }
  .page-foot a { color: var(--coral); }
  .hub-back { font: 700 12px/1 var(--mono); letter-spacing: 0.06em; text-decoration: none; }
  @media (max-width: 520px) {
    h1 { font-size: 28px; }
    .history li { grid-template-columns: 1fr; gap: 6px; }
    .pack { grid-template-columns: 1fr; }
  }
  @media (prefers-reduced-motion: reduce) {
    .orbs i { animation: none; }
  }
`
}

export function releaseAppHeader({ titleHtml, appName, version, tagline, date, iconUrl, esc }) {
  const title = titleHtml || esc(appName)
  const dateBit = date ? ` · 发布于 ${esc(date)}` : ''
  return `<header class="app-head">
    <div class="app-head-row">
      ${iconUrl ? `<img class="app-icon" src="${esc(iconUrl)}" alt="">` : ''}
      <div>
        <p class="kicker">子创的神奇口袋 · 发布页</p>
        <h1>${title}<span class="badge">${esc(version)}</span></h1>
        <p class="tagline sub">${esc(tagline)}${dateBit}</p>
      </div>
    </div>
  </header>`
}

export function releaseHubFooter({ manifestUrl, hubUrl = process.env.YINYUETAI_HUB_URL || '', extraHtml = '', esc }) {
  return `<footer class="page-foot">
    ${hubUrl ? `<p><a class="hub-back" href="${esc(hubUrl)}">← 回到子创的神奇口袋</a></p>` : ''}
    ${manifestUrl ? `<p>更新清单：<a href="${esc(manifestUrl)}">latest.json</a></p>` : ''}
    ${extraHtml}
  </footer>`
}
