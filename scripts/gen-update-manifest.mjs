#!/usr/bin/env node
/**
 * 从 package.json + dist/ 真实产物生成 dist/latest.json。
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { loadEnvLocal } from './lib/oss.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
loadEnvLocal(join(root, '.env.local'))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = pkg.version
const yy = pkg.yinyuetai ?? {}
const releaseDir = join(root, yy.releaseDir || 'dist')

if (!existsSync(releaseDir)) {
  console.error('[gen-update-manifest] 没有 dist/ 目录，先打包再生成清单。')
  process.exit(1)
}

const INSTALLER_RE = /\.(dmg|exe|AppImage)$/i
const ZIP_RE = /\.zip$/i

function collectAssets() {
  const out = []
  for (const name of readdirSync(releaseDir)) {
    if (!name.includes(version)) continue
    if (name.endsWith('.blockmap')) continue
    if (!INSTALLER_RE.test(name) && !ZIP_RE.test(name)) continue
    let st
    try {
      st = statSync(join(releaseDir, name))
    } catch {
      continue
    }
    if (!st.isFile() || st.size === 0) continue
    out.push({ name, size: st.size })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

const found = collectAssets()
if (!found.length) {
  console.error(`[gen-update-manifest] dist/ 里没有 ${version} 的安装包。先跑 npm run dist。`)
  process.exit(1)
}

const base = (process.env.YINYUETAI_DOWNLOAD_BASE_URL || yy.downloadBaseUrl || '').trim()
if (!base) {
  console.error('[gen-update-manifest] 缺少 downloadBaseUrl。')
  process.exit(1)
}
const prefix = base.endsWith('/') ? base : `${base}/`
const page = (process.env.YINYUETAI_DOWNLOAD_PAGE || yy.downloadPage || '').trim()

const manifest = {
  version,
  ...(page ? { releasesUrl: page } : {}),
  publishedAt: new Date().toISOString(),
  assets: found.map((f) => ({
    name: f.name,
    url: prefix + encodeURIComponent(f.name),
    size: f.size
  }))
}

const outPath = join(releaseDir, 'latest.json')
writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`[gen-update-manifest] 已写出 ${outPath}（版本 ${version}）`)
for (const a of manifest.assets) {
  console.log(`  - ${a.name}  ${(a.size / 1024 / 1024).toFixed(1)} MB`)
}
