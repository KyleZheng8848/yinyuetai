#!/usr/bin/env node
/**
 * 验收已发布（或即将发布）的安装包与清单是否可匿名下载。
 *
 * 用法：
 *   node scripts/verify-published.mjs
 *   node scripts/verify-published.mjs --version 1.15.10 --manifest-file dist/latest.json --skip-stables
 */
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { resolveOssConfig } from './lib/oss.mjs'
import { stableName } from './lib/release-index.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
function flag(name) {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : null
}
const skipStables = args.includes('--skip-stables')

function die(msg) {
  console.error(`[verify-published] ${msg}`)
  process.exit(1)
}

let cfg
try {
  cfg = resolveOssConfig(root, { requireCredentials: false })
} catch (err) {
  die(err.message)
}

const version = flag('--version') || cfg.version
const manifestFile =
  flag('--manifest-file') || join(root, cfg.releaseDirName, 'latest.json')
const { baseUrl } = cfg

async function head(url) {
  const res = await fetch(url, { method: 'HEAD', redirect: 'follow' })
  return { ok: res.ok, status: res.status, size: Number(res.headers.get('content-length') || 0) }
}

if (!existsSync(manifestFile)) die(`找不到清单：${manifestFile}`)
const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
if (manifest.version !== version) {
  die(`清单版本 ${manifest.version} ≠ 期望 ${version}`)
}

const assets = Array.isArray(manifest.assets) ? manifest.assets : []
if (!assets.length) die('清单没有 assets')

let failed = 0
for (const a of assets) {
  const url = a.url || `${baseUrl}${a.name}`
  process.stdout.write(`  HEAD ${a.name} … `)
  try {
    const r = await head(url)
    if (!r.ok) {
      console.log(`失败 ${r.status}`)
      failed++
      continue
    }
    if (a.size && r.size && Math.abs(r.size - a.size) > 1024) {
      console.log(`大小不符 local=${a.size} remote=${r.size}`)
      failed++
      continue
    }
    console.log(`OK ${r.size || a.size || ''}`.trim())
  } catch (err) {
    console.log(`错误 ${err.message}`)
    failed++
  }
}

if (!skipStables) {
  for (const a of assets) {
    const alias = stableName(a.name)
    if (alias === a.name) continue
    const url = `${baseUrl}${alias}`
    process.stdout.write(`  HEAD ${alias} … `)
    try {
      const r = await head(url)
      if (!r.ok) {
        console.log(`失败 ${r.status}`)
        failed++
      } else console.log('OK')
    } catch (err) {
      console.log(`错误 ${err.message}`)
      failed++
    }
  }

  for (const name of ['latest.json', 'index.html']) {
    const url = `${baseUrl}${name}`
    process.stdout.write(`  HEAD ${name} … `)
    try {
      const r = await head(url)
      if (!r.ok) {
        console.log(`失败 ${r.status}`)
        failed++
      } else console.log('OK')
    } catch (err) {
      console.log(`错误 ${err.message}`)
      failed++
    }
  }
}

if (failed) die(`${failed} 项失败`)
console.log(`[verify-published] OK · ${version}`)
