// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

// 集成测试用的最小 guard server：只挂业务侧 side-effect-guard 路由。
// 不拉代理子进程、不接管理面板，纯粹为了给 Python 客户端一个真 HTTP 端点验证跨语言闭环。
const express = require('express');
const router = require('../../routes/side-effect-guard');

const app = express();
app.use(express.json());
app.use('/api/guard', router);

const port = process.env.GUARD_TEST_PORT || 18999;
app.listen(port, () => {
    console.log('GUARD_SERVER_UP:' + port);
});
