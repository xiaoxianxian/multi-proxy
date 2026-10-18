// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

/**
 * Logs page tests
 * Verifies HTML structure, filter controls, JS parsing/rendering logic,
 * and backend log API endpoints.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../../../server');

// Valid auth token for endpoints protected by requireAuth (P0 fix).
const AUTH_TOKEN = jwt.sign({ authenticated: true, ts: Date.now() }, process.env.JWT_SECRET, { expiresIn: '8h' });
const authed = (req) => req.set('x-auth-token', AUTH_TOKEN);

const PUBLIC_DIR = path.join(__dirname, '../../../public');

function readHtml(filename) {
  return fs.readFileSync(path.join(PUBLIC_DIR, filename), 'utf8');
}

describe('Logs Page', () => {

  describe('HTML Structure', () => {
    let html;
    beforeAll(() => { html = readHtml('logs.html'); });

    it('should serve the logs HTML page', () => {
      expect(html).toBeDefined();
      expect(html).toContain('Proxy Manager - 日志');
    });

    it('should include shared CSS files', () => {
      expect(html).toContain('colors_and_type.css');
      expect(html).toContain('shared-styles.css');
    });

    it('should have sidebar with navigation', () => {
      expect(html).toContain('class="sidebar"');
      expect(html).toContain('class="sidebar-nav"');
    });

    it('should have offline banner', () => {
      expect(html).toContain('id="offlineBanner"');
    });

    it('should have filter bar', () => {
      expect(html).toContain('class="filter-bar"');
    });

    it('should have log viewer container', () => {
      expect(html).toContain('class="log-viewer"');
      expect(html).toContain('id="logViewer"');
    });

    it('should have toast container', () => {
      expect(html).toContain('id="toastContainer"');
    });
  });

  describe('Log Filters', () => {
    let html;
    beforeAll(() => { html = readHtml('logs.html'); });

    it('should have proxy filter dropdown', () => {
      expect(html).toContain('id="proxyFilter"');
      expect(html).toContain('option value="all"');
      expect(html).toContain('option value="codex"');
      expect(html).toContain('option value="hermes"');
      expect(html).toContain('option value="cursor"');
    });

    it('should have level filter dropdown', () => {
      expect(html).toContain('id="levelFilter"');
      expect(html).toContain('option value="all"');
      expect(html).toContain('option value="INFO"');
      expect(html).toContain('option value="WARN"');
      expect(html).toContain('option value="ERROR"');
    });

    it('should have search input', () => {
      expect(html).toContain('id="logSearch"');
      // P1-3: debounced search — oninput goes through onSearchInput (250ms debounce)
      expect(html).toContain('oninput="onSearchInput()"');
    });

    it('should have time range buttons', () => {
      expect(html).toContain('data-hours="1"');
      expect(html).toContain('data-hours="6"');
      expect(html).toContain('data-hours="24"');
      expect(html).toContain('data-hours="0"');
    });

    it('should have time range set function on window', () => {
      expect(html).toContain('window.setTimeRange');
    });
  });

  describe('Log Rendering & Parsing', () => {
    let html;
    beforeAll(() => { html = readHtml('logs.html'); });

    it('should have parseRawLogs function with regex for log format', () => {
      expect(html).toContain('function parseRawLogs');
      // Should parse [timestamp] [LEVEL] [PROXY] message
      expect(html).toContain("\\[([^\\]]+)\\]");
    });

    it('should have renderLogLine function', () => {
      expect(html).toContain('function renderLogLine');
    });

    it('should have renderLogs function', () => {
      expect(html).toContain('function renderLogs');
    });

    it('should have applyFilters function on window', () => {
      expect(html).toContain('window.applyFilters');
    });

    it('should filter by proxy name in applyFilters', () => {
      expect(html).toContain('l.proxy ===');
    });

    it('should filter by level in applyFilters', () => {
      expect(html).toContain('l.level ===');
    });

    it('should filter by search term in applyFilters', () => {
      expect(html).toContain('l.message.toLowerCase()');
    });

    it('should filter by time range in applyFilters', () => {
      expect(html).toContain('currentTimeRange');
    });
  });

  describe('Log Actions', () => {
    let html;
    beforeAll(() => { html = readHtml('logs.html'); });

    it('should have loadLogs function on window', () => {
      expect(html).toContain('window.loadLogs');
    });

    it('should have clearLogs function on window', () => {
      expect(html).toContain('window.clearLogs');
    });

    it('should have copyLogs function on window', () => {
      expect(html).toContain('window.copyLogs');
    });

    it('should have exportLogs function on window', () => {
      expect(html).toContain('window.exportLogs');
    });

    it('should have toggleAutoRefresh function on window', () => {
      expect(html).toContain('window.toggleAutoRefresh');
    });

    // 2026-10-16 反转：这条原来钉死 `function generateMockLogs` 必须存在。
    // 该函数在日志读失败/空日志时兜底，会显示 20+ 条不存在的日志（含假 ERROR
    // 'Upstream connection refused: codex-api service unavailable'）——
    // 排查线上问题时看到不存在的事件，比看不到日志更糟。已删除。
    // 现在反过来钉：它不许回来，且 renderLogLine 定义必须在（删除时曾误删，只剩调用点）。
    it('should NOT have generateMockLogs (mock 兜底已移除)', () => {
      // 只钉函数定义。注释里保留 generateMockLogs 字样是为了说明「为什么删」，
      // 拿注释文本断言会把历史文档也判成回归。
      expect(html).not.toContain('function generateMockLogs');
    });

    it('should keep renderLogLine definition (曾因误删只剩调用点)', () => {
      expect(html).toContain('function renderLogLine');
      // 调用点也必须在，否则定义回来了也没人用
      expect(html).toContain('logsToRender.map(renderLogLine)');
    });
  });

  describe('Clear Logs Interaction', () => {
    let html;
    beforeAll(() => { html = readHtml('logs.html'); });

    it('should prompt confirmation before clearing', () => {
      expect(html).toContain("confirm('确定要清除所有日志吗？')");
    });

    it('should POST to /api/logs/clear', () => {
      expect(html).toContain('/api/logs/clear');
    });

    it('should show toast after clearing', () => {
      expect(html).toContain("'日志已清除'");
    });
  });

  describe('Copy Logs', () => {
    let html;
    beforeAll(() => { html = readHtml('logs.html'); });

    it('should use clipboard API for copying', () => {
      expect(html).toContain('clipboard.writeText');
    });

    it('should format logs as timestamp-level-proxy-message', () => {
      expect(html).toContain("log.timestamp");
      expect(html).toContain("log.proxy.toUpperCase()");
      expect(html).toContain("log.level");
    });
  });

  describe('Auto Refresh', () => {
    let html;
    beforeAll(() => { html = readHtml('logs.html'); });

    it('should have autoRefreshInterval state variable', () => {
      expect(html).toContain('autoRefreshInterval');
    });

    it('should use setInterval for periodic refresh', () => {
      expect(html).toContain('setInterval');
    });

    it('should use 5000ms interval for auto refresh', () => {
      expect(html).toContain('5000');
    });
  });

  describe('API Endpoints (supertest)', () => {
    it('should serve logs HTML at /logs', async () => {
      const res = await request(app).get('/logs');
      expect(res.status).toBe(200);
      expect(res.text).toContain('日志');
    });

    it('should return logs via GET /api/logs', async () => {
      const res = await authed(request(app).get('/api/logs?limit=10'));
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('count');
    });

    it('should support limit query parameter', async () => {
      const res = await authed(request(app).get('/api/logs?limit=5'));
      expect(res.status).toBe(200);
    });

    it('should return raw logs via GET /api/logs/raw', async () => {
      const res = await authed(request(app).get('/api/logs/raw'));
      expect(res.status).toBe(200);
      expect(typeof res.text).toBe('string');
    });

    it('should require auth for POST /api/logs/clear', async () => {
      const res = await request(app).post('/api/logs/clear');
      expect(res.status).toBe(401);
    });
  });
});
