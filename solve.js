// site-generator-speed v2 — a faster drop-in for makefun-site 1.0.0.
// Written from the kit's README.md + reference behaviour (vendor/makefun-site/),
// in this session, from scratch. No third-party code: pure Node.js, no deps.
//
// Speed plan (all semantics kept byte-for-byte):
//  - front matter parsed by index scanning, no per-line regexes
//  - slugify memoised per case, with an ASCII fast path
//  - Markdown lexed+rendered in one fused pass, dispatching on the first
//    character instead of running seven regexes per line
//  - inline rendering scans plain-text runs in bulk and escapes each run once
//    (the reference escapes character by character)
//  - templates are compiled to JS functions (new Function) once per case;
//    an interpreter over the same node tree is the fallback if compiling
//    is unavailable, so the entry still works

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPE_RE = /[&<>"']/g;
const ESCAPE_TEST = /[&<>"']/;
export function escapeHtml(text) {
  return text.replace(ESCAPE_RE, (c) => ESCAPES[c]);
}

const SLUG_MAX = 64;
const SLUG_FAST = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MARK_RE = /\p{M}/gu;

/** Per-case slug cache, created fresh in run(). */
let slugCache = null;

export function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  let out;
  if (text.length <= SLUG_MAX && SLUG_FAST.test(text)) {
    out = text;
  } else {
    const plain = text.normalize('NFKD').replace(MARK_RE, '');
    out = '';
    let gap = false;
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
    out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
    if (out === '') out = 'untitled';
  }
  slugCache.set(text, out);
  return out;
}

export function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** Words: runs of non-whitespace. The table is exactly JS \s over UTF-16 units. */
const WS_TABLE = new Uint8Array(65536);
for (const c of [9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279]) WS_TABLE[c] = 1;
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (WS_TABLE[text.charCodeAt(i)] === 0) {
      if (!inWord) {
        n++;
        inWord = true;
      }
    } else inWord = false;
  }
  return n;
}

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const TAG_BAD = /["[\]]/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function isKeyChar(c) {
  return (c >= 'a' && c <= 'z') || c === '_';
}

function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    // '"' — a quoted string
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      // ^(\d{4})-(\d{2})-(\d{2})$ by hand
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) { ok = false; break; }
        }
      }
      const y = ok ? Number(raw.slice(0, 4)) : 0;
      const mo = ok ? Number(raw.slice(5, 7)) : 0;
      const d = ok ? Number(raw.slice(8, 10)) : 0;
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || TAG_BAD.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

