// Only allowlisted machine codes leave this boundary. Error text, URLs and
// certificates may contain secrets and must never be forwarded to the UI/log.
const groups = {
  CLOCK: ['CLOCK_UNSUPPORTED', 'CLOCK_AUTH_FAILED', 'CLOCK_CERTIFICATE_INVALID', 'CLOCK_VALIDATION_UNAVAILABLE', 'CLOCK_BUSY'],
  DNS: ['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL'],
  TLS_DATE: ['CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID'],
  TLS: ['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED', 'ERR_SSL_WRONG_VERSION_NUMBER', 'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE'],
  TIMEOUT: ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'],
  REFUSED: ['ECONNREFUSED'],
  RESET: ['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET'],
  UNREACHABLE: ['ENETUNREACH', 'EHOSTUNREACH'],
};
const allowed = new Map(Object.entries(groups).flatMap(([category, codes]) => codes.map(code => [code, category])));
export function classifyNetworkError(error) {
  const queue = [{ value: error, depth: 0 }], seen = new Set(), codes = new Set();
  let aborted = false, timedOut = false, visited = 0;
  while (queue.length && visited++ < 32) {
    const { value, depth } = queue.shift();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    try {
      if (allowed.has(value.code)) codes.add(value.code);
      aborted ||= value.name === 'AbortError'; timedOut ||= value.name === 'TimeoutError';
      if (depth < 5) {
        queue.push({ value: value.cause, depth: depth + 1 });
        if (Array.isArray(value.errors)) for (const child of value.errors.slice(0, 8)) queue.push({ value: child, depth: depth + 1 });
      }
    } catch { /* Untrusted/injected error properties must not break sanitizing. */ }
  }
  const categories = [...new Set([...codes].map(code => allowed.get(code)))];
  const category = timedOut ? 'TIMEOUT' : categories.length > 1 ? 'MULTIPLE' : categories[0] || (aborted ? 'CANCELLED' : 'UNKNOWN');
  return { category, codes: [...codes].sort() };
}
export const pairingNetworkMessages = {
  CLOCK: '配对网络失败 [CLOCK]：无法验证服务器时间。请检查当前配对、服务器升级和网络连接。',
  TLS_DATE: '配对网络失败 [TLS_DATE]：服务器证书有效日期校验失败。请先在 Windows“设置 → 时间和语言 → 日期和时间”中开启自动设置时间并点击“立即同步”。若日期和时间已正确但仍失败，请联系服务器管理员检查证书。',
  DNS: '配对网络失败 [DNS]：连接器无法解析服务器域名。请运行只读网络诊断。',
  TLS: '配对网络失败 [TLS]：连接器无法验证服务器证书或完成 TLS 握手。请运行只读网络诊断。',
  TIMEOUT: '配对网络失败 [TIMEOUT]：连接器请求超时。请运行只读网络诊断。',
  REFUSED: '配对网络失败 [REFUSED]：服务器连接被拒绝。请运行只读网络诊断。',
  RESET: '配对网络失败 [RESET]：连接在响应完成前中断。请运行只读网络诊断。',
  UNREACHABLE: '配对网络失败 [UNREACHABLE]：连接器无法到达服务器网络。请运行只读网络诊断。',
  MULTIPLE: '配对网络失败 [MULTIPLE]：连接尝试出现多种网络错误。请运行只读网络诊断。',
  CANCELLED: '配对网络失败 [CANCELLED]：连接器请求已取消。请运行只读网络诊断。',
  UNKNOWN: '配对网络失败 [UNKNOWN]：连接器未能收到有效响应。请运行只读网络诊断。',
};
export const certificateDateMessage = '服务器证书有效日期校验失败。请先在 Windows“设置 → 时间和语言 → 日期和时间”中开启自动设置时间并点击“立即同步”。若日期和时间已正确但仍失败，请联系服务器管理员检查证书。';
export function sanitizeNetworkDiagnosis(value) {
  if (!value || !Array.isArray(value.codes)) return null;
  const diagnosis = classifyNetworkError({ errors: value.codes.slice(0, 8).map(code => ({ code })) });
  return diagnosis.codes.length ? diagnosis : null;
}
export function networkErrorMessage(diagnosis) {
  if (diagnosis?.category === 'CLOCK') return diagnosis.codes.includes('CLOCK_UNSUPPORTED') ? '服务器尚未支持时钟兼容连接。请由管理员更新 Hub，或恢复正确系统时间后连接。' : diagnosis.codes.some(code => ['CLOCK_CERTIFICATE_INVALID', 'CLOCK_VALIDATION_UNAVAILABLE'].includes(code)) ? '服务器证书未通过可信时间校验。请联系服务器管理员检查证书与域名。' : '无法验证服务器时间。请检查当前配对、服务器升级和网络连接。';
  return diagnosis?.category === 'TLS_DATE' ? certificateDateMessage : `服务器网络连接失败 [${Object.hasOwn(pairingNetworkMessages, diagnosis?.category) ? diagnosis.category : 'UNKNOWN'}]。请检查网络连接，或运行只读网络诊断。`;
}
export function collaborationNetworkError(error) {
  const diagnosis = classifyNetworkError(error);
  const safe = new Error(networkErrorMessage(diagnosis));
  safe.code = `COLLABORATION_NETWORK_${diagnosis.category}`;
  safe.network = diagnosis;
  return safe;
}
export const pairingUncertainMessage = '请求可能已到达服务器；请先在网页设备列表确认结果，再决定撤销设备或重新生成配对信息。';
export function pairingNetworkError(error) {
  const diagnosis = classifyNetworkError(error);
  const safe = new Error(`${diagnosis.category === 'CLOCK' ? '配对网络失败 [CLOCK]：' + networkErrorMessage(diagnosis) : pairingNetworkMessages[diagnosis.category]} ${pairingUncertainMessage}`);
  safe.code = `PAIR_NETWORK_${diagnosis.category}`;
  safe.network = diagnosis;
  return safe;
}
