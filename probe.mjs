import { OpenCode } from '@opencode/client'
import { Service } from '@opencode/client/service'

const ep = await Service.discover()
if (!ep) throw new Error('no service')
console.log('url:', ep.url, '| auth:', ep.auth?.type ?? 'none')

const client = OpenCode.make({ baseUrl: ep.url, headers: Service.headers(ep) })
const info = await client.server.info()
console.log('version:', info.version)

const list = await client.session.list({ limit: 5 })
console.log('sessions:', list.data.length)
for (const s of list.data) console.log(' -', s.id, '|', s.title ?? '(untitled)', '|', new Date(s.time.updated).toISOString())
