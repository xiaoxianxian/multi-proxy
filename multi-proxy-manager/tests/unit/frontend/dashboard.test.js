// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

/**
 * Dashboard page tests
 * Verifies HTML structure, CSS classes, JS functions, and API endpoints
 * the dashboard frontend consumes.
 */

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const app = require('../../../server');

const PUBLIC_DIR = path.join(__dirname, '../../../public');

// Helper: read a static HTML file as a string
function readHtml(filename) {
  return fs.readFileSync(path.join(PUBLIC_DIR, filename), 'utf8');
}

describe('Dashboard Page', () => {

  describe('HTML Structure', () => {
    let html;
    beforeAll(() => { html = readHtml('dashboard.html'); });

    it('should serve the dashboard HTML page', () => {
      expect(html).toBeDefined();
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('Multi-Proxy Manager - 总览');
    });

    it('should include shared CSS files', () => {
      expect(html).toContain('colors_and_type.css');
      expect(html).toContain('shared-styles.css');
    });

    it('should have sidebar with navigation', () => {
      expect(html).toContain('id="sidebar"');
      expect(html).toContain('class="sidebar"');
      expect(html).toContain('class="sidebar-brand"');
      expect(html).toContain('class="sidebar-nav"');
      expect(html).toContain('Proxy Manager');
    });

    it('should source sidebar nav from single nav.js and cover key pages (P0-5)', () => {
      // P0-5：4 页主导航统一由 public/nav.js 在运行时注入（单一导航来源），
      // 静态 dashboard.html 不再硬编码 <div data-page="...">；主导航改 <a href> 路由。
      // proxy-config.html 仍由页内动态 proxy-nav 引用（见 dashboard.html buildProxyNavItems）。
      expect(html).toContain('nav.js');       // 引单一来源
      expect(html).toContain('renderNav');     // 运行时注入调用
      expect(html).toContain('proxy-config.html'); // 动态 proxy-nav 仍引用
      var nav = fs.readFileSync(path.join(PUBLIC_DIR, 'nav.js'), 'utf8');
      expect(nav).toContain("id: 'dashboard'"); // 真源覆盖：总览/日志/代理配置
      expect(nav).toContain("id: 'logs'");
      expect(nav).toContain("/proxy-config");
    });

    it('should have version info element in sidebar footer', () => {
      expect(html).toContain('id="sidebarVersion"');
    });

    it('should have logout button', () => {
      expect(html).toContain('handleLogout');
    });

    it('should have dark mode toggle button', () => {
      expect(html).toContain('id="darkModeToggle"');
    });

    it('should have mobile menu button', () => {
      expect(html).toContain('id="mobileMenuBtn"');
    });

    it('should have sidebar overlay for mobile', () => {
      expect(html).toContain('class="sidebar-overlay"');
    });

    it('should have offline banner', () => {
      expect(html).toContain('id="offlineBanner"');
      expect(html).toContain('offline-banner');
    });
  });

  describe('Auto-Refresh Controls', () => {
    let html;
    beforeAll(() => { html = readHtml('dashboard.html'); });

    it('should have auto-refresh toggle', () => {
      expect(html).toContain('id="autoRefreshToggle"');
      expect(html).toContain('auto-refresh-panel');
    });

    it('should have auto-refresh interval selector with expected options', () => {
      expect(html).toContain('id="autoRefreshInterval"');
      expect(html).toContain('option value="5"');
      expect(html).toContain('option value="10"');
      expect(html).toContain('option value="30"');
      expect(html).toContain('option value="60"');
      expect(html).toContain('option value="0"');
    });
  });

  describe('Stat Cards', () => {
    let html;
    beforeAll(() => { html = readHtml('dashboard.html'); });

    it('should have proxy status stat card', () => {
      // block1 HIG 重构:代理统计卡从 .stat-card accent-blue 改为 .hig-stat-card blue,
      // 旧 proxyStatusDetail 元素按新设计删除(统计行已并入 .hig-card 列表)。
      // count/label 能力仍在,断言跟到新真源(见 dashboard.html .hig-stat-card blue block)。
      expect(html).toContain('id="proxyStatusCount"');
      expect(html).toContain('class="hig-stat-card blue"');
      expect(html).toContain('class="hig-stat-value"');
    });

    it('should have installed count stat card', () => {
      // block1 HIG:已安装卡从 .stat-card accent-green 改为 .hig-stat-card green,
      // 旧 installedDetail 元素按新设计删除。count 能力仍在(见 .hig-stat-card green block)。
      expect(html).toContain('id="installedCount"');
      expect(html).toContain('class="hig-stat-card green"');
      expect(html).toContain('class="hig-stat-value"');
    });

    it('should have version info card', () => {
      expect(html).toContain('id="versionInfo"');
      expect(html).toContain('管理器版本');
      expect(html).toContain('Codex Proxy');
      expect(html).toContain('Hermes Proxy');
      expect(html).toContain('Cursor Proxy');
    });
  });

  describe('Proxy Status Cards', () => {
    let html;
    beforeAll(() => { html = readHtml('dashboard.html'); });

    it('should have proxy status list container', () => {
      expect(html).toContain('id="proxyStatusList"');
    });

    it('should define PROXY_CONFIGS for codex, hermes, cursor', () => {
      expect(html).toContain("codex:");
      expect(html).toContain("hermes:");
      expect(html).toContain("cursor:");
    });

    it('should define PROXY_CONFIGS for the other installed proxies (P0-1)', () => {
      // 2026-10-22 P0-1：面板此前只管 3 个代理，实测本机还有 6 个在跑/已装的。
      // 键名与端口必须与 lib/process-manager.js buildProxyConfigs() 逐字一致。
      const installed = {
        claude: 18791,
        dsh: 18797,
        opencode: 18798,
        generic: 18799,
        'opencode-free': 18800,
        'workbuddy-shim': 18789,
      };
      for (const [key, port] of Object.entries(installed)) {
        // 带连字符的键在 JS 里必须写成 'opencode-free': {...}，故允许可选引号。
        expect(html).toMatch(new RegExp("['\"]?" + key + "['\"]?\\s*:"));
      }
      // 端口也钉住：前端副本漂移会让卡片跳到错端口
      expect(html).toContain('18791');
      expect(html).toContain('18797');
      expect(html).toContain('18798');
      expect(html).toContain('18799');
      expect(html).toContain('18800');
      expect(html).toContain('18789');
    });

    it('should have proxy cards with toggle buttons', () => {
      expect(html).toContain('btn-toggle-');
      expect(html).toContain('toggleProxy');
    });

    it('should have start/stop API endpoints dynamically constructed', () => {
      // The dashboard constructs /api/{action}/{name} dynamically via fetch
      expect(html).toContain("'/api/'");
      expect(html).toContain('action');
    });

    it('should surface backend fault state in status badge (P2)', () => {
      // 后端 /api/status 返回 fault: true 时，卡片显示"故障熔断"而非笼统的"未运行"
      expect(html).toContain('status.fault');
      expect(html).toContain('故障熔断');
    });
  });

  describe('JavaScript Functions', () => {
    let html;
    beforeAll(() => { html = readHtml('dashboard.html'); });

    it('should reference handleLogout in logout button', () => {
      // handleLogout is defined in the shared auth.js module
      // The dashboard button calls it via onclick
      expect(html).toContain('onclick="handleLogout()"');
    });

    it('should define toggleProxy on window', () => {
      // toggleProxy is defined in the dashboard script
      expect(html).toContain('toggleProxy');
    });

    it('toggleProxy action must only be \'start\' or \'stop\'', () => {
      // Extract the action assignment from toggleProxy in the HTML
      // Expected pattern: var action = status && status.running ? 'stop' : 'start';
      var toggleMatch = html.match(/var action\s*=\s*([^;]+);/);
      expect(toggleMatch).not.toBeNull();
      var expr = toggleMatch[1];
      // Must use ternary with exactly 'start' and 'stop'
      expect(expr).toMatch(/\?\s*['"]stop['"]/);
      expect(expr).toMatch(/:\s*['"]start['"]/);
      // No other string literals should appear in the action assignment
      var strings = expr.match(/['"](.*?)['"]/g);
      expect(strings).toEqual(['\'stop\'', '\'start\'']);
    });

    it('should have init function that runs on load', () => {
      expect(html).toContain('function init()');
      expect(html).toContain('init();');
    });

    it('should use showToast pattern (defined in toast.js shared module (inline in page))', () => {
      // showToast is implemented inline in the page (designer's new architecture)
      expect(html).toContain('showToast');
    });

    it('should have loadStatus function for polling', () => {
      expect(html).toContain('function loadStatus');
    });

    it('should have loadVersion function', () => {
      expect(html).toContain('function loadVersion');
    });

    it('should have applyRefreshInterval for auto-refresh control', () => {
      expect(html).toContain('applyRefreshInterval');
    });

    it('should have dismissApiKeyBanner function', () => {
      expect(html).toContain('function dismissApiKeyBanner');
    });
  });

  describe('API Endpoints (supertest)', () => {
    it('should serve dashboard HTML at /dashboard route', async () => {
      const res = await request(app).get('/dashboard');
      expect(res.status).toBe(200);
      expect(res.text).toContain('Dashboard');
    });

    it('should have /api/status endpoint returning proxy status data', async () => {
      const res = await request(app).get('/api/status');
      expect(res.status).toBe(200);
      expect(typeof res.body).toBe('object');
    });

    it('should have /api/version endpoint', async () => {
      const res = await request(app).get('/api/version');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('version');
      expect(res.body).toHaveProperty('proxies');
    });

    it('should have /api/installed endpoint returning proxy list', async () => {
      const res = await request(app).get('/api/installed');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('should have /api/env-check endpoint', async () => {
      const res = await request(app).get('/api/env-check');
      expect(res.status).toBe(200);
      expect(typeof res.body).toBe('object');
    });
  });
});
