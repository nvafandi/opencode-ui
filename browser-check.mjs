import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const TARGET_URL = process.argv[2] ?? 'http://localhost:5174/'
const PORT = 9333
const sleep = ms => new Promise(r => setTimeout(r, ms))

const profile = mkdtempSync(join(tmpdir(), 'cdp-'))
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-extensions',
    '--window-size=1280,900',
    'about:blank',
  ],
  { stdio: 'ignore' }
)

const cleanup = () => {
  try { chrome.kill() } catch {}
}
process.on('exit', cleanup)

async function getPageTarget() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find(t => t.type === 'page')
      if (page?.webSocketDebuggerUrl) return page
    } catch {}
    await sleep(250)
  }
  throw new Error('CDP tidak siap setelah 20s')
}

const page = await getPageTarget()

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true })
  ws.addEventListener('error', () => rej(new Error('WS gagal')), { once: true })
})

let nextId = 1
const pending = new Map()
const consoleLines = []
const exceptions = []
const netEvents = []

ws.addEventListener('message', ev => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
    return
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    const text = (msg.params.args ?? [])
      .map(a => a.value ?? a.description ?? a.unserializableValue ?? a.type)
      .join(' ')
    consoleLines.push(`${msg.params.type}: ${text}`)
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails
    exceptions.push(d.exception?.description ?? d.text)
  }
  if (msg.method === 'Log.entryAdded') {
    const e = msg.params.entry
    if (e.level === 'error' || e.level === 'warning') consoleLines.push(`log-${e.level}: ${e.text}`)
  }
  if (msg.method === 'Network.responseReceived') {
    const { url, status, mimeType } = msg.params.response
    if (url.includes('/oc/')) netEvents.push(`${status} ${mimeType || '-'} ${url.replace(/^https?:\/\/[^/]+/, '')}`)
  }
  if (msg.method === 'Network.loadingFailed') {
    netEvents.push(`FAILED ${msg.params.errorText} ${msg.params.requestId}`)
  }
})

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })

await send('Runtime.enable')
await send('Log.enable')
await send('Network.enable')
await send('Page.enable')

await send('Page.navigate', { url: TARGET_URL })
await sleep(9000) // React mount + session fetch + SSE handshake

const evaluate = async expression => {
  const { result } = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })
  return result.value
}

const probe = await evaluate(`(() => {
  const txt = el => (el ? el.textContent.trim() : null)
  const items = [...document.querySelectorAll('.session-item')]
  return {
    title: document.title,
    sessions: items.map(el => txt(el.querySelector('.session-title'))),
    badge: txt(document.querySelector('.live-badge')),
    chatTitle: txt(document.querySelector('.chat-header h2')),
    messages: document.querySelectorAll('.message').length,
    userMessages: document.querySelectorAll('.message.user').length,
    assistantMessages: document.querySelectorAll('.message.assistant').length,
    toolCallBlocks: document.querySelectorAll('.tool-calls').length,
    firstToolName: txt(document.querySelector('.tool-call strong')),
    errorBanner: txt(document.querySelector('.error-banner')),
    agentOptions: [...document.querySelectorAll('.switchers select')][0]?.options.length ?? 0,
    modelOptions: [...document.querySelectorAll('.switchers select')][1]?.options.length ?? 0,
    inputPresent: !!document.querySelector('.input-field'),
    bodyTextLength: document.body.innerText.length,
    bodySample: document.body.innerText.slice(0, 600),
  }
})()`)

const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
const shotPath = join(process.cwd(), 'ui-check.png')
writeFileSync(shotPath, Buffer.from(shot.data, 'base64'))

// Click the second session to prove session switching reads real data.
const switched = await evaluate(`(async () => {
  const items = [...document.querySelectorAll('.session-item')]
  if (items.length < 2) return { skipped: true }
  items[1].click()
  await new Promise(r => setTimeout(r, 2500))
  return {
    chatTitle: document.querySelector('.chat-header h2')?.textContent.trim(),
    messages: document.querySelectorAll('.message').length,
    activeTitle: document.querySelector('.session-item.active .session-title')?.textContent.trim(),
  }
})()`)

console.log('=== PAGE ===')
console.log(JSON.stringify(probe, null, 2))
console.log('\n=== AFTER CLICKING SESSION #2 ===')
console.log(JSON.stringify(switched, null, 2))
console.log('\n=== NETWORK (/oc/*) ===')
console.log(netEvents.length ? [...new Set(netEvents)].join('\n') : '(tidak ada request /oc)')
console.log('\n=== CONSOLE ===')
console.log(consoleLines.length ? [...new Set(consoleLines)].join('\n') : '(bersih)')
console.log('\n=== EXCEPTIONS ===')
console.log(exceptions.length ? exceptions.join('\n---\n') : '(tidak ada)')
console.log('\n=== SCREENSHOT ===')
console.log(shotPath)

ws.close()
cleanup()
process.exit(0)