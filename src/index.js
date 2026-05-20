#!/usr/bin/env node
// Family Shared-Memory MCP for Tyler-Computer LibreChat.
// Cross-user fact attribution + recall. Multi-tenant within one family.
//
// Identity is passed per-process by LibreChat via env-var substitution of
// {{LIBRECHAT_USER_ID}}, {{LIBRECHAT_USER_EMAIL}}, etc. — LibreChat spawns
// one stdio child per (user, server) connection, so env is stable for the
// lifetime of this process and reflects the calling user.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { MongoClient, ObjectId } from 'mongodb';
import { z } from 'zod';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://mongo.railway.internal:27017';
const DB_NAME = process.env.FAMILY_MEMORY_DB || 'test';
const COLLECTION_NAME = process.env.FAMILY_MEMORY_COLLECTION || 'family_facts';

const USER_ID = process.env.LIBRECHAT_USER_ID || '';
const USER_EMAIL = process.env.LIBRECHAT_USER_EMAIL || '';
const USER_NAME = process.env.LIBRECHAT_USER_USERNAME || USER_EMAIL || 'unknown';
const USER_ROLE = (process.env.LIBRECHAT_USER_ROLE || 'USER').toUpperCase();
const IS_ADMIN = USER_ROLE === 'ADMIN';

const mongo = new MongoClient(MONGODB_URI, {
  serverSelectionTimeoutMS: 5000,
  connectTimeoutMS: 5000,
});

let collection = null;

async function getCollection() {
  if (collection) return collection;
  await mongo.connect();
  const db = mongo.db(DB_NAME);
  collection = db.collection(COLLECTION_NAME);

  await Promise.all([
    collection.createIndex({ fact: 'text', tags: 'text', category: 'text' }, { name: 'family_facts_text' }),
    collection.createIndex({ createdAt: -1 }),
    collection.createIndex({ authorId: 1, createdAt: -1 }),
    collection.createIndex({ deletedAt: 1 }),
    collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, partialFilterExpression: { expiresAt: { $type: 'date' } } }),
  ]).catch((err) => {
    process.stderr.write(`[family-memory-mcp] index creation warning: ${err.message}\n`);
  });

  return collection;
}

function notDeleted() {
  return { $or: [{ deletedAt: { $exists: false } }, { deletedAt: null }] };
}

function formatFact(doc) {
  const when = doc.createdAt instanceof Date ? doc.createdAt.toISOString() : String(doc.createdAt);
  const tags = Array.isArray(doc.tags) && doc.tags.length ? ` [${doc.tags.join(', ')}]` : '';
  const cat = doc.category ? ` (${doc.category})` : '';
  return `• ${doc.fact}${cat}${tags}\n    — ${doc.authorName || doc.authorEmail || 'unknown'} on ${when}  [id: ${doc._id}]`;
}

function requireIdentity() {
  if (!USER_ID) {
    return {
      content: [{
        type: 'text',
        text: 'family-memory: missing LIBRECHAT_USER_ID env var. The MCP server must be configured with {{LIBRECHAT_USER_ID}} as an env so LibreChat can substitute the calling user identity.',
      }],
      isError: true,
    };
  }
  return null;
}

