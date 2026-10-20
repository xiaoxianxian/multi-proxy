// D3（非回环强制鉴权 · fail-closed）：纯函数 shouldFailClosedBind 判定。
// 启动块在 NODE_ENV=test 下不执行（jest 走 supertest），无法经 server 触发，故直测导出的纯函数。
// 语义：回环地址 或 显式 bypass(MP_BIND_AUTH_BYPASS) → 放行(false)；非回环且未配鉴权 → 拒绝(true)。
const server = require('../../server');
const shouldFailClosedBind = server.shouldFailClosedBind;

describe('D3 shouldFailClosedBind（非回环强制鉴权 fail-closed）', () => {
  test('导出的判定是函数', () => {
    expect(typeof shouldFailClosedBind).toBe('function');
  });

  // ① 回环地址：任何鉴权状态都放行（默认本机面板零影响）。
  test('回环地址 → false（不 fail-closed），与鉴权状态无关', () => {
    const loops = ['127.0.0.1', 'localhost', '::1', '::ffff:127.0.0.1'];
    loops.forEach((h) => {
      expect(shouldFailClosedBind(h, { authConfigured: false, bypass: undefined })).toBe(false);
      expect(shouldFailClosedBind(h, { authConfigured: true, bypass: undefined })).toBe(false);
    });
  });

  // ② 非回环 + 未配鉴权 + 无 bypass → 拒绝（D3 核心：堵住「忘设密码→整网开放」）。
  test('非回环 + 未配鉴权 + 无 bypass → true（拒绝启动）', () => {
    expect(shouldFailClosedBind('0.0.0.0', { authConfigured: false })).toBe(true);
    expect(shouldFailClosedBind('::', { authConfigured: false })).toBe(true);
    expect(shouldFailClosedBind('192.168.1.5', { authConfigured: false })).toBe(true);
  });

  // ③ 非回环 + 已配鉴权 → 放行（fail-closed 只拦「没鉴权」，不是拦非回环本身）。
  test('非回环 + 已配鉴权 → false（放行）', () => {
    expect(shouldFailClosedBind('0.0.0.0', { authConfigured: true })).toBe(false);
    expect(shouldFailClosedBind('::', { authConfigured: true })).toBe(false);
  });

  // ④ 非回环 + 未配鉴权 + 显式 bypass → 放行（运维用真实防火墙/反代兜底的逃生门，自担风险）。
  test('非回环 + 未配鉴权 + MP_BIND_AUTH_BYPASS → false（逃生门放行）', () => {
    expect(shouldFailClosedBind('0.0.0.0', { authConfigured: false, bypass: '1' })).toBe(false);
    expect(shouldFailClosedBind('0.0.0.0', { authConfigured: false, bypass: true })).toBe(false);
  });

  // ⑤ bypass 非 '1'/true（如 '0'/undefined）不生效 → 仍 fail-closed。
  test('bypass 取值非 1 → 不放行（fail-closed 仍生效）', () => {
    expect(shouldFailClosedBind('0.0.0.0', { authConfigured: false, bypass: '0' })).toBe(true);
    expect(shouldFailClosedBind('0.0.0.0', { authConfigured: false, bypass: undefined })).toBe(true);
  });

  // ⑥ 边界：bindHost 未传（falsy）→ 视为非回环？否：显式要求传 host，未传时按「非回环」保守处理
  //    （调用方总会传 process.env.BIND_HOST || '127.0.0.1'，此处仅锁住纯函数契约）。
  test('bindHost 缺失 → 保守按非回环处理', () => {
    expect(shouldFailClosedBind(undefined, { authConfigured: false })).toBe(true);
    expect(shouldFailClosedBind('', { authConfigured: false })).toBe(true);
  });
});
