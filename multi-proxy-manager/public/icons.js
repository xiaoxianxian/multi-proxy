// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// 单一图标来源（决策 E）：全站内联 SVG，统一描边风格（stroke: currentColor，靠 .icon-svg 接管尺寸与描边）。
// 背景：此前会话/技能/日志等页各自硬编码了一份导航 SVG，与 nav.js 的图标集重复且会漂移；
// 另有 🔒 / ⚠ / 🔴🟡🔵 等 emoji 当图标用——不同平台渲染不一致，读屏器会读出一串名字。
// 收敛后：图标一律从 window.MPIcons 取，装饰性图标一律 aria-hidden（见 a11yAttrs）。
//
// 用法：在 nav.js 之前加载本文件；nav.js 会优先使用 global.MPIcons，取不到才用自己的内置回退。

(function (global) {
  'use strict';

  var S = function (body, extraClass) {
    return '<svg class="icon-svg' + (extraClass ? ' ' + extraClass : '') + '" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + body + '</svg>';
  };
  // 导航图标额外带 nav-icon 类：与 nav.js 原本的内联写法保持同形，避免切换图标集后尺寸漂移。
  var N = function (body) { return S(body, 'nav-icon'); };

  // ===== 导航图标 =====
  var nav = {
    overview: N('<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>'),
    floor: N('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>'),
    proxy: N('<rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>'),
    sessions: N('<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>'),
    knowledge: N('<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>'),
    skills: N('<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>'),
    logs: N('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>'),
    settings: N('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
    health: N('<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>'),
    alerts: N('<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>'),
    registry: N('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
    cost: N('<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>'),
    shadow: N('<path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2z"/><path d="M12 6v6l4 2"/>'),
    legal: N('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>')
  };

  // ===== 语义/状态图标 =====
  // 原先这些位置用 emoji（🔒 ⚠ 🔴🟡🔵），跨平台渲染不一致、读屏器读不出语义，这里换成 SVG。
  // 颜色走 currentColor + 语义 class（.sev-critical / .sev-warning / .sev-info），由 CSS 令牌决定。
  var status = {
    lock:    S('<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'),
    warn:    S('<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>'),
    critical: S('<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>', 'sev sev-critical'),
    warning:  S('<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>', 'sev sev-warning'),
    info:     S('<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>', 'sev sev-info'),
    offline:  S('<path d="M1 1l22 22"/><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/><path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/><path d="M10.71 5.05A16 16 0 0 1 22.58 9"/><path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/>')
  };

  // 告警严重度 → 图标（原 🔴 / 🟡 / 🔵 emoji）。形状 + 颜色双通道，不靠颜色单通道传达信息。
  var SEVERITY = { critical: status.critical, warning: status.warning, info: status.info };

  global.MPIcons = {
    nav: nav,
    status: status,
    // severity('critical'|'warning'|其他) → 对应 SVG；未知等级回落 info，绝不返回空串（空白会让人以为没图标）
    severity: function (level) { return SEVERITY[level] || status.info; },
    // get('nav.logs') / get('status.lock') 便捷取法，取不到返回空串
    get: function (path) {
      var parts = String(path).split('.');
      var cur = global.MPIcons;
      for (var i = 0; i < parts.length; i++) {
        if (cur == null) return '';
        cur = cur[parts[i]];
      }
      return typeof cur === 'string' ? cur : '';
    }
  };

  // ===== 静态 HTML 自动填充 =====
  // 静态标记：<div class="gate-icon" data-mp-icon="status.lock"></div>
  // 这样 HTML 里不必再重复内联一份 SVG（此前每个页面各内联一份，图标一改就漂移）。
  // 图标一律 aria-hidden（装饰性）；若某处图标是唯一信息载体，请在宿主元素上补 aria-label，
  // 不要给 <svg> 加 role/label —— 那样读屏器会重复播报。
  function fillStaticIcons() {
    var nodes = document.querySelectorAll('[data-mp-icon]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var svg = global.MPIcons.get(el.getAttribute('data-mp-icon'));
      if (svg) el.innerHTML = svg;
    }
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fillStaticIcons);
    } else {
      fillStaticIcons();
    }
  }
  global.MPIcons.fillStaticIcons = fillStaticIcons;
})(typeof window !== 'undefined' ? window : this);
