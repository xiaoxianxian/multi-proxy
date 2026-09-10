import app from './app.js';

const PORT = parseInt(process.env.PORT || '18794');

app.listen(PORT, () => {
  console.log(`[Proxy Server] 代理服务运行于 http://0.0.0.0:${PORT}`);
  console.log(`[Proxy Server] 管理面板 http://0.0.0.0:${PORT}/admin-api`);
});
