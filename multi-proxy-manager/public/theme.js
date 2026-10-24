// multi-proxy — 统一主题接线（P0-1 根因修复）
// 旧系统：各页只设 body.theme-dark（无 CSS 匹配）+ 写 localStorage.darkMode，
// 从不在 <html> 设 data-theme，导致暗色永不生效（11/11 页 themeLinked=false）。
// 本文件为唯一事实来源：在 <html> 上设 data-theme(light|dark|auto)，
// 兼容旧 darkMode 键，支持跟随系统；并接管旧开关按钮的点击。
(function () {
  'use strict';

  var STORAGE_KEY = 'theme';      // 'light' | 'dark' | 'auto'
  var LEGACY_KEY = 'darkMode';    // 旧键：'true' | 'false'

  function read(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function write(key, val) {
    try { localStorage.setItem(key, val); } catch (e) {}
  }

  function resolve() {
    var t = read(STORAGE_KEY);
    if (t === 'light' || t === 'dark' || t === 'auto') return t;
    // 迁移旧键
    var lm = read(LEGACY_KEY);
    if (lm === 'true') { write(STORAGE_KEY, 'dark'); return 'dark'; }
    if (lm === 'false') { write(STORAGE_KEY, 'light'); return 'light'; }
    return 'auto';
  }

  function applyTheme(theme) {
    var resolved = theme;
    if (theme === 'auto') {
      var mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
      resolved = (mq && mq.matches) ? 'dark' : 'light';
    }
    document.documentElement.setAttribute('data-theme', resolved);
    return resolved;
  }

  var current = resolve();
  applyTheme(current);

  // 跟随系统：仅在 auto 下响应系统切换
  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    var onSysChange = function () { if (resolve() === 'auto') { applyTheme('auto'); emit(); } };
    if (mq.addEventListener) mq.addEventListener('change', onSysChange);
    else if (mq.addListener) mq.addListener(onSysChange);
  }

  function persist(theme) { write(STORAGE_KEY, theme); }
  function set(theme) { current = theme; persist(theme); applyTheme(theme); emit(); }
  function get() { return current; }
  function toggle() { set(current === 'dark' ? 'light' : 'dark'); }

  function emit() {
    try {
      window.dispatchEvent(new CustomEvent('mp-theme-change', {
        detail: { theme: current, resolved: document.documentElement.getAttribute('data-theme') }
      }));
    } catch (e) {}
    syncLegacyToggles();
  }

  // 让旧开关按钮的视觉与 data-theme 同步（旧 handler 已被本文件接管点击）
  function syncLegacyToggles() {
    var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    var sels = '#darkModeToggle,#btn-theme,#appearanceDark,.theme-toggle,[data-mp-theme-toggle]';
    try {
      var nodes = document.querySelectorAll(sels);
      for (var i = 0; i < nodes.length; i++) {
        nodes[i].classList.toggle('mp-theme-on', isDark);
        if (nodes[i].hasAttribute('title')) {
          nodes[i].setAttribute('title', isDark ? '切换到亮色模式' : '切换暗色模式');
        }
        // 开关类控件：把状态同步进无障碍树，否则读屏器只知道有个开关、不知道开没开
        if (nodes[i].getAttribute('role') === 'switch') {
          nodes[i].setAttribute('aria-checked', isDark ? 'true' : 'false');
        }
      }
    } catch (e) {}
  }

  // 旧开关按钮：点击交给本文件，统一切 data-theme（避免旧 handler 只设 body 类无效）
  var TOGGLE_SEL = '#darkModeToggle,#btn-theme,#appearanceDark,.theme-toggle,[data-mp-theme-toggle]';
  document.addEventListener('DOMContentLoaded', function () {
    document.addEventListener('click', function (e) {
      var t = e.target;
      var el = t && t.closest ? t.closest(TOGGLE_SEL) : null;
      if (el) { e.preventDefault(); toggle(); }
    }, false);
    syncLegacyToggles();
  });

  window.MPTheme = {
    set: set, get: get, toggle: toggle,
    apply: applyTheme, resolve: resolve
  };
})();
