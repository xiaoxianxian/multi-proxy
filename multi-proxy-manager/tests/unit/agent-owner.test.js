const os = require('os');
const fs = require('fs');
const path = require('path');

// 在 mock 前 require，避免被测模块缓存旧引用
const { detectOccupancy, portOf } = require('../../lib/agent-owner');

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

  it('returns not occupied for cursor (no stable config)', () => {
    expect(detectOccupancy('cursor').occupied).toBe(false);
  });
});
