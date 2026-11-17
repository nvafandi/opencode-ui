import { OpenCode } from '@opencode/client'
import { Service } from '@opencode/client/service'

const ep = await Service.discover()
const client = OpenCode.make({ baseUrl: ep.url, headers: Service.headers(ep) })

const list = await client.session.list({ limit: 5 })
const target = list.data[0]
console.log('session:', target.id, '|', target.title)
console.log('agent:', target.agent, '| model:', JSON.stringify(target.model))

const msgs = await client.message.list({ sessionID: target.id, limit: 6, order: 'desc' })
console.log('messages:', msgs.data.length)
for (const m of msgs.data.reverse()) {
  console.log('---', m.type, m.id)
  if (m.type === 'user') console.log('   text:', JSON.stringify((m.text ?? '').slice(0, 60)))
  if (m.type === 'assistant') {
    for (const c of m.content) {
      if (c.type === 'text') console.log('   text:', JSON.stringify(c.text.slice(0, 60)))
      else console.log('   ' + c.type + ':', JSON.stringify(c).slice(0, 400))
    }
  }
}
