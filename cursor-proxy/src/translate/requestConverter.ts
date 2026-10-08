// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

export function convertSystemMessage(messages: any[]): { system?: string; cleaned: any[] } {
  const systemMessages = messages.filter(m => m.role === 'system');
  const cleaned = messages.filter(m => m.role !== 'system');
  
  if (systemMessages.length === 0) {
    return { cleaned };
  }
  
  // 合并所有 system 消息为一个字符串
  const system = systemMessages.map(m => m.content).join('\n');
  return { system, cleaned };
}
