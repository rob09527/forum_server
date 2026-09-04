import {
  NODELOC_BASE_URL,
  IMPORT_USER_AGENT,
  REQUEST_MIN_INTERVAL_MS,
  ASSET_MIN_INTERVAL_MS,
  MAX_IMAGE_REDIRECTS,
} from './import-config.js'

/** NodeLoc 资源允许访问的协议与主机，禁止导入数据把服务端变成 SSRF 代理。 */
const NODELOC_URL = new URL(NODELOC_BASE_URL)

function assertAllowedNodelocUrl(url: string): string {
  const absolute = new URL(url, NODELOC_BASE_URL)
  // origin 比 hostname 更严格：同时锁定协议、主机和端口，并拒绝 userinfo 伪装。
  if (absolute.origin !== NODELOC_URL.origin || absolute.username || absolute.password) {
    throw new Error(`[import] 拒绝访问非 NodeLoc 资源: ${url}`)
  }
  return absolute.toString()
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/** 手动跟随重定向，每一跳都重新执行主机白名单校验，避免 fetch 自动跟随造成 SSRF 绕过。 */
async function fetchNodelocResponse(
  initialUrl: string,
  init: RequestInit,
): Promise<Response> {
  let currentUrl = assertAllowedNodelocUrl(initialUrl)
  for (let redirect = 0; ; redirect += 1) {
    const response = await fetch(currentUrl, { ...init, redirect: 'manual' })
    if (!REDIRECT_STATUSES.has(response.status)) return response
    if (redirect >= MAX_IMAGE_REDIRECTS) {
      throw new Error(`[import] 重定向次数超过上限: ${initialUrl}`)
    }
    const location = response.headers.get('location')
    if (!location) throw new Error(`[import] 重定向缺少 Location: ${currentUrl}`)
    currentUrl = assertAllowedNodelocUrl(new URL(location, currentUrl).toString())
  }
}

/** 在不预先信任 Content-Length 的情况下读取响应，并限制内存上界。 */
async function readBodyWithinLimit(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Buffer | null> {
  if (!body) return null
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        return null
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total)
}

/**
 * NodeLoc(Discourse)匿名 JSON API 客户端。
 * - 全局限速:进程内串行排队,两次请求间隔 ≥ REQUEST_MIN_INTERVAL_MS(≤1 req/s 决策)
 * - 失败退避:429/5xx/网络错误按 5s→15s→45s 重试三次,仍失败抛错由调用方决定跳过或中止
 * - 404/403 不重试(帖子被删/无权限,直接返回 null 让调用方跳过)
 */

/** 上一次 JSON 接口请求发出的时间戳,用于全局限速 */
let lastRequestAt = 0
/** JSON 接口串行队列尾部 promise,保证并发调用也按序限速 */
let queueTail: Promise<unknown> = Promise.resolve()

/** 静态资源(图片)独立限速游标:走 Cloudflare 缓存,与接口分账(见 import-config) */
let lastAssetAt = 0
/** 静态资源串行队列尾部 */
let assetQueueTail: Promise<unknown> = Promise.resolve()

const RETRY_DELAYS_MS = [5_000, 15_000, 45_000]

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 限速执行:所有出站请求都过这条串行队列 */
function throttled<T>(task: () => Promise<T>): Promise<T> {
  const run = queueTail.then(async () => {
    const wait = lastRequestAt + REQUEST_MIN_INTERVAL_MS - Date.now()
    if (wait > 0) await sleep(wait)
    lastRequestAt = Date.now()
    return task()
  })
  // 队列尾部吞掉错误,避免一次失败让后续所有请求跟着 reject
  queueTail = run.catch(() => undefined)
  return run
}

/** 静态资源限速执行:独立队列,间隔 ASSET_MIN_INTERVAL_MS */
function throttledAsset<T>(task: () => Promise<T>): Promise<T> {
  const run = assetQueueTail.then(async () => {
    const wait = lastAssetAt + ASSET_MIN_INTERVAL_MS - Date.now()
    if (wait > 0) await sleep(wait)
    lastAssetAt = Date.now()
    return task()
  })
  assetQueueTail = run.catch(() => undefined)
  return run
}

/**
 * GET NodeLoc JSON 接口。
 * @param path 以 / 开头的路径(如 /latest.json?page=0)
 * @returns 解析后的 JSON;404/403/410(内容不存在或无权限)返回 null
 */
export async function fetchNodelocJson<T>(path: string): Promise<T | null> {
  return throttled(async () => {
    let lastError: unknown
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        const res = await fetchNodelocResponse(NODELOC_BASE_URL + path, {
          headers: { 'User-Agent': IMPORT_USER_AGENT, Accept: 'application/json' },
          signal: AbortSignal.timeout(30_000),
        })
        if (res.status === 404 || res.status === 403 || res.status === 410) return null
        if (res.ok) return (await res.json()) as T
        // 429/5xx 走退避重试
        lastError = new Error(`HTTP ${res.status} for ${path}`)
      } catch (err) {
        lastError = err
      }
      const delay = RETRY_DELAYS_MS[attempt]
      if (delay === undefined) break
      console.warn(`[import] retry ${attempt + 1} for ${path} in ${delay}ms:`, String(lastError))
      await sleep(delay)
    }
    throw lastError
  })
}

/**
 * 下载二进制资源(图片/头像)。支持绝对 URL(外链图床)与站内路径。
 * 走独立的静态资源限速队列(命中 CDN 缓存,与 JSON 接口分账);失败重试同 JSON。
 * @returns Buffer;404/403 或超限由调用方按 null 跳过
 */
export async function fetchNodelocBinary(
  url: string,
  maxBytes: number,
): Promise<{ data: Buffer; contentType: string } | null> {
  const absolute = assertAllowedNodelocUrl(url)
  return throttledAsset(async () => {
    let lastError: unknown
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        const res = await fetchNodelocResponse(absolute, {
          headers: { 'User-Agent': IMPORT_USER_AGENT },
          signal: AbortSignal.timeout(60_000),
        })
        if (res.status === 404 || res.status === 403 || res.status === 410) return null
        if (res.ok) {
          const length = Number(res.headers.get('content-length') ?? 0)
          if (length > maxBytes) return null
          const data = await readBodyWithinLimit(res.body, maxBytes)
          if (!data) return null
          return { data, contentType: res.headers.get('content-type') ?? '' }
        }
        lastError = new Error(`HTTP ${res.status} for ${absolute}`)
      } catch (err) {
        lastError = err
      }
      const delay = RETRY_DELAYS_MS[attempt]
      if (delay === undefined) break
      await sleep(delay)
    }
    console.warn(`[import] binary download failed, skip: ${absolute}`, String(lastError))
    return null
  })
}
