// ファイル形式ごとのテキスト抽出。
// 出力: { title, format, language, sentences: [{t, h?, ref?, code?}], sections: [{title, level, idx}] }
//   t: 表示・読み上げテキスト / h: 見出しレベル / ref: 参考文献 / code: コードブロック

const PDFJS_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/build/pdf.min.mjs';
const PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/build/pdf.worker.min.mjs';
const MAMMOTH_URL = 'https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js';

export async function extractFile(file) {
  const name = file.name;
  const ext = (name.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
  let result;
  if (ext === 'txt') result = fromPlainText(await file.text());
  else if (ext === 'md' || ext === 'markdown') result = fromMarkdown(await file.text());
  else if (ext === 'html' || ext === 'htm') result = fromHTML(await file.text());
  else if (ext === 'pdf') result = await fromPDF(await file.arrayBuffer());
  else if (ext === 'docx') result = await fromDocx(await file.arrayBuffer());
  else throw new Error(`未対応の形式です: .${ext}（対応: pdf / docx / md / txt / html）`);

  markReferences(result.sentences);
  const title = result.title || name.replace(/\.[a-z0-9]+$/i, '');
  const language = detectLanguage(result.sentences);
  return { title, format: ext, language, sentences: result.sentences, sections: buildSections(result.sentences) };
}

// ---------- 共通ユーティリティ ----------

export function splitSentences(text) {
  // 日本語（。！？）と英語（. ! ? ＋空白＋大文字）の文末で分割。改行も区切りとして扱う
  const out = [];
  const splitter = /(?<=[。！？])(?![」』）")\]、。！？])|(?<=[．.!?]["')\]]?)\s+(?=["'(\[]?[A-Z0-9])/;
  for (const rawLine of text.split(/\n+/)) {
    const t = rawLine.trim();
    if (!t) continue;
    for (let p of t.split(splitter)) {
      p = p.trim();
      if (!p) continue;
      // 文末記号のない長すぎる断片（表・箇条書きの成れの果て等）は強制分割
      while (p.length > 400) {
        let cut = Math.max(p.lastIndexOf('、', 400), p.lastIndexOf('，', 400));
        if (cut < 100) cut = p.lastIndexOf(', ', 400);
        if (cut < 100) cut = p.lastIndexOf(' ', 400);
        if (cut < 100) cut = 400;
        out.push(p.slice(0, cut + 1).trim());
        p = p.slice(cut + 1).trim();
      }
      if (p) out.push(p);
    }
  }
  return out;
}

function detectLanguage(sentences) {
  const sample = sentences.slice(0, 80).map(s => s.t).join('');
  const ja = (sample.match(/[぀-ヿ一-鿿]/g) || []).length;
  return ja / Math.max(sample.length, 1) > 0.15 ? 'ja' : 'en';
}

function markReferences(sentences) {
  let refStart = -1;
  for (let i = sentences.length - 1; i >= 0; i--) {
    const t = sentences[i].t.trim();
    if (t.length < 30 && /^(references?|bibliography|参考文献|引用文献|文献)[\s:：]*$/i.test(t)) { refStart = i; break; }
  }
  if (refStart >= 0) for (let i = refStart; i < sentences.length; i++) sentences[i].ref = true;
}

function buildSections(sentences) {
  const sections = [];
  sentences.forEach((s, idx) => { if (s.h) sections.push({ title: s.t, level: s.h, idx }); });
  return sections;
}

export function estimateSeconds(doc) {
  const chars = doc.sentences.reduce((a, s) => a + s.t.length, 0);
  return Math.round(chars / (doc.language === 'ja' ? 7.5 : 14));
}

// ---------- txt ----------

function fromPlainText(text) {
  return { sentences: splitSentences(text).map(t => ({ t })) };
}

// ---------- Markdown ----------

function fromMarkdown(text) {
  const sentences = [];
  let title = null;
  const lines = text.split('\n');
  let i = 0, buf = [];
  const flush = () => {
    if (buf.length) { for (const t of splitSentences(buf.join('\n'))) sentences.push({ t: cleanInlineMd(t) }); buf = []; }
  };
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) {              // コードブロック
      flush();
      const fence = line.trim().slice(0, 3);
      let code = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) { code.push(lines[i]); i++; }
      sentences.push({ t: code.join('\n'), code: true });
      i++; continue;
    }
    const h = line.match(/^(#{1,6})\s+(.+)/);
    if (h) {                                        // 見出し
      flush();
      const ht = cleanInlineMd(h[2].trim());
      if (!title && h[1].length === 1) title = ht;
      sentences.push({ t: ht, h: h[1].length });
      i++; continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {              // 表
      flush();
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) i++;
      sentences.push({ t: '（表は省略します）' });
      continue;
    }
    if (/^\s*$/.test(line)) { flush(); i++; continue; }
    buf.push(line.replace(/^\s*([-*+]|\d+[.)])\s+/, '').replace(/^\s*>\s?/, ''));
    i++;
  }
  flush();
  return { title, sentences };
}

function cleanInlineMd(t) {
  return t
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '（図は省略します）')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(\*\*|__|\*|_|~~)/g, '')
    .trim();
}

