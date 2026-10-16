import { MODES, analyze, build, offSize, openPdf, plan } from './labels.js';

const $ = (id) => document.getElementById(id);
const MAX_BYTES = 20 * 1024 * 1024;
const DONE = new Set(['submitted', 'uncertain', 'cancelled', 'expired']);
const STATUS = {
  awaiting_confirmation: 'Aguardando confirmação',
  queued: 'Na fila',
  dispatching: 'Enviando',
  submitted: 'Enviado à impressora',
  uncertain: 'Incerto — confira',
  cancelled: 'Cancelado',
  expired: 'Expirado',
};
const MODE_HINTS = {
  casado: 'Etiqueta reduzida no topo e tabela de bens no rodapé.',
  etiquetas: 'Remove as páginas de declaração de conteúdo.',
  ajustar: 'Encaixa e gira cada página para caber na etiqueta.',
  original: 'Imprime o PDF exatamente como veio.',
};

const state = {
  label: { widthMm: 100, heightMm: 150 },
  file: null, // { name, bytes }
  pages: null,
  mode: null,
  output: null, // { bytes, count, key, jobId }
  generation: 0,
};

// ---------- API ----------
async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(path, { method, body, headers: { 'X-Toffa': '1', ...headers }, credentials: 'same-origin' });
  if (res.status === 401 && !path.startsWith('/auth/')) {
    showLogin();
    throw Object.assign(new Error('Sessão expirada; entre novamente.'), { status: 401 });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.detail || `Erro ${res.status}`), { status: res.status });
  return data;
}

// ---------- Sessão ----------
function showLogin() {
  $('app-view').hidden = true;
  $('printer').hidden = true;
  $('logout').hidden = true;
  $('login-view').hidden = false;
  $('password').focus();
}

async function start() {
  try {
    const health = await api('/health');
    state.label = { widthMm: health.label_width_mm, heightMm: health.label_height_mm };
    const printer = $('printer');
    const ready = health.printing_enabled && health.engine_available;
    printer.textContent = `${health.printer} · ${ready ? 'pronta' : 'impressão desativada'}`;
    printer.classList.toggle('bad', !ready);
    printer.hidden = false;
    $('logout').hidden = false;
    $('login-view').hidden = true;
    $('app-view').hidden = false;
    setStatus(null);
    refreshJobs();
  } catch (err) {
    if (err.status !== 401) setStatus(err.message, 'bad');
  }
}

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = $('login-error');
  error.hidden = true;
  try {
    await api('/auth/login', { method: 'POST', body: JSON.stringify({ password: $('password').value }), headers: { 'Content-Type': 'application/json' } });
    $('password').value = '';
    await start();
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
  }
});

$('logout').addEventListener('click', async () => {
  await api('/auth/logout', { method: 'POST' }).catch(() => {});
  showLogin();
});

// ---------- Arquivo ----------
const drop = $('drop');
drop.addEventListener('click', () => $('file').click());
drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file').click(); } });
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
});
$('file').addEventListener('change', (e) => { if (e.target.files[0]) loadFile(e.target.files[0]); e.target.value = ''; });

async function loadFile(file) {
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
    setStatus('Envie um arquivo PDF.', 'bad');
    return;
  }
  const generation = ++state.generation;
  clearOutput();
  setStatus(null);
  $('settings').hidden = true;
  $('drop-title').textContent = file.name;
  $('drop-sub').textContent = 'Clique para trocar o arquivo';
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const pages = await analyze(bytes, (n, total) => progress(n / total, `Lendo página ${n} de ${total}…`));
    if (generation !== state.generation) return;
    state.file = { name: file.name.replace(/\.pdf$/i, ''), bytes };
    state.pages = pages;
    const declarations = pages.filter((p) => p.declaration).length;
    state.mode = declarations && declarations < pages.length ? 'casado' : 'ajustar';
    renderSettings();
    await rebuild();
  } catch (err) {
    progress(null);
    console.error(err);
    setStatus(err.name === 'PasswordException' ? 'PDF protegido por senha não é suportado.' : `Não foi possível ler o PDF: ${err.message}`, 'bad');
  }
}

