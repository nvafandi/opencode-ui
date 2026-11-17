import { OpenCode } from '@opencode/client'
import { Service } from '@opencode/client/service'

const ep = await Service.discover()
const h = Service.headers(ep)
const base = ep.url

// 1) CORS: can a browser page on localhost:5173 call this origin directly?
const r = await fetch(base + '/api/info', { headers: { ...h, origin: 'http://localhost:5173' } })
console.log('info status:', r.status)
for (const k of ['access-control-allow-origin','access-control-allow-headers','access-control-allow-credentials'])
  console.log('  ' + k + ':', r.headers.get(k))

// 2) Which paths does the SDK hit?
const client = OpenCode.make({ baseUrl: base, headers: h })
const models = await client.model.list({ types: ['chat'] })
console.log('models:', models.data.length)
for (const m of models.data.slice(0, 3))
  console.log('  id=' + m.id, '| modelID=' + m.modelID, '| provider=' + m.providerID, '| name=' + m.name)

const agents = await client.agent.list()
console.log('agents:', agents.data.length)
for (const a of agents.data.slice(0, 4)) console.log('  ', a.name, '| mode=' + a.mode, '| hidden=' + a.hidden)
