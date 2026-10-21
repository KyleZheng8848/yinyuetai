#!/usr/bin/env node
/** 只根据 OSS 现状重新生成并上传 index.html（不动安装包和 latest.json） */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OssClient, resolveOssConfig } from './lib/oss.mjs'
import { changelogHighlights, DOWNLOAD_SCREENSHOTS, renderDownloadPage } from './lib/download-page.mjs'
import { groupRemoteArtifacts, historyEntries, stableName } from './lib/release-index.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const cfg = resolveOssConfig(root)
const { keyPrefix, baseUrl, accessKeyId, accessKeySecret, bucket, endpoint, keep, yy } = cfg
const oss = new OssClient({ bucket, endpoint, accessKeyId, accessKeySecret })
const grouped = groupRemoteArtifacts(await oss.list(keyPrefix), keyPrefix)
if (!grouped.versions.length) throw new Error(`${baseUrl} 下没有任何安装包`)

const version = grouped.versions[0]
const assets = grouped.byVersion
  .get(version)
  .filter((f) => !f.name.endsWith('.blockmap'))
  .sort((a, b) => a.name.localeCompare(b.name))
const history = historyEntries(grouped, { limit: keep, baseUrl })
const publishedAt = assets
  .map((f) => f.lastModified)
  .filter(Boolean)
  .sort()
  .pop()

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
  await oss.putFile(local, `${keyPrefix}assets/screenshots/${shot.remoteName}`)
  console.log(`[refresh-download-page] 界面截图已上传：${baseUrl}assets/screenshots/${shot.remoteName}`)
  screenshots.push({
    url: `${baseUrl}assets/screenshots/${shot.remoteName}?v=${version}`,
    alt: shot.alt,
    caption: shot.caption
  })
}

const html = renderDownloadPage({
  version,
  publishedAt,
  assets: assets.map((a) => ({ ...a, url: `${baseUrl}${a.name}` })),
  highlights: changelogHighlights(changelog, version),
  manifestUrl: yy.updateManifest || `${baseUrl}latest.json`,
  iconUrl: `${baseUrl}assets/icon.png`,
  history,
  screenshots,
  stableUrl: (name) => `${baseUrl}${stableName(name)}`
})

const releaseDir = join(root, 'release')
mkdirSync(releaseDir, { recursive: true })
const pagePath = join(releaseDir, 'index.html')
writeFileSync(pagePath, html)
await oss.putFile(pagePath, `${keyPrefix}index.html`)
console.log(`[refresh-download-page] 已上传 ${baseUrl}index.html（${version}）`)
