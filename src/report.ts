/**
 * The inspection report's shape and its text formatting.
 *
 * The report is produced by the host's `network.inspect` service and arrives as
 * one JSON document through this package's runtime. Fields are read
 * defensively: a report is data, never markup, and a missing field renders as
 * a missing value rather than an exception.
 */

export interface InspectionRedirect {
  from: string;
  to: string;
  status: number;
}

export interface InspectionHeader {
  name: string;
  value: string;
}

export interface InspectionCertificate {
  subject: string;
  issuer: string;
  serial: string;
  notBefore: string;
  notAfter: string;
  dnsNames: string[];
  ipAddresses: string[];
  isCa: boolean;
  signatureAlgorithm: string;
  publicKeyAlgorithm: string;
  publicKeyBits: number;
  sha256: string;
}

export interface InspectionTLS {
  version: string;
  cipherSuite: string;
  alpn: string;
  serverName: string;
  verified: boolean;
  verifyError: string;
  chain: InspectionCertificate[];
}

export interface InspectionReport {
  requestUrl: string;
  finalUrl: string;
  status: number;
  statusText: string;
  proto: string;
  durationMs: number;
  redirects: InspectionRedirect[];
  headers: InspectionHeader[];
  tls: InspectionTLS | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function redirects(value: unknown): InspectionRedirect[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((item) => ({
    from: text(item.from),
    to: text(item.to),
    status: count(item.status),
  }));
}

function headers(value: unknown): InspectionHeader[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((item) => ({
    name: text(item.name),
    value: text(item.value),
  }));
}

function certificate(value: unknown): InspectionCertificate {
  const record = isRecord(value) ? value : {};
  return {
    subject: text(record.subject),
    issuer: text(record.issuer),
    serial: text(record.serial),
    notBefore: text(record.notBefore),
    notAfter: text(record.notAfter),
    dnsNames: strings(record.dnsNames),
    ipAddresses: strings(record.ipAddresses),
    isCa: record.isCa === true,
    signatureAlgorithm: text(record.signatureAlgorithm),
    publicKeyAlgorithm: text(record.publicKeyAlgorithm),
    publicKeyBits: count(record.publicKeyBits),
    sha256: text(record.sha256),
  };
}

function tls(value: unknown): InspectionTLS | null {
  if (!isRecord(value)) return null;
  const chain = Array.isArray(value.chain) ? value.chain.map(certificate) : [];
  return {
    version: text(value.version),
    cipherSuite: text(value.cipherSuite),
    alpn: text(value.alpn),
    serverName: text(value.serverName),
    verified: value.verified === true,
    verifyError: text(value.verifyError),
    chain,
  };
}

/** Reads the runtime's output; null means it is not an inspection report. */
export function parseReport(output: string): InspectionReport | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.status !== "number") return null;
  return {
    requestUrl: text(parsed.requestUrl),
    finalUrl: text(parsed.finalUrl),
    status: count(parsed.status),
    statusText: text(parsed.statusText),
    proto: text(parsed.proto),
    durationMs: count(parsed.durationMs),
    redirects: redirects(parsed.redirects),
    headers: headers(parsed.headers),
    tls: tls(parsed.tls),
  };
}

/** The one word a status tile shows for a status code. */
export function statusVerdict(status: number): string {
  if (status >= 200 && status < 300) return "成功";
  if (status >= 300 && status < 400) return "重定向";
  if (status >= 400 && status < 500) return "客户端错误";
  if (status >= 500 && status < 600) return "服务端错误";
  if (status >= 100 && status < 200) return "信息响应";
  return "未知状态";
}

/** The tile's tone: success, redirect, error, or neutral for anything else. */
export function statusTone(status: number): "success" | "redirect" | "error" | "neutral" {
  if (status >= 200 && status < 300) return "success";
  if (status >= 300 && status < 400) return "redirect";
  if (status >= 400 && status < 600) return "error";
  return "neutral";
}

