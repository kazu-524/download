// ページの中（各フレーム）で動く処理
// - 今表示されている画面を調べて、添付ファイルらしいリンク・要素を集める
// - hook.js（ページ側）から届く Blob の情報を覚え、頼まれたらダウンロードする
(() => {
  if (globalThis.__adlLoaded) return;
  globalThis.__adlLoaded = true;
  // 読み込みの途中から入った（＝拡張機能を入れる前から開いていたタブ）か
  const injectedLate = document.readyState !== 'loading';

  const TAG = '__adl_ext__';
  const DATA_URL_LIMIT = 25 * 1024 * 1024; // これより大きい Blob はページ内のリンク経由で保存

  // ---------- hook.js との連絡 ----------

  const blobs = new Map(); // Blob URL -> { size, type, name }
  const waiting = new Map(); // 問い合わせ番号 -> resolve
  let seq = 0;

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || typeof d !== 'object' || d[TAG] !== true) return;
    if (d.kind === 'blob') {
      // 名前の手がかり：File の名前 → サーバーの指定名 → 取得元 URL の末尾
      const srcName = ADL.baseName(d.src || '');
      const name = d.name || ADL.filenameFromDisposition(d.cd || '') || (ADL.extOf(srcName) ? srcName : '');
      blobs.set(d.url, { size: d.size, type: d.type || '', name, src: d.src || '' });
      if (blobs.size > 60) blobs.delete(blobs.keys().next().value);
    } else if (d.kind === 'anchor') {
      const b = blobs.get(d.url);
      if (b && d.name) b.name = d.name;
    } else if (d.kind === 'blobData') {
      const done = waiting.get(d.reqId);
      if (done) {
        waiting.delete(d.reqId);
        done(d.blob instanceof Blob ? d.blob : null);
      }
    }
  });

  function requestBlob(url) {
    return new Promise((resolve) => {
      const reqId = `${Date.now()}-${++seq}`;
      waiting.set(reqId, resolve);
      window.postMessage({ [TAG]: true, kind: 'getBlob', url, reqId }, '*');
      setTimeout(() => {
        if (waiting.delete(reqId)) resolve(null);
      }, 5000);
    });
  }

  // ---------- 画面の調査 ----------

  const SKIP_TAGS = new Set(['link', 'base', 'meta', 'script', 'style', 'img', 'picture', 'use', 'image',
    'noscript', 'template', 'input', 'track', 'head', 'title']);
  const SRC_ATTRS = new Set(['src', 'data']);
  const URL_ATTRS = new Set(['href', 'src', 'data', 'formaction']);
  const SKIP_SCHEME = /^(javascript|mailto|tel|sms|about|chrome|edge|chrome-extension|extension|intent|blob|data):/i;
  // パスやクエリにこの言葉があれば「たぶんダウンロード用」とみなす（推定扱い）
  const HINT = /(download|attach|getfile|get_file|filedownload|file_download|fileid|file_id|docid|dl\.(php|cgi|aspx?|jsp)|\/files?\/)/i;
  // 属性値が URL らしい形か
  const LOOKS_URL = /^(https?:\/\/|\/\/|\/|\.\.?\/)|^[\w\-.%~]+\/\S*$|^[^\s'"<>]+\.[a-z0-9]{2,5}([?#]\S*)?$/i;
  // onclick などの中の '...' "..." を取り出す
  const QUOTED = /["'`]([^"'`\s<>]{3,2048})["'`]/g;

  function allElements(root, out) {
    for (const el of root.querySelectorAll('*')) {
      out.push(el);
      let sr = el.shadowRoot;
      if (!sr && chrome.dom && chrome.dom.openOrClosedShadowRoot) {
        try { sr = chrome.dom.openOrClosedShadowRoot(el); } catch { sr = null; }
      }
      if (sr) allElements(sr, out);
    }
    return out;
  }

  function labelOf(el) {
    let t = (el.textContent || '').slice(0, 400);
    if (!t.trim()) {
      const img = el.querySelector && el.querySelector('img[alt]');
      t = el.getAttribute('title') || el.getAttribute('aria-label') || (img && img.alt) || '';
    }
    return t.replace(/\s+/g, ' ').trim().slice(0, 200);
  }

  function scan() {
    const found = new Map(); // URL -> 項目

    const add = (item) => {
      const cur = found.get(item.url);
      if (!cur) { found.set(item.url, item); return; }
      if (item.nameRank > cur.nameRank) { cur.name = item.name; cur.nameRank = item.nameRank; }
      cur.guess = cur.guess && item.guess;
      if (!cur.label && item.label) cur.label = item.label;
    };

    const consider = (raw, el, attr, fromScript) => {
      if (!raw) return;
      raw = raw.trim();
      if (!raw || raw.length > 4096 || raw.startsWith('#')) return;
      const tag = el.tagName.toLowerCase();
      const isLink = (tag === 'a' || tag === 'area') && attr === 'href';
      const dlAttr = isLink && el.hasAttribute('download') ? (el.getAttribute('download') || '').trim() : null;

      // <a href="data:..." download="名前"> のようにページ内で作られたファイル
      if (/^data:/i.test(raw)) {
        if (dlAttr) {
          const ext = ADL.extOf(dlAttr) || ADL.extFromMime(raw.slice(5).split(/[;,]/)[0]);
          add({ url: raw, source: 'link', name: dlAttr, nameRank: 3, ext, category: ADL.categoryOf(ext), guess: false, label: labelOf(el) });
        }
        return;
      }
      if (SKIP_SCHEME.test(raw)) return;
      if (!isLink && !SRC_ATTRS.has(attr) && !LOOKS_URL.test(raw)) return;

      let url;
      try { url = new URL(raw, document.baseURI); } catch { return; }
      if (!/^(https?|file|ftp):$/.test(url.protocol)) return;
      url.hash = '';
      const href = url.href;

      const urlExt = ADL.extOf(ADL.baseName(href));
      const qName = ADL.nameFromQuery(href);
      const label = labelOf(el);
      const textName = isLink ? ADL.findFileName(label) || ADL.findFileName(el.getAttribute('title')) : '';
      const hint = HINT.test(url.pathname + url.search);
      let guess = false;

      if (isLink) {
        if (!urlExt && !qName && !textName && dlAttr === null) {
          if (!hint) return;
          guess = true;
        }
      } else if (SRC_ATTRS.has(attr)) {
        // iframe・embed・object・video などの src は、拡張子がファイルのものだけ
        if (!urlExt) return;
      } else {
        // data-url="..." や onclick="..." など
        if (!urlExt && !qName) {
          if (!hint || fromScript) return;
          guess = true;
        }
      }

      let name = '';
      let nameRank = 1;
      if (dlAttr) { name = dlAttr; nameRank = 3; }
      else if (textName) { name = textName; nameRank = 3; }
      else if (qName) { name = qName; nameRank = 3; }
      else { name = ADL.baseName(href) || label || href; }

      const ext = ADL.extOf(name) || urlExt || ADL.extOf(qName);
      add({ url: href, source: 'link', name, nameRank, ext, category: ADL.categoryOf(ext), guess, label });
    };

    const doc = document;
    if (!doc || !doc.documentElement) return { items: [], late: injectedLate };
    for (const el of allElements(doc, [])) {
      const tag = el.tagName.toLowerCase();
      if (SKIP_TAGS.has(tag)) continue;
      for (const attr of el.attributes) {
        const n = attr.name.toLowerCase();
        const v = attr.value;
        if (!v) continue;
        if (n.startsWith('data-') && /^\s*[[{]/.test(v)) {
          // data-props='{"file": "/files/a.pdf"}' のように JSON で入っている場合
          for (const m of v.matchAll(QUOTED)) consider(m[1].replace(/\\\//g, '/'), el, n, true);
        } else if (URL_ATTRS.has(n) || n.startsWith('data-')) {
          consider(v, el, n, false);
        } else if (n.startsWith('on')) {
          for (const m of v.matchAll(QUOTED)) consider(m[1], el, n, true);
        }
      }
    }

    const items = [...found.values()];

    // JavaScript がその場で作ったファイル（Blob）
    let i = 0;
    for (const [url, b] of blobs) {
      i++;
      const ext = ADL.extOf(b.name) || ADL.extFromMime(b.type);
      const name = b.name || `page-file-${i}${ext ? '.' + ext : ''}`;
      items.push({
        url, source: 'blob', name, nameRank: b.name ? 3 : 1, ext, category: ADL.categoryOf(ext),
        size: b.size, contentType: b.type, guess: false, label: '', src: b.src,
      });
    }

    for (const it of items) it.frameUrl = location.href;
    return { items, late: injectedLate };
  }

  // ---------- Blob の保存 ----------

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }

  async function downloadBlob(url, name, folder) {
    const blob = await requestBlob(url);
    if (!blob) return { ok: false, error: 'ページ側でファイルが見つかりません（ページを開き直して再度お試しください）' };
    if (!ADL.extOf(name)) {
      const ext = ADL.extFromMime(blob.type);
      if (ext) name = `${name}.${ext}`;
    }
    // 拡張機能側で新しい Blob URL を作り、ダウンロード機能に渡す（ページが元の URL を破棄していても保存できる）
    const objUrl = URL.createObjectURL(blob);
    setTimeout(() => URL.revokeObjectURL(objUrl), 10 * 60 * 1000);
    const r = await chrome.runtime.sendMessage({ type: 'downloadNamed', url: objUrl, filename: name, folder });
    if (r && r.ok) return r;
    // 受け付けられなかった場合の予備：data URL で渡す
    if (blob.size <= DATA_URL_LIMIT) {
      const dataUrl = await blobToDataUrl(blob);
      return chrome.runtime.sendMessage({ type: 'downloadNamed', url: dataUrl, filename: name, folder });
    }
    return r || { ok: false, error: '保存できませんでした' };
  }

  globalThis.__adlScan = scan;
  globalThis.__adlDownloadBlob = downloadBlob;
})();
