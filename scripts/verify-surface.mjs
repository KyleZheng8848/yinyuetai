#!/usr/bin/env node
/**
 * 终检三条表面：本地版本 = OSS latest.json = 下载页文案。
 * 不过 → 禁止对用户说「已经更新了」。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { resolveOssConfig } from './lib/oss.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function die(msg) {
  console.error(`[verify:surface] ${msg}`)
  process.exit(1)
}

let cfg
try {
  cfg = resolveOssConfig(root, { requireCredentials: false })
} catch (err) {
  die(err.message)
}

const { version, baseUrl } = cfg
let failed = 0

async function getText(url) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.text()
}

console.log(`[verify:surface] 本地 version = ${version}`)
console.log(`  下载页：${baseUrl}index.html`)
console.log(`  清单：${baseUrl}latest.json`)

try {
  const raw = await getText(`${baseUrl}latest.json`)
  const remote = JSON.parse(raw)
  if (remote.version !== version) {
    console.error(`  ✗ latest.json 版本 ${remote.version} ≠ 本地 ${version}`)
    failed++
  } else {
    console.log(`  ✓ latest.json = ${remote.version}`)
  }
  const assets = remote.assets || []
  const hasDmg = assets.some((a) => /arm64\.dmg$/i.test(a.name || a.url || ''))
  if (!hasDmg) {
    console.error('  ✗ latest.json 缺少 mac arm64 dmg')
    failed++
  } else {
    console.log('  ✓ latest.json 含 mac arm64 dmg')
  }
} catch (err) {
  console.error(`  ✗ 拉取 latest.json 失败：${err.message}`)
  failed++
}

try {
  const html = await getText(`${baseUrl}index.html`)
  if (!html.includes(version)) {
    console.error(`  ✗ index.html 未出现版本 ${version}`)
    failed++
  } else {
    console.log(`  ✓ index.html 含 ${version}`)
  }
  if (!/音悦台 Studio/i.test(html)) {
    console.error('  ✗ index.html 缺少品牌名')
    failed++
  } else {
    console.log('  ✓ index.html 含品牌名')
  }
} catch (err) {
  console.error(`  ✗ 拉取 index.html 失败：${err.message}`)
  failed++
}

try {
  const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
  if (!new RegExp(`^##\\s+${version.replace(/\./g, '\\.')}\\s+[—–-]`, 'm').test(changelog)) {
    console.error(`  ✗ CHANGELOG.md 缺少 ${version} 条目`)
    failed++
  } else {
    console.log(`  ✓ CHANGELOG.md 含 ${version}`)
  }
} catch {
  console.error('  ✗ 缺少 CHANGELOG.md')
  failed++
}

if (failed) die(`${failed} 项未通过 —— 禁止宣称更新完成`)
console.log('[verify:surface] OK')
