# OpenCode Web Dashboard

A React + TypeScript web UI for OpenCode, built with Vite and `@opencode/client`.

## Prerequisites

- Node.js 18+
- OpenCode CLI installed and `opencode serve` running

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Copy env and adjust if needed
cp .env.example .env

# 3. Start OpenCode background service (in another terminal)
opencode serve --port 4096

# 4. Start dev server
npm run dev
```

Open http://localhost:5173

## Features

- Session list with create/delete
- Real-time message polling (5s interval)
- Tool call visualization (expandable)
- Code syntax highlighting (basic)
- Dark/light mode (follows system)
- Responsive layout (sidebar + chat)

## Project Structure

```
src/
├── main.tsx      # Entry point, creates OpenCode client
├── App.tsx       # Main dashboard component
└── styles.css    # All styles (CSS custom properties for theming)
```

## Configuration

| Env Var | Default | Description |
|---------|---------|-------------|
| `VITE_OPENCODE_URL` | `http://localhost:4096` | OpenCode service base URL |

## API Usage

The dashboard uses `@opencode/client`:

```ts
import { createClient } from '@opencode/client'

const client = createClient({ baseUrl: 'http://localhost:4096' })

// List sessions
const sessions = await client.sessions.list()

// Create session
const session = await client.sessions.create({})

// Send message
await client.sessions.messages.create(sessionId, { content: 'Hello' })

// Stream messages (SSE)
for await (const msg of client.sessions.messages.stream(sessionId)) {
  console.log(msg)
}
```

## Building for Production

```bash
npm run build
npm run preview  # test build locally
```

Output in `dist/` — deploy anywhere static hosting works.

## License

MIT