/**
 * 极小的阿里云 OSS 客户端：签名 + 上传 / 列举 / 删除 / 复制。
 * 密钥只从环境变量 / .env.local 读，绝不写进仓库。
 */
import { createHmac } from 'node:crypto'
import { createReadStream, readFileSync, statSync } from 'node:fs'
import { request } from 'node:https'
import { basename, join } from 'node:path'

export function loadEnvLocal(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return
  }
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (!s || s.startsWith('#')) continue
    const eq = s.indexOf('=')
    if (eq <= 0) continue
    const key = s.slice(0, eq).trim()
    let value = s.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (!(key in process.env)) process.env[key] = value
  }
}

/**
 * 解析发布配置（package.json 的 yinyuetai.* + 环境变量 + .env.local）。
 * @param {string} root
 * @param {{requireCredentials?:boolean}} opts
 */
export function resolveOssConfig(root, { requireCredentials = true } = {}) {
  loadEnvLocal(join(root, '.env.local'))
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const yy = pkg.yinyuetai ?? {}

  const target = String(process.env.YINYUETAI_OSS_TARGET || yy.ossTarget || '').trim()
  const m = /^oss:\/\/([^/]+)\/?(.*)$/.exec(target)
  if (!m) {
    throw new Error(
      '缺少上传目标。package.json 加 "yinyuetai": { "ossTarget": "oss://<bucket>/<前缀>/" }'
    )
  }
  const endpoint = String(process.env.YINYUETAI_OSS_ENDPOINT || yy.ossEndpoint || '').trim()
  if (!endpoint) {
    throw new Error('缺少 OSS endpoint（yinyuetai.ossEndpoint）。')
  }
  const baseUrl = String(process.env.YINYUETAI_DOWNLOAD_BASE_URL || yy.downloadBaseUrl || '').trim()
  if (!baseUrl) throw new Error('缺少 downloadBaseUrl。')

  const accessKeyId = String(process.env.OSS_ACCESS_KEY_ID || '').trim()
  const accessKeySecret = String(process.env.OSS_ACCESS_KEY_SECRET || '').trim()
  if (requireCredentials && (!accessKeyId || !accessKeySecret)) {
    throw new Error(
      '缺少 OSS 密钥。写进 .env.local：\n  OSS_ACCESS_KEY_ID=...\n  OSS_ACCESS_KEY_SECRET=...'
    )
  }

  const n = Number.parseInt(String(yy.keepReleases ?? ''), 10)
  return {
    pkg,
    yy,
    version: pkg.version,
    bucket: m[1],
    keyPrefix: m[2] ? (m[2].endsWith('/') ? m[2] : `${m[2]}/`) : '',
    endpoint,
    baseUrl: baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`,
    accessKeyId,
    accessKeySecret,
    keep: Number.isFinite(n) && n > 0 ? n : 20,
    releaseDirName: yy.releaseDir || 'dist'
  }
}

const MIME = {
  '.dmg': 'application/x-apple-diskimage',
  '.zip': 'application/zip',
  '.exe': 'application/vnd.microsoft.portable-executable',
  '.AppImage': 'application/octet-stream',
  '.json': 'application/json',
  '.blockmap': 'application/octet-stream',
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.txt': 'text/plain; charset=utf-8'
}

function contentTypeFor(name) {
  const dot = name.lastIndexOf('.')
  return (dot >= 0 && MIME[name.slice(dot)]) || 'application/octet-stream'
}

function isTransient(err) {
  const s = `${err?.code ?? ''} ${err?.message ?? ''}`
  return /ECONNRESET|EPIPE|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket hang up|RequestTimeout|InternalError|ServiceUnavailable|SlowDown|\b5\d\d\b/i.test(
    s
  )
}

function sign({ secret, method, contentMd5 = '', contentType = '', date, ossHeaders = {}, resource }) {
  const canonHeaders = Object.keys(ossHeaders)
    .map((k) => k.toLowerCase())
    .sort()
    .map((k) => `${k}:${ossHeaders[Object.keys(ossHeaders).find((x) => x.toLowerCase() === k)]}\n`)
    .join('')
  const raw = [method, contentMd5, contentType, date, `${canonHeaders}${resource}`].join('\n')
  return createHmac('sha1', secret).update(raw, 'utf8').digest('base64')
}

export class OssClient {
  constructor(cfg) {
    this.bucket = cfg.bucket
    this.endpoint = cfg.endpoint
    this.ak = cfg.accessKeyId
    this.sk = cfg.accessKeySecret
    this.host = `${cfg.bucket}.${cfg.endpoint}`
    this.onRetry = cfg.onRetry
  }

  publicUrl(key) {
    return `https://${this.host}/${key.split('/').map(encodeURIComponent).join('/')}`
  }

  #send({ method, key, query = '', headers = {}, body = null, ossHeaders = {} }) {
    const date = new Date().toUTCString()
    const contentType = headers['Content-Type'] || ''
    const resource = `/${this.bucket}/${key}`
    const signature = sign({
      secret: this.sk,
      method,
      contentType,
      date,
      ossHeaders,
      resource
    })
    const path = `/${key.split('/').map(encodeURIComponent).join('/')}${query}`
    const opts = {
      host: this.host,
      method,
      path,
      headers: {
        ...headers,
        ...ossHeaders,
        Date: date,
        Authorization: `OSS ${this.ak}:${signature}`
      }
    }
    return new Promise((resolve, reject) => {
      const req = request(opts, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          if (res.statusCode >= 200 && res.statusCode < 300) resolve({ status: res.statusCode, text })
          else {
            const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? String(res.statusCode)
            const msg = /<Message>([^<]+)<\/Message>/.exec(text)?.[1] ?? text.slice(0, 200)
            reject(new Error(`OSS ${method} ${key || '/'} 失败：${code} —— ${msg}`))
          }
        })
      })
      req.on('error', reject)
      if (body && typeof body.pipe === 'function') {
        body.on('error', (err) => {
          req.destroy()
          reject(err)
        })
        body.pipe(req)
      } else req.end(body ?? undefined)
    })
  }

  async putFile(localPath, key, { acl = 'public-read', onProgress, retries = 4 } = {}) {
    const size = statSync(localPath).size
    const contentType = contentTypeFor(basename(localPath))
    for (let attempt = 1; ; attempt++) {
      const stream = createReadStream(localPath)
      if (onProgress) {
        let sent = 0
        stream.on('data', (c) => {
          sent += c.length
          onProgress(sent, size)
        })
      }
      try {
        await this.#send({
          method: 'PUT',
          key,
          headers: { 'Content-Type': contentType, 'Content-Length': String(size) },
          ossHeaders: acl ? { 'x-oss-object-acl': acl } : {},
          body: stream
        })
        return { size, url: this.publicUrl(key) }
      } catch (err) {
        stream.destroy()
        if (attempt > retries || !isTransient(err)) throw err
        const waitMs = Math.min(2000 * attempt, 10_000)
        this.onRetry?.({ key, attempt, waitMs, error: err })
        await new Promise((r) => setTimeout(r, waitMs))
      }
    }
  }

  async putText(text, key, { acl = 'public-read', contentType = 'text/plain; charset=utf-8' } = {}) {
    const body = Buffer.from(text, 'utf8')
    await this.#send({
      method: 'PUT',
      key,
      headers: { 'Content-Type': contentType, 'Content-Length': String(body.length) },
      ossHeaders: acl ? { 'x-oss-object-acl': acl } : {},
      body
    })
    return this.publicUrl(key)
  }

  async copy(srcKey, dstKey, { acl = 'public-read' } = {}) {
    await this.#send({
      method: 'PUT',
      key: dstKey,
      ossHeaders: {
        'x-oss-copy-source': `/${this.bucket}/${srcKey}`,
        ...(acl ? { 'x-oss-object-acl': acl } : {})
      }
    })
    return this.publicUrl(dstKey)
  }

  async list(prefix) {
    const items = []
    let marker = ''
    for (;;) {
      const query =
        `?prefix=${encodeURIComponent(prefix)}&max-keys=1000` +
        (marker ? `&marker=${encodeURIComponent(marker)}` : '')
      const { text } = await this.#send({ method: 'GET', key: '', query })
      for (const c of text.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const key = /<Key>([^<]+)<\/Key>/.exec(c[1])?.[1]
        if (!key) continue
        items.push({
          key,
          size: Number.parseInt(/<Size>(\d+)<\/Size>/.exec(c[1])?.[1] ?? '0', 10),
          lastModified: /<LastModified>([^<]+)<\/LastModified>/.exec(c[1])?.[1] ?? ''
        })
      }
      if (!/<IsTruncated>true<\/IsTruncated>/.test(text)) break
      marker = items[items.length - 1]?.key
      if (!marker) break
    }
    return items
  }

  async remove(key) {
    await this.#send({ method: 'DELETE', key })
  }
}
