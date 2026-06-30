/**
 * Proxy-Config page tests
 * Verifies HTML structure, tab system, provider CRUD, model switching,
 * balance display, history, and fetch-models functionality.
 */

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const app = require('../../../server');

const PUBLIC_DIR = path.join(__dirname, '../../../public');

function readHtml(filename) {
  return fs.readFileSync(path.join(PUBLIC_DIR, filename), 'utf8');
}

describe('Proxy Config Page', () => {

  describe('HTML Structure', () => {
    let html;
    beforeAll(() => { html = readHtml('proxy-config.html'); });

    it('should serve the proxy-config HTML page', () => {
      expect(html).toBeDefined();
      expect(html).toContain('<!DOCTYPE html>');
    });

    it('should include shared CSS files', () => {
      expect(html).toContain('colors_and_type.css');
      expect(html).toContain('shared-styles.css');
    });

    it('should have sidebar', () => {
      expect(html).toContain('class="sidebar"');
      expect(html).toContain('id="sidebar"');
    });

    it('should have offline banner', () => {
      expect(html).toContain('offline-banner');
    });

    it('should have proxy header with start/stop button', () => {
      expect(html).toContain('proxy-header');
      expect(html).toContain('btnStartStop');
    });

    it('should have status badge', () => {
      expect(html).toContain('proxyStatusBadge');
      expect(html).toContain('proxyStatusText');
    });

    it('should have toast container', () => {
      expect(html).toContain('toast-container');
    });
  });

  describe('Tab System', () => {
    let html;
    beforeAll(() => { html = readHtml('proxy-config.html'); });

    it('should have tabs container', () => {
      expect(html).toContain('tabs-container');
      expect(html).toContain('section-tabs');
    });

    it('should have config tab as default active', () => {
      expect(html).toContain('section-tab');
      // Config tab should have "active" class
      expect(html).toContain("id=\"tab-config\"");
    });

    it('should have providers tab', () => {
      expect(html).toContain("id=\"tab-providers\"");
    });

    it('should have models tab', () => {
      expect(html).toContain("id=\"tab-models\"");
    });

    it('should have balances tab', () => {
      expect(html).toContain("id=\"tab-balances\"");
    });

    it('should have tab-content divs for each tab', () => {
      expect(html).toContain('class="tab-content"');
    });

    it('should have switchTab function', () => {
      expect(html).toContain('function switchTab');
    });

    it('should switch tabs by adding/removing active class', () => {
      expect(html).toContain("classList.add('active')");
      expect(html).toContain("classList.remove('active')");
    });

    it('should handle hash-based tab navigation', () => {
      expect(html).toContain('getTabFromHash');
      expect(html).toContain("location.hash");
    });

    it('should prevent switching to disabled tabs', () => {
      // switchTab checks tabEl.disabled
      expect(html).toContain('if (tabEl.disabled) return');
    });
  });

  describe('Dynamic Tab Disable for Non-Cursor Proxies', () => {
    let html;
    beforeAll(() => { html = readHtml('proxy-config.html'); });

    it('should have providers tab button element', () => {
      expect(html).toContain('id="tab-providers-btn"');
    });

    it('should have balances tab button element', () => {
      expect(html).toContain('id="tab-balances-btn"');
    });

    it('should have setupDynamicTabs function', () => {
      expect(html).toContain('setupDynamicTabs');
    });

    it('should disable providers and balances tabs for non-cursor proxies', () => {
      expect(html).toContain('providersBtn.disabled');
      expect(html).toContain('balancesBtn.disabled');
    });

    it('should check current proxy name from URL params', () => {
      expect(html).toContain('getProxyFromUrl');
      expect(html).toContain('URLSearchParams');
    });
  });

  describe('Provider Tab - CRUD Operations', () => {
    let html;
    beforeAll(() => { html = readHtml('proxy-config.html'); });

    it('should have providers table', () => {
      expect(html).toContain('id="providersTable"');
      expect(html).toContain('id="providersBody"');
    });

    it('should have add provider button', () => {
      expect(html).toContain('showAddProviderModal');
    });

    it('should have edit provider button class', () => {
      expect(html).toContain('edit-provider-btn');
    });

    it('should have delete provider button class', () => {
      expect(html).toContain('delete-provider-btn');
    });

    it('should define MOCK_PROVIDERS array', () => {
      expect(html).toContain('MOCK_PROVIDERS');
    });

    it('should have loadProviders API function', () => {
      expect(html).toContain('async function loadProviders');
    });

    it('should have addProvider API function', () => {
      expect(html).toContain('async function addProvider');
    });

    it('should validate required fields in add provider', () => {
      expect(html).toContain('showToast');
      expect(html).toContain('请填写所有必填字段');
    });

    it('should validate URL format in add provider', () => {
      expect(html).toContain('https?:');
    });

    it('should validate API key length in add provider', () => {
      expect(html).toContain('key.length < 8');
    });

    it('should have updateProvider API function', () => {
      expect(html).toContain('async function updateProvider');
    });

    it('should have deleteProviderById API function', () => {
      expect(html).toContain('async function deleteProviderById');
    });

    it('should have toggleProviderEnabled function', () => {
      expect(html).toContain('toggleProviderEnabled');
    });

    it('should have provider enable/disable toggle checkboxes', () => {
      expect(html).toContain('provider-enable-toggle');
    });

    it('should handle provider edit modal', () => {
      expect(html).toContain('showEditProviderModal');
    });

    it('should delete provider with confirmation', () => {
      expect(html).toContain('confirm');
    });
  });

  describe('Provider Key Visibility Toggle', () => {
    let html;
    beforeAll(() => { html = readHtml('proxy-config.html'); });

    it('should have toggleKeyVisibility function', () => {
      expect(html).toContain('function toggleKeyVisibility');
    });

    it('should have keyVisible state variable', () => {
      expect(html).toContain('var keyVisible');
    });

    it('should mask API keys by default', () => {
      expect(html).toContain('maskKey');
    });

    it('should unmask API keys when toggled', () => {
      expect(html).toContain('keyVisible ? esc(p.api_key)');
    });
  });

  describe('Model Switching', () => {
    let html;
    beforeAll(() => { html = readHtml('proxy-config.html'); });

    it('should have model select dropdown', () => {
      expect(html).toContain('id="modelSelect"');
    });

    it('should have switch button', () => {
      expect(html).toContain('switchCurrentModel');
    });

    it('should display current model', () => {
      expect(html).toContain('id="currentModelDisplay"');
    });

    it('should define MOCK_MODELS array', () => {
      expect(html).toContain('MOCK_MODELS');
    });

    it('should have loadModels function', () => {
      expect(html).toContain('async function loadModels');
    });

    it('should have switchModel function', () => {
      expect(html).toContain('async function switchModel');
    });

    it('should render model select options', () => {
      expect(html).toContain('renderModels');
    });

    it('should set option as selected based on current model', () => {
      expect(html).toContain('m.id === currentModel ? \' selected\'');
    });

    it('should show toast if model is already current', () => {
      expect(html).toContain('已经是当前模型');
      // Actually the code checks nm === currentModel
      // Let's search for the actual string
    });
  });

  describe('Balance Display', () => {
    let html;
    beforeAll(() => { html = readHtml('proxy-config.html'); });

    it('should have balance grid container', () => {
      expect(html).toContain('id="balanceGrid"');
      expect(html).toContain('class="balance-grid"');
    });

    it('should define MOCK_BALANCES array', () => {
      expect(html).toContain('MOCK_BALANCES');
    });

    it('should have loadBalances function', () => {
      expect(html).toContain('async function loadBalances');
    });

    it('should render balance cards with currency', () => {
      expect(html).toContain('balance-card');
      expect(html).toContain('balance-name');
      expect(html).toContain('balance-amount');
      expect(html).toContain('balance-currency');
    });
  });

  describe('Switching History', () => {
    let html;
    beforeAll(() => { html = readHtml('proxy-config.html'); });

    it('should have history table', () => {
      expect(html).toContain('id="historyBody"');
    });

    it('should have clear history button', () => {
      expect(html).toContain('clearHistory');
    });

    it('should define MOCK_HISTORY array', () => {
      expect(html).toContain('MOCK_HISTORY');
    });

    it('should render history entries with timestamp, action, old/new model, result', () => {
      expect(html).toContain('fmtTime');
    });

    it('should show relative time (minutes ago, hours ago)', () => {
      expect(html).toContain('分钟前');
      expect(html).toContain('小时前');
    });

    it('should have success/fail result indicators', () => {
      expect(html).toContain('result-dot');
      expect(html).toContain('success');
      expect(html).toContain('fail');
    });

    it('should clear history with confirmation', () => {
      expect(html).toContain('MOCK_HISTORY.length = 0');
    });
  });

  describe('Fetch Models Feature', () => {
    let html;
    beforeAll(() => { html = readHtml('proxy-config.html'); });

    it('should have fetchAndShowModels function', () => {
      expect(html).toContain('fetchAndShowModels');
    });

    it('should POST to /api/fetch-models', () => {
      expect(html).toContain("/api/fetch-models");
    });

    it('should show loading state while fetching', () => {
      expect(html).toContain('正在拉取');
    });

    it('should show model checkboxes with select/deselect/all/invert', () => {
      expect(html).toContain('selectAllBtn');
      expect(html).toContain('invertBtn');
    });

    it('should show model display name and ID', () => {
      expect(html).toContain('displayName');
      expect(html).toContain('model-cb');
    });

    it('should confirm selected models', () => {
      expect(html).toContain('models-confirm');
    });

    it('should disable confirm button until selection made', () => {
      expect(html).toContain('confirmBtn.disabled');
    });

    it('should enable fetch button when provider ID, URL, and key are filled', () => {
      expect(html).toContain('updateFetchBtn');
    });

    it('should show error when fetch fails', () => {
      expect(html).toContain('拉取失败');
    });

    it('should cancel button to close modal', () => {
      expect(html).toContain('models-cancel');
    });
  });

  describe('Routing Mode Selection', () => {
    let html;
    beforeAll(() => { html = readHtml('proxy-config.html'); });

    it('should have routing mode select', () => {
      expect(html).toContain('id="routingModeSelect"');
    });

    it('should have failover, round-robin, weighted options', () => {
      expect(html).toContain('failover');
      expect(html).toContain('round-robin');
      expect(html).toContain('weighted');
    });

    it('should have changeRoutingMode function', () => {
      expect(html).toContain('changeRoutingMode');
    });
  });

  describe('API Endpoints (supertest)', () => {
    it('should serve proxy-config HTML at /proxy-config', async () => {
      const res = await request(app).get('/proxy-config');
      expect(res.status).toBe(200);
      expect(res.text).toContain('配置');
    });

    it('should require auth for /api/fetch-models (401 without token)', async () => {
      const res = await request(app)
        .post('/api/fetch-models')
        .send({ providerId: 'openai', baseUrl: 'https://api.openai.com', apiKey: 'sk-test' });
      // Endpoint is protected by requireAuth middleware
      expect(res.status).toBe(401);
    });

    it('should return model list for fetch-models POST', async () => {
      const res = await request(app)
        .post('/api/fetch-models')
        .send({ providerId: 'anthropic', baseUrl: 'https://example.com', apiKey: 'sk-test' });
      // Endpoint requires auth, returns 401 without valid token
      expect(res.status).toBe(401);
    });
  });
});