const server = new McpServer(
  { name: 'family-memory', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.registerTool(
  'remember',
  {
    title: 'Remember a fact for the whole family',
    description:
      'Store a fact in shared family memory. Visible to ALL family members on this LibreChat instance. ' +
      'Use this when the user tells you something worth recalling later — a name, a date, a preference, ' +
      'an appointment, a status. The fact is attributed to the calling user and timestamped automatically.',
    inputSchema: {
      fact: z.string().min(1).max(2000).describe('The fact to remember, in plain language.'),
      category: z.string().max(60).optional().describe('Optional bucket like "appointment", "preference", "person", "pet".'),
      tags: z.array(z.string().max(40)).max(10).optional().describe('Optional tags for retrieval, e.g. ["mom", "doctor"].'),
      expiresAt: z.string().datetime().optional().describe('Optional ISO-8601 timestamp at which this fact should auto-expire.'),
    },
  },
  async ({ fact, category, tags, expiresAt }) => {
    const guard = requireIdentity();
    if (guard) return guard;
    const col = await getCollection();
    const doc = {
      fact,
      category: category || null,
      tags: tags || [],
      authorId: USER_ID,
      authorEmail: USER_EMAIL,
      authorName: USER_NAME,
      createdAt: new Date(),
      expiresAt: expiresAt ? new Date(expiresAt) : null,
    };
    const result = await col.insertOne(doc);
    return {
      content: [{
        type: 'text',
        text: `Remembered. id=${result.insertedId}\n  author: ${USER_NAME} (${USER_EMAIL})\n  fact: ${fact}`,
      }],
    };
  },
);

server.registerTool(
  'recall',
  {
    title: 'Recall shared family memory by query',
    description:
      'Search ALL family members\' shared facts (not just the calling user\'s). Returns up to 5 matches ' +
      'ranked by relevance + recency, each annotated with who said it and when. Use this whenever the user ' +
      'asks a question that might be answered by something a family member told the AI previously.',
    inputSchema: {
      query: z.string().min(1).max(500).describe('Natural-language search query.'),
      limit: z.number().int().min(1).max(20).optional().describe('Max results to return (default 5).'),
    },
  },
  async ({ query, limit }) => {
    const guard = requireIdentity();
    if (guard) return guard;
    const col = await getCollection();
    const max = limit || 5;

    const textResults = await col
      .find(
        { $and: [{ $text: { $search: query } }, notDeleted()] },
        { projection: { score: { $meta: 'textScore' } } },
      )
      .sort({ score: { $meta: 'textScore' }, createdAt: -1 })
      .limit(max)
      .toArray();

    let docs = textResults;

    if (docs.length === 0) {
      const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const rx = new RegExp(escaped, 'i');
      docs = await col
        .find({ $and: [{ $or: [{ fact: rx }, { tags: rx }, { category: rx }] }, notDeleted()] })
        .sort({ createdAt: -1 })
        .limit(max)
        .toArray();
    }

    if (docs.length === 0) {
      return {
        content: [{ type: 'text', text: `No family facts matched "${query}".` }],
      };
    }

    const body = docs.map(formatFact).join('\n');
    return {
      content: [{
        type: 'text',
        text: `Found ${docs.length} match${docs.length === 1 ? '' : 'es'} in shared family memory:\n${body}`,
      }],
    };
  },
);

server.registerTool(
  'list_recent',
  {
    title: 'List recent family facts',
    description: 'Return the N most recent family facts across all members. Useful for "what has the family been up to lately".',
    inputSchema: {
      limit: z.number().int().min(1).max(50).optional().describe('Number of recent facts to return (default 10).'),
    },
  },
  async ({ limit }) => {
    const guard = requireIdentity();
    if (guard) return guard;
    const col = await getCollection();
    const max = limit || 10;
    const docs = await col.find(notDeleted()).sort({ createdAt: -1 }).limit(max).toArray();
    if (docs.length === 0) {
      return { content: [{ type: 'text', text: 'No family facts have been stored yet.' }] };
    }
    return {
      content: [{
        type: 'text',
        text: `Most recent ${docs.length} family fact${docs.length === 1 ? '' : 's'}:\n` + docs.map(formatFact).join('\n'),
      }],
    };
  },
);

server.registerTool(
  'forget',
  {
    title: 'Soft-delete a family fact',
    description:
      'Soft-delete a fact by id. Regular users can only forget facts they authored. ADMIN users (Tyler) can ' +
      'forget anyone\'s fact. The fact is hidden from future recall but the row is retained for audit.',
    inputSchema: {
      factId: z.string().min(1).describe('The _id of the fact to forget (as returned by remember/recall).'),
    },
  },
  async ({ factId }) => {
    const guard = requireIdentity();
    if (guard) return guard;
    const col = await getCollection();
    let oid;
    try {
      oid = new ObjectId(factId);
    } catch {
      return { content: [{ type: 'text', text: `Invalid factId: ${factId}` }], isError: true };
    }
    const doc = await col.findOne({ _id: oid });
    if (!doc) {
      return { content: [{ type: 'text', text: `No fact with id ${factId}.` }], isError: true };
    }
    if (doc.deletedAt) {
      return { content: [{ type: 'text', text: `Fact ${factId} is already forgotten.` }] };
    }
    if (!IS_ADMIN && doc.authorId !== USER_ID) {
      return {
        content: [{
          type: 'text',
          text: `Not allowed: only ${doc.authorName || doc.authorEmail} (the author) or an admin can forget this fact.`,
        }],
        isError: true,
      };
    }
    await col.updateOne(
      { _id: oid },
      { $set: { deletedAt: new Date(), deletedBy: USER_ID, deletedByName: USER_NAME } },
    );
    return {
      content: [{
        type: 'text',
        text: `Forgotten. id=${factId} (originally by ${doc.authorName || doc.authorEmail})`,
      }],
    };
  },
);

server.registerTool(
  'who_said',
  {
    title: 'Attribution lookup',
    description: 'Find which family member said something matching the query. Returns up to 5 matches with author + timestamp, ranked by relevance.',
    inputSchema: {
      query: z.string().min(1).max(500).describe('Phrase or topic to look up.'),
    },
  },
  async ({ query }) => {
    const guard = requireIdentity();
    if (guard) return guard;
    const col = await getCollection();
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rx = new RegExp(escaped, 'i');
    const docs = await col
      .find({ $and: [{ $or: [{ fact: rx }, { tags: rx }, { category: rx }] }, notDeleted()] })
      .sort({ createdAt: -1 })
      .limit(5)
      .toArray();
    if (docs.length === 0) {
      return { content: [{ type: 'text', text: `No family member has said anything matching "${query}".` }] };
    }
    const lines = docs.map((d) => {
      const when = d.createdAt instanceof Date ? d.createdAt.toISOString() : String(d.createdAt);
      return `• ${d.authorName || d.authorEmail} said: "${d.fact}" (${when})  [id: ${d._id}]`;
    });
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `[family-memory-mcp] connected as user=${USER_NAME} (${USER_EMAIL}) role=${USER_ROLE} mongo=${MONGODB_URI} db=${DB_NAME}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`[family-memory-mcp] fatal: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});

process.on('SIGINT', async () => {
  try { await mongo.close(); } catch {}
  process.exit(0);
});
process.on('SIGTERM', async () => {
  try { await mongo.close(); } catch {}
  process.exit(0);
});
