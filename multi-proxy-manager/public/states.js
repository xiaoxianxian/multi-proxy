/* ============================================================================
   multi-proxy · 统一状态层（Phase C）
   ----------------------------------------------------------------------------
   三态：loading（骨架/加载中）/ empty（真没有）/ error（读不到）。
   视觉与既有 .empty-state 同族（不引入新样式体系），但补了骨架态 variant
   与 ARIA 角色（role=status / role=alert），并对齐 dashboard 既有的「重试」
   按钮约定（注册式，innerHTML 重绘也不丢监听）。

   用法（各页在 nav.js 之后、业务脚本之前加载本文件）：
     MPStates.loading('加载中…')                 → 加载态 HTML
     MPStates.empty({title, hint, icon})         → 空态 HTML
     MPStates.error({title, detail, hint, retryKey})
                                                  → 错误态 HTML（带重试）
     MPStates.skeleton({variant, count, height}) → 骨架占位 HTML
     MPStates.registerRetry('key', fn)           → 注册某区域的重试回调
   所有函数返回字符串，可直接 innerHTML 进容器；必要时先用 loading/skeleton
   占位，拿到结果再 empty/正常渲染，失败再 error。
   ========================================================================== */
(function () {
  'use strict';

  function esc(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // 常用 Feather 风格 SVG（与现有 .icon-svg 同 viewBox，保证视觉一致）
  var SVG = {
    box:   '<svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>',
    clock: '<svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
    inbox: '<svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>',
    warn:  '<svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    bars:  '<svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>'
  };

  var WARN_COLOR = '#d97706';

  function loading(text) {
    return '<div class="empty-state" role="status" aria-live="polite">' +
             '<div class="empty-icon">' + SVG.clock + '</div>' +
             '<div class="empty-text">' + esc(text || '加载中…') + '</div>' +
           '</div>';
  }

  // variant: 'block'（卡片/行占位）| 'text'（行内文字占位）| 'card'（网格卡片占位）
  function skeleton(opts) {
    opts = opts || {};
    var count = opts.count || 3;
    var variant = opts.variant || 'block';
    var out = '';
    if (variant === 'text') {
      var lines = opts.count || 4;
      for (var i = 0; i < lines; i++) {
        out += '<div class="mp-skel mp-skel-line" style="width:' +
               (opts.widths && opts.widths[i] ? opts.widths[i] : (60 + (i % 3) * 12) + '%') + '"></div>';
      }
      return '<div class="mp-skel-wrap" role="status" aria-label="加载中" aria-busy="true">' + out + '</div>';
    }
    if (variant === 'card') {
      var h = opts.height || 96;
      for (var c = 0; c < count; c++) {
        out += '<div class="mp-skel mp-skel-card" style="height:' + h + 'px"></div>';
      }
      return '<div class="mp-skel-grid" role="status" aria-label="加载中" aria-busy="true">' + out + '</div>';
    }
    // block（默认）
    var bh = opts.height || 20;
    for (var b = 0; b < count; b++) {
      out += '<div class="mp-skel mp-skel-block" style="height:' + bh + 'px"></div>';
    }
    return '<div class="mp-skel-wrap" role="status" aria-label="加载中" aria-busy="true">' + out + '</div>';
  }

  function empty(opts) {
    opts = opts || {};
    var icon = opts.icon ? opts.icon : SVG.inbox;
    var html = '<div class="empty-state" role="status">';
    if (icon) html += '<div class="empty-icon">' + icon + '</div>';
    html += '<div class="empty-text">' + esc(opts.title || '暂无数据') + '</div>';
    if (opts.hint) {
      html += '<div class="empty-hint">' + esc(opts.hint) + '</div>';
    }
    html += '</div>';
    return html;
  }

  // retryKey: 注册到 MPStates.retryHandlers 的键；不传则不显示重试按钮
  function error(opts) {
    opts = opts || {};
    var body = [opts.detail, opts.hint].filter(Boolean).map(esc).join('<br>') || '未知错误';
    var btn = '';
    if (opts.retryKey) {
      btn = '<button class="btn btn-outline btn-sm" type="button" style="margin-top:10px;" ' +
            'onclick="MPStates.retry(\'' + esc(opts.retryKey) + '\')">重试</button>';
    }
    return '<div class="empty-state" role="alert" style="grid-column:1/-1;">' +
             '<div class="empty-icon" style="color:' + WARN_COLOR + ';">' + SVG.warn + '</div>' +
             '<div class="empty-text" style="color:' + WARN_COLOR + ';">' +
               esc(opts.title || '读取失败') + '</div>' +
             '<div class="empty-detail">' + body + '</div>' +
             btn +
           '</div>';
  }

  // 注册式重试：避免 innerHTML 重绘丢失监听器（容器被替换，但 JS 里的回调还在）
  var retryHandlers = {};
  function registerRetry(key, fn) { retryHandlers[key] = fn; }
  function retry(key) { var f = retryHandlers[key]; if (typeof f === 'function') f(); }

  window.MPStates = {
    esc: esc,
    svg: SVG,
    loading: loading,
    skeleton: skeleton,
    empty: empty,
    error: error,
    registerRetry: registerRetry,
    retry: retry
  };
})();
