// ==UserScript==
// @name         Aptem OTJ Autofill (ARU Canvas timetable)
// @namespace    aru-otj-autofill
// @version      0.1.0
// @description  Captures your weekly timetable from Canvas, tops it up to 37:30 with self-managed learning topics, and fills Aptem's Add Note form. You review and press Save yourself.
// @match        https://canvas.anglia.ac.uk/courses/*/pages/*
// @match        https://*.aptem.co.uk/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @grant        unsafeWindow
// @connect      api.deepseek.com
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  // ───────────────────────── Pure helpers (also unit-tested in Node) ─────────────────────────

  const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
    'september', 'october', 'november', 'december'];

  const clean = (s) => String(s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
  const norm = (s) => clean(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  /** "09:00-09:45" (also en dash, dots, spaces) → {start, end} in minutes since midnight */
  function parseTimeRange(text) {
    const m = clean(text).match(/^(\d{1,2})[:.](\d{2})\s*[-–—to]+\s*(\d{1,2})[:.](\d{2})$/i);
    if (!m) return null;
    const start = +m[1] * 60 + +m[2];
    const end = +m[3] * 60 + +m[4];
    if (end <= start || end > 24 * 60) return null;
    return { start, end };
  }

  /** "Monday 28th September 2026" → "2026-09-28" (null if not a day heading) */
  function parseDayHeading(text) {
    const m = clean(text).toLowerCase().match(
      /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday),?\s+(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+),?\s+(\d{4})$/);
    if (!m) return null;
    const month = MONTHS.indexOf(m[3]) + 1;
    if (!month) return null;
    const day = +m[2];
    if (day < 1 || day > 31) return null;
    return `${m[4]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  /** minutes → "37:30" */
  function fmtHM(mins) {
    const sign = mins < 0 ? '-' : '';
    mins = Math.abs(Math.round(mins));
    return `${sign}${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
  }

  /** "37:30" or "37.5" → minutes */
  function parseHM(text) {
    const t = clean(text);
    let m = t.match(/^(\d{1,3}):(\d{2})$/);
    if (m) return +m[1] * 60 + +m[2];
    m = t.match(/^(\d{1,3}(?:\.\d+)?)$/);
    if (m) return Math.round(parseFloat(m[1]) * 60);
    return null;
  }

  /** "2026-09-28" → "28/09/2026" */
  const isoToUK = (iso) => iso.split('-').reverse().join('/');
  /** "2026-09-28" → "Mon 28/09" */
  function shortDay(iso) {
    const [y, mo, d] = iso.split('-').map(Number);
    const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay(); // 0 = Sunday
    const name = DAYS[(dow + 6) % 7];
    return `${name[0].toUpperCase()}${name.slice(1, 3)} ${String(d).padStart(2, '0')}/${String(mo).padStart(2, '0')}`;
  }

  /**
   * Make AI topic blocks sum exactly to `target` minutes, in 15-minute steps.
   * Input: [{topic, minutes}] (any shape the model returns). Output: cleaned list.
   */
  function normaliseTopics(list, target) {
    let items = (Array.isArray(list) ? list : [])
      .map((x) => ({ topic: clean(x && (x.topic || x.title || x.name)), minutes: Number(x && (x.minutes || x.mins)) || 0 }))
      .filter((x) => x.topic);
    if (!items.length || target <= 0) return [];
    // Scale proportionally to the target, then round to 15 minutes.
    const weight = (x) => (x.minutes > 0 ? x.minutes : 1);
    const total = items.reduce((a, x) => a + weight(x), 0);
    items = items.map((x) => ({
      topic: x.topic,
      minutes: Math.max(15, Math.round((weight(x) / total) * target / 15) * 15),
    }));
    // Fix any rounding drift on the largest blocks.
    let diff = target - items.reduce((a, x) => a + x.minutes, 0);
    let guard = 1000;
    while (diff !== 0 && guard--) {
      items.sort((a, b) => b.minutes - a.minutes);
      const step = diff > 0 ? 15 : -15;
      const victim = items.find((x) => x.minutes + step >= 15) || null;
      if (!victim) break;
      victim.minutes += step;
      diff -= step;
    }
    // If target isn't a multiple of 15, put the odd minutes on the first block.
    if (diff !== 0 && items.length) items[0].minutes += diff;
    return items.filter((x) => x.minutes > 0);
  }

  /** "1:30 | Topic" lines ↔ [{topic, minutes}] */
  function topicsToText(items) {
    return items.map((x) => `${fmtHM(x.minutes)} | ${x.topic}`).join('\n');
  }
  function textToTopics(text) {
    return String(text || '').split('\n').map((line) => {
      const m = line.match(/^\s*(\d{1,2}:\d{2}|\d+(?:\.\d+)?)\s*\|\s*(.+)$/);
      if (!m) return null;
      return { minutes: parseHM(m[1]) || 0, topic: clean(m[2]) };
    }).filter((x) => x && x.topic && x.minutes > 0);
  }

  const sessionMinutes = (s) => s.end - s.start;

  /** Build the note text that goes into Aptem's notes box. */
  function buildNote(week, sessions, topics, targetMins) {
    const lines = [];
    lines.push(clean(week.title) || 'Weekly timetable');
    if (week.theme && week.theme.length) lines.push(`Theme: ${week.theme.join('; ')}`);
    lines.push('');
    const taught = sessions.reduce((a, s) => a + sessionMinutes(s), 0);
    lines.push(`Timetabled teaching (${fmtHM(taught)}):`);
    let lastDate = null;
    for (const s of sessions) {
      if (s.date !== lastDate) { lines.push(shortDay(s.date)); lastDate = s.date; }
      const delivery = s.delivery ? ` [${s.delivery}]` : '';
      lines.push(`  ${fmtHM(s.start)}-${fmtHM(s.end)} ${s.title}${delivery}`);
    }
    const sml = topics.reduce((a, t) => a + t.minutes, 0);
    if (topics.length) {
      lines.push('');
      lines.push(`Self-managed learning (${fmtHM(sml)}):`);
      for (const t of topics) lines.push(`  ${fmtHM(t.minutes)} ${t.topic}`);
    }
    lines.push('');
    lines.push(`Total: ${fmtHM(taught + sml)}${targetMins ? ` (target ${fmtHM(targetMins)})` : ''}`);
    return lines.join('\n');
  }

  /** Pick the dropdown option that best matches the wanted text. */
  function bestOption(optionTexts, wanted) {
    const w = norm(wanted);
    if (!w) return -1;
    let best = -1, bestScore = 0;
    const wWords = w.split(' ');
    optionTexts.forEach((t, i) => {
      const o = norm(t);
      if (!o) return;
      let score;
      if (o === w) score = 1000;
      else if (o.includes(w)) score = 500;
      else score = wWords.filter((word) => o.split(' ').includes(word)).length;
      if (score > bestScore) { bestScore = score; best = i; }
    });
    return best;
  }

  const PURE = { parseTimeRange, parseDayHeading, fmtHM, parseHM, isoToUK, shortDay, normaliseTopics,
    topicsToText, textToTopics, buildNote, bestOption, norm };
  if (typeof window === 'undefined') { module.exports = PURE; return; }

  // ───────────────────────── Settings & storage ─────────────────────────

  const DEFAULTS = {
    apiKey: '',
    model: 'deepseek-chat',
    target: '37:30',
    noteType: 'Other',
    otjType: 'paid in my own time',
  };
  const getSetting = (k) => GM_getValue(`setting:${k}`, DEFAULTS[k]);
  const setSetting = (k, v) => GM_setValue(`setting:${k}`, v);
  const getWeeks = () => GM_getValue('weeks', {});
  const saveWeeks = (w) => GM_setValue('weeks', w);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Tiny element builder (textContent only, never innerHTML with page data). */
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'style') el.style.cssText = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else if (v !== false && v != null) el.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  const STYLE = `
    .otj-box{position:fixed;z-index:2147483646;font:13px/1.4 system-ui,-apple-system,Segoe UI,sans-serif;color:#1d2433}
    .otj-btn{background:#1a3fd1;color:#fff;border:0;border-radius:999px;padding:8px 14px;cursor:pointer;font-weight:600}
    .otj-btn.secondary{background:#e8ecf7;color:#1a3fd1}
    .otj-btn:disabled{opacity:.5;cursor:default}
    .otj-panel{right:16px;bottom:64px;width:440px;max-width:calc(100vw - 32px);max-height:calc(100vh - 96px);overflow:auto;
      background:#fff;border:1px solid #d6dbe8;border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.18);padding:14px}
    .otj-panel h3{margin:0 0 8px;font-size:15px}
    .otj-panel h4{margin:12px 0 4px;font-size:13px}
    .otj-panel label{display:block}
    .otj-panel textarea,.otj-panel input[type=text],.otj-panel input[type=password],.otj-panel select{
      width:100%;box-sizing:border-box;border:1px solid #c9cfdd;border-radius:6px;padding:6px;font:inherit}
    .otj-panel textarea{min-height:90px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px}
    .otj-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:6px 0}
    .otj-day{font-weight:600;margin-top:6px}
    .otj-sess{display:flex;gap:6px;align-items:flex-start;padding:1px 0}
    .otj-muted{color:#5b6478;font-size:12px}
    .otj-status{white-space:pre-wrap;font-size:12px;margin-top:8px;padding:8px;border-radius:6px;background:#f4f6fb}
    .otj-toast{left:16px;bottom:16px;background:#fff;border:1px solid #d6dbe8;border-radius:10px;padding:10px 14px;
      box-shadow:0 8px 24px rgba(0,0,0,.15);max-width:380px}
    .otj-fab{right:16px;bottom:16px}
  `;
  function injectStyle() {
    if (document.getElementById('otj-style')) return;
    document.head.append(h('style', { id: 'otj-style' }, STYLE));
  }

  // ───────────────────────── Canvas: capture the timetable ─────────────────────────

  function parseCanvasTimetable(doc) {
    const root = doc.querySelector('#wiki_page_show') || doc.querySelector('.show-content') || doc.body;
    const titleEl = doc.querySelector('h1.page-title') ||
      [...root.querySelectorAll('h1,h2')].find((e) => /timetable/i.test(e.textContent));
    const title = clean(titleEl ? titleEl.textContent : doc.title);

    const theme = [];
    const sessions = [];
    const warnings = [];
    let currentDate = null;
    let inTheme = false;

    for (const el of root.querySelectorAll('h1,h2,h3,h4,h5,h6,p,table')) {
      if (el.closest('table') && el.tagName !== 'TABLE') continue; // cell contents handled with their table
      if (el.tagName === 'TABLE') {
        inTheme = false;
        const rows = [...el.querySelectorAll('tr')];
        // Work out columns from a header row if there is one.
        let col = { time: 0, title: 1, presenter: 2, delivery: 3 };
        const headerRow = rows.find((r) => /session title/i.test(r.textContent));
        if (headerRow) {
          const heads = [...headerRow.children].map((c) => norm(c.textContent));
          const idx = (re) => heads.findIndex((t) => re.test(t));
          col = {
            time: Math.max(idx(/^time/), 0),
            title: idx(/session|title/) >= 0 ? idx(/session|title/) : 1,
            presenter: idx(/presenter|lecturer/),
            delivery: idx(/delivery|location|room/),
          };
        }
        for (const tr of rows) {
          const cells = [...tr.children].filter((c) => /^T[DH]$/.test(c.tagName));
          if (cells.length < 2) continue;
          const time = parseTimeRange(cells[col.time] ? cells[col.time].textContent : '');
          if (!time) continue;
          const titleText = clean(cells[col.title] ? cells[col.title].textContent : '');
          if (!titleText || /^(lunch|break)\b/i.test(titleText)) continue;
          if (!currentDate) { warnings.push(`Skipped "${titleText}": no day heading above it`); continue; }
          const delivery = col.delivery >= 0 && cells[col.delivery] ? clean(cells[col.delivery].textContent) : '';
          sessions.push({ date: currentDate, start: time.start, end: time.end, title: titleText, delivery });
        }
        continue;
      }
      const text = clean(el.textContent);
      const day = parseDayHeading(text);
      if (day) { currentDate = day; inTheme = false; continue; }
      if (/weekly theme/i.test(text)) {
        theme.push(clean(text.replace(/^.*?weekly theme\s*:?\s*/i, '')));
        inTheme = true;
        continue;
      }
      if (inTheme && /^H[1-6]$/.test(el.tagName) && text) theme.push(text);
      else if (el.tagName === 'P') inTheme = false;
    }

    sessions.sort((a, b) => (a.date + String(a.start).padStart(4, '0')).localeCompare(b.date + String(b.start).padStart(4, '0')));
    return { title, theme: theme.filter(Boolean), sessions, warnings };
  }

  function runCanvas() {
    const looksLikeTimetable = /timetable/i.test(location.pathname) ||
      /timetable/i.test(document.title) || !!document.querySelector('h1.page-title');
    if (!looksLikeTimetable) return;
    const parsed = parseCanvasTimetable(document);
    if (!/timetable/i.test(parsed.title) && !parsed.sessions.length) return;
    injectStyle();

    if (!parsed.sessions.length) {
      showToast(`OTJ autofill: this looks like a timetable but no sessions could be read.`);
      return;
    }
    const firstDate = parsed.sessions[0].date;
    const key = `${firstDate}|${parsed.title}`;
    const weeks = getWeeks();
    weeks[key] = { ...parsed, url: location.href, captured: new Date().toISOString(), firstDate };
    saveWeeks(weeks);
    const taught = parsed.sessions.reduce((a, s) => a + sessionMinutes(s), 0);
    showToast(`✓ OTJ autofill captured "${parsed.title}": ${parsed.sessions.length} sessions, ${fmtHM(taught)} timetabled.` +
      (parsed.warnings.length ? `\n⚠ ${parsed.warnings.join('\n⚠ ')}` : ''));
  }

  function showToast(text) {
    const t = h('div', { class: 'otj-box otj-toast', style: 'white-space:pre-wrap' }, text,
      h('div', { style: 'margin-top:6px;text-align:right' },
        h('button', { class: 'otj-btn secondary', onclick: () => t.remove() }, 'Dismiss')));
    document.body.append(t);
    setTimeout(() => t.remove(), 12000);
  }

  // ───────────────────────── DeepSeek: SML topics ─────────────────────────

  function askDeepSeek(week, sessions, remainingMins) {
    const apiKey = getSetting('apiKey');
    if (!apiKey) return Promise.reject(new Error('No DeepSeek API key set. Open ⚙ Settings in the panel.'));
    const payload = {
      model: getSetting('model'),
      response_format: { type: 'json_object' },
      temperature: 0.4,
      messages: [
        {
          role: 'system',
          content: 'You plan self-managed revision for a UK medical student. Reply with JSON only: ' +
            '{"topics":[{"topic":"specific revision topic","minutes":90}]}. ' +
            'Blocks are 60-180 minutes in multiples of 15 and must add up exactly to the minutes requested. ' +
            'Topics must be specific, clinically relevant, follow on from this week\'s theme and sessions, ' +
            'and must not just repeat a session title. Write each topic as a short phrase (max 15 words).',
        },
        {
          role: 'user',
          content: JSON.stringify({
            week: week.title,
            theme: week.theme,
            sessions: sessions.map((s) => s.title), // titles only; no names or rooms
            minutes_to_plan: remainingMins,
          }),
        },
      ],
    };
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: 'https://api.deepseek.com/chat/completions',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        data: JSON.stringify(payload),
        timeout: 60000,
        onload: (res) => {
          try {
            if (res.status !== 200) throw new Error(`DeepSeek returned ${res.status}: ${String(res.responseText).slice(0, 200)}`);
            const body = JSON.parse(res.responseText);
            const content = body.choices[0].message.content;
            const json = JSON.parse(content.replace(/^```(?:json)?|```$/g, '').trim());
            resolve(normaliseTopics(json.topics || json, remainingMins));
          } catch (e) { reject(e); }
        },
        onerror: () => reject(new Error('Could not reach DeepSeek (network error).')),
        ontimeout: () => reject(new Error('DeepSeek took too long to answer.')),
      });
    });
  }

  // ───────────────────────── Aptem: fill the Add Note form ─────────────────────────

  const isVisible = (el) => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const page$ = () => (typeof unsafeWindow !== 'undefined' && unsafeWindow.jQuery) || null;

  function findDialog() {
    const heads = [...document.querySelectorAll('h1,h2,h3,h4,h5,.modal-title,.k-window-title,span,div')]
      .filter((e) => clean(e.textContent) === 'Add Note' && isVisible(e));
    for (const head of heads) {
      let el = head;
      while (el && el !== document.body) {
        if (el.querySelector('textarea') && el.querySelector('input,select')) return el;
        el = el.parentElement;
      }
    }
    return null;
  }

  /** Find the control that belongs to a visible label like "Note Type:" inside the dialog. */
  function controlForLabel(dialog, labelRe) {
    const labels = [...dialog.querySelectorAll('label,span,div,b,strong,p')]
      .filter((e) => isVisible(e) && labelRe.test(clean(e.textContent)) && clean(e.textContent).length < 60 &&
        ![...e.children].some((c) => labelRe.test(clean(c.textContent))));
    for (const label of labels) {
      if (label.htmlFor) {
        const byId = document.getElementById(label.htmlFor);
        if (byId) return byId;
      }
      // Walk forward through following siblings (and parents' siblings) to the first control.
      let node = label;
      for (let depth = 0; depth < 4 && node; depth++) {
        let sib = node.nextElementSibling;
        while (sib) {
          const c = sib.matches('select,input:not([type=hidden]),textarea,[role=combobox],.k-dropdown,.k-dropdownlist,.k-picker')
            ? sib
            : sib.querySelector('select,input:not([type=hidden]):not([type=radio]),textarea,[role=combobox],.k-dropdown,.k-dropdownlist,.k-picker');
          if (c) return c;
          sib = sib.nextElementSibling;
        }
        node = node.parentElement;
        if (node === dialog) break;
      }
    }
    return null;
  }

  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype
      : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    el.focus();
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  /** Kendo widgets keep the real <input>/<select> inside a wrapper; find it. */
  function kendoWidget(ctrl, name) {
    const $ = page$();
    if (!$) return null;
    const candidates = [ctrl, ...ctrl.querySelectorAll('input,select'),
      ...(ctrl.parentElement ? ctrl.parentElement.querySelectorAll('input,select') : [])];
    for (const c of candidates) {
      const w = $(c).data(name);
      if (w) return w;
    }
    return null;
  }

  async function setDropdown(ctrl, wanted) {
    // 1. Native <select>
    const sel = ctrl.tagName === 'SELECT' ? ctrl : ctrl.querySelector('select');
    if (sel && sel.options.length) {
      const i = bestOption([...sel.options].map((o) => o.text), wanted);
      if (i < 0) return { ok: false, msg: `no option like "${wanted}" in [${[...sel.options].map((o) => o.text).join(', ')}]` };
      setNativeValue(sel, sel.options[i].value);
      const k = kendoWidget(ctrl, 'kendoDropDownList');
      if (k) { k.value(sel.options[i].value); k.trigger('change'); }
      return { ok: true, msg: sel.options[i].text };
    }
    // 2. Kendo DropDownList
    const k = kendoWidget(ctrl, 'kendoDropDownList') || kendoWidget(ctrl, 'kendoComboBox');
    if (k) {
      const items = k.dataSource.view().map((d) => (typeof d === 'object' ? d[k.options.dataTextField] || d.text || d.Text : d));
      const i = bestOption(items.map(String), wanted);
      if (i < 0) return { ok: false, msg: `no option like "${wanted}" in [${items.join(', ')}]` };
      k.select(i + (k.options.optionLabel ? 1 : 0));
      k.trigger('change');
      return { ok: true, msg: String(items[i]) };
    }
    // 3. Click it open and pick from the popup list
    (ctrl.querySelector('[role=combobox],button,.k-input-button,.k-select') || ctrl).click();
    await sleep(400);
    const opts = [...document.querySelectorAll('[role=option],li.k-list-item,li.k-item,.dropdown-item,mat-option')].filter(isVisible);
    const i = bestOption(opts.map((o) => o.textContent), wanted);
    if (i < 0) {
      document.body.click();
      return { ok: false, msg: `couldn't open the list or find "${wanted}"` };
    }
    const text = clean(opts[i].textContent);
    opts[i].click();
    return { ok: true, msg: text };
  }

  async function setDate(ctrl, iso) {
    const input = ctrl.tagName === 'INPUT' ? ctrl : ctrl.querySelector('input');
    if (!input) return { ok: false, msg: 'no date box found' };
    const k = kendoWidget(input, 'kendoDatePicker');
    const [y, m, d] = iso.split('-').map(Number);
    if (k) { k.value(new Date(y, m - 1, d)); k.trigger('change'); return { ok: true, msg: isoToUK(iso) }; }
    setNativeValue(input, input.type === 'date' ? iso : isoToUK(iso));
    return { ok: true, msg: isoToUK(iso) };
  }

  function chooseRadio(dialog, labelRe) {
    const labels = [...dialog.querySelectorAll('label,span')].filter((e) => labelRe.test(clean(e.textContent)) && isVisible(e));
    for (const l of labels) {
      const input = l.control || l.querySelector('input[type=radio]') ||
        (l.previousElementSibling && l.previousElementSibling.matches('input[type=radio]') ? l.previousElementSibling : null) ||
        (l.parentElement && l.parentElement.querySelector('input[type=radio]'));
      if (input) {
        input.click();
        if (!input.checked) { input.checked = true; input.dispatchEvent(new Event('change', { bubbles: true })); }
        return { ok: true, msg: clean(l.textContent) };
      }
      l.click();
      return { ok: true, msg: clean(l.textContent) };
    }
    return { ok: false, msg: 'option not found' };
  }

  async function waitFor(fn, ms = 3000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const v = fn();
      if (v) return v;
      await sleep(100);
    }
    return null;
  }

  async function fillAptem({ dateISO, hours, noteText }) {
    const report = [];
    let dialog = findDialog();
    if (!dialog) {
      const addBtn = [...document.querySelectorAll('button,a')].find((b) => /^\+?\s*add note$/i.test(clean(b.textContent)) && isVisible(b));
      if (!addBtn) return ['✗ Open the task you want and click "+ Add Note" first.'];
      addBtn.click();
      dialog = await waitFor(findDialog);
      if (!dialog) return ['✗ Clicked "Add Note" but the form didn\'t appear.'];
    }

    const line = (name, r) => report.push(`${r.ok ? '✓' : '✗'} ${name}: ${r.msg}`);

    const noteType = controlForLabel(dialog, /^note type:?$/i);
    line('Note type', noteType ? await setDropdown(noteType, getSetting('noteType')) : { ok: false, msg: 'field not found' });

    const date = controlForLabel(dialog, /^completion date:?$/i);
    line('Completion date', date ? await setDate(date, dateISO) : { ok: false, msg: 'field not found' });

    line('Hours collection type', chooseRadio(dialog, /^off\s*the\s*job\s*training\s*hours$/i));

    const hoursBox = await waitFor(() => controlForLabel(dialog, /^off.?the.?job hours spent:?$/i));
    if (hoursBox) {
      const input = hoursBox.tagName === 'INPUT' ? hoursBox : hoursBox.querySelector('input');
      const mk = input && kendoWidget(input, 'kendoMaskedTextBox');
      if (mk) { mk.value(hours); mk.trigger('change'); }
      if (input) setNativeValue(input, hours);
      line('OTJ hours spent', { ok: !!input, msg: input ? hours : 'no input' });
    } else line('OTJ hours spent', { ok: false, msg: 'field not found (did the radio button switch?)' });

    const typeCtrl = controlForLabel(dialog, /^off.?the.?job hours type:?$/i);
    line('OTJ hours type', typeCtrl ? await setDropdown(typeCtrl, getSetting('otjType')) : { ok: false, msg: 'field not found' });

    const boxes = [...dialog.querySelectorAll('textarea')].filter(isVisible);
    const notes = boxes[boxes.length - 1];
    if (notes) { setNativeValue(notes, noteText); line('Notes', { ok: true, msg: `${noteText.split('\n').length} lines` }); }
    else line('Notes', { ok: false, msg: 'notes box not found' });

    report.push('', 'Check the form, then press Save yourself.');
    return report;
  }

  // ───────────────────────── Aptem: panel UI ─────────────────────────

  function runAptem() {
    injectStyle();
    let panel = null;
    const fab = h('button', { class: 'otj-box otj-btn otj-fab', title: 'Aptem OTJ autofill' }, 'OTJ fill');
    fab.addEventListener('click', () => {
      if (panel) { panel.remove(); panel = null; return; }
      panel = buildPanel(() => { panel.remove(); panel = null; });
      document.body.append(panel);
    });
    document.body.append(fab);
  }

  function buildPanel(close) {
    const weeks = getWeeks();
    const keys = Object.keys(weeks).sort().reverse();
    const panel = h('div', { class: 'otj-box otj-panel' });

    const header = h('div', { class: 'otj-row', style: 'justify-content:space-between' },
      h('h3', {}, 'OTJ autofill'),
      h('div', {},
        h('button', { class: 'otj-btn secondary', onclick: () => { body.replaceChildren(settingsView(() => { body.replaceChildren(); render(); })); } }, '⚙ Settings'),
        ' ',
        h('button', { class: 'otj-btn secondary', onclick: close }, '✕')));
    const body = h('div');
    panel.append(header, body);

    if (!keys.length) {
      body.append(h('p', {}, 'No timetables captured yet. Open your week\'s timetable page on Canvas once (with this script installed), then come back here.'));
      return panel;
    }

    let weekKey = keys[0];
    let topics = [];
    let attended = {};

    const status = h('div', { class: 'otj-status', style: 'display:none' });
    const setStatus = (text) => { status.style.display = text ? 'block' : 'none'; status.textContent = text || ''; };

    function render() {
      const week = weeks[weekKey];
      const target = parseHM(getSetting('target')) || 2250;
      week.sessions.forEach((s, i) => { if (!(i in attended)) attended[i] = true; });
      const chosen = () => week.sessions.filter((_, i) => attended[i]);
      const taught = () => chosen().reduce((a, s) => a + sessionMinutes(s), 0);
      const remaining = () => Math.max(0, target - taught());

      const weekSelect = h('select', {
        onchange: (e) => { weekKey = e.target.value; topics = []; attended = {}; body.replaceChildren(); render(); },
      }, keys.map((k) => h('option', { value: k, selected: k === weekKey }, weeks[k].title || k)));

      const summary = h('div', { class: 'otj-muted' });
      const updateSummary = () => {
        summary.textContent = `Timetabled ${fmtHM(taught())} · SML needed ${fmtHM(remaining())} · Target ${fmtHM(target)}`;
      };

      const list = h('div');
      let lastDate = null;
      week.sessions.forEach((s, i) => {
        if (s.date !== lastDate) { list.append(h('div', { class: 'otj-day' }, shortDay(s.date))); lastDate = s.date; }
        list.append(h('label', { class: 'otj-sess' },
          h('input', { type: 'checkbox', checked: attended[i], onchange: (e) => { attended[i] = e.target.checked; updateSummary(); } }),
          h('span', {}, `${fmtHM(s.start)}-${fmtHM(s.end)} ${s.title}`)));
      });

      const topicsBox = h('textarea', { placeholder: 'One per line, e.g.\n01:30 | Upper vs lower motor neurone signs' }, topicsToText(topics));
      topicsBox.addEventListener('input', () => { topics = textToTopics(topicsBox.value); });

      const suggestBtn = h('button', { class: 'otj-btn secondary' }, 'Suggest SML topics');
      suggestBtn.addEventListener('click', async () => {
        if (!remaining()) { setStatus('Timetabled hours already reach the target; no SML needed.'); return; }
        suggestBtn.disabled = true; setStatus('Asking DeepSeek…');
        try {
          topics = await askDeepSeek(week, chosen(), remaining());
          topicsBox.value = topicsToText(topics);
          setStatus('Topics suggested. Edit them so they match what you\'ll actually revise.');
        } catch (e) { setStatus(`✗ ${e.message}`); }
        suggestBtn.disabled = false;
      });

      const lastDay = week.sessions[week.sessions.length - 1].date;
      const dateInput = h('input', { type: 'text', value: isoToUK(lastDay) });

      const preview = h('textarea', { style: 'min-height:180px' });
      const buildBtn = h('button', { class: 'otj-btn secondary' }, 'Build note');
      buildBtn.addEventListener('click', () => {
        topics = textToTopics(topicsBox.value);
        const sml = topics.reduce((a, t) => a + t.minutes, 0);
        preview.value = buildNote(week, chosen(), topics, target);
        const total = taught() + sml;
        setStatus(total === target ? '✓ Adds up to the target.'
          : `⚠ Sessions + SML = ${fmtHM(total)}, target is ${fmtHM(target)}. Adjust the SML times if needed.`);
      });

      const fillBtn = h('button', { class: 'otj-btn' }, 'Fill Aptem form');
      fillBtn.addEventListener('click', async () => {
        if (!preview.value.trim()) buildBtn.click();
        const m = dateInput.value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
        if (!m) { setStatus('✗ Completion date must be dd/mm/yyyy.'); return; }
        const iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
        fillBtn.disabled = true; setStatus('Filling…');
        try {
          const report = await fillAptem({ dateISO: iso, hours: fmtHM(target), noteText: preview.value });
          setStatus(report.join('\n'));
        } catch (e) { setStatus(`✗ ${e.message}`); }
        fillBtn.disabled = false;
      });

      const debugBtn = h('button', { class: 'otj-btn secondary', title: 'Copies the Add Note form\'s HTML so it can be sent for fixing' }, 'Copy form HTML');
      debugBtn.addEventListener('click', () => {
        const d = findDialog();
        if (!d) { setStatus('Open the Add Note form first.'); return; }
        GM_setClipboard(d.outerHTML, 'text');
        setStatus('Form HTML copied to clipboard.');
      });

      updateSummary();
      body.append(
        h('label', {}, 'Week', weekSelect),
        summary,
        h('h4', {}, 'Sessions attended'),
        list,
        h('h4', {}, 'Self-managed learning'),
        h('div', { class: 'otj-row' }, suggestBtn),
        topicsBox,
        h('h4', {}, 'Note'),
        h('label', {}, 'Completion date (dd/mm/yyyy)', dateInput),
        h('div', { class: 'otj-row' }, buildBtn, fillBtn, debugBtn),
        preview,
        status,
      );
    }

    function settingsView(done) {
      const fields = {
        apiKey: h('input', { type: 'password', value: getSetting('apiKey'), placeholder: 'sk-…' }),
        model: h('input', { type: 'text', value: getSetting('model') }),
        target: h('input', { type: 'text', value: getSetting('target') }),
        noteType: h('input', { type: 'text', value: getSetting('noteType') }),
        otjType: h('input', { type: 'text', value: getSetting('otjType') }),
      };
      const save = h('button', { class: 'otj-btn' }, 'Save settings');
      save.addEventListener('click', () => {
        if (parseHM(fields.target.value) == null) { alert('Weekly target must look like 37:30'); return; }
        for (const [k, el] of Object.entries(fields)) setSetting(k, el.value.trim());
        done();
      });
      const clear = h('button', { class: 'otj-btn secondary' }, 'Forget captured weeks');
      clear.addEventListener('click', () => { if (confirm('Delete all captured timetables?')) { saveWeeks({}); location.reload(); } });
      return h('div', {},
        h('label', {}, 'DeepSeek API key (stored only in this browser)', fields.apiKey),
        h('label', {}, 'Model', fields.model),
        h('label', {}, 'Weekly hours target', fields.target),
        h('label', {}, 'Note type to pick', fields.noteType),
        h('label', {}, 'OTJ hours type to pick (closest match is chosen)', fields.otjType),
        h('div', { class: 'otj-row' }, save, clear));
    }

    render();
    return panel;
  }

  // ───────────────────────── Start ─────────────────────────

  if (location.hostname === 'canvas.anglia.ac.uk') {
    // Canvas renders page content after load; give it a moment.
    setTimeout(runCanvas, 1500);
  } else if (/\.aptem\.co\.uk$/.test(location.hostname)) {
    runAptem();
  }
  GM_registerMenuCommand('OTJ autofill: forget captured weeks', () => saveWeeks({}));
})();
