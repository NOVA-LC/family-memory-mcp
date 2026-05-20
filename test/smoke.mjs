// End-to-end smoke test: spawn the MCP server as a child process, drive it
// over stdio with raw MCP JSON-RPC frames, verify multi-user attribution
// + cross-user recall + forget permissions.

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { MongoClient } from 'mongodb';
import assert from 'node:assert/strict';

const MONGO = process.env.TEST_MONGO || 'mongodb://localhost:27029';
const DB = 'family_memory_test';
const COLLECTION = 'family_facts';
const SCRIPT = new URL('../src/index.js', import.meta.url).pathname.replace(/^\//, '');

async function reset() {
  const client = new MongoClient(MONGO);
  await client.connect();
  await client.db(DB).collection(COLLECTION).deleteMany({});
  try { await client.db(DB).collection(COLLECTION).dropIndexes(); } catch {}
  await client.close();
}

function makeClient(envOverrides) {
  const child = spawn(process.execPath, [SCRIPT], {
    env: {
      ...process.env,
      MONGODB_URI: MONGO,
      FAMILY_MEMORY_DB: DB,
      FAMILY_MEMORY_COLLECTION: COLLECTION,
      ...envOverrides,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let buf = '';
  const pending = new Map();
  let nextId = 1;

  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null && pending.has(msg.id)) {
          pending.get(msg.id).resolve(msg);
          pending.delete(msg.id);
        }
      } catch (e) {
        // ignore non-JSON
      }
    }
  });

  child.stderr.on('data', (d) => process.stderr.write(`[mcp:${envOverrides.LIBRECHAT_USER_USERNAME || '?'}] ${d}`));

  function send(method, params) {
    const id = nextId++;
    const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(frame);
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`timeout waiting for ${method}#${id}`));
        }
      }, 10000);
    });
  }

  async function init() {
    const r = await send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'smoke-test', version: '0' },
    });
    if (r.error) throw new Error('init failed: ' + JSON.stringify(r.error));
    // Send the initialized notification (no id, no response expected).
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    return r.result;
  }

  async function callTool(name, args) {
    const r = await send('tools/call', { name, arguments: args });
    if (r.error) throw new Error(`${name} failed: ${JSON.stringify(r.error)}`);
    return r.result;
  }

  async function listTools() {
    const r = await send('tools/list', {});
    if (r.error) throw new Error('tools/list failed: ' + JSON.stringify(r.error));
    return r.result;
  }

  async function close() {
    child.stdin.end();
    child.kill('SIGTERM');
    await once(child, 'exit').catch(() => {});
  }

  return { init, callTool, listTools, close };
}

