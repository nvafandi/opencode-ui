import { useCallback, useEffect, useRef, useState } from 'react'
import { OpenCode } from '@opencode/client'

type Client = ReturnType<typeof OpenCode.make>

interface Session {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  agent?: string
  model?: { id: string; providerID: string }
}

interface ToolCall {
  id: string
  name: string
  input: string
  result?: string
  status: 'pending' | 'completed' | 'failed'
}

interface Message {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: number
  toolCalls?: ToolCall[]
}

interface Permission {
  id: string
  action: string
  resources: string[]
  message?: string
}

interface Agent {
  id: string
  name: string
}

interface Model {
  key: string
  modelID: string
  providerID: string
  name: string
}

// /oc is proxied by vite.config.ts, which resolves the live port and Basic auth
// per request; the browser never sees either. The base URL must be absolute:
// the SDK builds request URLs with new URL(path, baseUrl) and throws on a
// relative base before any request is made.
const client: Client = OpenCode.make({ baseUrl: `${window.location.origin}/oc` })
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// Tool output can be megabytes; the UI only needs the head of it.
const clip = (text: string, limit = 2000) =>
  text.length > limit ? `${text.slice(0, limit)}\n… (${text.length - limit} karakter disembunyikan)` : text

export default function App() {
  const [sessions, setSessions] = useState<Session[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [permissions, setPermissions] = useState<Permission[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [models, setModels] = useState<Model[]>([])
  const [modelSearch, setModelSearch] = useState('')
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(true)
  const [live, setLive] = useState(false)
  const [tick, setTick] = useState(0)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const refreshTimer = useRef<number | null>(null)
  const activeIdRef = useRef<string | null>(null)

  activeIdRef.current = activeSessionId

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Bursts of server events collapse into one refetch.
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current !== null) return
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null
      setTick(t => t + 1)
    }, 150)
  }, [])

  const fetchSessions = async (cursor?: string) => {
    const isLoadMore = !!cursor
    if (isLoadMore) setLoadingMore(true)
    try {
      const response: any = await client.session.list({ limit: 5, cursor })
      const mapped: Session[] = (response.data ?? []).map((s: any) => ({
        id: s.id,
        title: s.title || 'Untitled',
        createdAt: s.time?.created ?? 0,
        updatedAt: s.time?.updated ?? 0,
        agent: s.agent,
        model: s.model,
      }))
      // Newest activity first. Sorted here rather than trusting server order, so
      // the list stays stable after a refresh reorders sessions mid-session.
      mapped.sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt))

      if (isLoadMore) {
        setSessions(prev => [...prev, ...mapped])
      } else {
        setSessions(mapped)
        setActiveSessionId(current => current ?? mapped[0]?.id ?? null)
      }
      setNextCursor(response.cursor?.next ?? null)
    } finally {
      if (isLoadMore) setLoadingMore(false)
    }
  }

  const fetchMessages = async (sessionId: string) => {
    const response: any = await client.message.list({ sessionID: sessionId, limit: 200 })
    const mapped: Message[] = (response.data ?? []).map((m: any) => {
      const createdAt = m.time?.created ?? 0

      if (m.type === 'user') {
        return { id: m.id, role: 'user' as const, content: m.text ?? '', createdAt }
      }

      if (m.type !== 'assistant') {
        // idle / system / shell / compaction / skill: nothing worth rendering.
        return { id: m.id, role: 'system' as const, content: '', createdAt }
      }

      const blocks: any[] = m.content ?? []
      const text = blocks
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('')

      const toolCalls: ToolCall[] = blocks
        .filter(b => b.type === 'tool')
        .map((b: any, idx: number) => {
          const state = b.state ?? {}
          const input =
            typeof state.input === 'string' ? state.input : JSON.stringify(state.input ?? {}, null, 2)
          const output =
            state.error?.message ??
            (state.content ?? [])
              .map((c: any) => (c.type === 'text' ? c.text : c.type === 'file' ? `[file] ${c.name ?? c.uri}` : ''))
              .filter(Boolean)
              .join('\n')

          return {
            id: b.id ?? `${m.id}-${idx}`,
            name: b.name ?? 'tool',
            input: clip(input),
            result: output ? clip(output) : undefined,
            status:
              state.status === 'completed'
                ? ('completed' as const)
                : state.status === 'error' || state.status === 'failed'
                  ? ('failed' as const)
                  : ('pending' as const),
          }
        })

      return {
        id: m.id,
        role: 'assistant' as const,
        content: text,
        createdAt,
        toolCalls: toolCalls.length ? toolCalls : undefined,
      }
    })

    setMessages(mapped)
  }

  const fetchPermissions = async (sessionId: string) => {
    const data: any = await client.permission.list({ sessionID: sessionId })
    setPermissions(Array.isArray(data) ? data : [])
  }

  // Only refresh messages/permissions for active session on events.
  // Session list is refreshed separately (periodic + on session.* events).
  const refreshActive = useCallback(async () => {
    const sessionId = activeIdRef.current
    if (!sessionId) return
    try {
      await Promise.all([
        fetchMessages(sessionId),
        fetchPermissions(sessionId).catch(() => undefined),
      ])
      setError(null)
    } catch (e) {
      setError(`Tidak bisa baca data session: ${e instanceof Error ? e.message : String(e)}`)
    }
  }, [])

  // Full refresh including session list (periodic + on session create/delete).
  const refreshAll = useCallback(async () => {
    try {
      await fetchSessions()
      const sessionId = activeIdRef.current
      if (sessionId) {
        await Promise.all([
          fetchMessages(sessionId),
          fetchPermissions(sessionId).catch(() => undefined),
        ])
      }
      setConnecting(false)
      setError(null)
    } catch (e) {
      setConnecting(false)
      setError(`Tidak bisa baca data dari OpenCode: ${e instanceof Error ? e.message : String(e)}`)
    }
  }, [])

  useEffect(() => {
    refreshActive()
  }, [tick, activeSessionId, refreshActive])

  // Agents and models change rarely; fetch once and on reconnect.
  useEffect(() => {
    let stopped = false
    ;(async () => {
      try {
        const a: any = await client.agent.list()
        if (stopped) return
        setAgents(
          (a.data ?? [])
            .filter((x: any) => !x.hidden && x.mode !== 'subagent')
            .map((x: any) => ({ id: x.id ?? x.name, name: x.name }))
        )
      } catch {
        /* agent list is optional */
      }
      try {
        const m: any = await client.model.list({ types: ['chat'] })
        if (stopped) return
        setModels(
          (m.data ?? [])
            .filter((x: any) => x.enabled !== false)
            .map((x: any) => ({
              key: `${x.providerID}/${x.modelID ?? x.id}`,
              modelID: x.modelID ?? x.id,
              providerID: x.providerID,
              name: x.name,
            }))
        )
      } catch {
        /* model list is optional */
      }
    })()
    return () => {
      stopped = true
    }
  }, [tick > 0])

  // Live updates. Reconnects with backoff; the proxy re-resolves the service
  // endpoint, so a restarted service on a new port is picked up automatically.
  useEffect(() => {
    let stopped = false
    let controller: AbortController | null = null
    let attempt = 0
    let lastActivity = Date.now()

    // A half-open connection never errors, it just goes quiet.
    const watchdog = window.setInterval(() => {
      if (Date.now() - lastActivity > 45000) controller?.abort()
    }, 5000)

    ;(async () => {
      while (!stopped) {
        controller = new AbortController()
        lastActivity = Date.now()
        try {
          const stream: any = (client.event as any).subscribe({
            signal: controller.signal,
            onActivity: () => {
              // Fires for keepalive frames too: transport activity proves the
              // stream is alive even when no event is being delivered.
              lastActivity = Date.now()
              setLive(true)
            },
          })

          for await (const event of stream) {
            if (stopped) break
            attempt = 0
            lastActivity = Date.now()
            setLive(true)

            const type: string = event?.type ?? ''
            if (type === 'server.connected') {
              // Anything that happened while disconnected is now stale.
              refreshAll()
            } else if (type === 'session.created' || type === 'session.deleted') {
              // Session list changed; refetch everything.
              refreshAll()
            } else if (type.startsWith('session.execution.') || type === 'session.idle') {
              setLoading(false)
              scheduleRefresh()
            } else if (type.startsWith('session.') || type.startsWith('permission.')) {
              scheduleRefresh()
            }
          }
        } catch {
          /* dropped; handled below */
        }

        if (stopped) break
        setLive(false)
        attempt++
        await sleep(Math.min(500 * 2 ** (attempt - 1), 15000))
      }
    })()

    return () => {
      stopped = true
      window.clearInterval(watchdog)
      controller?.abort()
    }
  }, [scheduleRefresh])

  // Last-resort poll in case SSE stays down (refreshes active session).
  useEffect(() => {
    const interval = window.setInterval(() => setTick(t => t + 1), 30000)
    return () => window.clearInterval(interval)
  }, [])

  // Periodic full refresh including session list (every 60s).
  useEffect(() => {
    const interval = window.setInterval(() => refreshAll(), 60000)
    return () => window.clearInterval(interval)
  }, [refreshAll])

  const sendMessage = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!input.trim() || !activeSessionId || loading) return

    const text = input.trim()
    setInput('')
    setLoading(true)
    setError(null)

    try {
      await client.session.prompt({ sessionID: activeSessionId, text })
      scheduleRefresh()
    } catch (e) {
      setError(`Gagal kirim pesan: ${e instanceof Error ? e.message : String(e)}`)
      setLoading(false)
    }
  }

  const createSession = async () => {
    try {
      const session: any = await client.session.create({})
      setSessions(prev => [
        {
          id: session.id,
          title: session.title || 'Untitled',
          createdAt: session.time?.created ?? Date.now(),
          updatedAt: session.time?.updated ?? Date.now(),
          agent: session.agent,
          model: session.model,
        },
        ...prev,
      ])
      setActiveSessionId(session.id)
    } catch (e) {
      setError(`Gagal buat session: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const deleteSession = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (!confirm('Hapus session ini?')) return
    try {
      await client.session.remove({ sessionID: id })
      setSessions(prev => prev.filter(s => s.id !== id))
      if (activeSessionId === id) setActiveSessionId(null)
    } catch (e) {
      setError(`Gagal hapus session: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const replyPermission = async (requestID: string, decision: 'once' | 'always' | 'reject') => {
    if (!activeSessionId) return
    try {
      await client.permission.reply({ sessionID: activeSessionId, requestID, decision })
      setPermissions(prev => prev.filter(p => p.id !== requestID))
    } catch (e) {
      setError(`Gagal balas permission: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const changeAgent = async (agent: string) => {
    if (!activeSessionId || !agent) return
    try {
      await client.session.switchAgent({ sessionID: activeSessionId, agent })
      scheduleRefresh()
    } catch (e) {
      setError(`Gagal ganti agent: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const changeModel = async (key: string) => {
    if (!activeSessionId || !key) return
    const model = models.find(m => m.key === key)
    if (!model) return
    try {
      await client.session.switchModel({
        sessionID: activeSessionId,
        model: { id: model.modelID, providerID: model.providerID },
      })
      scheduleRefresh()
    } catch (e) {
      setError(`Gagal ganti model: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  if (connecting && sessions.length === 0) {
    return (
      <div className="loading">
        <div className="spinner" />
        <p>Membaca session dari OpenCode…</p>
        {error && <p className="error-inline">{error}</p>}
      </div>
    )
  }

  const active = sessions.find(s => s.id === activeSessionId)
  const currentModel = active?.model ? `${active.model.providerID}/${active.model.id}` : ''
  const currentAgent = active?.agent ?? ''

  return (
    <div className="app">
      <aside className="sidebar">
        <header className="sidebar-header">
          <h1>OpenCode</h1>
          <button className="btn-primary" onClick={createSession} title="Session baru">
            +
          </button>
        </header>
        <nav className="session-list">
          {sessions.length === 0 ? (
            <p className="empty">Belum ada session. Klik + untuk buat.</p>
          ) : (
            <>
              {sessions.map(session => (
                <div
                  key={session.id}
                  className={`session-item ${activeSessionId === session.id ? 'active' : ''}`}
                  onClick={() => setActiveSessionId(session.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && setActiveSessionId(session.id)}
                >
                  <span className="session-title">{session.title}</span>
                  <button className="btn-delete" onClick={e => { e.stopPropagation(); deleteSession(session.id, e); }} title="Hapus">
                    ✕
                  </button>
                </div>
              ))}
              {nextCursor && (
                <button
                  className="btn-load-more"
                  onClick={() => fetchSessions(nextCursor)}
                  disabled={loadingMore}
                >
                  {loadingMore ? 'Memuat…' : `Lebih lanjut (${nextCursor ? '↓' : ''})`}
                </button>
              )}
            </>
          )}
        </nav>
        <footer className={`live-badge ${live ? 'on' : 'off'}`}>
          {live ? '● live' : '○ polling'}
          <span className="session-count">{sessions.length} session</span>
        </footer>
      </aside>

      <main className="main">
        {/* Rendered outside the branch below: a failed fetch leaves
            activeSessionId null, which is exactly when the error must show. */}
        {error && <div className="error-banner">{error}</div>}

        {activeSessionId ? (
          <>
            <header className="chat-header">
              <h2>{active?.title || 'Session'}</h2>
              <div className="switchers">
                <select value={currentAgent} onChange={e => changeAgent(e.target.value)} title="Agent">
                  <option value="">agent…</option>
                  {agents.map(a => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
                <div className="model-select-wrapper">
                  <input
                    type="text"
                    placeholder="Cari model…"
                    value={modelSearch}
                    onChange={e => setModelSearch(e.target.value)}
                    className="model-search"
                    title="Filter model by name or provider"
                  />
                  <select value={currentModel} onChange={e => changeModel(e.target.value)} title="Model">
                    <option value="">model…</option>
                    {models
                      .filter(m =>
                        m.name.toLowerCase().includes(modelSearch.toLowerCase()) ||
                        m.providerID.toLowerCase().includes(modelSearch.toLowerCase()) ||
                        m.modelID.toLowerCase().includes(modelSearch.toLowerCase())
                      )
                      .map(m => (
                        <option key={m.key} value={m.key}>
                          {m.name}
                        </option>
                      ))}
                  </select>
                </div>
              </div>
            </header>

            <div className="messages">
              {messages.length === 0 ? (
                <p className="empty">Belum ada pesan di session ini.</p>
              ) : (
                messages.map(msg => <MessageBubble key={msg.id} message={msg} />)
              )}
              <div ref={messagesEndRef} />
            </div>

            {permissions.length > 0 && (
              <div className="permissions">
                {permissions.map(p => (
                  <div key={p.id} className="permission">
                    <div className="permission-text">
                      <strong>{p.action}</strong>
                      <code>{p.resources.join(', ')}</code>
                      {p.message && <span className="permission-msg">{p.message}</span>}
                    </div>
                    <div className="permission-actions">
                      <button onClick={() => replyPermission(p.id, 'once')}>Allow once</button>
                      <button onClick={() => replyPermission(p.id, 'always')}>Always</button>
                      <button className="danger" onClick={() => replyPermission(p.id, 'reject')}>
                        Reject
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <form className="input-form" onSubmit={sendMessage}>
              <textarea
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    sendMessage(e)
                  }
                }}
                placeholder="Ketik pesan… (Enter kirim, Shift+Enter baris baru)"
                disabled={loading}
                rows={1}
                className="input-field"
              />
              <button type="submit" className="btn-send" disabled={loading || !input.trim()}>
                {loading ? '⏳' : '➤'}
              </button>
            </form>
          </>
        ) : (
          <div className="empty-state">
            <h2>Pilih atau buat session</h2>
            <p>Klik + di sidebar untuk memulai session baru</p>
          </div>
        )}
      </main>
    </div>
  )
}

function MessageBubble({ message }: { message: Message }) {
  if (message.role === 'system' || (!message.content && !message.toolCalls)) return null

  const isUser = message.role === 'user'

  return (
    <div className={`message ${isUser ? 'user' : 'assistant'}`}>
      <div className="message-content">
        {message.toolCalls && message.toolCalls.length > 0 && (
          <details className="tool-calls">
            <summary>
              🔧 {message.toolCalls.length} tool call
              {message.toolCalls.length > 1 ? 's' : ''}
            </summary>
            <ul>
              {message.toolCalls.map(tc => (
                <li key={tc.id} className={`tool-call ${tc.status}`}>
                  <div className="tool-head">
                    <strong>{tc.name}</strong>
                    <span className="tool-status">{tc.status}</span>
                  </div>
                  <pre>{tc.input}</pre>
                  {tc.result && <pre className="result">{tc.result}</pre>}
                </li>
              ))}
            </ul>
          </details>
        )}
        {message.content && (
          <div
            className="message-text"
            dangerouslySetInnerHTML={{ __html: formatContent(message.content) }}
          />
        )}
      </div>
      <time className="message-time">{new Date(message.createdAt).toLocaleTimeString()}</time>
    </div>
  )
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// Model output is untrusted: escape first, then apply the markdown subset.
function formatContent(content: string): string {
  return escapeHtml(content)
    .replace(/```(\w+)?\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br/>')
}