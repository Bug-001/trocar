// src/dissect/vendors.mjs — the D37 third axis: the VENDOR, from the upstream host (3.2:50). Cache
// semantics and prices are keyed by it (3.3:89, 2.2), never by the wire format or the harness: dsh
// speaks the Anthropic wire to api.deepseek.com. An unknown host → null, which readers render as
// 「厂商缓存语义未知」 instead of borrowing another vendor's semantics. Leaf module.
import { headerOf } from './harnesses.mjs';

const VENDOR_HOSTS = [
  [/(^|\.)anthropic\.com$/, 'anthropic'],
  [/(^|\.)(openai\.com|chatgpt\.com)$/, 'openai'],
  [/(^|\.)deepseek\.com$/, 'deepseek'],
  [/(^|\.)(moonshot\.(cn|ai)|kimi\.(com|ai))$/, 'moonshot'],
  [/(^|\.)(z\.ai|bigmodel\.cn)$/, 'zai'],
  [/(^|\.)openrouter\.ai$/, 'openrouter'],
];

// The upstream host: the collector's `host` field, else (legacy MITM / reverse-proxy envelopes) the Host
// or :authority request header. Lowercased, port stripped, IPv6 brackets removed.
export function hostOf(rec) {
  const raw = rec && typeof rec.host === 'string' && rec.host ? rec.host : (headerOf(rec, 'host') ?? headerOf(rec, ':authority'));
  if (!raw) return null;
  const h = String(raw).trim().toLowerCase();
  const v6 = /^\[([^\]]+)\](:\d+)?$/.exec(h);
  return v6 ? v6[1] : h.replace(/:\d+$/, '');
}

export function vendorOf(rec) {
  const h = hostOf(rec);
  if (!h) return null;
  for (const [re, v] of VENDOR_HOSTS) if (re.test(h)) return v;
  return null;
}