export function formatDuration(milliseconds: number): string {
  if (milliseconds < 1000) return `${milliseconds} ms`;
  return `${(milliseconds / 1000).toFixed(2)} s`;
}

/** The CN of a distinguished name, or the whole name when it has none. */
export function commonName(distinguishedName: string): string {
  const match = /(?:^|,)\s*CN=((?:\\.|[^,])+)/.exec(distinguishedName);
  const name = match?.[1];
  if (name === undefined) return distinguishedName;
  return name.replace(/\\(.)/g, "$1");
}

/** An RFC 3339 instant as a person reads it, keeping the seconds and the zone. */
export function formatInstant(value: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  const iso = new Date(parsed).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}

/** A certificate's validity window as the two dates the page shows. */
export function validity(cert: InspectionCertificate): string {
  return `${formatInstant(cert.notBefore)} → ${formatInstant(cert.notAfter)}`;
}

export type ValidityState = "valid" | "expired" | "pending" | "unknown";

/**
 * Where the certificate sits in its own validity window, read from the dates
 * the host already reported. A viewer must show an expired certificate rather
 * than hide it, so this is a label, not a filter.
 */
export function validityState(cert: InspectionCertificate, now = Date.now()): ValidityState {
  const from = Date.parse(cert.notBefore);
  const until = Date.parse(cert.notAfter);
  if (Number.isNaN(from) || Number.isNaN(until)) return "unknown";
  if (now < from) return "pending";
  if (now > until) return "expired";
  return "valid";
}

export function validityLabel(state: ValidityState): string {
  switch (state) {
    case "valid": return "在有效期内";
    case "expired": return "已过期";
    case "pending": return "尚未生效";
    default: return "日期无法读取";
  }
}

/**
 * formatReport renders the whole inspection as the plain text the copy button
 * puts on the clipboard. It mirrors the page's sections in the same order.
 */
export function formatReport(report: InspectionReport): string {
  const lines: string[] = ["响应头与证书", `请求地址：${report.requestUrl}`];
  if (report.finalUrl !== "" && report.finalUrl !== report.requestUrl) {
    lines.push(`最终地址：${report.finalUrl}`);
  }
  lines.push(
    `状态：${report.status} ${report.statusText}`.trimEnd(),
    `协议：${report.proto} · 耗时 ${formatDuration(report.durationMs)}`,
    "",
  );
  if (report.redirects.length > 0) {
    lines.push("重定向", ...report.redirects.map((hop) => `  ${hop.status} ${hop.from} → ${hop.to}`), "");
  }
  lines.push("响应头", ...report.headers.map((header) => `  ${header.name}: ${header.value}`), "");
  if (report.tls === null) {
    lines.push("TLS", "  未建立 TLS 连接（目标不是 HTTPS 或连接在握手前结束）");
    return lines.join("\n");
  }
  lines.push(
    "TLS",
    `  版本：${report.tls.version}`,
    `  密码套件：${report.tls.cipherSuite}`,
    report.tls.alpn === "" ? "" : `  ALPN：${report.tls.alpn}`,
    `  验证：${report.tls.verified ? "通过" : `失败 — ${report.tls.verifyError}`}`,
    "",
    "证书链",
  );
  report.tls.chain.forEach((cert, index) => {
    lines.push(
      `${index + 1}. ${cert.subject}`,
      `   颁发者：${cert.issuer}`,
      `   有效期：${validity(cert)}`,
      `   序列号：${cert.serial}`,
      `   公钥：${cert.publicKeyAlgorithm} ${cert.publicKeyBits} 位`,
      `   签名算法：${cert.signatureAlgorithm}`,
      `   SHA-256：${cert.sha256}`,
    );
    if (cert.dnsNames.length > 0) lines.push(`   DNS：${cert.dnsNames.join(", ")}`);
    if (cert.ipAddresses.length > 0) lines.push(`   IP：${cert.ipAddresses.join(", ")}`);
    if (cert.isCa) lines.push("   这是 CA 证书");
  });
  return lines.join("\n");
}
