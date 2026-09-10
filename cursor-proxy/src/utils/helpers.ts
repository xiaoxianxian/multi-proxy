export function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function formatSSEEvent(data: any): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export function countTokens(text: string): number {
  // 简化的 token 估算：按平均字符/token 比例 4:1 估算
  return Math.ceil(text.length / 4);
}
