// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

const os = require('os');
const fs = require('fs');
const path = require('path');

// 在 mock 前 require，避免被测模块缓存旧引用
const { detectOccupancy, detectAll, portOf, isOccupantPort, OCCUPANT_PORTS, SELF_PORTS } = require('../../lib/agent-owner');

describe('agent-owner detection', () => {
  let tmp;
  let realHomedir;
  let writeConfigs;

  beforeEach(() => {
    tmp = path.join(os.tmpdir(), 'agent-owner-test-' + Date.now() + Math.random());
    fs.mkdirSync(path.join(tmp, '.codex'), { recursive: true });
    fs.mkdirSync(path.join(tmp, '.hermes'), { recursive: true });
    realHomedir = os.homedir;
    jest.spyOn(os, 'homedir').mockReturnValue(tmp);
    writeConfigs = (codexUrl, hermesUrl) => {
      if (codexUrl !== undefined) {
        fs.writeFileSync(path.join(tmp, '.codex', 'config.toml'),
          '[model_providers.custom]\nname = "custom"\nbase_url = "' + codexUrl + '"\n');
      }
      if (hermesUrl !== undefined) {
        fs.writeFileSync(path.join(tmp, '.hermes', 'config.yaml'),
          'model:\n  base_url: ' + hermesUrl + '\n');
      }
    };
  });

  afterEach(() => {
    os.homedir = realHomedir;
    jest.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('portOf extracts port from url', () => {
    expect(portOf('http://127.0.0.1:15721/v1')).toBe('15721');
    expect(portOf('https://apihub.agnes-ai.com/v1')).toBe(null);
    expect(portOf(null)).toBe(null);
  });

  it('detects codex occupied when base_url points to occupant port 15721', () => {
    writeConfigs('http://127.0.0.1:15721/v1', undefined);
    const r = detectOccupancy('codex');
    expect(r.occupied).toBe(true);
    expect(r.by).toBe('port:15721');
  });

  it('detects no conflict when codex points to multi-proxy port 18790', () => {
    writeConfigs('http://127.0.0.1:18790/v1', undefined);
    expect(detectOccupancy('codex').occupied).toBe(false);
  });

  it('detects hermes occupied via model: block base_url', () => {
    writeConfigs(undefined, 'http://127.0.0.1:15721/v1');
    expect(detectOccupancy('hermes').occupied).toBe(true);
  });

  it('returns not occupied when config file missing', () => {
    // tmp 下 .codex/.hermes 已建但无配置文件
    expect(detectOccupancy('codex').occupied).toBe(false);
    expect(detectOccupancy('hermes').occupied).toBe(false);
  });

  it('returns unknown (not free) for cursor (no stable config)', () => {
    const r = detectOccupancy('cursor');
    expect(r.occupied).toBe(false);
    expect(r.status).toBe('unknown');
    expect(typeof r.reason).toBe('string');
  });

  // ===== 以下为 P0-2：冲突检测覆盖全部 agent =====

  const writeClaude = (url) => {
    fs.mkdirSync(path.join(tmp, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.claude', 'settings.json'),
      JSON.stringify(url === undefined ? { enabledPlugins: {} } : { env: { ANTHROPIC_BASE_URL: url } }));
  };

  const writeOpencode = (url, kind) => {
    fs.mkdirSync(path.join(tmp, '.config', 'opencode'), { recursive: true });
    // 故意带注释：opencode.jsonc 是 JSONC，解析器必须容忍
    const body = kind === 'v2'
      ? '// multi-proxy\n{ "providers": { "multi-proxy": { "settings": { "baseURL": "' + url + '" } } } }'
      : '// legacy v1\n{ "provider": { "mp": { "options": { "baseURL": "' + url + '" } } } }';
    fs.writeFileSync(path.join(tmp, '.config', 'opencode', 'opencode.jsonc'), body);
  };

  it('claude: detects occupied via ~/.claude/settings.json env.ANTHROPIC_BASE_URL', () => {
    writeClaude('http://127.0.0.1:15721');
    const r = detectOccupancy('claude');
    expect(r.occupied).toBe(true);
    expect(r.status).toBe('occupied');
    expect(r.by).toBe('port:15721');
  });

  it('claude: settings.json without ANTHROPIC_BASE_URL is free, not unknown', () => {
    writeClaude(undefined);
    const r = detectOccupancy('claude');
    expect(r.status).toBe('free');
    expect(r.occupied).toBe(false);
  });

  it('claude: missing settings.json is unknown (cannot prove free)', () => {
    expect(detectOccupancy('claude').status).toBe('unknown');
    expect(detectOccupancy('claude').reason).toBe('config-not-found');
  });

  it('claude: malformed settings.json degrades to unknown, never crashes', () => {
    fs.mkdirSync(path.join(tmp, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.claude', 'settings.json'), '{ this is not json');
    const r = detectOccupancy('claude');
    expect(r.occupied).toBe(false);
    expect(r.status).toBe('unknown');
    expect(r.reason).toBe('config-unreadable');
  });

  it('opencode: detects occupied via legacy provider.*.options.baseURL (jsonc with comments)', () => {
    writeOpencode('http://127.0.0.1:15721/v1', 'v1');
    const r = detectOccupancy('opencode');
    expect(r.occupied).toBe(true);
    expect(r.by).toBe('port:15721');
  });

  it('opencode: detects occupied via v2 providers.*.settings.baseURL', () => {
    writeOpencode('http://127.0.0.1:15721/v1', 'v2');
    expect(detectOccupancy('opencode').occupied).toBe(true);
  });

  it('opencode: pointing at its own multi-proxy port 18798 is free', () => {
    writeOpencode('http://127.0.0.1:18798/v1', 'v2');
    const r = detectOccupancy('opencode');
    expect(r.occupied).toBe(false);
    expect(r.status).toBe('free');
  });

  it('opencode: no config at all is unknown', () => {
    expect(detectOccupancy('opencode').status).toBe('unknown');
    expect(detectOccupancy('opencode').reason).toBe('config-not-found');
  });

  it('generic and dsh are unknown, never silently free', () => {
    for (const a of ['generic', 'dsh']) {
      const r = detectOccupancy(a);
      expect(r.occupied).toBe(false);
      expect(r.status).toBe('unknown');
      expect(r.reason).toBeTruthy();
    }
  });

  it('unknown is distinguishable from free (same occupied=false, different status)', () => {
    writeConfigs('http://127.0.0.1:18790/v1', undefined);
    const free = detectOccupancy('codex');
    const unknown = detectOccupancy('cursor');
    expect(free.occupied).toBe(unknown.occupied);
    expect(free.status).toBe('free');
    expect(unknown.status).toBe('unknown');
  });

  it('never flags multi-proxy own ports as occupied (self-port guard)', () => {
    for (const p of SELF_PORTS) {
      expect(isOccupantPort(p)).toBe(false);
    }
    expect(isOccupantPort('15721')).toBe(true);
    // 即使占用者清单被误配成含自家端口，也必须排除（宁可漏报，不可误报）
    expect(isOccupantPort('18790', ['15721', '18790'])).toBe(false);
    expect(isOccupantPort('15721', ['15721', '18790'])).toBe(true);
  });

  it('self-port guard holds on the full detect path (OCCUPANT_PORTS polluted with 18790)', () => {
    OCCUPANT_PORTS.push('18790');
    try {
      writeConfigs('http://127.0.0.1:18790/v1', undefined);
      const r = detectOccupancy('codex');
      expect(r.occupied).toBe(false);
      expect(r.status).toBe('free');
      writeConfigs('http://127.0.0.1:15721/v1', undefined);
      expect(detectOccupancy('codex').occupied).toBe(true);
    } finally {
      OCCUPANT_PORTS.pop();
    }
  });

  it('detectAll covers all 7 agents with a status each', () => {
    const all = detectAll();
    expect(Object.keys(all).sort()).toEqual(
      ['claude', 'codex', 'cursor', 'dsh', 'generic', 'hermes', 'opencode']);
    for (const r of Object.values(all)) {
      expect(['occupied', 'free', 'unknown']).toContain(r.status);
      expect(typeof r.occupied).toBe('boolean');
    }
  });
});
