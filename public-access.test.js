'use strict';
// Loopback HTTP and mocked upstream services only; never uses real credentials.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const http = require('node:http');
const source = fs.readFileSync('server.js', 'utf8');
const input = { ideaText: 'Build a hotel website', inputLang: 'singlish', category: 'general', platform: 'ChatGPT', answers: {}, refinement: 'none' };
const generated = { detectedLang: 'Singlish', basic: 'Basic', detailed: 'Detailed', creative: 'Creative', sinhalaSummary: 'Summary', tamilSummary: 'Summary', whyWorks: 'Explanation', blocks: { role: 'r', context: 'c', task: 't', constraints: 'c', format: 'f' }, clarityScore: 80, tips: [] };

function quotaService() {
  let now = 0;
  const counters = new Map();
  return {
    advance(seconds) { now += seconds; },
    // Model the Redis command contract; actual Lua is also passed unchanged to
    // EVAL by the application. No process-local state is shared by app fixtures.
    async fetch(url, options) {
      assert.equal(url, 'https://test-quota.upstash.io');
      assert.equal(options.headers.Authorization, 'Bearer quota-test-token');
      assert.equal(options.redirect, 'error');
      const command = JSON.parse(options.body);
      assert.equal(command[0], 'EVAL');
      assert.equal(command[2], '2');
      assert.deepEqual(command.slice(3), ['{promptway-public}:minute', '{promptway-public}:day', '10', '60', '100', '86400']);
      assert(!options.body.includes(input.ideaText));
      assert(!options.body.includes('groq-test-key'));
      const keys = command.slice(3, 5), args = command.slice(5).map(Number);
      for (const key of keys) if (counters.get(key)?.expiry <= now) counters.delete(key);
      let retry = 0;
      keys.forEach((key, i) => {
        const entry = counters.get(key);
        if (entry && entry.count >= args[i * 2]) retry = Math.max(retry, entry.expiry - now, 1);
      });
      if (!retry) keys.forEach((key, i) => {
        const entry = counters.get(key) || { count: 0, expiry: now + args[i * 2 + 1] };
        entry.count++;
        counters.set(key, entry);
      });
      return { ok: true, json: async () => ({ result: retry ? [0, retry] : [1, 0] }) };
    }
  };
}

async function instance({ quota = quotaService(), env = {}, groqStatus = 200 } = {}) {
  let groqCalls = 0;
  const context = { require, module: { exports: {} }, __dirname, Date, AbortSignal, console,
    process: { env: { VERCEL: '1', VERCEL_URL: 'test-deployment.vercel.app',
      GROQ_API_KEY: 'groq-test-key', GROQ_MODEL: 'qwen/qwen3.8-27b',
      UPSTASH_REDIS_REST_URL: 'https://test-quota.upstash.io', UPSTASH_REDIS_REST_TOKEN: 'quota-test-token', ...env } },
    fetch: async (url, options) => {
      if (url !== 'https://api.groq.com/openai/v1/chat/completions') return quota.fetch(url, options);
      groqCalls++;
      assert.equal(options.headers.Authorization, 'Bearer groq-test-key');
      assert.equal(JSON.parse(options.body).model, 'qwen/qwen3.8-27b');
      return { ok: groqStatus === 200, status: groqStatus, headers: new Headers(),
        json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(generated) } }] }) };
    }
  };
  vm.runInNewContext(source, context);
  const server = context.module.exports.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  return {
    groqCalls: () => groqCalls,
    close: () => new Promise(resolve => server.close(resolve)),
    send(path = '/api/groq/prompts', { method = 'POST', body = input, headers = {} } = {}) {
      return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: server.address().port, path, method,
          headers: { Host: 'promptway-omega.vercel.app', 'Content-Type': 'application/json', ...headers } }, res => {
          let body = '';
          res.on('data', chunk => { body += chunk; });
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        });
        req.on('error', reject);
        req.end(method === 'GET' ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
      });
    }
  };
}

test('production HTML and Groq generation are public, including when obsolete demo credentials remain', async () => {
  for (const env of [{}, { DEMO_USER: 'obsolete', DEMO_PASSWORD: 'obsolete' }]) {
    const app = await instance({ env });
    try {
      for (const path of ['/', '/Multilingual_AI_Prompt_Generation_Mobile_Application11.html']) {
        const page = await app.send(path, { method: 'GET' });
        assert.equal(page.status, 200);
        assert.equal(page.headers['www-authenticate'], undefined);
        assert(page.body.includes('language-accuracy-tip'));
        assert(!page.body.includes('groq-test-key'));
      }
      const response = await app.send();
      assert.equal(response.status, 200);
      const body = JSON.parse(response.body);
      assert.equal(body.source, 'groq');
      assert.equal(body.model, 'qwen/qwen3.8-27b');
      for (const key of ['basic', 'detailed', 'creative', 'sinhalaSummary', 'tamilSummary']) assert(body[key]);
      assert.equal(app.groqCalls(), 1);
      assert(!response.body.includes('groq-test-key'));
      assert(!response.body.includes('quota-test-token'));
    } finally { await app.close(); }
  }
});

