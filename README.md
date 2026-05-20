# @nova-lc/family-memory-mcp

Multi-user shared-memory MCP server for the Brown family LibreChat instance.

LibreChat scopes each user's chat history and built-in memory to their own JWT — which is the right default for privacy between siblings. This MCP punches a documented hole in that isolation for **one** shared knowledge layer: any family member can write a fact, any other family member can recall it, and every fact is permanently attributed to its author.

## The use case

> **Lavette:** "Mom has a doctor's appointment Tuesday at 3."
> Two days later…
> **Tyler:** "When's mom's appointment?"
> → Tyler's chat calls `recall("mom appointment")` → gets Lavette's note back.

## How identity flows

LibreChat substitutes `{{LIBRECHAT_USER_ID}}`, `{{LIBRECHAT_USER_EMAIL}}`, `{{LIBRECHAT_USER_USERNAME}}`, and `{{LIBRECHAT_USER_ROLE}}` into MCP `env:` entries before spawning the child process. LibreChat spawns one stdio child per `(user, server)` pair, so each process knows exactly which family member it's serving for its entire lifetime. We read those env vars at startup and stamp every `remember` with the calling user's id, email, and display name.

## Tools

| Tool | Purpose |
|---|---|
| `remember(fact, category?, tags?, expiresAt?)` | Store a fact in shared family memory. Attributed + timestamped automatically. |
| `recall(query, limit?)` | Search across **all** family members' facts. Mongo $text first, regex fallback. Returns up to 5 by default. |
| `list_recent(limit?)` | The N most recent family facts. |
| `forget(factId)` | Soft-delete by id. Author OR admin (Tyler) only. Audit row retained. |
| `who_said(query)` | Attribution lookup — which family member said something matching the query. |

## Storage

A single Mongo collection, `family_facts`, in the existing LibreChat database. The MCP runs inside the LibreChat container's private Railway network and connects to `mongo.railway.internal:27017` with no auth (internal-network only).

```js
{
  _id: ObjectId,
  fact: string,
  category: string | null,
  tags: string[],
  authorId: string,       // LibreChat user._id from {{LIBRECHAT_USER_ID}}
  authorEmail: string,
  authorName: string,
  createdAt: Date,
  expiresAt: Date | null, // TTL-indexed; auto-removed when reached
  deletedAt?: Date,       // soft-delete
  deletedBy?: string,
  deletedByName?: string,
}
```

Indexes:
- `{ fact: 'text', tags: 'text', category: 'text' }` — text search
- `{ createdAt: -1 }` — list_recent
- `{ authorId: 1, createdAt: -1 }` — per-author scans
- `{ deletedAt: 1 }` — soft-delete filter
- `{ expiresAt: 1 }` TTL — auto-expire

## Permissions

- `recall`, `list_recent`, `who_said`: **all family members** see all non-deleted facts.
- `remember`: author is always the calling user.
- `forget`: regular users can only forget their **own** facts. `LIBRECHAT_USER_ROLE=ADMIN` (Tyler) can forget anyone's.

## Configuration

Environment variables read by the server:

| Var | Default | Notes |
|---|---|---|
| `MONGODB_URI` | `mongodb://mongo.railway.internal:27017` | LibreChat's internal Mongo |
| `FAMILY_MEMORY_DB` | `test` | Railway LibreChat template uses `test`, not `LibreChat` |
| `FAMILY_MEMORY_COLLECTION` | `family_facts` | |
| `LIBRECHAT_USER_ID` | _(required)_ | Set by LibreChat per-connection |
| `LIBRECHAT_USER_EMAIL` | _(set by LibreChat)_ | |
| `LIBRECHAT_USER_USERNAME` | _(set by LibreChat)_ | |
| `LIBRECHAT_USER_ROLE` | `USER` | Set to `ADMIN` (via LibreChat) for elevated `forget` |

## Wiring into LibreChat

In `librechat.yaml`:

```yaml
mcpServers:
  family-memory:
    type: stdio
    command: npx
    args:
      - -y
      - github:NOVA-LC/family-memory-mcp
    env:
      MONGODB_URI: "mongodb://mongo.railway.internal:27017"
      FAMILY_MEMORY_DB: "test"
      LIBRECHAT_USER_ID: "{{LIBRECHAT_USER_ID}}"
      LIBRECHAT_USER_EMAIL: "{{LIBRECHAT_USER_EMAIL}}"
      LIBRECHAT_USER_USERNAME: "{{LIBRECHAT_USER_USERNAME}}"
      LIBRECHAT_USER_ROLE: "{{LIBRECHAT_USER_ROLE}}"
    timeout: 60000
    chatMenu: true
```

## Local dev

```bash
npm install
LIBRECHAT_USER_ID=local-dev \
  LIBRECHAT_USER_EMAIL=dev@example.com \
  LIBRECHAT_USER_USERNAME=dev \
  MONGODB_URI=mongodb://localhost:27017 \
  npm start
```

Then send MCP JSON-RPC frames to stdin.
