import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { registerHooks } from 'node:module';
import { WebSocketServer } from 'ws';

const manifest = new URL('./node_modules/@koreaaitel/sdk/package.json', import.meta.url);
assert.equal(JSON.parse(readFileSync(manifest, 'utf8')).version, '0.63.0');

const account = 'ACFixtureReplay';
const callId = 'CAFixtureOutboundReplay';
const from = '07000000000';
const to = '01000000000';
const kaKey = 'fixture-kat-key';
const modelKey = 'fixture-model-key';
const inbound = Buffer.alloc(160, 0xe2).toString('base64');
const outbound = Buffer.alloc(160, 0x67).toString('base64');
const pending = new Map();
const peers = new Map();
let fail;
const failure = new Promise((_, reject) => { fail = reject; });
// Attach before event callbacks can reject while setup is running.
failure.catch(() => {});
function waitFor(name) {
  if (!pending.has(name)) pending.set(name, Promise.withResolvers());
  return pending.get(name);
}
function report(name, event) { waitFor(name).resolve(event); }
function guarded(action) {
  return (...args) => Promise.resolve().then(() => action(...args)).catch(fail);
}
function send(peer, msg) { peers.get(peer).send(JSON.stringify(msg)); }

const endpoint = `/v1/accounts/${account}`;
const http = createServer(guarded(async (req, res) => {
  try {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, `${endpoint}/calls`);
    assert.equal(req.headers.authorization, `Bearer ${kaKey}`);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    assert.deepEqual(JSON.parse(Buffer.concat(chunks)), { To: to, From: from, Timeout: 30 });
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ callId, status: 'queued' }));
    report('post', 201);
  } catch (err) {
    res.writeHead(400).end();
    throw err;
  }
}));
const sockets = new WebSocketServer({ server: http });
sockets.on('error', fail);
sockets.on('connection', guarded((peer, req) => {
  peer.on('error', fail);
  const target = new URL(req.url, 'http://127.0.0.1');
  let name;
  if (target.pathname === `${endpoint}/agent/listen`) {
    assert.equal(req.headers.authorization, `Bearer ${kaKey}`);
    assert.equal(target.searchParams.get('number'), from);
    name = 'control';
  } else if (target.pathname === '/media') {
    assert.equal(req.headers.authorization, undefined);
    assert.equal(target.searchParams.get('token'), 'fixture-media-token');
    name = 'media';
  } else {
    assert.equal(target.pathname, '/v1/realtime');
    assert.equal(target.searchParams.get('model'), 'gpt-realtime-2');
    assert.equal(req.headers.authorization, `Bearer ${modelKey}`);
    name = 'model';
  }
  assert(!peers.has(name), `Unexpected duplicate ${name} connection`);
  peers.set(name, peer);
  peer.on('message', guarded((raw) => {
    const msg = JSON.parse(raw);
    if (name === 'control' && msg.event === 'agent.hello') report('registered', true);
    if (name === 'model' && msg.type === 'session.update' && msg.session.audio) report('model-config', msg.session);
    if (name === 'model' && msg.type === 'input_audio_buffer.append') report('model-input', msg.audio);
    if (name === 'media' && msg.event === 'media') report('media-output', msg.media.payload);
  }));
  peer.on('close', () => report(`${name}-closed`, true));
}));

http.listen(0, '127.0.0.1');
await once(http, 'listening');
const base = `http://127.0.0.1:${http.address().port}`;
const wsBase = base.replace('http', 'ws');
const originalFetch = globalThis.fetch;
globalThis.fetch = (request, options) => {
  const target = new URL(request instanceof Request ? request.url : request);
  assert.equal(target.origin, base);
  return originalFetch(request, { ...options, redirect: 'error' });
};
const shim = `import { WebSocket as NativeSocket } from ${JSON.stringify(import.meta.resolve('ws'))};
export class WebSocket extends NativeSocket {
  constructor(address, options) {
    const original = new URL(address);
    const local = original.hostname === 'api.openai.com' && original.pathname === '/v1/realtime'
      ? new URL(original.pathname + original.search, ${JSON.stringify(wsBase)}) : original;
    if (local.origin !== ${JSON.stringify(wsBase)}) throw new Error('Only the fixture may be contacted');
    super(local, { ...options, followRedirects: false });
  }
}`;
const hookUrl = `data:text/javascript,${encodeURIComponent(shim)}`;
const hook = registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'ws' && context.parentURL?.includes('/node_modules/@koreaaitel/sdk/')) {
    return { url: hookUrl, shortCircuit: true };
  }
  return nextResolve(specifier, context);
} });
let agent;
let timer;
const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Fixture timed out')), 7000); });
try {
  await Promise.race([failure, deadline, (async () => {
    const { ClawOpsAgent, OpenAIRealtime } = await import('@koreaaitel/sdk/agent');
    agent = new ClawOpsAgent({
      apiKey: kaKey,
      accountId: account,
      baseUrl: base,
      from,
      prewarmEnabled: false,
      session: new OpenAIRealtime({ apiKey: modelKey, model: 'gpt-realtime-2', language: 'ko', greeting: false }),
    });
    const call = await agent.call(to, { timeout: 30 });
    assert.equal(call.callId, callId);
    assert.equal(await waitFor('post').promise, 201);
    await waitFor('registered').promise;
    send('control', { event: 'call.outbound_ready', callId, to, mediaUrl: `${wsBase}/media?token=fixture-media-token` });
    const session = await waitFor('model-config').promise;
    assert.equal(session.audio.input.format.type, 'audio/pcmu');
    assert.equal(session.audio.input.transcription.language, 'ko');
    assert.equal(session.audio.output.format.type, 'audio/pcmu');
    send('media', { event: 'media', media: { timestamp: '20', payload: inbound } });
    assert.equal(await waitFor('model-input').promise, inbound);
    send('model', { type: 'response.output_audio.delta', item_id: 'fixture-audio', delta: outbound });
    assert.equal(await waitFor('media-output').promise, outbound);
    send('control', { event: 'call.ended', callId, status: 'completed', duration: 7 });
    await call.wait();
    await waitFor('model-closed').promise;
    await waitFor('media-closed').promise;
    console.log(JSON.stringify({ post_calls: 201, control_registered: true, audio_format: 'PCMU',
      input_bytes: 160, output_bytes: 160, same_call_completed: true, media_and_model_sockets_closed: true }));
  })()]);
} finally {
  clearTimeout(timer);
  globalThis.fetch = originalFetch;
  hook.deregister();
  for (const peer of sockets.clients) peer.terminate();
  try { await agent?.disconnect(); } finally {
    sockets.close();
    await new Promise(resolve => http.close(resolve));
  }
}
