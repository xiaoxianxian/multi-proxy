// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

const { contextBridge } = require('electron');

// 渲染层（manager 的网页）目前无需任何壳能力；
// 预留桥接点，未来如需"原生菜单/通知"再扩展。
contextBridge.exposeInMainWorld('desktopShell', {
  isDesktop: true,
  platform: process.platform,
});
