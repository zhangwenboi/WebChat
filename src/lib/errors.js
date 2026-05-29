/**
 * 将 HTTP 状态码 + 提供商原始错误转成对用户友好的错误
 */
export function friendlyError({ status, providerMessage = '', providerKey = '' }) {
  const tail = providerMessage ? `（${providerMessage}）` : '';

  if (status === 401 || status === 403) {
    return new Error(`认证失败：API 密钥无效或权限不足，请前往设置页检查 ${providerKey || ''} 的密钥${tail}`);
  }
  if (status === 404) {
    return new Error(`接口未找到：请求 URL 或模型名可能填错${tail}`);
  }
  if (status === 429) {
    return new Error(`请求过于频繁或额度不足，请稍后重试${tail}`);
  }
  if (status >= 500 && status < 600) {
    return new Error(`服务端错误（${status}），请稍后重试${tail}`);
  }
  if (status === 400) {
    return new Error(`请求参数错误${tail}`);
  }
  return new Error(`API 请求失败（${status}）${tail}`);
}
