/**
 * 客户端 ID 生成。
 *
 * 为什么不直接用 `crypto.randomUUID()`（真实上线时踩的坑）：
 * 该 API **只在安全上下文（HTTPS 或 localhost）可用**。我们的部署是 `http://IP:8080`，
 * 浏览器里 `crypto.randomUUID` 是 `undefined`，点击发送就会抛
 * `TypeError: crypto.randomUUID is not a function`，而且是在事件回调里抛出，
 * 表现为"按钮点了没反应"，控制台才看得到。
 *
 * 这类"localhost 能跑、http://IP 就炸"的问题和 `Secure` Cookie 属于同一家族：
 * 开发环境（localhost 被视为安全上下文）与真实部署环境的行为不一致。
 *
 * 降级策略：
 *   1) 有 randomUUID 就用它；
 *   2) 否则用 `crypto.getRandomValues`（该 API 在非安全上下文同样可用，且是密码学安全随机源）拼 32 位十六进制；
 *   3) 极端情况（老浏览器）退回时间戳 + Math.random —— 仅用于幂等键，不用于安全用途。
 */
export function newClientId(): string {
  const webCrypto = globalThis.crypto;

  if (webCrypto && typeof webCrypto.randomUUID === 'function') {
    return webCrypto.randomUUID();
  }

  if (webCrypto && typeof webCrypto.getRandomValues === 'function') {
    const bytes = webCrypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
