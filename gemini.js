/* Free-tier AI option: Google Gemini (key from aistudio.google.com, no credit card). Used when no ANTHROPIC_API_KEY is set. */
const MODEL = () => process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const url = () => `https://generativelanguage.googleapis.com/v1beta/models/${MODEL()}:generateContent`;
const enabled = () => !!process.env.GEMINI_API_KEY;

async function call(body) {
  const r = await fetch(url(), { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
  const j = await r.json();
  if (!r.ok) { const e = new Error((j.error && j.error.message) || 'Gemini API ' + r.status); e.status = r.status; throw e; }
  return j;
}
const clean = (s) => {
  if (!s || typeof s !== 'object') return s;
  if (Array.isArray(s)) return s.map(clean);
  const o = {};
  for (const k of Object.keys(s)) { if (k === 'additionalProperties' || k === '$schema') continue; o[k] = clean(s[k]); }
  return o;
};
const parts = (j) => (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];

/* Same contract as claudeChat: run tools until the model answers in plain text. */
async function chat({ system, history, message, tools, runTool }) {
  const decl = tools.map((t) => { const p = clean(t.inputSchema); return { name: t.name, description: t.description, ...(p && p.properties && Object.keys(p.properties).length ? { parameters: p } : {}) }; });
  const contents = [...history.slice(-8).map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: String(m.text || '') }] })), { role: 'user', parts: [{ text: message }] }];
  for (let i = 0; i < 6; i++) {
    const j = await call({ systemInstruction: { parts: [{ text: system }] }, contents, tools: [{ functionDeclarations: decl }], generationConfig: { maxOutputTokens: 1800 } });
    const ps = parts(j), calls = ps.filter((p) => p.functionCall);
    if (!calls.length) return ps.filter((p) => p.text).map((p) => p.text).join('\n') || 'No answer. Try rephrasing.';
    contents.push({ role: 'model', parts: ps });
    const out = [];
    for (const c of calls) out.push({ functionResponse: { name: c.functionCall.name, response: { result: await runTool(c.functionCall.name, c.functionCall.args || {}) } } });
    contents.push({ role: 'user', parts: out });
  }
  return 'I ran out of reasoning steps. Try a narrower question.';
}

/* Photo reading: returns the model's raw text. */
async function vision(prompt, imgs) {
  const j = await call({ contents: [{ role: 'user', parts: [...imgs.map((x) => ({ inlineData: { mimeType: x.mime, data: x.buf.toString('base64') } })), { text: prompt }] }], generationConfig: { maxOutputTokens: 600 } });
  return parts(j).filter((p) => p.text).map((p) => p.text).join('');
}
module.exports = { enabled, chat, vision };