// ---------- Ajustes ----------
function renderSettings() {
  const { pages } = state;
  const declarations = pages.filter((p) => p.declaration).length;
  $('summary').textContent = `${pages.length} página${pages.length > 1 ? 's' : ''}` +
    (declarations ? ` · ${declarations} declaraç${declarations > 1 ? 'ões' : 'ão'} de conteúdo` : '');
  const modes = $('modes');
  modes.replaceChildren(...Object.entries(MODES).map(([value, title]) => {
    const needsDecl = value === 'casado' || value === 'etiquetas';
    const count = value === 'original' ? pages.length : plan(pages, value).length;
    const label = document.createElement('label');
    label.className = 'mode';
    const input = Object.assign(document.createElement('input'), { type: 'radio', name: 'mode', value, checked: value === state.mode, disabled: needsDecl && !declarations });
    input.addEventListener('change', () => { state.mode = value; updateSettingVisibility(); rebuild(); });
    const text = document.createElement('span');
    const hint = document.createElement('small');
    hint.textContent = needsDecl && !declarations ? 'Nenhuma declaração de conteúdo encontrada.' : `${MODE_HINTS[value]} ${count} etiqueta${count > 1 ? 's' : ''}.`;
    text.append(title, hint);
    label.append(input, text);
    return label;
  }));
  updateSettingVisibility();
  $('settings').hidden = false;
}

function updateSettingVisibility() {
  $('table-setting').hidden = state.mode !== 'casado';
  $('margin-setting').hidden = state.mode === 'original';
}

function syncOutputs() {
  $('table-height-val').textContent = `${$('table-height').value} pt`;
  $('margin-val').textContent = `${String($('margin').value).replace('.', ',')} mm`;
}

let timer;
for (const id of ['table-height', 'margin']) {
  const input = $(id);
  try { const saved = localStorage.getItem(`toffa-${id}`); if (saved) input.value = saved; } catch { /* sem armazenamento */ }
  input.addEventListener('input', () => {
    syncOutputs();
    try { localStorage.setItem(`toffa-${id}`, input.value); } catch { /* sem armazenamento */ }
    clearTimeout(timer);
    timer = setTimeout(rebuild, 250);
  });
}
syncOutputs();

// ---------- Montagem e prévia ----------
async function rebuild() {
  if (!state.file) return;
  const generation = ++state.generation;
  clearOutput();
  setStatus(null);
  const warnings = [];
  try {
    let result;
    if (state.mode === 'original') {
      result = { bytes: state.file.bytes, count: state.pages.length };
      const wrong = offSize(state.pages, state.label.widthMm, state.label.heightMm);
      if (wrong) warnings.push(`${wrong} página${wrong > 1 ? 's' : ''} fora de ${state.label.widthMm} × ${state.label.heightMm} mm: podem sair cortadas.`);
    } else {
      result = await build(state.file.bytes, state.pages, {
        mode: state.mode,
        ...state.label,
        marginMm: Number($('margin').value),
        tableHeightPt: Number($('table-height').value),
        title: state.file.name,
      }, (n, total) => progress(n / total, `Montando etiqueta ${n} de ${total}…`));
      if (state.mode === 'casado') {
        const single = result.count - result.paired;
        if (single) warnings.push(`${single} página${single > 1 ? 's' : ''} sem par etiqueta/declaração: saem sozinhas.`);
      }
    }
    if (generation !== state.generation) return;
    if (result.bytes.length > MAX_BYTES) warnings.push(`PDF final com ${(result.bytes.length / 1048576).toFixed(1)} MB; o limite é 20 MB. Divida o arquivo.`);
    state.output = { bytes: result.bytes, count: result.count, key: crypto.randomUUID(), jobId: null };
    $('warning').textContent = warnings.join(' ');
    $('warning').hidden = !warnings.length;
    await renderPreview(generation);
  } catch (err) {
    console.error(err);
    setStatus(`Falha ao montar as etiquetas: ${err.message}`, 'bad');
  } finally {
    if (generation === state.generation) progress(null);
  }
}

