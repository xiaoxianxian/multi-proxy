import { Command } from 'commander';
import { spawn, execSync } from 'child_process';
import path from 'path';

const __filename = path.join(process.cwd(), 'src', 'index.ts');
const __dirname = path.dirname(__filename);

import { ProviderRegistry, registerDefaultProviders } from './providers/index.js';

const program = new Command();

program
  .name('cursor-proxy')
  .description('Cursor 多模型代理配置工具')
  .version('1.0.0');

// start 命令
program
  .command('start')
  .description('启动代理服务')
  .action(() => {
    console.log('[cursor-proxy] 正在初始化 Provider 注册表...');
    const registry = ProviderRegistry.getInstance();
    registerDefaultProviders(registry);
    console.log('[cursor-proxy] Providers 已注册:', registry.getAll().map(p => p.name).join(', '));

    console.log('[cursor-proxy] 启动代理服务...');
    const proxyScript = path.join(__dirname, '..', 'dist', 'server', 'start.js');
    const proxyProc = spawn('node', [proxyScript], {
      stdio: 'inherit',
    });

    proxyProc.on('error', (err) => {
      console.error('[cursor-proxy] 启动失败:', err.message);
    });

    proxyProc.on('exit', (code) => {
      if (code !== 0) {
        console.error(`[cursor-proxy] 代理服务异常退出，代码 ${code}`);
      }
    });
  });

// stop 命令
program
  .command('stop')
  .description('停止代理服务')
  .action(() => {
    try {
      const pid = execSync('/usr/sbin/lsof -ti :18794 2>/dev/null', { encoding: 'utf-8' }).trim();
      if (pid) {
        execSync(`kill ${pid}`, { stdio: 'inherit' });
        console.log('[cursor-proxy] 代理服务已停止');
      } else {
        console.log('[cursor-proxy] 代理服务未在运行');
      }
    } catch {
      console.log('[cursor-proxy] 代理服务未在运行');
    }
  });

// status 命令
program
  .command('status')
  .description('查看代理服务状态')
  .action(() => {
    try {
      const health = execSync('curl -s http://127.0.0.1:18794/health 2>/dev/null', {
        encoding: 'utf-8',
        timeout: 3000,
      });
      console.log('[cursor-proxy] 代理服务运行中');
      console.log(health);
    } catch {
      console.log('[cursor-proxy] 代理服务未运行');
    }
  });

// guide 命令 - Cursor 接入引导
program
  .command('guide')
  .description('显示 Cursor 接入引导说明')
  .action(() => {
    console.log(`
=== Cursor 接入引导 ===

1. 打开 Cursor → Settings → Models

2. 在 OpenAI API Key 处填入占位符：dummy

3. 开启 "Override OpenAI Base URL"，填入：
   http://127.0.0.1:18794/v1

4. 点击 "Add Custom Model"，输入你要使用的模型名称

5. 返回 Web 管理面板 (http://127.0.0.1:18792)
   添加你的真实 API Key 和配置

6. 在对话中使用 // @model: model-name 指令切换模型

=== 更多信息 ===
详细文档见 README.md
    `);
  });

program.parse();