function isBlankLine(text, a, b) {
  for (let i = a; i < b; i++) {
    const c = text.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * A source's front matter and body: { data, body }, or { error }.
 * `text` has "\n" line ends. Lines are walked by index, never split.
 */
export function parseFrontMatter(text) {
  // First line must be exactly '---'.
  let nl = text.indexOf('\n');
  const firstEnd = nl === -1 ? text.length : nl;
  if (firstEnd !== 3 || text.charCodeAt(0) !== 45 || text.charCodeAt(1) !== 45 || text.charCodeAt(2) !== 45) return { error: 'no front matter' };
  // Find the closing '---' line.
  let pos = nl === -1 ? text.length : nl + 1;
  let closeLine = -1; // line number (0-based) of the closing line
  let closeStart = -1;
  let lineNo = 1;
  while (pos <= text.length) {
    const e = text.indexOf('\n', pos);
    const end = e === -1 ? text.length : e;
    if (end - pos === 3 && text.charCodeAt(pos) === 45 && text.charCodeAt(pos + 1) === 45 && text.charCodeAt(pos + 2) === 45) {
      closeLine = lineNo;
      closeStart = pos;
      break;
    }
    if (e === -1) break;
    pos = e + 1;
    lineNo++;
  }
  if (closeLine === -1) return { error: 'the front matter is not closed' };
  const data = {};
  // Walk lines 1..closeLine-1 (line numbers count from 1 at the opening '---').
  pos = nl + 1;
  for (let i = 1; i < closeLine; i++) {
    const e = text.indexOf('\n', pos);
    const end = e === -1 ? text.length : e;
    if (!isBlankLine(text, pos, end) && text.charCodeAt(pos) !== 35) {
      // 'key: value' — key of [a-z_]+, ':', then end or ' ' + rest.
      const ci = text.indexOf(':', pos);
      let bad = ci === -1 || ci === pos || ci >= end;
      if (!bad) {
        for (let k = pos; k < ci; k++) if (!isKeyChar(text[k])) { bad = true; break; }
      }
      if (bad) return { error: `line ${i + 1} is not "key: value"` };
      const key = text.slice(pos, ci);
      let raw;
      if (ci + 1 === end) raw = '';
      else if (text.charCodeAt(ci + 1) === 32) raw = text.slice(ci + 2, end);
      else return { error: `line ${i + 1} is not "key: value"` };
      // Drop trailing spaces and tabs.
      let rEnd = raw.length;
      while (rEnd > 0) {
        const c = raw.charCodeAt(rEnd - 1);
        if (c !== 32 && c !== 9) break;
        rEnd--;
      }
      raw = raw.slice(0, rEnd);
      if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    if (e === -1) break;
    pos = e + 1;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  // Body: everything after the closing line's newline ('' when it is the last line).
  const closeNl = text.indexOf('\n', closeStart);
  const body = closeNl === -1 ? '' : text.slice(closeNl + 1);
  return { data, body };
}

// ---------------------------------------------------------------- Markdown

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const ESCAPABLE_CODE = new Uint8Array(128);
for (const ch of ESCAPABLE) ESCAPABLE_CODE[ch.charCodeAt(0)] = 1;

const trimLine = (line) => {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
};

function isBlankStr(line) {
  if (line === '') return true;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Fence open: the language, or null. /^```([A-Za-z0-9_+-]*)[ \t]*$/ */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = line.slice(3, i);
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}

function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line: { depth, text }, or null. */
function headingOf(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6) return null;
  if (n >= line.length) return null;
  const c = line.charCodeAt(n);
  if (c !== 32 && c !== 9) return null;
  let a = n;
  while (a < line.length && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  let b = line.length;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  if (b === a) return null;
  return { depth: n, text: line.slice(a, b) };
}

function isHr(line) {
  const c0 = line.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false;
  if (line.charCodeAt(1) !== c0 || line.charCodeAt(2) !== c0) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether `line` ends a paragraph: blank, fence, heading or thematic break. */
function endsParagraph(line) {
  const c = line.charCodeAt(0);
  if (c === 96) return fenceOpen(line) !== null; // '`'
  if (c === 35) return headingOf(line) !== null; // '#'
  if (c === 45 || c === 42) return isHr(line); // '-' or '*'
  if (c === 32 || c === 9 || Number.isNaN(c)) return isBlankStr(line);
  return false;
}

/** Bullet: { text } with the marker consumed, or null. /^[-*] (.*)$/ */
function bulletOf(line) {
  const c0 = line.charCodeAt(0);
  if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** Ordered: { start, text }, or null. /^(\d{1,9})\. (.*)$/ */
function orderedOf(line) {
  let i = 0;
  while (i < line.length && i < 9 && line.charCodeAt(i) >= 48 && line.charCodeAt(i) <= 57) i++;
  if (i === 0 || i >= line.length) return null;
  if (line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null;
  return { start: Number(line.slice(0, i)), text: line.slice(i + 2) };
}

/** A list continuation line: two or more spaces, then a non-space. /^ {2,}\S/ */
function isContinued(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i < 2 || i >= line.length) return false;
  const c = line.charCodeAt(i);
  return c !== 32 && c !== 9;
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < s.length && ESCAPABLE_CODE[s.charCodeAt(j + 1)] === 1) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && ESCAPABLE_CODE[s.charCodeAt(j + 1)] === 1) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

const WS_RE = /\s/;

/**
 * `s` rendered inline; `env.link(target)` is a link's href.
 * Plain-text runs are escaped in bulk; only the markup characters are
 * handled one at a time. Byte-for-byte the reference's inline().
 */
/**
 * `s` rendered inline; `env.link(target)` is a link's href.
 * One regex scan finds the next markup or HTML-escape character, so the
 * plain text between matches needs no escaping pass at all. Byte-for-byte
 * the reference's inline(). The scan regex is shared: every recursive call
 * leaves lastIndex at 0 (its scan ran out) and every use sets it explicitly
 * after the call, so sharing is safe.
 */
const INLINE_RE = /[&<>"'\\`*\[]/g;
export function inline(s, env) {
  const re = INLINE_RE;
  re.lastIndex = 0;
  const out = [];
  let last = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    const i = m.index;
    const c = m[0];
    if (c === '&') {
      out.push(s.slice(last, i) + '&amp;');
      last = i + 1;
      continue;
    }
    if (c === '<') {
      out.push(s.slice(last, i) + '&lt;');
      last = i + 1;
      continue;
    }
    if (c === '>') {
      out.push(s.slice(last, i) + '&gt;');
      last = i + 1;
      continue;
    }
    if (c === '"') {
      out.push(s.slice(last, i) + '&quot;');
      last = i + 1;
      continue;
    }
    if (c === "'") {
      out.push(s.slice(last, i) + '&#39;');
      last = i + 1;
      continue;
    }
    if (c === '\\') {
      const nx = s[i + 1];
      if (nx !== undefined && ESCAPABLE_CODE[nx.charCodeAt(0)] === 1) {
        out.push(s.slice(last, i) + nx);
        last = i + 2;
        re.lastIndex = i + 2;
      } else {
        out.push(s.slice(last, i + 1));
        last = i + 1;
      }
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        out.push(s.slice(last, i) + `<code>${escapeHtml(s.slice(i + 1, j))}</code>`);
        last = j + 1;
        re.lastIndex = j + 1;
      } else {
        out.push(s.slice(last, i + 1));
        last = i + 1;
      }
      continue;
    }
    if (c === '*') {
      if (s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          out.push(s.slice(last, i) + `<strong>${inline(s.slice(i + 2, j), env)}</strong>`);
          last = j + 2;
          re.lastIndex = j + 2;
        } else {
          out.push(s.slice(last, i + 2));
          last = i + 2;
          re.lastIndex = i + 2;
        }
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        out.push(s.slice(last, i) + `<em>${inline(s.slice(i + 1, j), env)}</em>`);
        last = j + 1;
        re.lastIndex = j + 1;
      } else {
        out.push(s.slice(last, i + 1));
        last = i + 1;
      }
      continue;
    }
    // '['
    const k = findUnescaped(s, ']', i + 1);
    const mm = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
    const target = mm === -1 ? '' : s.slice(k + 2, mm);
    if (target !== '' && !WS_RE.test(target)) {
      out.push(s.slice(last, i) + `<a href="${escapeHtml(env.link(target))}">${inline(s.slice(i + 1, k), env)}</a>`);
      last = mm + 1;
      re.lastIndex = mm + 1;
      continue;
    }
    out.push(s.slice(last, i + 1));
    last = i + 1;
  }
  // No match at all: the string is returned as-is, not copied.
  if (out.length === 0 && last === 0) return s;
  out.push(s.slice(last));
  return out.join('');
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the
 * last), its table of contents and its excerpt (the first paragraph's
 * inline HTML, or ""). One fused pass: no token array.
 */
export function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const ids = new Set();
  const parts = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  const total = lines.length;
  while (i < total) {
    const line = lines[i];
    const c0 = line.charCodeAt(0);
    // Dispatch on the first character: most lines are paragraph text, and
    // only a few first characters can open any other block.
    if (c0 === 32 || c0 === 9 || Number.isNaN(c0)) {
      if (isBlankStr(line)) {
        i++;
        continue;
      }
    } else if (c0 === 96) {
      const lang = fenceOpen(line);
      if (lang !== null) {
        const body = [];
        i++;
        while (i < total && !isFenceClose(lines[i])) body.push(lines[i++]);
        i++;
        const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
        const inner = body.length === 0 ? '' : `${escapeHtml(body.join('\n'))}\n`;
        parts.push(`<pre><code${cls}>${inner}</code></pre>\n`);
        continue;
      }
    } else if (c0 === 35) {
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugify(heading.text), ids);
        const h = inline(heading.text, env);
        parts.push(`<h${heading.depth} id="${id}">${h}</h${heading.depth}>\n`);
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html: h });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (isHr(line)) {
        parts.push('<hr>\n');
        i++;
        continue;
      }
      const bulletText = bulletOf(line);
      if (bulletText !== null) {
        const r = renderList(lines, i, total, false, 1, bulletText, env);
        parts.push(r.html);
        i = r.next;
        continue;
      }
    } else if (c0 === 62) {
      // '>' — blockquote
      const body = [];
      while (i < total && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(l.startsWith('> ') ? l.slice(2) : l.slice(1));
      }
      const kept = [];
      for (const l of body) {
        const t = trimLine(l);
        if (t !== '') kept.push(t);
      }
      parts.push(kept.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(kept.join('\n'), env)}</p>\n</blockquote>\n`);
      continue;
    } else if (c0 >= 48 && c0 <= 57) {
      const ordered = orderedOf(line);
      if (ordered !== null) {
        const r = renderList(lines, i, total, true, ordered.start, ordered.text, env);
        parts.push(r.html);
        i = r.next;
        continue;
      }
    }
    // Paragraph (also the fall-through for fence/heading/hr/list misses).
    const body = [trimLine(line)];
    i++;
    while (i < total && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const text = body.join('\n');
    const p = inline(text, env);
    if (excerpt === null) excerpt = p;
    parts.push(`<p>${p}</p>\n`);
  }
  return { html: parts.join(''), toc, excerpt: excerpt ?? '' };
}

/** Render a list starting at lines[i]; returns its HTML and the index after it. */
function renderList(lines, i, total, isOrdered, start, firstText, env) {
  const items = [[trimLine(firstText)]];
  i++;
  while (i < total) {
    let text = null;
    if (isOrdered) {
      const o = orderedOf(lines[i]);
      if (o !== null) text = o.text;
    } else {
      const b = bulletOf(lines[i]);
      if (b !== null) text = b;
    }
    if (text !== null) {
      items.push([trimLine(text)]);
      i++;
    } else if (isContinued(lines[i])) {
      items[items.length - 1].push(trimLine(lines[i]));
      i++;
    } else break;
  }
  const tag = isOrdered ? 'ol' : 'ul';
  const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
  return { html: `${open}\n${items.map((parts) => `<li>${inline(parts.join('\n'), env)}</li>\n`).join('')}</${tag}>\n`, next: i };
}

// ---------------------------------------------------------------- templates

export const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
export class TemplateError extends Error {}

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
export function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

// --- runtime helpers for compiled templates (passed as parameters) ---

/** A value as text: string itself, a number in its digits, true/false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** textOf, HTML-escaped — numbers and booleans never hold an escapable character. */
function textOfEscaped(v) {
  if (typeof v === 'string') {
    // Template values are almost always clean: one regex test costs less
    // than a replace, and a clean string is returned as-is.
    if (!ESCAPE_TEST.test(v)) return v;
    return escapeHtml(v);
  }
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return escapeHtml(v.map(textOf).join(', '));
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** One more path segment: an own property of an object, else undefined. */
function seg(v, k) {
  return v === null || typeof v !== 'object' || !Object.hasOwn(v, k) ? undefined : v[k];
}

// --- code generation ---

/** A path as a JS expression over (L, V, _v). The first name resolves to the
 * innermost lexically enclosing loop binding when one exists (a plain JS
 * local, no Map lookup), else the innermost loop binding, else the page's
 * values. `scope` is the stack of {name, local} frames, innermost last. */
function pathExpr(path, scope) {
  let local = null;
  for (let i = scope.length - 1; i >= 0; i--) {
    if (scope[i].name === path[0]) { local = scope[i].local; break; }
  }
  let e = local !== null ? local : `(L.has(${JSON.stringify(path[0])})?L.get(${JSON.stringify(path[0])}):V.${path[0]})`;
  for (let k = 1; k < path.length; k++) {
    e = `((_v=${e})===undefined?undefined:((_v===null||typeof _v!=='object'||!Object.hasOwn(_v,${JSON.stringify(path[k])}))?undefined:(_v=_v[${JSON.stringify(path[k])}])))`;
  }
  return e;
}

/** Does `list` contain an include anywhere (loops and both if-branches included)? */
function subtreeHasInclude(list) {
  for (const n of list) {
    if (n.kind === 'include') return true;
    if (n.kind === 'for' && subtreeHasInclude(n.body)) return true;
    if (n.kind === 'if' && ((n.then && subtreeHasInclude(n.then)) || (n.else && subtreeHasInclude(n.else)))) return true;
  }
  return false;
}

/** Compile `nodes` to a render function (V, L, D, TPL, ET, T, Y, S, I), or null when compiling is unavailable. */
function compileNodes(nodes) {
  const src = [];
  let counter = 0;
  const scope = [];
  const gen = (list) => {
    for (const n of list) {
      if (n.kind === 'text') src.push(`o.push(${JSON.stringify(n.text)});`);
      else if (n.kind === 'var') src.push(`o.push(ET(${pathExpr(n.path, scope)}));`);
      else if (n.kind === 'raw') src.push(`o.push(T(${pathExpr(n.path, scope)}));`);
      else if (n.kind === 'if') {
        const cond = `Y(${pathExpr(n.path, scope)})!==${n.not ? 'true' : 'false'}`;
        src.push(`if(${cond}){`);
        gen(n.then);
        src.push('}');
        if (n.else !== null) {
          src.push('else{');
          gen(n.else);
          src.push('}');
        }
      } else if (n.kind === 'for') {
        const id = counter++;
        const hasInc = subtreeHasInclude(n.body);
        const elemLocal = `_e${id}`;
        const loopLocal = `_l${id}`;
        src.push(`{const _x${id}=${pathExpr(n.path, scope)};if(Array.isArray(_x${id})){const _n${id}=_x${id}.length;`);
        if (hasInc) src.push(`const _h${id}=L.has(${JSON.stringify(n.name)});const _o${id}=L.get(${JSON.stringify(n.name)});const _hl${id}=L.has('loop');const _ol${id}=L.get('loop');`);
        src.push(`const ${loopLocal}={index:0,first:false,last:false,length:_n${id}};for(let _k${id}=0;_k${id}<_n${id};_k${id}++){const ${elemLocal}=_x${id}[_k${id}];${loopLocal}.index=_k${id}+1;${loopLocal}.first=_k${id}===0;${loopLocal}.last=_k${id}===_n${id}-1;`);
        scope.push({ name: n.name, local: elemLocal }, { name: 'loop', local: loopLocal });
        gen(n.body);
        scope.pop();
        scope.pop();
        src.push('}');
        if (hasInc) src.push(`if(_hl${id})L.set('loop',_ol${id});else L.delete('loop');if(_h${id})L.set(${JSON.stringify(n.name)},_o${id});else L.delete(${JSON.stringify(n.name)});`);
        src.push('}}');
      } else if (n.kind === 'include') {
        const id = counter++;
        // An included template reads the caller's loop bindings from L, so
        // the lexically visible ones are synced here (innermost wins per
        // name); the loop restores L afterwards when it has any include.
        const syncs = [];
        const seen = new Set();
        for (let i = scope.length - 1; i >= 0; i--) {
          if (seen.has(scope[i].name)) continue;
          seen.add(scope[i].name);
          syncs.push(`L.set(${JSON.stringify(scope[i].name)},${scope[i].local});`);
        }
        src.push(`{${syncs.join('')}const _r${id}=TPL.get(${JSON.stringify(n.name)});if(_r${id}!==undefined&&D<8)o.push(_r${id}.fn?_r${id}.fn(V,L,D+1,TPL,ET,T,Y,S,I):I(_r${id}.nodes,V,L,D+1));}`);
      }
    }
  };
  gen(nodes);
  const body = `const o=[];let _v;${src.join('')}return o.join('');`;
  try {
    return new Function('V', 'L', 'D', 'TPL', 'ET', 'T', 'Y', 'S', 'I', body);
  } catch {
    return null;
  }
}

// --- interpreter fallback (same node tree, used only when compiling fails) ---

function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function renderNodes(nodes, scope, ctx, depth) {
  let out = '';
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out += n.text;
        break;
      case 'var':
        out += textOfEscaped(lookup(scope, n.path));
        break;
      case 'raw':
        out += textOf(lookup(scope, n.path));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) out += renderNodes(branch, scope, ctx, depth);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        xs.forEach((x, k) => {
          const vars = { [n.name]: x, loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          out += renderNodes(n.body, { vars, parent: scope }, ctx, depth);
        });
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) out += renderNodes(t.nodes, scope, ctx, depth + 1);
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- the build

export const REPORT_FILE = 'build-report.txt';
export const RESERVED = Object.freeze(['posts', 'tags', 'page']);

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** One site's output tree: path -> text. */
export function run(input) {
  slugCache = new Map();
  const templates = new Map(); // name -> { nodes, fn }
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      const nodes = parseTemplate(name, input.templates[name]);
      templates.set(name, { nodes, fn: compileNodes(nodes) });
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  // The interpreter bridge, for templates whose compile failed.
  const interpret = (nodes, V, L, D) => {
    const vars = Object.create(null);
    for (const [k, v] of L) vars[k] = v;
    return renderNodes(nodes, { vars, parent: { vars: V, parent: null } }, { templates }, D);
  };

  const b = {
    input,
    base: input.site.base_url.replace(/\/+$/, ''),
    templates,
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report,
    posts: [],
    tags: [],
    cards: new Map(),
    output: {},
  };

  // 1. Sources, in code-unit order of their paths.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const content = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      b.sources.push({ path: f.path, text: content });
    } else b.statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter.
  const kept = [];
  for (const s of b.sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      b.report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own;
    for (const d of RESERVED) {
      if (d !== 'posts' && s.path.startsWith(`${d}/`)) { own = d; break; }
    }
    if (own !== undefined) {
      b.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      b.report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!b.templates.has(layout)) {
      b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      b.report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  b.sources = kept;

  // 3. Permalinks.
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  for (const s of b.sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${b.base}/${s.outDir}/`;
    // The neighbour record templates read, built once per source.
    s.link = { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
    b.bySource.set(s.path, s);
  }

  // 4. Markdown, links resolved. Resolved targets are cached per (dir, target);
  // a broken target is still reported once per (source, target).
  const staticPaths = new Set(b.statics.map((f) => f.path));
  const linkCache = new Map();
  const schemeRe = /^[A-Za-z][A-Za-z0-9+.-]*:/;
  for (const s of b.sources) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (schemeRe.test(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
        let href = linkCache.get(`${dir}\0${target}`);
        if (href === undefined) {
          const hash = target.indexOf('#');
          const rel = hash === -1 ? target : target.slice(0, hash);
          const frag = hash === -1 ? '' : target.slice(hash);
          const path = rel === '' ? null : resolvePath(dir, rel);
          if (path !== null && b.bySource.has(path)) href = `${b.bySource.get(path).url}${frag}`;
          else if (path !== null && staticPaths.has(path)) href = `${b.base}/${path}${frag}`;
          else href = null;
          linkCache.set(`${dir}\0${target}`, href);
        }
        if (href === null) {
          b.broken.add(`broken-link ${s.path} -> ${target}`);
          return target;
        }
        return href;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. Collections.
  const posts = b.sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  b.posts = posts;
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. Tags.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of b.posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      if (!bySlug.has(slug)) {
        const tag = { name, slug, url: `${b.base}/tags/${slug}/`, posts: [] };
        tag.link = { name, slug, url: tag.url };
        bySlug.set(slug, tag);
      }
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of b.sources) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const tag = bySlug.get(slugify(name));
        if (tag !== undefined) return tag;
        const slug = slugify(name);
        const pseudo = { name, slug, url: '', posts: [] };
        pseudo.link = { name, slug, url: '' };
        return pseudo;
      });
    }
  }
  b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Layouts.
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => t.link),
  });
  for (const p of b.posts) b.cards.set(p, cardOf(p));
  const site = { title: b.input.site.title, base_url: b.base };
  const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = b.posts.slice(0, b.input.site.recent).map((p) => b.cards.get(p));
  // The loop scope is empty between renders (every for restores it), so one
  // Map serves every render of the case.
  const loopScope = new Map();
  const render = (name, vars) => {
    const rec = b.templates.get(name);
    if (rec === undefined) return null;
    const V = Object.create(null);
    V.site = site;
    V.tags = allTags;
    V.recent = recent;
    for (const k of Object.keys(vars)) V[k] = vars[k];
    const L = loopScope;
    if (rec.fn !== null) return rec.fn(V, L, 0, b.templates, textOfEscaped, textOf, truthy, seg, interpret);
    return interpret(rec.nodes, V, L, 0);
  };
  const pageOf = (s) => {
    // A post's card is already built (cardOf is deterministic), so reuse it
    // instead of counting its words a second time. The toc entries already
    // hold exactly { level, id, html }, so they are reused as-is.
    const card = s.post ? b.cards.get(s) : cardOf(s);
    return {
      ...card,
      slug: s.slug,
      content: s.html,
      toc: s.toc,
      newer: s.newer ? s.newer.link : null,
      older: s.older ? s.older.link : null,
      is_post: s.post,
    };
  };
  for (const s of b.sources) b.output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = b.input.site.per_page;
  const pages = Math.max(1, Math.ceil(b.posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: b.posts.slice((k - 1) * per, k * per).map((p) => b.cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of b.tags) {
    const html = render('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => b.cards.get(p)) },
    });
    if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
  for (const f of b.statics) {
    if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
    else b.output[f.path] = f.content;
  }

  // 8. Report.
  const lines = [...b.report, ...b.broken].sort(byCodeUnits);
  const pageCount = b.sources.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
  b.output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return b.output;
}