let previewDoc = null;
let observer = null;

function clearOutput() {
  state.output = null;
  observer?.disconnect();
  previewDoc?.destroy();
  previewDoc = null;
  $('preview').replaceChildren(Object.assign(document.createElement('p'), { className: 'empty muted', textContent: state.file ? 'Montando…' : 'Escolha um PDF para ver as etiquetas aqui.' }));
  $('preview-meta').textContent = '';
  updateButtons();
}

async function renderPreview(generation) {
  const doc = await openPdf(state.output.bytes);
  if (generation !== state.generation) { doc.destroy(); return; }
  previewDoc = doc;
  const { count } = state.output;
  $('preview-meta').textContent = `· ${count} etiqueta${count > 1 ? 's' : ''} · ${(state.output.bytes.length / 1048576).toFixed(1)} MB`;
  observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      draw(doc, Number(entry.target.dataset.page), entry.target.querySelector('canvas'), 320).catch(() => {});
    }
  }, { rootMargin: '400px' });
  const sheets = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const sheet = document.createElement('figure');
    sheet.className = 'sheet';
    sheet.dataset.page = n;
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('aria-label', `Ampliar etiqueta ${n}`);
    button.append(document.createElement('canvas'));
    button.addEventListener('click', () => zoom(doc, n));
    const caption = document.createElement('figcaption');
    caption.textContent = n;
    sheet.append(button, caption);
    sheets.push(sheet);
  }
  $('preview').replaceChildren(...sheets);
  sheets.forEach((s) => observer.observe(s));
  updateButtons();
}

async function draw(doc, n, canvas, width) {
  const page = await doc.getPage(n);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: (width * devicePixelRatio) / base.width });
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
}

async function zoom(doc, n) {
  const canvas = $('zoom-canvas');
  const height = Math.min(window.innerHeight - 110, 900);
  await draw(doc, n, canvas, height * (100 / 150));
  canvas.style.width = `${Math.round(height * (100 / 150))}px`;
  $('zoom').showModal();
}

// ---------- Ações ----------
function updateButtons() {
  const out = state.output;
  $('download').disabled = !out;
  $('print').disabled = !out || out.bytes.length > MAX_BYTES;
  $('print').textContent = !out ? 'Imprimir' : `${out.jobId ? 'Imprimir de novo' : 'Imprimir'} ${out.count} etiqueta${out.count > 1 ? 's' : ''}`;
}

$('download').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([state.output.bytes], { type: 'application/pdf' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `${state.file.name}-etiquetas.pdf` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
});

function ask(title, text, okLabel) {
  $('confirm-title').textContent = title;
  $('confirm-text').textContent = text;
  $('confirm').querySelector('button[value=ok]').textContent = okLabel;
  $('confirm').returnValue = '';
  $('confirm').showModal();
  return new Promise((resolve) => $('confirm').addEventListener('close', () => resolve($('confirm').returnValue === 'ok'), { once: true }));
}

$('print').addEventListener('click', async () => {
  const out = state.output;
  const again = Boolean(out.jobId);
  const noun = `${out.count} etiqueta${out.count > 1 ? 's' : ''}`;
  const ok = await ask(
    again ? 'Imprimir de novo?' : 'Imprimir etiquetas?',
    again ? `Este PDF já foi enviado. Enviar mais uma vez ${noun} para a impressora?` : `Enviar ${noun} de “${state.file.name}” para a impressora?`,
    `Imprimir ${noun}`,
  );
  if (!ok || out !== state.output) return;
  if (again) out.key = crypto.randomUUID();
  $('print').disabled = true;
  setStatus('Enviando o PDF…');
  let job;
  try {
    job = await api('/v1/jobs', { method: 'POST', body: out.bytes, headers: { 'Content-Type': 'application/pdf', 'Idempotency-Key': out.key } });
    remember(job.id, state.file.name, out.count);
    out.jobId = job.id;
    job = await api(`/v1/jobs/${job.id}/confirm`, { method: 'POST' });
  } catch (err) {
    if (job?.id) await api(`/v1/jobs/${job.id}`, { method: 'DELETE' }).catch(() => {});
    setStatus(`Não foi impresso: ${err.message}`, 'bad');
    updateButtons();
    refreshJobs();
    return;
  }
  updateButtons();
  await follow(job);
});

