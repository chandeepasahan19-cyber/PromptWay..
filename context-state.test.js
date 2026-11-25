'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const hotel = 'mata hotel ekakata website ekak hadaganna oni';
const result = { source: 'groq', basic: 'Hotel website basic', detailed: 'Hotel website detailed', creative: 'Hotel website creative', sinhalaSummary: 'Hotel summary', tamilSummary: 'Hotel summary', blocks: {}, tips: [] };
function app(saved) {
  const elements = new Map(), requests = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', textContent: '', innerHTML: '', style: {}, classList: { toggle() {}, add() {}, remove() {} }, setAttribute() {}, removeAttribute() {}, focus() {} });
    return elements.get(id);
  };
  const context = { window: saved ? { notebookAppApi: { getAppState: async () => saved } } : {}, document: { getElementById: element, querySelectorAll: () => [], addEventListener() {} }, Date, AbortSignal, setInterval, clearInterval, setTimeout, clearTimeout, fetch: async (url, options) => {
    requests.push(JSON.parse(options.body)); return { status: 200, ok: true, headers: new Headers(), json: async () => ({ ...result }) };
  }};
  vm.createContext(context);
  const html = fs.readFileSync('Multilingual_AI_Prompt_Generation_Mobile_Application11.html', 'utf8');
  vm.runInContext([...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]).filter(s => s.trim()).at(-1), context);
  vm.runInContext('showNotice=()=>{}; persistState=()=>{}; renderBuilderOutputs=()=>{}; renderSmartQuestions=()=>{}; renderAll=()=>{}; switchView=()=>{};', context);
  const run = code => vm.runInContext(code, context);
  return { context, requests, element, run, state: () => JSON.parse(run('JSON.stringify(appState)')), output: () => JSON.parse(run('JSON.stringify(currentGenerated)')), type(text) { element('idea-textarea').value = text; context.onIdeaTyping(); } };
}
test('fresh initialization is empty general, no inherited answers or generated templates', async () => {
  const a = app(); await a.context.initApp();
  assert.equal(a.state().ideaText, ''); assert.equal(a.state().category, 'general'); assert.deepEqual(a.state().answers, {}); assert.equal(a.requests.length, 0);
});
test('replacing sample invalidates inherited answers once, sends only current custom context', async () => {
  const a = app(); a.context.loadSample(0); assert.equal(a.state().answers.soc_brand, 'Lanka Tech Guide');
  a.type(hotel); assert.equal(a.state().category, 'general'); assert.deepEqual(a.state().answers, {});
  await a.context.generatePrompts(false);
  assert.equal(a.requests.length, 1); assert.equal(a.requests[0].ideaText, hotel); assert.deepEqual(a.requests[0].answers, {});
  assert(!JSON.stringify(a.requests[0]).match(/TikTok|Lanka Tech Guide/));
});
test('intentional user clarifications survive typing and replace inherited provenance', () => {
  const a = app(); a.type(hotel); a.context.updateSmartAnswer('gen_role', 'Website developer');
  a.type(hotel + ' booking system ekak ekka'); assert.equal(a.state().answers.gen_role, 'Website developer');
  a.context.loadSample(0); a.context.updateSmartAnswer('soc_brand', 'My hotel');
  a.type('Create a post for my hotel'); assert.equal(a.state().answers.soc_brand, 'My hotel'); assert.equal(a.state().answers.soc_platform, undefined);
});
test('category change prunes unrelated answers, preserves relevant ones', async () => {
  const a = app(); a.context.loadSample(0);
  a.element('category-select').value = 'general'; a.context.onCategoryChange();
  assert.deepEqual(a.state().answers, {});
  a.context.updateSmartAnswer('gen_role', 'Website engineer'); a.context.onCategoryChange();
  assert.equal(a.state().answers.gen_role, 'Website engineer');
  a.run('appState.answers.soc_brand="stale"'); await a.context.generatePrompts(false);
  assert.equal(a.requests[0].answers.soc_brand, undefined);
});
test('clear resets context, answers and previous results without generating', async () => {
  const a = app(); a.type(hotel); await a.context.generatePrompts(false); assert(a.output().basic);
  a.context.clearIdeaInput(); assert.equal(a.state().ideaText, ''); assert.equal(a.state().category, 'general'); assert.deepEqual(a.state().answers, {}); assert.equal(a.output().basic, ''); assert.equal(a.requests.length, 1);
});
test('template selection and saved prompt restore preserve answers only for their loaded idea', () => {
  const a = app(); const id = a.run('TEMPLATES[0].id'); a.context.useTemplate(id); assert(Object.keys(a.state().answers).length);
  a.type(hotel); assert.deepEqual(a.state().answers, {});
  a.run('appState.savedPrompts=[{id:"saved",ideaText:"Build hotel website",category:"general",platform:"ChatGPT",answers:{gen_role:"Web developer",soc_brand:"stale"}}]');
  a.context.reuseSavedPrompt('saved'); assert.equal(a.state().ideaText, 'Build hotel website'); assert.deepEqual(a.state().answers, { gen_role: 'Web developer' });
  a.type('Build a hospital website'); assert.deepEqual(a.state().answers, {});
});
test('draft and history restore bind their own answers to their own input', () => {
  const a = app();
  a.run('appState.drafts=[{id:"d",ideaText:"Hotel draft",category:"general",platform:"ChatGPT",answers:{gen_role:"Web developer"}}];appState.historyLog=[{id:"h",ideaText:"Hotel history",category:"general",platform:"ChatGPT",answers:{gen_role:"UI developer"}}]');
  a.context.loadDraft('d'); assert.equal(a.state().answers.gen_role, 'Web developer');
  a.context.reopenHistory('h'); assert.equal(a.state().answers.gen_role, 'UI developer');
});
test('editing generated input removes previous results; offline engine uses clean custom intent', async () => {
  const a = app(); a.type(hotel); await a.context.generatePrompts(false);
  a.type('Build hospital website'); assert.equal(a.output().source, 'none'); assert.equal(a.output().basic, '');
  a.context.loadSample(0); a.type(hotel); a.run('appState.engineMode="local"'); await a.context.updatePromptsAndView(true);
  assert.equal(a.output().source, 'local-engine'); assert(!a.output().basic.match(/TikTok|Lanka Tech Guide/));
});
test('legacy persisted sample answers are invalidated for unrelated restored custom input', async () => {
  const a = app({ ideaText: hotel, category: 'social', answers: { soc_brand: 'Lanka Tech Guide', soc_platform: 'TikTok' } });
  await a.context.initApp(); assert.deepEqual(a.state().answers, {}); assert.equal(a.state().category, 'general');
});
test('a late API response cannot restore results after Clear or a new idea', async () => {
  for (const change of ['clear', 'edit']) {
    const a = app(); a.type(hotel);
    let release;
    a.context.fetch = () => new Promise(resolve => { release = () => resolve({ ok: true, status: 200, headers: new Headers(), json: async () => ({ ...result }) }); });
    const pending = a.context.generatePrompts(false);
    if (change === 'clear') a.context.clearIdeaInput(); else a.type('Build a hospital website');
    release(); await pending;
    assert.equal(a.output().source, 'none'); assert.equal(a.output().basic, '');
  }
});
test('new generation clears previous output even for unchanged input if the API fails', async () => {
  const a = app(); a.type(hotel); await a.context.generatePrompts(false); assert(a.output().basic);
  a.context.fetch = async () => ({ ok: false, status: 502, headers: new Headers(), json: async () => ({ error: 'Mock failure' }) });
  await a.context.generatePrompts(false); assert.equal(a.output().basic, ''); assert.equal(a.output().source, 'none');
});
