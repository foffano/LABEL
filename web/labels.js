// Montagem das etiquetas no navegador. A lógica do modo "casado" vem da extensão
// PDF Casado Pro: a página da etiqueta encolhe e a tabela "Identificação dos bens"
// da declaração seguinte é recortada e colada no rodapé.
import { PDFDocument, PDFNumber, PDFOperator, degrees } from './vendor/pdf-lib.min.js';
import * as pdfjs from './vendor/pdf.min.js';

pdfjs.GlobalWorkerOptions.workerSrc = '/static/vendor/pdf.worker.min.js';

export const MM = 72 / 25.4;
export { pdfjs };

export const MODES = {
  casado: 'Etiqueta + tabela da declaração',
  etiquetas: 'Somente etiquetas (descarta declarações)',
  ajustar: 'Ajustar cada página ao tamanho da etiqueta',
  original: 'Enviar sem alteração',
};

const plain = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function openPdf(bytes) {
  // isEvalSupported=false impede execução de código vindo de fontes do PDF.
  return pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
}

// Lê o texto de cada página para achar declarações de conteúdo e os limites da tabela.
export async function analyze(bytes, onProgress = () => {}) {
  const doc = await openPdf(bytes);
  const pages = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      onProgress(n, doc.numPages);
      const page = await doc.getPage(n);
      const [left, bottom, right, top] = page.view;
      const items = (await page.getTextContent()).items
        .filter((item) => 'str' in item && item.str.trim())
        .map((item) => ({ text: plain(item.str), y: item.transform[5] }));
      const header = items.find((item) => item.text.includes('identifica') && item.text.includes('bens'));
      const info = { box: { left, bottom, right, top }, rotate: page.rotate, declaration: false, table: null };
      if (header) {
        info.declaration = true;
        // Linhas abaixo do cabeçalho; para no primeiro vão grande para não levar
        // textos soltos do fim da página. Ignora as faixas de 15 pt das bordas.
        const ys = items.map((item) => item.y)
          .filter((y) => y < header.y && y > bottom + 15 && y < top - 15)
          .sort((a, b) => b - a);
        let lowest = header.y;
        for (const y of ys) {
          if (lowest - y > 40) break;
          lowest = y;
        }
        const tableTop = Math.min(header.y + 12, top);
        const tableBottom = Math.max(bottom + 5, lowest - 8);
        if (tableTop - tableBottom > 10) info.table = { left, right, top: tableTop, bottom: tableBottom };
      }
      pages.push(info);
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }
  return pages;
}

// Lista de etiquetas de saída: cada item tem a página principal e, opcionalmente, a declaração.
export function plan(pages, mode) {
  const out = [];
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    if (mode === 'etiquetas' && page.declaration) continue;
    const next = pages[i + 1];
    if (mode === 'casado' && !page.declaration && next?.table) {
      out.push({ label: i, table: i + 1 });
      i++;
    } else {
      out.push({ label: i, table: null });
    }
  }
  return out;
}

function clip(page, x, y, w, h) {
  const n = (v) => PDFNumber.of(v);
  page.pushOperators(PDFOperator.of('q'), PDFOperator.of('re', [n(x), n(y), n(w), n(h)]), PDFOperator.of('W'), PDFOperator.of('n'));
}

// Desenha `box` (espaço do usuário da página de origem) dentro de `region`,
// respeitando /Rotate. O recorte explícito garante que nada vaze da região,
// mesmo em leitores que ignoram o BBox do XObject.
async function place(out, target, source, box, rotation, region, { autoRotate = false, maxScale = Infinity, valign = 'center' } = {}) {
  const embedded = await out.embedPage(source, box);
  const w = box.right - box.left;
  const h = box.top - box.bottom;
  let r = ((rotation % 360) + 360) % 360;
  let dw = r % 180 ? h : w;
  let dh = r % 180 ? w : h;
  if (autoRotate && Math.abs(dw - dh) > 1 && (dw > dh) !== (region.w > region.h)) {
    r = (r + 90) % 360;
    [dw, dh] = [dh, dw];
  }
  const s = Math.min(region.w / dw, region.h / dh, maxScale);
  const ox = region.x + (region.w - dw * s) / 2;
  const oy = valign === 'top' ? region.y + region.h - dh * s : region.y + (region.h - dh * s) / 2;
  // /Rotate gira no sentido horário; drawPage gira no anti-horário em torno de (x, y).
  const ccw = (360 - r) % 360;
  let x = ox;
  let y = oy;
  if (ccw === 90) x += h * s;
  if (ccw === 180) { x += w * s; y += h * s; }
  if (ccw === 270) y += w * s;
  clip(target, ox, oy, dw * s, dh * s);
  target.drawPage(embedded, { x, y, xScale: s, yScale: s, rotate: degrees(ccw) });
  target.pushOperators(PDFOperator.of('Q'));
}

// opts: { mode, widthMm, heightMm, marginMm, tableHeightPt }
export async function build(bytes, pages, opts, onProgress = () => {}) {
  const items = plan(pages, opts.mode);
  const src = await PDFDocument.load(bytes);
  const out = await PDFDocument.create();
  // Uma única cópia compartilha fontes e imagens entre páginas; embutir direto
  // da origem duplicaria esses recursos a cada etiqueta (PDF ~2× maior).
  const used = [...new Set(items.flatMap((i) => (i.table == null ? [i.label] : [i.label, i.table])))];
  const copies = await out.copyPages(src, used);
  const srcPages = Object.fromEntries(used.map((index, k) => [index, copies[k]]));
  const W = opts.widthMm * MM;
  const H = opts.heightMm * MM;
  const m = opts.marginMm * MM;
  const area = { x: m, y: m, w: W - 2 * m, h: H - 2 * m };
  const T = Math.min(opts.tableHeightPt, area.h / 2);

  for (const [index, item] of items.entries()) {
    onProgress(index + 1, items.length);
    const target = out.addPage([W, H]);
    const main = pages[item.label];
    if (item.table == null) {
      await place(out, target, srcPages[item.label], main.box, main.rotate, area, { autoRotate: true });
      continue;
    }
    const decl = pages[item.table];
    await place(out, target, srcPages[item.label], main.box, main.rotate,
      { x: area.x, y: area.y + T, w: area.w, h: area.h - T }, { valign: 'top' });
    // Tabelas pequenas ficam no tamanho original; grandes encolhem para caber.
    await place(out, target, srcPages[item.table], decl.table, decl.rotate,
      { x: area.x, y: area.y, w: area.w, h: T }, { maxScale: 1 });
  }
  out.setTitle(opts.title || 'Etiquetas');
  out.setProducer('Toffa Print');
  return { bytes: await out.save(), count: items.length, paired: items.filter((i) => i.table != null).length };
}

// Para o modo "sem alteração": quantas páginas fogem do tamanho da etiqueta (±2 mm).
export function offSize(pages, widthMm, heightMm) {
  return pages.filter(({ box, rotate }) => {
    let w = (box.right - box.left) / MM;
    let h = (box.top - box.bottom) / MM;
    if (rotate % 180) [w, h] = [h, w];
    return Math.abs(w - widthMm) > 2 || Math.abs(h - heightMm) > 2;
  }).length;
}