async function follow(job) {
  const started = Date.now();
  while (!DONE.has(job.status) && Date.now() - started < 5 * 60_000) {
    setStatus(`${STATUS[job.status] || job.status}…`);
    await new Promise((r) => setTimeout(r, 1500));
    try { job = await api(`/v1/jobs/${job.id}`); } catch { /* tenta de novo */ }
  }
  refreshJobs();
  if (job.status === 'submitted') setStatus('Enviado à impressora. Confira as etiquetas impressas.', 'ok');
  else if (job.status === 'uncertain') setStatus(`${job.detail || 'Envio incerto.'} Não reimprima antes de conferir.`, 'warn');
  else if (DONE.has(job.status)) setStatus(STATUS[job.status], 'bad');
  else setStatus('Ainda na fila. Acompanhe em “Impressões recentes”.', 'warn');
}

// ---------- Histórico ----------
function names() {
  try { return JSON.parse(localStorage.getItem('toffa-jobs')) || {}; } catch { return {}; }
}

function remember(id, name, count) {
  const all = names();
  all[id] = { name, count, at: Date.now() };
  const recent = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, 50);
  try { localStorage.setItem('toffa-jobs', JSON.stringify(Object.fromEntries(recent))); } catch { /* sem armazenamento */ }
}

async function refreshJobs() {
  let jobs;
  try { jobs = await api('/v1/jobs'); } catch { return; }
  const known = names();
  const list = $('jobs');
  if (!jobs.length) {
    list.replaceChildren(Object.assign(document.createElement('li'), { className: 'muted', textContent: 'Nenhuma impressão ainda.' }));
    return;
  }
  list.replaceChildren(...jobs.slice(0, 10).map((job) => {
    const li = document.createElement('li');
    const info = known[job.id];
    const name = Object.assign(document.createElement('span'), { className: 'name', textContent: info ? `${info.name} · ${info.count} etiq.` : `Pedido ${job.id.slice(0, 8)}` });
    name.title = job.detail || '';
    const badge = Object.assign(document.createElement('span'), { className: `badge ${job.status}`, textContent: STATUS[job.status] || job.status });
    const meta = Object.assign(document.createElement('span'), { className: 'meta', textContent: new Date(job.created * 1000).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) });
    li.append(name, badge, meta);
    if (job.status === 'awaiting_confirmation' || job.status === 'queued') {
      const cancel = Object.assign(document.createElement('button'), { className: 'btn ghost small danger', textContent: 'Cancelar' });
      cancel.addEventListener('click', async () => { await api(`/v1/jobs/${job.id}`, { method: 'DELETE' }).catch(() => {}); refreshJobs(); });
      li.append(cancel);
    }
    return li;
  }));
}
$('jobs-refresh').addEventListener('click', refreshJobs);
setInterval(() => { if (!document.hidden && !$('app-view').hidden) refreshJobs(); }, 15_000);

// ---------- Utilidades ----------
function progress(fraction, text) {
  $('progress').hidden = fraction == null;
  if (fraction == null) return;
  $('progress-bar').style.width = `${Math.round(fraction * 100)}%`;
  $('progress-text').textContent = text;
}

function setStatus(text, kind = '') {
  const el = $('status');
  el.hidden = !text;
  el.textContent = text || '';
  el.className = `status ${kind}`;
}

start();
