#!/usr/bin/env node
/**
 * 把当前版本发布到 OSS：上传安装包 → 固定名 → latest.json → index.html。
 * 顺序固定：包全部传完 → 最后覆盖 latest.json（避免中间窗口 404）。
 *
 * 用法：
 *   node scripts/publish-release.mjs
 *   node scripts/publish-release.mjs --dry-run
 *   node scripts/publish-release.mjs --backfill
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { OssClient, resolveOssConfig } from './lib/oss.mjs'
import { changelogHighlights, DOWNLOAD_SCREENSHOTS, renderDownloadPage } from './lib/download-page.mjs'
import {
  ARTIFACT_RE,
  compareVersions,
  groupRemoteArtifacts,
  historyEntries,
  stableName
} from './lib/release-index.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dryRun = process.argv.includes('--dry-run') || process.argv.includes('-n')
const backfill = process.argv.includes('--backfill')

function die(msg) {
  console.error(`[publish-release] ${msg}`)
  process.exit(1)
}

let cfg
try {
  cfg = resolveOssConfig(root)
} catch (err) {
  die(err.message)
}
const { yy, version, bucket, keyPrefix, endpoint, baseUrl, accessKeyId, accessKeySecret, keep, releaseDirName } =
  cfg
const releaseDir = join(root, releaseDirName)

if (!existsSync(releaseDir)) die(`没有 ${releaseDirName}/ 目录，先打包。`)

const uploads = readdirSync(releaseDir)
  .filter((name) => {
    const hit = ARTIFACT_RE.exec(name)
    if (!hit || hit[1] !== version) return false
    try {
      return statSync(join(releaseDir, name)).size > 0
    } catch {
      return false
    }
  })
  .sort()
if (!uploads.length) die(`${releaseDirName}/ 里没有 ${version} 的安装包，先跑 npm run dist。`)

const hasMacArmDmg = uploads.some((n) => /mac-arm64\.dmg$/i.test(n) || (/arm64\.dmg$/i.test(n) && !/x64/i.test(n)))
if (!hasMacArmDmg) die(`缺少 mac arm64 DMG（当前至少要求这一端）。已有：${uploads.join(', ')}`)

const oss = new OssClient({
  bucket,
  endpoint,
  accessKeyId,
  accessKeySecret,
  onRetry: ({ key, attempt, waitMs, error }) =>
    console.log(`\n    ${key} 第 ${attempt} 次重试（${error.message}），等 ${waitMs / 1000}s`)
})
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`

console.log(`[publish-release] ${version} → oss://${bucket}/${keyPrefix}${dryRun ? '（dry-run）' : ''}`)

async function upload(name, label = '上传') {
  const path = join(releaseDir, name)
  const size = statSync(path).size
  if (dryRun) {
    console.log(`  [dry-run] ${label} ${name}  ${mb(size)}`)
    return
  }
  process.stdout.write(`  ${label} ${name}  ${mb(size)} … `)
  const started = Date.now()
  await oss.putFile(path, `${keyPrefix}${name}`)
  console.log(`完成（${((Date.now() - started) / 1000).toFixed(1)}s）`)
}

if (backfill) {
  let existing = []
  try {
    existing = await oss.list(keyPrefix)
  } catch (err) {
    die(`列不出远端对象：${err.message}`)
  }
  const remoteSize = new Map()
  for (const { key, size } of existing) {
    remoteSize.set(key.startsWith(keyPrefix) ? key.slice(keyPrefix.length) : key, size)
  }

  const localByVersion = new Map()
  for (const name of readdirSync(releaseDir)) {
    const hit = ARTIFACT_RE.exec(name)
    if (!hit || hit[1] === version) continue
    if (!localByVersion.has(hit[1])) localByVersion.set(hit[1], [])
    localByVersion.get(hit[1]).push(name)
  }

  const survivors = [...localByVersion.keys()]
    .sort(compareVersions)
    .reverse()
    .slice(0, Math.max(keep - 1, 0))

  const pending = []
  for (const v of survivors) {
    for (const name of localByVersion.get(v).sort()) {
      const local = statSync(join(releaseDir, name)).size
      if (local <= 0) continue
      if (remoteSize.get(name) === local) continue
      pending.push(name)
    }
  }

  if (!pending.length) {
    console.log('  历史版本已经齐了，无需补传。')
  } else {
    console.log(`  补传 ${pending.length} 个历史文件`)
    for (const name of pending) await upload(name, '补传')
  }
}

for (const name of uploads) await upload(name)

const stableOf = new Map(uploads.map((name) => [name, stableName(name)]))
for (const [name, alias] of stableOf) {
  if (alias === name) continue
  if (dryRun) {
    console.log(`  [dry-run] 固定名 ${alias} → ${name}`)
    continue
  }
  await oss.copy(`${keyPrefix}${name}`, `${keyPrefix}${alias}`)
  console.log(`  固定名 ${alias} → ${name}`)
}

console.log('  生成 latest.json（先本地）')
const gen = spawnSync(process.execPath, [join(root, 'scripts', 'gen-update-manifest.mjs')], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, YINYUETAI_DOWNLOAD_BASE_URL: baseUrl }
})
if (gen.status !== 0) die('生成 latest.json 失败。')

if (!dryRun) {
  console.log('  远端可用性预检（尚未切换 latest.json）…')
  const verify = spawnSync(
    process.execPath,
    [
      join(root, 'scripts', 'verify-published.mjs'),
      '--version',
      version,
      '--manifest-file',
      join(releaseDir, 'latest.json'),
      '--skip-stables'
    ],
    {
      cwd: root,
      stdio: 'inherit',
      env: (() => {
        const e = { ...process.env, YINYUETAI_DOWNLOAD_BASE_URL: baseUrl }
        delete e.ELECTRON_RUN_AS_NODE
        return e
      })()
    }
  )
  if (verify.status !== 0) {
    die('可用性预检失败：未覆盖 latest.json。修好后重跑。')
  }
  await oss.putFile(join(releaseDir, 'latest.json'), `${keyPrefix}latest.json`)
  console.log('  上传 latest.json')
} else {
  console.log('  [dry-run] 跳过远端可用性验收')
}

let remoteItems = []
try {
  remoteItems = await oss.list(keyPrefix)
} catch (err) {
  console.warn(`  ⚠️ 列不出远端对象：${err.message}`)
}

const grouped = groupRemoteArtifacts(remoteItems, keyPrefix)
// 把刚上传的当前版并进历史（list 可能因一致性延迟缺项）
if (!grouped.byVersion.has(version)) {
  grouped.byVersion.set(
    version,
    uploads
      .filter((n) => /\.(dmg|exe|AppImage)$/i.test(n))
      .map((name) => ({ name, size: statSync(join(releaseDir, name)).size }))
  )
  grouped.versions = [...new Set([version, ...grouped.versions])].sort(compareVersions).reverse()
}
const history = historyEntries(grouped, { limit: keep, baseUrl })

{
  const manifest = JSON.parse(readFileSync(join(releaseDir, 'latest.json'), 'utf8'))
  const stableUrl = (name) => `${baseUrl}${stableOf.get(name) ?? stableName(name)}`
  const iconLocal = join(root, 'assets', 'icon.png')
  const iconKey = `${keyPrefix}assets/icon.png`
  if (!dryRun && existsSync(iconLocal)) await oss.putFile(iconLocal, iconKey)

  let changelog = ''
  try {
    changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
  } catch {
    /* optional */
  }

  const screenshots = []
  for (const shot of DOWNLOAD_SCREENSHOTS) {
    const local = join(root, shot.localRel)
    if (!existsSync(local)) continue
    if (!dryRun) await oss.putFile(local, `${keyPrefix}assets/screenshots/${shot.remoteName}`)
    screenshots.push({
      url: `${baseUrl}assets/screenshots/${shot.remoteName}?v=${version}`,
      alt: shot.alt,
      caption: shot.caption
    })
  }

  const html = renderDownloadPage({
    version,
    publishedAt: manifest.publishedAt,
    assets: manifest.assets,
    highlights: changelogHighlights(changelog, version),
    manifestUrl: yy.updateManifest || `${baseUrl}latest.json`,
    iconUrl: `${baseUrl}assets/icon.png`,
    stableUrl,
    history,
    screenshots
  })
  const htmlPath = join(releaseDir, 'index.html')
  writeFileSync(htmlPath, html)
  if (dryRun) {
    console.log(`  [dry-run] 写出本地 ${htmlPath}`)
  } else {
    await oss.putFile(htmlPath, `${keyPrefix}index.html`)
    console.log(`  上传 index.html → ${baseUrl}index.html`)
  }
}

if (!dryRun) {
  console.log('  最终验收…')
  const verify = spawnSync(process.execPath, [join(root, 'scripts', 'verify-published.mjs')], {
    cwd: root,
    stdio: 'inherit',
    env: (() => {
      const e = { ...process.env }
      delete e.ELECTRON_RUN_AS_NODE
      return e
    })()
  })
  if (verify.status !== 0) die('最终验收失败。')
}

// 超出 keep 的远端版本清理（只删版本化安装包，不动 latest / index / assets）
{
  const excess = grouped.versions.slice(keep)
  for (const v of excess) {
    for (const f of grouped.byVersion.get(v) || []) {
      if (dryRun) {
        console.log(`  [dry-run] 删远端 ${f.name}`)
        continue
      }
      await oss.remove(`${keyPrefix}${f.name}`)
      console.log(`  删远端旧包 ${f.name}`)
    }
  }
}

console.log(`[publish-release] 完成 ${version}`)
console.log(`  下载页：${baseUrl}index.html`)
console.log(`  清单：${baseUrl}latest.json`)
