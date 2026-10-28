// 共通処理：拡張子の分類、ファイル名の取り出し・整形
// ページ内（content.js）・ポップアップ・バックグラウンドのすべてで読み込む
(() => {
  if (globalThis.ADL) return;

  const CATEGORIES = [
    { key: 'pdf', label: 'PDF', exts: ['pdf'] },
    {
      key: 'office',
      label: 'Office・文書',
      exts: ['doc', 'docx', 'docm', 'dot', 'dotx', 'xls', 'xlsx', 'xlsm', 'xlsb', 'xlt', 'xltx',
        'ppt', 'pptx', 'pptm', 'pps', 'ppsx', 'csv', 'tsv', 'rtf', 'txt', 'odt', 'ods', 'odp',
        'msg', 'eml', 'vsd', 'vsdx', 'one', 'xps', 'xdw', 'xbd', 'jtd', 'pages', 'numbers', 'key', 'epub', 'md'],
    },
    { key: 'archive', label: '圧縮', exts: ['zip', 'lzh', '7z', 'rar', 'gz', 'tgz', 'tar', 'bz2', 'xz', 'cab', 'iso', 'dmg'] },
    { key: 'image', label: '画像', exts: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'tif', 'tiff', 'webp', 'heic', 'heif', 'svg', 'psd', 'ai', 'eps'] },
    { key: 'media', label: '動画・音声', exts: ['mp4', 'mov', 'm4v', 'avi', 'wmv', 'mkv', 'webm', 'mpg', 'mpeg', 'mp3', 'm4a', 'wav', 'wma', 'aac', 'flac', 'ogg'] },
    { key: 'other', label: 'その他', exts: ['exe', 'msi', 'apk', 'dwg', 'dxf', 'jww', 'sfc', 'p21', 'ics', 'vcf'] },
  ];

  const EXT_TO_CAT = new Map();
  for (const c of CATEGORIES) for (const e of c.exts) EXT_TO_CAT.set(e, c.key);
  const EXT_LIST = [...EXT_TO_CAT.keys()].sort((a, b) => b.length - a.length).join('|');

  const MIME_TO_EXT = {
    'application/pdf': 'pdf',
    'application/zip': 'zip',
    'application/x-zip-compressed': 'zip',
    'application/x-7z-compressed': '7z',
    'application/vnd.rar': 'rar',
    'application/x-rar-compressed': 'rar',
    'application/gzip': 'gz',
    'application/x-gzip': 'gz',
    'application/x-tar': 'tar',
    'application/x-lzh-compressed': 'lzh',
    'application/msword': 'doc',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.ms-powerpoint': 'ppt',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'application/vnd.ms-excel.sheet.macroenabled.12': 'xlsm',
    'application/vnd.ms-outlook': 'msg',
    'application/rtf': 'rtf',
    'text/rtf': 'rtf',
    'text/csv': 'csv',
    'application/csv': 'csv',
    'text/tab-separated-values': 'tsv',
    'text/plain': 'txt',
    'message/rfc822': 'eml',
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/bmp': 'bmp',
    'image/tiff': 'tif',
    'image/heic': 'heic',
    'image/svg+xml': 'svg',
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/webm': 'webm',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
  };

  function safeDecode(s) {
    try { return decodeURIComponent(s); } catch { return s; }
  }

  // 名前の末尾が既知の拡張子なら、その拡張子（小文字）を返す
  function extOf(name) {
    const m = /\.([a-z0-9]{1,8})$/i.exec(String(name || '').trim());
    if (!m) return '';
    const e = m[1].toLowerCase();
    return EXT_TO_CAT.has(e) ? e : '';
  }

  function categoryOf(ext) {
    return EXT_TO_CAT.get(ext) || 'other';
  }

  function extFromMime(mime) {
    return MIME_TO_EXT[String(mime || '').split(';')[0].trim().toLowerCase()] || '';
  }

  // URL のパスの最後の部分（デコード済み）
  function baseName(urlStr) {
    try {
      const u = new URL(urlStr);
      if (!/^(https?|file|ftp):$/.test(u.protocol)) return '';
      const seg = u.pathname.split('/').filter(Boolean).pop() || '';
      return safeDecode(seg);
    } catch {
      return '';
    }
  }

  // ?filename=xxx.pdf のようにクエリにファイル名が入っている場合
  function nameFromQuery(urlStr) {
    try {
      const u = new URL(urlStr);
      for (const k of ['filename', 'file_name', 'fileName', 'fname', 'name', 'file', 'title', 'f']) {
        const v = u.searchParams.get(k);
        if (!v) continue;
        const last = v.split(/[\\/]/).pop();
        if (extOf(last)) return last;
      }
    } catch { /* 無視 */ }
    return '';
  }

  // 「添付：見積書.xlsx（120KB）」のような文から、ファイル名らしい部分を取り出す
  const FILE_IN_TEXT = new RegExp(
    `([^\\\\/:*?"<>|\\s:：「『（(\\[]+\\.(?:${EXT_LIST}))(?=$|[\\s()（）\\[\\]「」『』、,;；])`,
    'i',
  );
  function findFileName(text) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t || t.length > 300) return '';
    // 文全体がファイル名（空白入りの名前も含む）
    if (t.length <= 150 && extOf(t) && !/[\\/:*?"<>|]/.test(t)) return t;
    const m = FILE_IN_TEXT.exec(t);
    return m ? m[1].trim() : '';
  }

  // Content-Disposition ヘッダーからファイル名を取り出す
  function filenameFromDisposition(cd) {
    if (!cd) return '';
    let m = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(cd);
    if (m) {
      const charset = (m[1] || 'utf-8').trim().toLowerCase() || 'utf-8';
      const v = m[2].trim().replace(/^"|"$/g, '');
      try { return decodePercent(v, charset); } catch { /* 下へ */ }
    }
    m = /filename\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^;]+))/i.exec(cd);
    if (!m) return '';
    let v = (m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2]).trim();
    if (/%[0-9a-f]{2}/i.test(v)) v = safeDecode(v);
    else if (/[\u0080-\u00ff]/.test(v) && !/[^\u0000-\u00ff]/.test(v)) v = fixMojibake(v);
    return v;
  }

  function decodePercent(v, charset) {
    if (charset === 'utf-8' || charset === 'utf8') return decodeURIComponent(v);
    const bytes = [];
    for (let i = 0; i < v.length; i++) {
      if (v[i] === '%' && /^[0-9a-f]{2}$/i.test(v.substr(i + 1, 2))) {
        bytes.push(parseInt(v.substr(i + 1, 2), 16));
        i += 2;
      } else {
        bytes.push(v.charCodeAt(i) & 0xff);
      }
    }
    return new TextDecoder(charset).decode(new Uint8Array(bytes));
  }

  // ヘッダーの生バイトが Latin-1 の文字として届いたときに、日本語へ戻す
  function fixMojibake(s) {
    const bytes = Uint8Array.from(s, (c) => c.charCodeAt(0));
    for (const enc of ['utf-8', 'shift_jis', 'euc-jp']) {
      try { return new TextDecoder(enc, { fatal: true }).decode(bytes); } catch { /* 次へ */ }
    }
    return s;
  }

  // Windows でも保存できるファイル名にする
  const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
  function sanitizeName(name, fallback = 'download') {
    let s = String(name || '')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^[.\s]+/, '')
      .replace(/[.\s]+$/, '');
    if (!s) s = fallback;
    if (RESERVED.test(s)) s = '_' + s;
    if (s.length > 120) {
      const ext = (/\.[^.]{1,8}$/.exec(s) || [''])[0];
      s = s.slice(0, 120 - ext.length).trim() + ext;
    }
    return s;
  }

  // 「サイト名/2026-10-28」のような保存先フォルダ（ダウンロードフォルダからの相対）
  function sanitizeFolder(folder) {
    return String(folder || '')
      .split(/[\\/]+/)
      .map((p) => p.trim())
      .filter((p) => p && p !== '.' && p !== '..')
      .slice(0, 4)
      .map((p) => sanitizeName(p, 'folder').slice(0, 60))
      .join('/');
  }

  function formatSize(bytes) {
    if (!bytes) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let n = bytes;
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
  }

  globalThis.ADL = {
    CATEGORIES,
    extOf,
    categoryOf,
    extFromMime,
    baseName,
    nameFromQuery,
    findFileName,
    filenameFromDisposition,
    sanitizeName,
    sanitizeFolder,
    formatSize,
    safeDecode,
  };
})();
