import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { Service } from '@opencode/client/service'
import { Readable } from 'node:stream'

// The service binds a random port and requires Basic auth, and both change on
// every restart. Discovery reads a file from disk, so it can only run in this
// process. The browser therefore talks to /oc/* and this middleware resolves the
// live endpoint per request and adds credentials the page must never see.
const PREFIX = '/oc'
let cache: { url: string; headers: Record<string, string>; at: number } | undefined

async function endpoint() {
  if (cache && Date.now() - cache.at < 1000) return cache
  const ep = await Service.discover()
  if (!ep) throw new Error('OpenCode service tidak ditemukan')
  const raw: any = Service.headers(ep) ?? {}
  const headers: Record<string, string> = raw instanceof Headers ? Object.fromEntries(raw) : raw
  cache = { url: ep.url, headers, at: Date.now() }
  return cache
}

const DROP = new Set([
  'host', 'connection', 'keep-alive', 'content-length', 'transfer-encoding',
  'authorization', 'accept-encoding', 'upgrade', 'proxy-connection',
])

async function readBody(req: any): Promise<Buffer | undefined> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

function opencodeProxy() {
  const handler = async (req: any, res: any, next: () => void) => {
    if (!req.url?.startsWith(PREFIX)) return next()

    let ep: { url: string; headers: Record<string, string> }
    try {
      ep = await endpoint()
    } catch (e) {
      cache = undefined
      res.statusCode = 503
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }))
      return
    }

    const abort = new AbortController()
    res.on('close', () => abort.abort())

    const headers: Record<string, string> = { ...ep.headers }
    for (const [k, v] of Object.entries(req.headers)) {
      if (DROP.has(k) || v === undefined) continue
      headers[k] = Array.isArray(v) ? v.join(', ') : String(v)
    }
    const body = await readBody(req)
    if (body) headers['content-type'] ??= 'application/json'

    try {
      const upstream = await fetch(ep.url + req.url.slice(PREFIX.length), {
        method: req.method,
        headers,
        body,
        signal: abort.signal,
      })

      res.statusCode = upstream.status
      upstream.headers.forEach((v, k) => {
        if (['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(k)) return
        res.setHeader(k, v)
      })
      res.flushHeaders?.()

      if (!upstream.body) {
        res.end()
        return
      }
      // Streamed, so SSE (/api/event) arrives token by token instead of buffered.
      Readable.fromWeb(upstream.body as any).pipe(res)
    } catch (e) {
      if (abort.signal.aborted) return
      cache = undefined
      res.statusCode = 502
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }))
    }
  }

  return {
    name: 'opencode-proxy',
    configureServer(server: any) {
      server.middlewares.use(handler)
    },
    configurePreviewServer(server: any) {
      server.middlewares.use(handler)
    },
  }
}

export default defineConfig({
  plugins: [react(), opencodeProxy()],
})