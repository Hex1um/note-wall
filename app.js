/* =====================================================================
 * 留言板 · Note Wall
 * app.js —— 逻辑全部在本地完成，数据存 localStorage
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
    // 取第一个「有意义」的字符（中文取首字，英文取首字母大写）
    const ch = Array.from(s)[0];
    return /[a-z]/.test(ch) ? ch.toUpperCase() : ch;
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
  let state = {
    sort: 'new',
    query: '',
    visible: PAGE,
    justAdded: null,
  };

  function loadNotes() {
    const saved = read(KEY.notes, null);
    if (Array.isArray(saved)) return saved.filter(isValidNote);
    const seeded = seedNotes();
    write(KEY.notes, seeded);
    return seeded;
  }

  function isValidNote(n) {
    return n && typeof n.id === 'string' && typeof n.text === 'string';
  }

  function save() {
    if (!write(KEY.notes, notes)) {
      toast('保存失败：浏览器存储空间可能已满', true);
    }
  }

  function seedNotes() {
    const now = Date.now();
    const min = 60 * 1000;
    const hour = 60 * min;
    return [
      {
        id: 'seed-2',
        name: '阿柴',
        text: '第一次用这个留言板，界面挺舒服的。\n希望以后能加上回复功能。',
        at: now - 26 * min,
        likes: 3,
        ownerId: 'seed',
      },
      {
        id: 'seed-1',
        name: '匿名',
        text: '路过，留个脚印。',
        at: now - 3 * hour,
        likes: 1,
        ownerId: 'seed',
      },
    ];
  }

  /* ------------------------------------------------------------ DOM */

  const el = {
    form: $('#form'),
    nickname: $('#nickname'),
    content: $('#content'),
    count: $('#count'),
    counter: null,
    hint: $('#hint'),
    statusDot: $('#status-dot'),
    statusText: $('#status-text'),
    previewAvatar: $('#preview-avatar'),
    clearBtn: $('#clear-btn'),
    submitBtn: $('#submit-btn'),
    search: $('#search'),
    themeBtn: $('#theme-btn'),
    list: $('#list'),
    empty: $('#empty'),
    emptyText: $('#empty-text'),
    countLabel: $('#count-label'),
    moreBtn: $('#more-btn'),
    toast: $('#toast'),
    exportBtn: $('#export-btn'),
    tabs: Array.prototype.slice.call(document.querySelectorAll('.tab')),
  };

  el.counter = el.count.parentElement;

  /* ------------------------------------------------------------ 主题 */

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem(KEY.theme, theme); } catch (e) {}
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'light' ? '#f4f6fb' : '#0a0c11');
  }

  el.themeBtn.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    applyTheme(next);
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
    // 强制重排以重启动画
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
      arr.sort((a, b) => (b.likes || 0) - (a.likes || 0) || b.at - a.at);
    } else {
      arr.sort((a, b) => b.at - a.at);
    }
    return arr;
  }

  function highlighted(text, q) {
    const safe = escapeHtml(text);
    if (!q) return safe;
    const re = new RegExp('(' + escapeRegExp(escapeHtml(q)) + ')', 'gi');
    return safe.replace(re, '<mark>$1</mark>');
  }

  function noteTemplate(note, q, animate) {
    const liked = likedSet.has(note.id);
    const mine = note.ownerId === ownerId;
    const name = note.name || '匿名';

    const article = document.createElement('article');
    article.className = 'note' + (mine ? ' mine' : '') + (animate ? ' enter' : '');
    article.dataset.id = note.id;

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
      '<p class="note-body">' + highlighted(note.text, q) + '</p>' +
      '<div class="note-foot">' +
        '<button class="act like' + (liked ? ' on' : '') + '" type="button" data-act="like" ' +
          'aria-pressed="' + liked + '" aria-label="点赞">' +
          heartSvg() +
          '<span class="like-n">' + (note.likes || 0) + '</span>' +
        '</button>' +
        '<button class="act" type="button" data-act="copy" aria-label="复制这条留言">' +
          copySvg() + '<span>复制</span>' +
        '</button>' +
        (mine
          ? '<span class="act-spacer"></span>' +
            '<button class="act del" type="button" data-act="del" aria-label="删除这条留言">' +
            trashSvg() + '<span>删除</span></button>'
          : '') +
      '</div>';

    return article;
  }

  function heartSvg() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" ' +
      'stroke-linecap="round" stroke-linejoin="round"><path d="M20.3 5.7a5.1 5.1 0 0 0-7.2 0L12 6.8l-1.1-1.1a5.1 5.1 0 1 0-7.2 7.2L12 21l8.3-8.1a5.1 5.1 0 0 0 0-7.2z"/></svg>';
  }
  function copySvg() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" ' +
      'stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M15 5.5A2.5 2.5 0 0 0 12.5 3h-6A3.5 3.5 0 0 0 3 6.5v6A2.5 2.5 0 0 0 5.5 15"/></svg>';
  }
  function trashSvg() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" ' +
      'stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/></svg>';
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

    // 空状态
    const isEmpty = list.length === 0;
    el.empty.hidden = !isEmpty;
    el.list.hidden = isEmpty;
    if (isEmpty) {
      el.emptyText.textContent = state.query.trim()
        ? '没有匹配的留言，换个关键词试试。'
        : '还没有留言，成为第一个写下的人吧。';
    }

    // 计数
    const total = notes.length;
    if (state.query.trim()) {
      el.countLabel.textContent = '找到 ' + list.length + ' 条 / 共 ' + total + ' 条';
    } else {
      el.countLabel.textContent = '共 ' + total + ' 条留言';
    }

    // 加载更多
    el.moreBtn.hidden = list.length <= state.visible;
    el.moreBtn.textContent = '加载更多（还有 ' + Math.max(0, list.length - state.visible) + ' 条）';
  }

  /* ------------------------------------------------------------ 交互：列表 */

  el.list.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const card = btn.closest('.note');
    if (!card) return;
    const id = card.dataset.id;
    const note = notes.find((n) => n.id === id);
    if (!note) return;

    const act = btn.dataset.act;

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

    if (act === 'copy') {
      const text = (note.name || '匿名') + '：' + note.text;
      copyText(text).then(
        () => toast('已复制到剪贴板'),
        () => toast('复制失败，请手动选择文本', true)
      );
      return;
    }

    if (act === 'del') {
      // 两次点击确认，避免误删
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
        save();
        render();
        toast('已删除');
      }, 200);
    }
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

  /* ------------------------------------------------------------ 交互：排序 / 搜索 */

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

  /* ------------------------------------------------------------ 交互：发布 */

  function updateCounter() {
    const len = el.content.value.length;
    el.count.textContent = len;
    el.counter.classList.toggle('warn', len > MAX_LEN - 40);
  }

  function updateStatus() {
    const has = el.content.value.trim().length > 0 || el.nickname.value.trim().length > 0;
    el.statusDot.className = 'dot' + (has ? ' dirty' : '');
    el.statusText.textContent = has ? '编辑中…' : '未发布';
  }

  function setHint(msg, isError) {
    el.hint.textContent = msg;
    el.hint.classList.toggle('err', !!isError);
  }

  const DEFAULT_HINT = '说点什么吧，写下的内容只会保存在这台设备的浏览器里。';

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
    updateCounter();
    updateStatus();
    setHint(DEFAULT_HINT, false);
    el.content.focus();
  });

  el.form.addEventListener('submit', (e) => {
    e.preventDefault();

    const text = el.content.value.trim();
    if (!text) {
      setHint('留言内容不能为空。', true);
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
    };

    notes.unshift(note);
    save();

    el.content.value = '';
    updateCounter();
    refreshAvatar();

    state.justAdded = note.id;
    state.visible = Math.max(state.visible, PAGE);

    // 发布后回到「最新」排序，保证新留言可见
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
    // 昵称回填
    const savedNick = read(KEY.nick, '');
    if (typeof savedNick === 'string' && savedNick) el.nickname.value = savedNick.slice(0, 16);

    refreshAvatar();
    updateCounter();
    updateStatus();
    render();
    applyTheme(document.documentElement.dataset.theme || 'dark');

    // 每 60 秒刷新相对时间
    setInterval(() => {
      const cards = el.list.querySelectorAll('.note');
      cards.forEach((card) => {
        const note = notes.find((n) => n.id === card.dataset.id);
        if (!note) return;
        const t = card.querySelector('.note-time');
        if (t) t.textContent = timeAgo(note.at);
      });
    }, 60000);
  }

  init();
})();