function textOf(result) {
  return (result.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
}

async function run() {
  await reset();

  // ---- Test 1: Lavette boots, lists tools, remembers a fact ----
  const lavette = makeClient({
    LIBRECHAT_USER_ID: 'user-lavette-001',
    LIBRECHAT_USER_EMAIL: 'lavette@gonenova.com',
    LIBRECHAT_USER_USERNAME: 'lavette',
    LIBRECHAT_USER_ROLE: 'USER',
  });
  await lavette.init();
  const toolList = await lavette.listTools();
  const names = toolList.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['forget', 'list_recent', 'recall', 'remember', 'who_said']);
  console.log('✓ tools/list returns 5 tools:', names.join(', '));

  const rememberResult = await lavette.callTool('remember', {
    fact: "Mom has a doctor's appointment Tuesday at 3pm with Dr. Chen",
    category: 'appointment',
    tags: ['mom', 'doctor', 'appointment'],
  });
  const rememberText = textOf(rememberResult);
  console.log('✓ Lavette remembers:', rememberText.split('\n')[0]);
  assert.match(rememberText, /Remembered/);
  assert.match(rememberText, /author: lavette/);
  const factIdMatch = rememberText.match(/id=([a-f0-9]{24})/);
  assert.ok(factIdMatch, 'should return a fact id');
  const lavetteFactId = factIdMatch[1];

  await lavette.callTool('remember', {
    fact: 'The new dog\'s name is Luna and she is a corgi',
    category: 'pet',
    tags: ['dog', 'luna'],
  });
  await lavette.close();
  console.log('✓ Lavette stored 2 facts and disconnected');

  // ---- Test 2: Tyler (admin) connects, recalls Lavette's facts ----
  const tyler = makeClient({
    LIBRECHAT_USER_ID: 'user-tyler-000',
    LIBRECHAT_USER_EMAIL: 'tyler@gonenova.com',
    LIBRECHAT_USER_USERNAME: 'tyler',
    LIBRECHAT_USER_ROLE: 'ADMIN',
  });
  await tyler.init();

  const recall1 = textOf(await tyler.callTool('recall', { query: 'mom appointment' }));
  console.log('✓ Tyler recalls "mom appointment":\n   ' + recall1.split('\n')[0]);
  assert.match(recall1, /Dr\. Chen/);
  assert.match(recall1, /lavette/);

  const recall2 = textOf(await tyler.callTool('recall', { query: 'dog' }));
  console.log('✓ Tyler recalls "dog":\n   ' + recall2.split('\n').slice(0, 2).join('\n   '));
  assert.match(recall2, /Luna/);

  const whoSaid = textOf(await tyler.callTool('who_said', { query: 'Luna' }));
  console.log('✓ who_said("Luna"):\n   ' + whoSaid);
  assert.match(whoSaid, /lavette said/);

  // ---- Test 3: Tyler adds his own fact ----
  await tyler.callTool('remember', {
    fact: 'Tyler is moving to SF in June 2026',
    category: 'plan',
    tags: ['tyler', 'sf', 'move'],
  });

  const recent = textOf(await tyler.callTool('list_recent', { limit: 5 }));
  console.log('✓ list_recent returns', (recent.match(/\n/g) || []).length, 'lines');
  assert.match(recent, /Luna/);
  assert.match(recent, /SF/);

  // ---- Test 4: forget permissions ----
  // Tyler (admin) forgets Lavette's fact — should succeed.
  const adminForget = textOf(await tyler.callTool('forget', { factId: lavetteFactId }));
  console.log('✓ Admin Tyler forgets Lavette fact:', adminForget.split('\n')[0]);
  assert.match(adminForget, /Forgotten/);

  // Recall should no longer return it.
  const afterForget = textOf(await tyler.callTool('recall', { query: 'mom appointment' }));
  assert.doesNotMatch(afterForget, /Dr\. Chen/, 'forgotten fact should not appear in recall');
  console.log('✓ Forgotten fact no longer in recall');
  await tyler.close();

  // ---- Test 5: Kyle (non-admin) tries to forget Tyler's fact — should fail ----
  const kyle = makeClient({
    LIBRECHAT_USER_ID: 'user-kyle-002',
    LIBRECHAT_USER_EMAIL: 'kyle@gonenova.com',
    LIBRECHAT_USER_USERNAME: 'kyle',
    LIBRECHAT_USER_ROLE: 'USER',
  });
  await kyle.init();

  // Find Tyler's fact id
  const tylerFacts = textOf(await kyle.callTool('recall', { query: 'SF' }));
  const tylerFactIdMatch = tylerFacts.match(/id: ([a-f0-9]{24})/);
  assert.ok(tylerFactIdMatch, 'should find Tyler fact');
  const tylerFactId = tylerFactIdMatch[1];

  const denyResult = await kyle.callTool('forget', { factId: tylerFactId });
  const denyText = textOf(denyResult);
  console.log('✓ Kyle (non-admin) blocked from forgetting Tyler fact:', denyText.split('\n')[0]);
  assert.match(denyText, /Not allowed/);
  assert.equal(denyResult.isError, true);

  // Kyle CAN forget his own fact, though.
  const kyleRemember = textOf(await kyle.callTool('remember', { fact: 'Kyle prefers pepperoni pizza' }));
  const kyleFactId = kyleRemember.match(/id=([a-f0-9]{24})/)[1];
  const kyleForget = textOf(await kyle.callTool('forget', { factId: kyleFactId }));
  console.log('✓ Kyle forgets his own fact:', kyleForget.split('\n')[0]);
  assert.match(kyleForget, /Forgotten/);
  await kyle.close();

  // ---- Test 6: missing identity ----
  const anon = makeClient({
    LIBRECHAT_USER_ID: '',
    LIBRECHAT_USER_EMAIL: '',
    LIBRECHAT_USER_USERNAME: '',
    LIBRECHAT_USER_ROLE: 'USER',
  });
  await anon.init();
  const anonResult = await anon.callTool('remember', { fact: 'should fail' });
  console.log('✓ Anonymous (no user id) is rejected:', textOf(anonResult).slice(0, 80));
  assert.equal(anonResult.isError, true);
  await anon.close();

  console.log('\n  All smoke tests passed.');
}

run().catch((err) => {
  console.error('\nFAIL:', err);
  process.exit(1);
});