// ---------- HTML ----------

function fromHTML(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return htmlBodyToSentences(doc);
}

function htmlBodyToSentences(doc) {
  for (const sel of ['script', 'style', 'nav', 'header', 'footer', 'aside', 'noscript'])
    doc.querySelectorAll(sel).forEach(el => el.remove());
  const sentences = [];
  const title = doc.querySelector('title')?.textContent?.trim() || doc.querySelector('h1')?.textContent?.trim() || null;
  const walk = (el) => {
    for (const node of el.children) {
      const tag = node.tagName.toLowerCase();
      const hm = tag.match(/^h([1-6])$/);
      if (hm) {
        const t = node.textContent.trim();
        if (t) sentences.push({ t, h: +hm[1] });
      } else if (tag === 'pre') {
        sentences.push({ t: node.textContent, code: true });
      } else if (tag === 'table') {
        sentences.push({ t: '（表は省略します）' });
      } else if (tag === 'img' || tag === 'figure' || tag === 'svg') {
        sentences.push({ t: '（図は省略します）' });
      } else if (tag === 'p' || tag === 'li' || tag === 'blockquote' || tag === 'td') {
        const t = node.textContent.replace(/\s+/g, ' ').trim();
        if (t) for (const s of splitSentences(t)) sentences.push({ t: s });
      } else {
        walk(node);
      }
    }
  };
  walk(doc.body);
  return { title, sentences };
}

// ---------- docx（mammoth.js → HTML経由） ----------

let _mammothLoading = null;
function loadMammoth() {
  if (window.mammoth) return Promise.resolve();
  if (!_mammothLoading) {
    _mammothLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = MAMMOTH_URL;
      s.onload = resolve;
      s.onerror = () => reject(new Error('mammoth.js の読み込みに失敗しました（ネット接続を確認してください）'));
      document.head.appendChild(s);
    });
  }
  return _mammothLoading;
}

async function fromDocx(arrayBuffer) {
  await loadMammoth();
  const { value: html } = await window.mammoth.convertToHtml({ arrayBuffer });
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return htmlBodyToSentences(doc);
}

// ---------- PDF（pdf.js） ----------

let _pdfjs = null;
async function loadPdfjs() {
  if (_pdfjs) return _pdfjs;
  _pdfjs = await import(PDFJS_URL);
  _pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  return _pdfjs;
}

