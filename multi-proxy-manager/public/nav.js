// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// 单一导航来源（P0-5）：dashboard / knowledge / proxy-config / floor 共用。
// 主导航 8 项（真实页面/路由，统一中文化），键盘可激活（<a>/<button>）。
// dashboard 额外渲染页内 SPA 子视图（健康/告警/注册表/成本/影子）+ 动态代理容器，
// 其余页面只渲染主导航，保证 4 页主导航一致。

(function (global) {
  'use strict';

  // ===== 图标（内联 SVG，统一描边风格；与既有 nav 视觉一致）=====
  var ICON = {
    overview:  '<svg class="icon-svg nav-icon" viewBox="0 0 24 24"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>',
    floor:     '<svg class="icon-svg nav-icon" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
    proxy:     '<svg class="icon-svg nav-icon" viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>',
    sessions:  '<svg class="icon-svg nav-icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
    knowledge: '<svg class="icon-svg nav-icon" viewBox="0 0 24 24"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>',
    skills:    '<svg class="icon-svg nav-icon" viewBox="0 0 24 24"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
    logs:      '<svg class="icon-svg nav-icon" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
    settings:  '<svg class="icon-svg nav-icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
    health:    '<svg class="icon-svg nav-icon" viewBox="0 0 24 24"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>',
    alerts:    '<svg class="icon-svg nav-icon" viewBox="0 0 24 24"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>',
    registry:  '<svg class="icon-svg nav-icon" viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    cost:      '<svg class="icon-svg nav-icon" viewBox="0 0 24 24"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
    shadow:    '<svg class="icon-svg nav-icon" viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2z"/><path d="M12 6v6l4 2"/></svg>'
  };

  // ===== 主导航（真实页面/路由）—— 4 页一致 =====
  var PRIMARY = [
    { id: 'dashboard', label: '总览',     href: '/dashboard',     icon: ICON.overview },
    { id: 'floor',     label: 'Floor 盘面', href: '/floor',        icon: ICON.floor },
    { id: 'proxy',     label: '代理配置',  href: '/proxy-config',  icon: ICON.proxy },
    { id: 'sessions',  label: '任务管理',  href: '/sessions',      icon: ICON.sessions },
    { id: 'knowledge', label: '知识库',    href: '/knowledge',     icon: ICON.knowledge },
    { id: 'skills',    label: '技能',      href: '/skills',        icon: ICON.skills },
    { id: 'logs',      label: '日志',      href: '/logs',          icon: ICON.logs },
    { id: 'settings',  label: '设置',      href: '/settings',      icon: ICON.settings }
  ];

  // ===== dashboard 页内 SPA 子视图（仅 dashboard 渲染，保持功能不丢）=====
  var SPA_VIEWS = [
    { id: 'health',   label: '健康状态', icon: ICON.health },
    { id: 'alerts',   label: '告警中心', icon: ICON.alerts },
    { id: 'registry', label: 'Agent 注册表', icon: ICON.registry },
    { id: 'cost',     label: '成本',     icon: ICON.cost },
    { id: 'shadow',   label: '影子模式', icon: ICON.shadow }
  ];

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function linkItem(item, current) {
    var active = item.id === current ? ' active' : '';
    return '<a class="nav-item' + active + '" href="' + esc(item.href) + '">' +
      item.icon + '<span>' + esc(item.label) + '</span></a>';
  }

  function spaItem(item, current) {
    var active = item.id === current ? ' active' : '';
    return '<button type="button" class="nav-item' + active + '" data-page="' + esc(item.id) + '">' +
      item.icon + '<span>' + esc(item.label) + '</span></button>';
  }

  /**
   * 渲染侧栏导航到指定容器。
   * @param {HTMLElement} container 目标（通常是 <nav id="sidebarNav">）
   * @param {Object} opts { current, spa, proxyNav }
   *   current  : 当前页 id（高亮）
   *   spa      : 是否渲染 dashboard 页内 SPA 子视图按钮
   *   proxyNav : 是否渲染动态代理容器 #proxyNavItems（dashboard 用）
   */
  function renderNav(container, opts) {
    if (!container) return;
    opts = opts || {};
    var current = opts.current || '';
    var spa = !!opts.spa;
    var proxyNav = !!opts.proxyNav;

    var html = '';
    html += '<div class="nav-label">总览</div>';
    PRIMARY.forEach(function (it) { html += linkItem(it, current); });

    if (spa) {
      html += '<div class="nav-label">仪表盘视图</div>';
      SPA_VIEWS.forEach(function (it) { html += spaItem(it, current); });
    }
    if (proxyNav) {
      html += '<div class="nav-label" id="proxySectionLabel" style="display:none;">代理服务</div>';
      html += '<div id="proxyNavItems"></div>';
    }

    container.innerHTML = html;
  }

  global.renderNav = renderNav;
})(window);
