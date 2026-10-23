/* =====================================================================
 * 留言板 · Note Wall
 * app.js —— 逻辑全部在本地完成，数据存 localStorage
 * v1.1.0：新增「回复指定留言」与「图片」
 * ===================================================================== */

(function () {
  'use strict';

  const KEY = {
    notes: 'notewall:notes:v1',
    owner: 'notewall:owner:v1',
    liked: 'notewall:liked:v1',
    nick: 'notewall:nick:v1',
    theme: 'notewall:theme',
  };

  const PAGE = 8;
  const MAX_LEN = 500;
  const MAX_REPLY = 300;
  const MAX_IMAGES = 3;
  const IMG_MAX_EDGE = 1280;
  const IMG_TARGET_BYTES = 200 * 1024;
  const DEFAULT_HINT = '说点什么吧，写下的内容只会保存在这台设备的浏览器里。';

  /* ------------------------------------------------------------ 工具 */

  const $ = (sel) => document.querySelector(sel);

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID().slice(0, 12);
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function read(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  }

  function write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      return false;
    }
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function timeAgo(ts) {
    const diff = Date.now() - ts;
    if (diff < 45 * 1000) return '刚刚';
    if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + ' 分钟前';
    if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / 3600000) + ' 小时前';
    if (diff < 7 * 24 * 60 * 60 * 1000) return Math.floor(diff / 86400000) + ' 天前';

    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    const sameYear = d.getFullYear() === new Date().getFullYear();
    const base = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return sameYear ? base : d.getFullYear() + '-' + base;
  }

  const GRADIENTS = [
    ['#6366f1', '#8b5cf6'], ['#06b6d4', '#3b82f6'], ['#f59e0b', '#ef4444'],
    ['#10b981', '#06b6d4'], ['#ec4899', '#8b5cf6'], ['#f97316', '#facc15'],
    ['#14b8a6', '#22d3ee'], ['#8b5cf6', '#ec4899'],
  ];

  function avatarStyle(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    const [a, b] = GRADIENTS[h % GRADIENTS.length];
    return `background:linear-gradient(135deg,${a},${b})`;
  }

  function initial(name) {
    const s = String(name).trim();
    if (!s) return '匿';
    const ch = Array.from(s)[0];
    return /[a-z]/.test(ch) ? ch.toUpperCase() : ch;
  }

  /** 压缩图片为 dataURL，控制体积以适配 localStorage */
  function compressImage(file) {
    return new Promise((resolve, reject) => {
      if (!file || !/^image\//.test(file.type)) {
        reject(new Error('不是图片文件'));
        return;
      }
      const url = URL.createObjectURL(file);
      const img = new Image();

      img.onload = () => {
        const scale = Math.min(1, IMG_MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
        let w = Math.max(1, Math.round(img.naturalWidth * scale));
        let h = Math.max(1, Math.round(img.naturalHeight * scale));

        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        let quality = 0.82;
        let data = '';

        for (let guard = 0; guard < 8; guard++) {
          canvas.width = w;
          canvas.height = h;
          ctx.clearRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
          data = canvas.toDataURL('image/webp', quality);
          if (data.length * 0.75 <= IMG_TARGET_BYTES) break;
          if (quality > 0.55) {
            quality -= 0.12;
          } else {
            w = Math.max(1, Math.round(w * 0.8));
            h = Math.max(1, Math.round(h * 0.8));
            quality = 0.72;
          }
        }

        URL.revokeObjectURL(url);
        resolve(data);
      };

      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('图片读取失败'));
      };

      img.src = url;
    });
  }

  /* ------------------------------------------------------------ 状态 */

  const ownerId = (function () {
    let id = read(KEY.owner, null);
    if (!id) {
      id = uid();
      write(KEY.owner, id);
    }
    return id;
  })();

  let notes = loadNotes();
  let likedSet = new Set(read(KEY.liked, []));

  const state = {
    sort: 'new',
    query: '',
    visible: PAGE,
    justAdded: null,
    openReply: new Set(),   // 展开了回复框的留言
    expanded: new Set(),    // 展开了全部回复的留言
    quote: new Map(),       // noteId -> replyId（引用回复）
    drafts: new Map(),      // noteId -> 草稿文本
    pending: [],            // 待发布的图片 dataURL
  };

  function loadNotes() {
    const saved = read(KEY.notes, null);
    if (!Array.isArray(saved)) {
      write(KEY.notes, []);
      return [];
    }
    // 迁移：清掉早期版本内置的示例留言；补齐 v1.1.0 新字段
    let changed = false;
    const cleaned = [];

    for (const n of saved) {
      if (!isValidNote(n)) { changed = true; continue; }
      if (n.ownerId === 'seed') { changed = true; continue; }

      if (!Array.isArray(n.images)) { n.images = []; changed = true; }
      if (!Array.isArray(n.replies)) { n.replies = []; changed = true; }
      n.replies = n.replies.filter((r) => r && typeof r.text === 'string');
      cleaned.push(n);
    }

    if (changed) write(KEY.notes, cleaned);
    return cleaned;
  }

  function isValidNote(n) {
    return n && typeof n.id === 'string' && typeof n.text === 'string';
  }

  function save() {
    return write(KEY.notes, notes);
  }

  /* ------------------------------------------------------------ DOM */

  const el = {
    form: $('#form'),
    nickname: $('#nickname'),
    content: $('#content'),
    count: $('#count'),
    counter: $('#count').parentElement,
    hint: $('#hint'),
    statusDot: $('#status-dot'),
    statusText: $('#status-text'),
    previewAvatar: $('#preview-avatar'),
    clearBtn: $('#clear-btn'),
    pickImg: $('#pick-img'),
    fileInput: $('#file-input'),
    imgStrip: $('#img-strip'),
    imgHint: $('#img-hint'),
    search: $('#search'),
    themeBtn: $('#theme-btn'),
    list: $('#list'),
    empty: $('#empty'),
    emptyText: $('#empty-text'),
    countLabel: $('#count-label'),
    moreBtn: $('#more-btn'),
    toast: $('#toast'),
    exportBtn: $('#export-btn'),
    lightbox: $('#lightbox'),
    lightboxImg: $('#lightbox-img'),
    lightboxClose: $('#lightbox-close'),
    tabs: Array.prototype.slice.call(document.querySelectorAll('.tab')),
  };

  /* ------------------------------------------------------------ 主题 */

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem(KEY.theme, theme); } catch (e) {}
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'light' ? '#f4f6fb' : '#0a0c11');
  }

  el.themeBtn.addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
  });

  /* ------------------------------------------------------------ 渲染 */

  function currentName() {
    const v = el.nickname.value.trim();
    return v || '匿名';
  }

  function refreshAvatar() {
    const name = currentName();
    el.previewAvatar.textContent = initial(name);
    el.previewAvatar.setAttribute('style', avatarStyle(name));
    el.previewAvatar.classList.remove('pop');
    void el.previewAvatar.offsetWidth;
    el.previewAvatar.classList.add('pop');
  }

  function filtered() {
    let arr = notes.slice();
    const q = state.query.trim();
    if (q) {
      const lq = q.toLowerCase();
      arr = arr.filter(
        (n) =>
          n.text.toLowerCase().includes(lq) ||
          String(n.name || '').toLowerCase().includes(lq)
      );
    }
    if (state.sort === 'hot') {
      arr.sort((a, b) => heat(b) - heat(a) || b.at - a.at);
    } else {
      arr.sort((a, b) => b.at - a.at);
    }
    return arr;
  }

  function heat(n) {
    return (n.likes || 0) * 3 + (n.replies ? n.replies.length : 0) * 4 + Math.log10(1 + (n.images || []).length * 5);
  }

  function highlighted(text, q) {
    const safe = escapeHtml(text);
    if (!q) return safe;
    const re = new RegExp('(' + escapeRegExp(escapeHtml(q)) + ')', 'gi');
    return safe.replace(re, '<mark>$1</mark>');
  }

  const ICON = {
    heart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20.3 5.7a5.1 5.1 0 0 0-7.2 0L12 6.8l-1.1-1.1a5.1 5.1 0 1 0-7.2 7.2L12 21l8.3-8.1a5.1 5.1 0 0 0 0-7.2z"/></svg>',
    reply: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.5 9.5 0 0 1-2.9-.5L4 21l1.5-4.4A8.2 8.2 0 0 1 3 11.6C3 7 7 3.4 12 3.4s9 3.6 9 8.1z"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M15 5.5A2.5 2.5 0 0 0 12.5 3h-6A3.5 3.5 0 0 0 3 6.5v6A2.5 2.5 0 0 0 5.5 15"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg>',
  };

  /* ------------------------------------------------------------ 回复渲染 */

  function replyTemplate(note, r, q) {
    const mine = r.ownerId === ownerId;
    const canDelete = mine || note.ownerId === ownerId;
    const name = r.name || '匿名';

    return (
      '<div class="reply" data-rid="' + r.id + '">' +
        '<div class="avatar avatar-sm" style="' + avatarStyle(name) + '" aria-hidden="true">' +
          escapeHtml(initial(name)) +
        '</div>' +
        '<div class="reply-main">' +
          '<div class="reply-head">' +
            '<span class="reply-name">' + highlighted(name, q) + '</span>' +
            (mine ? '<span class="tag-mine">我</span>' : '') +
            '<span class="reply-time" title="' + escapeHtml(new Date(r.at).toLocaleString()) + '">' +
              escapeHtml(timeAgo(r.at)) +
            '</span>' +
          '</div>' +
          (r.quote
            ? '<div class="quote" title="' + escapeHtml(r.quote.text) + '">' +
                '<span class="quote-who">@' + escapeHtml(r.quote.name) + '</span>' +
                '<span class="quote-text">' + escapeHtml(r.quote.text) + '</span>' +
              '</div>'
            : '') +
          '<div class="reply-text">' + highlighted(r.text, q) + '</div>' +
          '<div class="reply-acts">' +
            '<button class="act act-xs" type="button" data-act="reply-to" data-rid="' + r.id + '">回复</button>' +
            (canDelete
              ? '<button class="act act-xs del" type="button" data-act="reply-del" data-rid="' + r.id + '">删除</button>'
              : '') +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }

  function replyBlock(note, q) {
    const replies = note.replies || [];
    const open = state.openReply.has(note.id);
    const expanded = state.expanded.has(note.id);
    const shown = expanded ? replies : replies.slice(-2);
    const hiddenCount = replies.length - shown.length;

    const quoteId = state.quote.get(note.id);
    const quoteTarget = quoteId ? replies.find((r) => r.id === quoteId) : null;

    let html = '<section class="replies">';

    if (replies.length) {
      html +=
        (hiddenCount > 0
          ? '<button class="more-replies" type="button" data-act="expand">展开其余 ' + hiddenCount + ' 条回复</button>'
          : '') +
        '<div class="reply-list">' +
          shown.map((r) => replyTemplate(note, r, q)).join('') +
        '</div>';
    }

    if (open) {
      html +=
        '<form class="reply-form" data-note="' + note.id + '">' +
          (quoteTarget
            ? '<div class="quote-chip">' +
                '<span>回复 <b>@' + escapeHtml(quoteTarget.name || '匿名') + '</b>：' +
                  escapeHtml(quoteTarget.text.slice(0, 40)) + '</span>' +
                '<button type="button" class="chip-x" data-act="quote-cancel" aria-label="取消引用">' +
                  ICON.close + '</button>' +
              '</div>'
            : '') +
          '<textarea class="reply-input" maxlength="' + MAX_REPLY + '" rows="2" ' +
            'placeholder="回复 ' + escapeHtml(note.name || '匿名') + '…">' +
            escapeHtml(state.drafts.get(note.id) || '') +
          '</textarea>' +
          '<div class="reply-form-foot">' +
            '<span class="reply-counter" data-for="' + note.id + '">' +
              (state.drafts.get(note.id) || '').length + ' / ' + MAX_REPLY +
            '</span>' +
            '<button type="button" class="btn btn-ghost btn-sm" data-act="reply-cancel">取消</button>' +
            '<button type="submit" class="btn btn-primary btn-sm">发送</button>' +
          '</div>' +
        '</form>';
    } else {
      html +=
        '<button class="reply-trigger" type="button" data-act="open-reply">' +
          '<span class="trigger-avatar" style="' + avatarStyle(currentName()) + '">' +
            escapeHtml(initial(currentName())) +
          '</span>' +
          '<span>写下你的回复…</span>' +
        '</button>';
    }

    html += '</section>';
    return html;
  }

  /* ------------------------------------------------------------ 留言渲染 */

  function noteTemplate(note, q, animate) {
    const liked = likedSet.has(note.id);
    const mine = note.ownerId === ownerId;
    const name = note.name || '匿名';
    const images = note.images || [];

    const article = document.createElement('article');
    article.className = 'note' + (mine ? ' mine' : '') + (animate ? ' enter' : '');
    article.dataset.id = note.id;

    const imgsHtml = images.length
      ? '<div class="note-imgs cols-' + Math.min(images.length, 3) + '">' +
          images.map((src, i) =>
            '<button type="button" class="img-cell" data-act="img" aria-label="查看图片 ' + (i + 1) + '">' +
              '<img src="' + src + '" alt="附图 ' + (i + 1) + '" loading="lazy">' +
            '</button>'
          ).join('') +
        '</div>'
      : '';

    article.innerHTML =
      '<div class="note-head">' +
        '<div class="avatar" style="' + avatarStyle(name) + '" aria-hidden="true">' +
          escapeHtml(initial(name)) +
        '</div>' +
        '<div class="note-who">' +
          '<div class="note-name">' +
            highlighted(name, q) +
            (mine ? '<span class="tag-mine">我</span>' : '') +
          '</div>' +
          '<div class="note-time" title="' + escapeHtml(new Date(note.at).toLocaleString()) + '">' +
            escapeHtml(timeAgo(note.at)) +
          '</div>' +
        '</div>' +
      '</div>' +
      (note.text
        ? '<p class="note-body">' + highlighted(note.text, q) + '</p>'
        : '') +
      imgsHtml +
      '<div class="note-foot">' +
        '<button class="act like' + (liked ? ' on' : '') + '" type="button" data-act="like" ' +
          'aria-pressed="' + liked + '" aria-label="点赞">' +
          ICON.heart + '<span class="like-n">' + (note.likes || 0) + '</span>' +
        '</button>' +
        '<button class="act" type="button" data-act="open-reply" aria-label="回复这条留言">' +
          ICON.reply + '<span>回复' + (note.replies.length ? ' ' + note.replies.length : '') + '</span>' +
        '</button>' +
        '<button class="act" type="button" data-act="copy" aria-label="复制这条留言">' +
          ICON.copy + '<span>复制</span>' +
        '</button>' +
        (mine
          ? '<span class="act-spacer"></span>' +
            '<button class="act del" type="button" data-act="del" aria-label="删除这条留言">' +
            ICON.trash + '<span>删除</span></button>'
          : '') +
      '</div>' +
      replyBlock(note, q);

    return article;
  }

  function render() {
    const list = filtered();
    const shown = list.slice(0, state.visible);

    el.list.innerHTML = '';
    const frag = document.createDocumentFragment();
    shown.forEach((note) => {
      frag.appendChild(noteTemplate(note, state.query.trim(), note.id === state.justAdded));
    });
    el.list.appendChild(frag);
    state.justAdded = null;

    const isEmpty = list.length === 0;
    el.empty.hidden = !isEmpty;
    el.list.hidden = isEmpty;
    if (isEmpty) {
      el.emptyText.textContent = state.query.trim()
        ? '没有匹配的留言，换个关键词试试。'
        : '还没有留言，成为第一个写下的人吧。';
    }

    const total = notes.length;
    el.countLabel.textContent = state.query.trim()
      ? '找到 ' + list.length + ' 条 / 共 ' + total + ' 条'
      : '共 ' + total + ' 条留言';

    el.moreBtn.hidden = list.length <= state.visible;
    el.moreBtn.textContent = '加载更多（还有 ' + Math.max(0, list.length - state.visible) + ' 条）';

    // 回复框自动聚焦
    for (const id of state.openReply) {
      const ta = el.list.querySelector('.reply-input[data-note="' + id + '"]') ||
                 el.list.querySelector('.reply-form[data-note="' + id + '"] .reply-input');
      if (ta) {
        const val = ta.value;
        ta.focus();
        ta.setSelectionRange(val.length, val.length);
        break;
      }
    }
  }

  /* ------------------------------------------------------------ 图片查看 */

  function openLightbox(src) {
    el.lightboxImg.src = src;
    el.lightbox.hidden = false;
    document.body.style.overflow = 'hidden';
  }

  function closeLightbox() {
    el.lightbox.hidden = true;
    el.lightboxImg.removeAttribute('src');
    document.body.style.overflow = '';
  }

  el.lightboxClose.addEventListener('click', closeLightbox);
  el.lightbox.addEventListener('click', (e) => {
    if (e.target === el.lightbox) closeLightbox();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el.lightbox.hidden) closeLightbox();
  });

  /* ------------------------------------------------------------ 列表交互 */

  el.list.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const card = btn.closest('.note');
    if (!card) return;
    const id = card.dataset.id;
    const note = notes.find((n) => n.id === id);
    if (!note) return;
    const act = btn.dataset.act;

    /* 图片放大 */
    if (act === 'img') {
      const img = btn.querySelector('img');
      if (img) openLightbox(img.src);
      return;
    }

    /* 点赞 */
    if (act === 'like') {
      const on = !likedSet.has(id);
      if (on) likedSet.add(id); else likedSet.delete(id);
      note.likes = Math.max(0, (note.likes || 0) + (on ? 1 : -1));
      write(KEY.liked, Array.from(likedSet));
      save();
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-pressed', String(on));
      btn.querySelector('.like-n').textContent = note.likes;
      return;
    }

    /* 复制 */
    if (act === 'copy') {
      const text = (note.name || '匿名') + '：' + note.text;
      copyText(text).then(
        () => toast('已复制到剪贴板'),
        () => toast('复制失败，请手动选择文本', true)
      );
      return;
    }

    /* 删除留言（两段式确认） */
    if (act === 'del') {
      if (btn.dataset.confirm !== '1') {
        btn.dataset.confirm = '1';
        btn.classList.add('confirming');
        btn.querySelector('span').textContent = '确认删除？';
        clearTimeout(btn._resetTimer);
        btn._resetTimer = setTimeout(() => {
          if (!btn.isConnected) return;
          delete btn.dataset.confirm;
          btn.classList.remove('confirming');
          btn.querySelector('span').textContent = '删除';
        }, 3000);
        return;
      }
      clearTimeout(btn._resetTimer);
      card.classList.add('leaving');
      setTimeout(() => {
        notes = notes.filter((n) => n.id !== id);
        likedSet.delete(id);
        write(KEY.liked, Array.from(likedSet));
        state.openReply.delete(id);
        state.expanded.delete(id);
        state.quote.delete(id);
        state.drafts.delete(id);
        save();
        render();
        toast('已删除');
      }, 200);
      return;
    }

    /* 展开全部回复 */
    if (act === 'expand') {
      state.expanded.add(id);
      render();
      return;
    }

    /* 打开回复框 */
    if (act === 'open-reply') {
      state.openReply.add(id);
      render();
      return;
    }

    /* 引用某条回复 */
    if (act === 'reply-to') {
      state.openReply.add(id);
      state.quote.set(id, btn.dataset.rid);
      render();
      return;
    }

    /* 取消引用 */
    if (act === 'quote-cancel') {
      state.quote.delete(id);
      render();
      return;
    }

    /* 取消回复 */
    if (act === 'reply-cancel') {
      state.openReply.delete(id);
      render();
      return;
    }

    /* 删除回复（两段式确认） */
    if (act === 'reply-del') {
      if (btn.dataset.confirm !== '1') {
        btn.dataset.confirm = '1';
        btn.textContent = '确认删除？';
        btn.classList.add('confirming');
        clearTimeout(btn._resetTimer);
        btn._resetTimer = setTimeout(() => {
          if (!btn.isConnected) return;
          delete btn.dataset.confirm;
          btn.classList.remove('confirming');
          btn.textContent = '删除';
        }, 3000);
        return;
      }
      const rid = btn.dataset.rid;
      clearTimeout(btn._resetTimer);
      note.replies = note.replies.filter((r) => r.id !== rid);
      if (state.quote.get(id) === rid) state.quote.delete(id);
      save();
      render();
      toast('回复已删除');
    }
  });

  /* 回复框输入：保存草稿 + 字数 */
  el.list.addEventListener('input', (e) => {
    const ta = e.target.closest('.reply-input');
    if (!ta) return;
    const form = ta.closest('.reply-form');
    const noteId = form.dataset.note;
    state.drafts.set(noteId, ta.value);
    const counter = form.querySelector('.reply-counter');
    if (counter) counter.textContent = ta.value.length + ' / ' + MAX_REPLY;
  });

  /* 回复框提交 + Ctrl+Enter */
  el.list.addEventListener('keydown', (e) => {
    const ta = e.target.closest('.reply-input');
    if (!ta) return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      ta.closest('form').requestSubmit();
    }
    if (e.key === 'Escape') {
      const form = ta.closest('.reply-form');
      state.openReply.delete(form.dataset.note);
      render();
    }
  });

  el.list.addEventListener('submit', (e) => {
    const form = e.target.closest('.reply-form');
    if (!form) return;
    e.preventDefault();

    const noteId = form.dataset.note;
    const note = notes.find((n) => n.id === noteId);
    if (!note) return;

    const ta = form.querySelector('.reply-input');
    const text = (ta.value || '').trim();
    if (!text) {
      toast('回复内容不能为空', true);
      ta.focus();
      return;
    }
    if (text.length > MAX_REPLY) {
      toast('回复不能超过 ' + MAX_REPLY + ' 字', true);
      return;
    }

    const quoteId = state.quote.get(noteId);
    let quote = null;
    if (quoteId) {
      const target = (note.replies || []).find((r) => r.id === quoteId);
      if (target) {
        quote = { name: target.name || '匿名', text: target.text.slice(0, 60) };
      }
    }

    const reply = {
      id: uid(),
      name: currentName().slice(0, 16),
      text: text,
      at: Date.now(),
      ownerId: ownerId,
      quote: quote,
    };

    note.replies.push(reply);
    if (!save()) {
      note.replies.pop();
      toast('保存失败：浏览器存储空间不足', true);
      return;
    }

    state.drafts.delete(noteId);
    state.quote.delete(noteId);
    state.openReply.delete(noteId);
    state.expanded.add(noteId);
    render();
    toast('回复已发布');
  });

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise((resolve, reject) => {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        ok ? resolve() : reject(new Error('copy failed'));
      } catch (err) {
        reject(err);
      }
    });
  }

  el.moreBtn.addEventListener('click', () => {
    state.visible += PAGE;
    render();
  });

  /* ------------------------------------------------------------ 排序 / 搜索 */

  el.tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      if (tab.classList.contains('active')) return;
      el.tabs.forEach((t) => {
        const on = t === tab;
        t.classList.toggle('active', on);
        t.setAttribute('aria-selected', String(on));
      });
      state.sort = tab.dataset.sort;
      state.visible = PAGE;
      render();
    });
  });

  let searchTimer = null;
  el.search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.query = el.search.value;
      state.visible = PAGE;
      render();
    }, 140);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== el.search && document.activeElement !== el.content) {
      e.preventDefault();
      el.search.focus();
    }
    if (e.key === 'Escape' && document.activeElement === el.search) {
      el.search.value = '';
      state.query = '';
      state.visible = PAGE;
      render();
      el.search.blur();
    }
  });

  /* ------------------------------------------------------------ 图片选择 */

  function renderStrip() {
    const n = state.pending.length;
    el.imgStrip.hidden = n === 0;

    el.imgStrip.innerHTML = state.pending.map((src, i) =>
      '<div class="strip-item">' +
        '<img src="' + src + '" alt="待发布图片 ' + (i + 1) + '">' +
        '<button type="button" class="strip-x" data-i="' + i + '" aria-label="移除图片">' + ICON.close + '</button>' +
      '</div>'
    ).join('');

    el.imgHint.textContent = n >= MAX_IMAGES
      ? '已达上限（' + MAX_IMAGES + ' 张）'
      : '还可添加 ' + (MAX_IMAGES - n) + ' 张';
    el.imgHint.classList.toggle('warn', n >= MAX_IMAGES);
    updateStatus();
  }

  el.imgStrip.addEventListener('click', (e) => {
    const btn = e.target.closest('.strip-x');
    if (!btn) return;
    state.pending.splice(Number(btn.dataset.i), 1);
    renderStrip();
  });

  async function addFiles(fileList) {
    const files = Array.prototype.slice.call(fileList || []);
    const imgs = files.filter((f) => /^image\//.test(f.type));
    if (!imgs.length) {
      toast('请选择图片文件', true);
      return;
    }

    for (const file of imgs) {
      if (state.pending.length >= MAX_IMAGES) {
        toast('最多只能添加 ' + MAX_IMAGES + ' 张图片', true);
        break;
      }
      try {
        const data = await compressImage(file);
        state.pending.push(data);
        renderStrip();
      } catch (err) {
        toast('图片处理失败：' + err.message, true);
      }
    }
  }

  el.pickImg.addEventListener('click', () => el.fileInput.click());
  el.fileInput.addEventListener('change', () => {
    addFiles(el.fileInput.files);
    el.fileInput.value = '';
  });

  /* 粘贴图片 */
  el.content.addEventListener('paste', (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    const files = [];
    for (const it of items) {
      if (it.kind === 'file' && /^image\//.test(it.type)) {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  });

  /* 拖拽图片到输入框 */
  el.content.addEventListener('dragover', (e) => {
    if (e.dataTransfer && Array.prototype.some.call(e.dataTransfer.types, (t) => t === 'Files')) {
      e.preventDefault();
      el.content.classList.add('dragging');
    }
  });
  el.content.addEventListener('dragleave', () => el.content.classList.remove('dragging'));
  el.content.addEventListener('drop', (e) => {
    el.content.classList.remove('dragging');
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
      e.preventDefault();
      addFiles(e.dataTransfer.files);
    }
  });

  /* ------------------------------------------------------------ 发布留言 */

  function updateCounter() {
    const len = el.content.value.length;
    el.count.textContent = len;
    el.counter.classList.toggle('warn', len > MAX_LEN - 40);
  }

  function updateStatus() {
    const has = el.content.value.trim().length > 0 ||
      el.nickname.value.trim().length > 0 ||
      state.pending.length > 0;
    el.statusDot.className = 'dot' + (has ? ' dirty' : '');
    el.statusText.textContent = has ? '编辑中…' : '未发布';
  }

  function setHint(msg, isError) {
    el.hint.textContent = msg;
    el.hint.classList.toggle('err', !!isError);
  }

  el.nickname.addEventListener('input', () => {
    refreshAvatar();
    updateStatus();
    try { localStorage.setItem(KEY.nick, el.nickname.value); } catch (e) {}
  });

  el.content.addEventListener('input', () => {
    updateCounter();
    updateStatus();
    if (el.hint.classList.contains('err')) setHint(DEFAULT_HINT, false);
  });

  el.content.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      el.form.requestSubmit();
    }
  });

  el.clearBtn.addEventListener('click', () => {
    el.content.value = '';
    state.pending = [];
    renderStrip();
    updateCounter();
    setHint(DEFAULT_HINT, false);
    el.content.focus();
  });

  el.form.addEventListener('submit', (e) => {
    e.preventDefault();

    const text = el.content.value.trim();
    if (!text && state.pending.length === 0) {
      setHint('留言内容不能为空，写点字或加一张图片吧。', true);
      el.content.focus();
      return;
    }
    if (text.length > MAX_LEN) {
      setHint('内容超过 ' + MAX_LEN + ' 字了，精简一下吧。', true);
      return;
    }

    const note = {
      id: uid(),
      name: currentName().slice(0, 16),
      text: text,
      at: Date.now(),
      likes: 0,
      ownerId: ownerId,
      images: state.pending.slice(),
      replies: [],
    };

    notes.unshift(note);
    if (!save()) {
      notes.shift();
      setHint('保存失败：浏览器存储空间不足，少放几张图片试试。', true);
      toast('保存失败：存储空间不足', true);
      return;
    }

    el.content.value = '';
    state.pending = [];
    renderStrip();
    updateCounter();
    refreshAvatar();

    state.justAdded = note.id;
    state.visible = Math.max(state.visible, PAGE);

    if (state.sort !== 'new') {
      state.sort = 'new';
      el.tabs.forEach((t) => {
        const on = t.dataset.sort === 'new';
        t.classList.toggle('active', on);
        t.setAttribute('aria-selected', String(on));
      });
    }
    if (state.query) {
      el.search.value = '';
      state.query = '';
    }

    render();
    updateStatus();
    el.statusDot.className = 'dot ok';
    el.statusText.textContent = '已发布';
    setHint('发布成功，已置顶显示。', false);
    toast('留言已发布');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  /* ------------------------------------------------------------ 导出 */

  el.exportBtn.addEventListener('click', () => {
    const data = JSON.stringify({ exportedAt: new Date().toISOString(), notes: notes }, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const d = new Date();
    a.href = url;
    a.download = 'notewall-' + d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0') + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('已导出 ' + notes.length + ' 条留言');
  });

  /* ------------------------------------------------------------ Toast */

  let toastTimer = null;
  function toast(msg, isError) {
    el.toast.textContent = msg;
    el.toast.classList.toggle('err', !!isError);
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2200);
  }

  /* ------------------------------------------------------------ 初始化 */

  function init() {
    const savedNick = read(KEY.nick, '');
    if (typeof savedNick === 'string' && savedNick) el.nickname.value = savedNick.slice(0, 16);

    refreshAvatar();
    updateCounter();
    updateStatus();
    renderStrip();
    render();
    applyTheme(document.documentElement.dataset.theme || 'dark');

    setInterval(() => {
      el.list.querySelectorAll('.note').forEach((card) => {
        const note = notes.find((n) => n.id === card.dataset.id);
        if (!note) return;
        const t = card.querySelector('.note-time');
        if (t) t.textContent = timeAgo(note.at);
        card.querySelectorAll('.reply').forEach((r) => {
          const rep = (note.replies || []).find((x) => x.id === r.dataset.rid);
          if (!rep) return;
          const rt = r.querySelector('.reply-time');
          if (rt) rt.textContent = timeAgo(rep.at);
        });
      });
    }, 60000);
  }

  init();
})();
