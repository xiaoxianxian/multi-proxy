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
      expect(html).toContain('Proxy Manager - Dashboard');
    });

    it('should include shared CSS files', () => {
      expect(html).toContain('colors_and_type.css');
      expect(html).toContain('shared-styles.css');
    });

    it('should have sidebar with navigation', () => {
      expect(html).toContain('id="sidebar"');
      expect(html).toContain('class="sidebar"');
      expect(html).toContain('class="sidebar-header"');
      expect(html).toContain('class="sidebar-nav"');
      expect(html).toContain('Proxy Manager');
    });

    it('should have nav items for dashboard, logs, and proxy config', () => {
      expect(html).toContain('data-page="dashboard"');
      expect(html).toContain('data-page="logs"');
      expect(html).toContain('proxy-config.html');
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
      expect(html).toContain('id="proxyStatusCount"');
      expect(html).toContain('proxyStatusDetail');
      expect(html).toContain('class="stat-card accent-blue"');
    });

    it('should have installed count stat card', () => {
      expect(html).toContain('id="installedCount"');
      expect(html).toContain('installedDetail');
      expect(html).toContain('class="stat-card accent-green"');
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

    it('should have proxy cards with toggle buttons', () => {
      expect(html).toContain('btn-toggle-');
      expect(html).toContain('toggleProxy');
    });

    it('should have start/stop API endpoints dynamically constructed', () => {
      // The dashboard constructs /api/{action}/{name} dynamically via fetch
      expect(html).toContain("'/api/'");
      expect(html).toContain('action');
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

    it('should have init function that runs on load', () => {
      expect(html).toContain('function init()');
      expect(html).toContain('init();');
    });

    it('should use showToast pattern (defined in toast.js shared module)', () => {
      // showToast was moved to shared js/toast.js in the refactored architecture
      // The HTML page includes <script src="js/toast.js"> for this
      expect(html).toContain('js/toast.js');
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
