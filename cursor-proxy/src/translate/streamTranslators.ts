export function convertToolCalling(messages: any[], tools: any[]): any {
  const toolCalls: any[] = [];
  const cleaned: any[] = [];

  for (const msg of messages) {
    if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
      toolCalls.push(...msg.tool_calls);
    } else {
      cleaned.push(msg);
    }
  }

  return { messages: cleaned, toolCalls };
}

export function convertResponseFormat(response: any): any {
  // 将上游响应格式统一转换为 Chat Completions 格式
  return {
    id: response.id || `resp_${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: response.model || 'unknown',
    choices: response.choices || [],
    usage: response.usage || null,
  };
}
