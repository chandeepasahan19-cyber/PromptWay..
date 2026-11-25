'use strict';
// No credentials or external network: Groq is mocked; HTTP tests use loopback only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const http = require('node:http');
const file = 'Multilingual_AI_Prompt_Generation_Mobile_Application11.html';
const input = { ideaText: 'Test idea', inputLang: 'english', category: 'general', platform: 'ChatGPT', answers: {}, refinement: 'none' };
const result = { detectedLang: 'English', basic: 'Basic', detailed: 'Detailed', creative: 'Creative', sinhalaSummary: 'සිංහල', tamilSummary: 'தமிழ்', whyWorks: 'Framework', blocks: { role: 'r', context: 'c', task: 't', constraints: 'c', format: 'f' }, clarityScore: 80, tips: [] };
function response(status, headers = {}) {
  return { status, ok: status === 200, headers: new Headers(headers), json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] }) };
}
async function backend(mock, run) {
  let now = 1700000000000;
  class Clock extends Date { static now() { return now; } }
  const context = { require, module: { exports: {} }, __dirname, process: { env: { GROQ_API_KEY: 'mock-only', GROQ_MODEL: 'qwen/qwen3.8-27b' } }, Date: Clock, AbortSignal, fetch: mock, console };
  vm.runInNewContext(fs.readFileSync('server.js', 'utf8'), context);
  const server = context.module.exports.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const send = () => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: '/api/groq/prompts', method: 'POST', headers: { Host: 'localhost:3000', 'Content-Type': 'application/json' } }, res => {
      let body = ''; res.on('data', c => body += c); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(body) }));
    });
    req.on('error', reject); req.end(JSON.stringify(input));
  });
  try { await run(send, ms => now += ms); } finally { await new Promise(resolve => server.close(resolve)); }
}
test('429 burst: one upstream call; actual Retry-After countdown; no automatic retry', async () => {
  let calls = 0;
  await backend(async () => { calls++; return response(429, { 'Retry-After': '12' }); }, async (send, advance) => {
    assert.equal((await send()).headers['retry-after'], '12');
    for (let i = 0; i < 9; i++) assert.equal((await send()).status, 429);
    assert.equal(calls, 1);
    advance(5000); assert.equal((await send()).headers['retry-after'], '7');
    advance(7000); assert.equal(calls, 1);
    await send(); assert.equal(calls, 2);
  });
});
test('successful response exhausted token headers prevent next call until reset', async () => {
  let calls = 0;
  await backend(async (url, options) => {
    calls++;
    const body = JSON.parse(options.body);
    assert.equal(body.max_completion_tokens, 2800); assert.equal(body.reasoning_effort, 'none');
    assert(body.messages[0].content.includes('current ideaText is the primary source of truth'));
    assert(body.messages[0].content.includes('Never invent business names'));
    assert(body.messages[0].content.includes('all three prompts') || body.messages[0].content.includes('All three prompts'));
    return response(200, { 'x-ratelimit-remaining-tokens': '0', 'x-ratelimit-reset-tokens': '1m2.5s' });
  }, async (send, advance) => {
    const r = await send(); assert.equal(r.status, 200); assert.equal(r.headers['retry-after'], '63');
    for (const field of ['basic','detailed','creative','sinhalaSummary','tamilSummary']) assert(r.body[field]);
    assert.equal((await send()).status, 429); assert.equal(calls, 1);
    advance(63000); assert.equal((await send()).status, 200); assert.equal(calls, 2);
  });
});
test('HTTP-date Retry-After, exhausted request reset and missing-header fallback', async () => {
  for (const [headers, seconds] of [
    [{ 'Retry-After': new Date(1700000000000 + 18000).toUTCString() }, '18'],
    [{ 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '2m3s' }, '123'],
    [{}, '60']
  ]) await backend(async () => response(429, headers), async send => assert.equal((await send()).headers['retry-after'], seconds));
});
test('two overlapping requests cannot both reach Groq', async () => {
  let calls = 0, release, started;
  const pending = new Promise(resolve => { started = resolve; });
  await backend(async () => { calls++; started(); return new Promise(resolve => { release = () => resolve(response(200)); }); }, async send => {
    const first = send(); await pending;
    assert.equal((await send()).status, 409); assert.equal(calls, 1);
    release(); assert.equal((await first).status, 200);
  });
});
function frontend(mock) {
  let now = 1700000000000, interval;
  class Clock extends Date { static now() { return now; } }
  const button = { disabled: false, setAttribute() {}, removeAttribute() {}, classList: { toggle() {} }, getAttribute: () => 'none' };
  const notices = [];
  const context = {
    Date: Clock, AbortSignal, fetch: mock, setInterval: fn => { interval = fn; return 1; }, clearInterval: () => { interval = null; },
    appState: { ...input, engineMode: 'groq' }, currentGenerated: { ...result }, CATEGORY_QUESTIONS: { general: [] }, renderSmartQuestions() {},
    document: { querySelectorAll: () => [button], getElementById: () => ({ value: 'Test idea' }) },
    showNotice: message => notices.push(message), renderBuilderOutputs() {}, persistState() {}, runLocalPromptEngine: () => result
  };
  const html = fs.readFileSync(file, 'utf8');
  const sections = [
    html.slice(html.indexOf('    function relevantAnswers'), html.indexOf('    // Server-side Groq proxy.')),
    html.slice(html.indexOf('    async function fetchGroqPrompts'), html.indexOf('    // 4. LOCAL')),
    html.slice(html.indexOf('    async function updatePromptsAndView'), html.indexOf('    function renderBuilderOutputs')),
    html.slice(html.indexOf('    function applyRefinement(mode)'), html.indexOf('    function setVariationFilter')),
    html.slice(html.indexOf('    async function generatePrompts'), html.indexOf('    function toggleVoiceInput'))
  ];
  vm.createContext(context); vm.runInContext(sections.join('\n'), context);
  return { context, button, notices, advance(ms) { now += ms; if (interval) interval(); } };
}
test('frontend double clicks, direct duplicate updates and refinement while pending send once', async () => {
  let calls = 0, release;
  const f = frontend(async () => { calls++; return new Promise(resolve => { release = () => resolve({ ok: true, status: 200, headers: new Headers(), json: async () => result }); }); });
  const first = f.context.generatePrompts(false);
  assert(f.button.disabled);
  await f.context.generatePrompts(false); await f.context.updatePromptsAndView(true); f.context.applyRefinement('shorter');
  assert.equal(calls, 1); release(); await first; assert.equal(f.button.disabled, false);
  await f.context.updatePromptsAndView(); assert.equal(calls, 1);
});
test('frontend cooldown blocks clicks/refinements and counts down without retrying', async () => {
  let calls = 0;
  const f = frontend(async () => { calls++; return { ok: false, status: 429, headers: new Headers({ 'Retry-After': '12' }), json: async () => ({ error: 'Rate limited' }) }; });
  await f.context.generatePrompts(false); assert(f.button.disabled);
  f.advance(5000); assert(f.notices.at(-1).includes('7 seconds'));
  await f.context.generatePrompts(false); f.context.applyRefinement('shorter'); assert.equal(calls, 1);
  f.advance(7000); assert.equal(f.button.disabled, false); assert.equal(calls, 1);
  await f.context.generatePrompts(false); assert.equal(calls, 2);
});
test('frontend missing Retry-After labels the fallback as estimated', async () => {
  const f = frontend(async () => ({ ok: false, status: 429, headers: new Headers(), json: async () => ({ error: 'Rate limited' }) }));
  await f.context.generatePrompts(false); assert(f.notices.at(-1).includes('estimated')); assert(f.button.disabled);
});
test('frontend allows another explicit action after success, preserves offline engine during cooldown', async () => {
  let calls = 0;
  const f = frontend(async () => { calls++; return { ok: true, status: 200, headers: new Headers(), json: async () => result }; });
  await f.context.generatePrompts(false);
  await f.context.updatePromptsAndView(true);
  assert.equal(calls, 2);
  vm.runInContext('startGroqCooldown(12000, false)', f.context);
  f.context.appState.engineMode = 'local';
  vm.runInContext('refreshGenerationControls()', f.context); // toggleEngineMode refreshes controls.
  const local = await f.context.updatePromptsAndView(true);
  assert.equal(local.source, 'local-engine'); assert.equal(calls, 2); assert.equal(f.button.disabled, false);
});
test('server labels unknown retry time as estimated, including blocked subsequent requests', async () => {
  await backend(async () => response(429), async send => {
    assert.equal((await send()).headers['x-retry-after-estimated'], 'true');
    assert.equal((await send()).headers['x-retry-after-estimated'], 'true');
  });
});