async function fromPDF(arrayBuffer) {
  const pdfjs = await loadPdfjs();
  const pdf = await pdfjs.getDocument({ data: arrayBuffer }).promise;
  const meta = await pdf.getMetadata().catch(() => null);
  const title = meta?.info?.Title?.trim() || null;

  const pages = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    pages.push({ lines: itemsToLines(content.items, page.view) });
  }

  const repeated = findRepeatedLines(pages);
  const segments = [];
  let buf = [];
  const flush = () => { if (buf.length) { segments.push(joinPdfLines(buf)); buf = []; } };
  for (const page of pages) {
    for (const line of page.lines) {
      const trimmed = line.text.trim();
      const norm = normalizeLine(trimmed);
      if (!norm) continue;
      if (/^[\d\s\-–—・.]+$/.test(trimmed)) continue;               // ページ番号のみの行
      if (repeated.has(norm)) continue;                             // ヘッダー・フッター
      // 参考文献見出しは独立した文として残す（読み飛ばし判定に使う）
      if (/^(references?|bibliography|参考文献|引用文献)\s*$/i.test(trimmed)) {
        flush();
        segments.push(trimmed);
        continue;
      }
      buf.push(line.text);
    }
  }
  flush();
  return { title, sentences: splitSentences(segments.join('\n')).map(t => ({ t })) };
}

function itemsToLines(items, view) {
  // y座標で行にまとめ、2段組みなら左段→右段の順に並べる
  const lineMap = new Map();
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const y = Math.round(it.transform[5] / 4) * 4;
    if (!lineMap.has(y)) lineMap.set(y, []);
    lineMap.get(y).push({ x: it.transform[4], str: it.str, w: it.width || 0 });
  }
  const pageWidth = (view?.[2] || 600) - (view?.[0] || 0);
  const mid = (view?.[0] || 0) + pageWidth / 2;
  let lines = [...lineMap.entries()].map(([y, parts]) => {
    parts.sort((a, b) => a.x - b.x);
    const x0 = parts[0].x;
    const x1 = parts[parts.length - 1].x + parts[parts.length - 1].w;
    return { y, x0, x1, text: parts.map(p => p.str).join(' ').replace(/\s+/g, ' ').trim() };
  });
  // 2段組み判定：大半の行が半ページ幅未満で、左右両方に行が分布する
  const narrow = lines.filter(l => (l.x1 - l.x0) < pageWidth * 0.55);
  const left = lines.filter(l => l.x1 <= mid + pageWidth * 0.05);
  const right = lines.filter(l => l.x0 >= mid - pageWidth * 0.05);
  const twoCol = lines.length > 8 && narrow.length / lines.length > 0.7 && left.length > 3 && right.length > 3;
  if (twoCol) {
    const sortY = (a, b) => b.y - a.y; // PDFのy原点は下
    const mixed = lines.filter(l => !left.includes(l) && !right.includes(l));
    return [...mixed.filter(l => l.y > Math.max(...left.map(v => v.y), 0)).sort(sortY),
            ...left.sort(sortY), ...right.sort(sortY)];
  }
  return lines.sort((a, b) => b.y - a.y);
}

function normalizeLine(t) {
  return t.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().toLowerCase();
}

function findRepeatedLines(pages) {
  // 6割以上のページに現れる行（正規化後）をヘッダー・フッターとみなす
  const counts = new Map();
  for (const page of pages) {
    const seen = new Set();
    for (const line of page.lines.slice(0, 3).concat(page.lines.slice(-3))) {
      const n = normalizeLine(line.text);
      if (n && !seen.has(n)) { seen.add(n); counts.set(n, (counts.get(n) || 0) + 1); }
    }
  }
  const repeated = new Set();
  if (pages.length >= 4) {
    for (const [n, c] of counts) if (c >= pages.length * 0.6 && n.length > 1) repeated.add(n);
  }
  return repeated;
}

function joinPdfLines(lines) {
  let out = '';
  for (const line of lines) {
    if (out.endsWith('-') && /^[a-z]/.test(line)) out = out.slice(0, -1) + line; // ハイフネーション結合
    else if (/[぀-ヿ一-鿿]$/.test(out)) out += line;             // 日本語は空白なしで結合
    else out += (out ? ' ' : '') + line;
  }
  return out;
}