test('public access preserves confidential routes, host/origin checks and input/body validation', async () => {
  const app = await instance();
  try {
    for (const path of ['/.env', '/.env.local', '/server.js', '/package.json', '/backup/Multilingual_AI_Prompt_Generation_Mobile_Application11.html', '/.vercel/project.json']) {
      assert.equal((await app.send(path, { method: 'GET' })).status, 404);
    }
    assert.equal((await app.send('/', { method: 'GET', headers: { Host: 'untrusted.example' } })).status, 403);
    assert.equal((await app.send(undefined, { headers: { Origin: 'https://untrusted.example' } })).status, 403);
    assert.equal((await app.send(undefined, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await app.send(undefined, { body: {} })).status, 400);
    assert.equal((await app.send(undefined, { body: '{' })).status, 400);
    assert.equal((await app.send(undefined, { body: { ...input, ideaText: 'x'.repeat(25000) } })).status, 413);
    assert.equal(app.groqCalls(), 0);
  } finally { await app.close(); }
});

test('shared quota limits independent instances and a fresh cold start, then resets the minute window', async () => {
  const quota = quotaService(), a = await instance({ quota }), b = await instance({ quota });
  let cold;
  try {
    for (let i = 0; i < 10; i++) assert.equal((await (i % 2 ? a : b).send()).status, 200);
    const limited = await a.send();
    assert.equal(limited.status, 429);
    assert.equal(limited.headers['retry-after'], '60');
    cold = await instance({ quota });
    assert.equal((await cold.send()).status, 429);
    assert.equal(cold.groqCalls(), 0);
    quota.advance(60);
    assert.equal((await cold.send()).status, 200);
    assert.equal(a.groqCalls() + b.groqCalls() + cold.groqCalls(), 11);
  } finally { await a.close(); await b.close(); if (cold) await cold.close(); }
});

test('daily shared budget survives instance recycling and minute resets', async () => {
  const quota = quotaService();
  for (let group = 0; group < 10; group++) {
    const app = await instance({ quota });
    try { for (let i = 0; i < 10; i++) assert.equal((await app.send()).status, 200); }
    finally { await app.close(); }
    quota.advance(60);
  }
  const app = await instance({ quota });
  try {
    const denied = await app.send();
    assert.equal(denied.status, 429);
    assert.equal(denied.headers['retry-after'], '85800');
    assert.equal(app.groqCalls(), 0);
    quota.advance(85800);
    assert.equal((await app.send()).status, 200);
  } finally { await app.close(); }
});

test('production fails closed when quota config/service is missing, invalid, exhausted or unavailable', async () => {
  const cases = [
    { env: { UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '' } },
    { env: { UPSTASH_REDIS_REST_TOKEN: '' } },
    { env: { UPSTASH_REDIS_REST_URL: 'https://untrusted.example' } },
    { quota: { fetch: async () => { throw new Error('private-provider-detail'); } } },
    { quota: { fetch: async () => ({ ok: false }) } },
    ...[{}, { error: 'private-provider-detail' }, { result: [1, -1] }, { result: [1, 10] }, { result: [0, 0] }, { result: [2, 0] }]
      .map(body => ({ quota: { fetch: async () => ({ ok: true, json: async () => body }) } }))
  ];
  for (const options of cases) {
    const app = await instance(options);
    try {
      assert.equal((await app.send('/', { method: 'GET' })).status, 200);
      const response = await app.send();
      assert.equal(response.status, 503);
      assert(!response.body.includes('private-provider-detail'));
      assert.equal(app.groqCalls(), 0);
    } finally { await app.close(); }
  }
});

test('no API-key disclosure or browser login challenge when Groq rejects backend credentials', async () => {
  const app = await instance({ groqStatus: 401 });
  try {
    const response = await app.send();
    assert.equal(response.status, 502);
    assert.equal(response.headers['www-authenticate'], undefined);
    assert(!response.body.includes('groq-test-key'));
  } finally { await app.close(); }
});
