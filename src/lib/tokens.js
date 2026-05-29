/**
 * 估算文本的 token 数
 * 中文每字约 1 token，英文每 4 字符约 1 token，混合文本分别计算后求和
 * 比单纯 length/4 更接近真实 tokenizer 的结果
 */
export function estimateTokens(text) {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // CJK Unified + 扩展 A + 兼容象形 + 平假名 + 片假名 + Hangul
    if (
      (code >= 0x3400 && code <= 0x9fff) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0x3040 && code <= 0x309f) ||
      (code >= 0x30a0 && code <= 0x30ff) ||
      (code >= 0xac00 && code <= 0xd7af)
    ) {
      cjk++;
    } else {
      other++;
    }
  }
  return cjk + Math.ceil(other / 4);
}
