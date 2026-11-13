/**
 * The response-header and certificate page.
 *
 * The page owns the whole card (PLUGINS.md §5.1, `chrome: "page"`): the address
 * field, the summary tiles, the redirect chain, the certificate chain and the
 * response headers are drawn here. The request itself runs in this package's
 * Go runtime, reached through the host's internal-command channel; the page
 * opens no socket and holds no host object beyond the surface bridge.
 *
 * Every inspected value — the URL, a header name or value, a distinguished
 * name — is written with textContent only: a response header must never become
 * markup.
 */

import { connectSurface } from "./bridge";
import {
  commonName,
  formatDuration,
  formatReport,
  parseReport,
  statusTone,
  statusVerdict,
  validity,
  validityLabel,
  validityState,
  type InspectionCertificate,
  type InspectionReport,
  type ValidityState,
} from "./report";

const OWN_PLUGIN_ID = "com.mypaste.response-inspector";
const INSPECT_COMMAND = "inspect";
/** Matches the host's and the runtime's own bound on the address. */
const MAX_INPUT = 2048;
/** Chips shown per certificate before the rest fold into one count. */
const MAX_CHIPS = 12;

function one<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) throw new Error(`缺少元素 ${selector}`);
  return element;
}

const form = one<HTMLFormElement>("#inspect-form");
const addressInput = one<HTMLInputElement>("#address");
const runButton = one<HTMLButtonElement>("#run");
const statusElement = one<HTMLParagraphElement>("#status");
const errorPanel = one<HTMLElement>("#error");
const errorMessage = one<HTMLParagraphElement>("#error-message");
const retryButton = one<HTMLButtonElement>("#retry");
const resultSection = one<HTMLElement>("#result");
const statusCode = one<HTMLSpanElement>("#status-code");
const statusNumber = one<HTMLSpanElement>("#status-number");
const statusVerdictElement = one<HTMLSpanElement>("#status-verdict");
const protoValue = one<HTMLSpanElement>("#proto");
const durationValue = one<HTMLSpanElement>("#duration");
const headerTotal = one<HTMLSpanElement>("#header-total");
const redirectTotal = one<HTMLSpanElement>("#redirect-total");
const tlsVersionValue = one<HTMLSpanElement>("#tls-version");
const finalUrlLine = one<HTMLParagraphElement>("#final-url");
const redirectGroup = one<HTMLElement>("#redirect-group");
const redirectCount = one<HTMLSpanElement>("#redirect-count");
const redirectsBody = one<HTMLTableSectionElement>("#redirects");
const tlsBadge = one<HTMLSpanElement>("#tls-badge");
const tlsFacts = one<HTMLParagraphElement>("#tls-facts");
const verifyError = one<HTMLParagraphElement>("#verify-error");
const chain = one<HTMLDivElement>("#chain");
const headersCount = one<HTMLSpanElement>("#headers-count");
const headersBody = one<HTMLTableSectionElement>("#headers");
const copyButton = one<HTMLButtonElement>("#copy");
const closeButton = one<HTMLButtonElement>("#doc-close");

const bridge = connectSurface();

let running = false;
let lastReport: InspectionReport | null = null;
let runToken = 0;

function setStatus(text: string, tone: "info" | "error" = "info"): void {
  statusElement.textContent = text;
  statusElement.dataset.tone = tone;
}

function setBusy(busy: boolean): void {
  running = busy;
  runButton.disabled = busy;
  runButton.textContent = busy ? "检查中…" : "检查";
}

function hideError(): void {
  errorPanel.hidden = true;
  errorMessage.textContent = "";
}

function showError(message: string): void {
  errorPanel.hidden = false;
  errorMessage.textContent = message;
  setStatus("检查没有完成。", "error");
}

function hostOf(value: string): string {
  try {
    return new URL(value.includes("://") ? value : `https://${value}`).host;
  } catch {
    return value;
  }
}

async function runInspection(raw: string): Promise<void> {
  const value = raw.trim();
  if (running) return;
  if (value === "") {
    showError("请先输入一个地址，例如 example.com。");
    return;
  }
  runToken += 1;
  const token = runToken;
  setBusy(true);
  hideError();
  resultSection.hidden = true;
  copyButton.disabled = true;
  setStatus(`正在检查 ${hostOf(value)}…`);

  try {
    const result = await bridge.invoke(OWN_PLUGIN_ID, INSPECT_COMMAND, value);
    if (token !== runToken) return;
    if (!result.ok) {
      showError(result.message ?? "检查失败，运行时没有给出原因。");
      return;
    }
    const report = parseReport(result.output ?? "");
    if (token !== runToken) return;
    if (report === null) {
      showError("检查结果无法读取，宿主返回了预期的格式之外的内容。");
      return;
    }
    lastReport = report;
    addressInput.value = report.requestUrl;
    render(report);
  } catch (error) {
    if (token !== runToken) return;
    showError(error instanceof Error ? error.message : "检查失败。");
  } finally {
    if (token === runToken) setBusy(false);
  }
}

function tileText(element: Element, value: string): void {
  element.textContent = value;
}

function render(report: InspectionReport): void {
  hideError();
  resultSection.hidden = false;
  copyButton.disabled = false;
  setStatus(
    `检查完成：${report.status} ${report.statusText} · ${report.headers.length} 个响应头。`.trim(),
  );

  statusCode.dataset.tone = statusTone(report.status);
  statusNumber.textContent = String(report.status);
  statusVerdictElement.textContent = statusVerdict(report.status);
  tileText(protoValue, report.proto === "" ? "—" : report.proto);
  tileText(durationValue, formatDuration(report.durationMs));
  tileText(headerTotal, String(report.headers.length));
  tileText(redirectTotal, String(report.redirects.length));

  renderFinalURL(report);
  renderRedirects(report);
  renderTLS(report);
  renderHeaders(report);
}

function renderFinalURL(report: InspectionReport): void {
  const changed = report.finalUrl !== "" && report.finalUrl !== report.requestUrl;
  finalUrlLine.hidden = !changed;
  finalUrlLine.textContent = "";
  if (!changed) return;
  finalUrlLine.append("最终地址 ");
  const final = document.createElement("b");
  final.textContent = report.finalUrl;
  finalUrlLine.append(final);
}

function renderRedirects(report: InspectionReport): void {
  redirectGroup.hidden = report.redirects.length === 0;
  redirectCount.textContent = `${report.redirects.length} 跳`;
  redirectsBody.textContent = "";
  for (const hop of report.redirects) {
    const row = document.createElement("tr");
    const status = document.createElement("td");
    status.className = "hop";
    status.textContent = String(hop.status);
    const from = document.createElement("td");
    from.textContent = hop.from;
    const to = document.createElement("td");
    to.textContent = hop.to;
    row.append(status, from, to);
    redirectsBody.append(row);
  }
}

const VALIDITY_TONE: Record<ValidityState, string> = {
  valid: "success",
  expired: "error",
  pending: "pending",
  unknown: "neutral",
};

function renderTLS(report: InspectionReport): void {
  const tls = report.tls;
  tlsBadge.dataset.tone = "neutral";
  tlsBadge.textContent = "";
  verifyError.hidden = true;
  verifyError.textContent = "";
  chain.textContent = "";
  tileText(tlsVersionValue, tls === null || tls.version === "" ? "—" : tls.version);

  if (tls === null) {
    tlsBadge.textContent = "没有 TLS 信息";
    tlsFacts.textContent = "目标没有建立 TLS 连接，无法读取证书。";
    return;
  }

  tlsBadge.dataset.tone = tls.verified ? "success" : "error";
  tlsBadge.textContent = tls.verified ? "证书链验证通过" : "验证失败";

  const facts = [tls.version, tls.cipherSuite];
  if (tls.alpn !== "") facts.push(tls.alpn);
  if (tls.serverName !== "") facts.push(`SNI ${tls.serverName}`);
  tlsFacts.textContent = facts.filter((fact) => fact !== "").join(" · ");

  if (!tls.verified) {
    verifyError.hidden = false;
    verifyError.textContent = `证书链验证失败：${tls.verifyError === "" ? "原因未提供" : tls.verifyError}`;
  }

  if (tls.chain.length === 0) {
    const empty = document.createElement("p");
    empty.className = "facts";
    empty.textContent = "服务器没有提供证书。";
    chain.append(empty);
    return;
  }
  tls.chain.forEach((cert, index) => {
    chain.append(certificateCard(cert, index));
  });
}

function certificateCard(cert: InspectionCertificate, index: number): HTMLElement {
  const card = document.createElement("article");
  card.className = "cert";

  const head = document.createElement("div");
  head.className = "cert-head";

  const badge = document.createElement("span");
  badge.className = "cert-index";
  badge.textContent = String(index + 1);

  const name = document.createElement("div");
  name.className = "cert-name";
  const cn = document.createElement("span");
  cn.className = "cert-cn";
  cn.textContent = commonName(cert.subject);
  const role = document.createElement("span");
  role.className = "cert-role";
  role.textContent = certificateRole(cert, index);
  cn.append(role);
  const dn = document.createElement("span");
  dn.className = "cert-dn";
  dn.textContent = cert.subject;
  name.append(cn, dn);

  const state = validityState(cert);
  const validityBadge = document.createElement("span");
  validityBadge.className = "badge";
  validityBadge.dataset.tone = VALIDITY_TONE[state];
  validityBadge.textContent = validityLabel(state);

  head.append(badge, name, validityBadge);
  card.append(head);

  const facts = document.createElement("dl");
  facts.className = "cert-facts";
  facts.append(
    fact("颁发者", cert.issuer),
    fact("有效期", validity(cert)),
    fact("序列号", cert.serial),
    fact("公钥", keyDescription(cert)),
    fact("签名算法", cert.signatureAlgorithm),
  );
  card.append(facts);

  const names = [...cert.dnsNames, ...cert.ipAddresses];
  if (names.length > 0) {
    const san = document.createElement("p");
    san.className = "cert-san";
    const label = document.createElement("span");
    label.className = "san-label";
    label.textContent = "SAN";
    san.append(label);
    for (const entry of names.slice(0, MAX_CHIPS)) {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.textContent = entry;
      san.append(chip);
    }
    if (names.length > MAX_CHIPS) {
      const more = document.createElement("span");
      more.className = "chip";
      more.textContent = `另有 ${names.length - MAX_CHIPS} 个`;
      san.append(more);
    }
    card.append(san);
  }

  const fingerprint = document.createElement("p");
  fingerprint.className = "fingerprint";
  const label = document.createElement("span");
  label.textContent = "SHA-256";
  const value = document.createElement("code");
  value.textContent = cert.sha256;
  fingerprint.append(label, value);
  card.append(fingerprint);

  return card;
}

function fact(label: string, value: string): HTMLDivElement {
  const entry = document.createElement("div");
  const term = document.createElement("dt");
  term.textContent = label;
  const description = document.createElement("dd");
  description.textContent = value === "" ? "—" : value;
  entry.append(term, description);
  return entry;
}

function certificateRole(cert: InspectionCertificate, index: number): string {
  if (index === 0) return "服务器证书";
  return cert.isCa ? "CA 证书" : "中间证书";
}

function keyDescription(cert: InspectionCertificate): string {
  const algorithm = cert.publicKeyAlgorithm === "" ? "未知算法" : cert.publicKeyAlgorithm;
  return cert.publicKeyBits > 0 ? `${algorithm} ${cert.publicKeyBits} 位` : algorithm;
}

function renderHeaders(report: InspectionReport): void {
  headersCount.textContent = `${report.headers.length} 条`;
  headersBody.textContent = "";
  if (report.headers.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.className = "empty";
    cell.colSpan = 2;
    cell.textContent = "这个响应没有响应头。";
    row.append(cell);
    headersBody.append(row);
    return;
  }
  for (const header of report.headers) {
    const row = document.createElement("tr");
    const name = document.createElement("td");
    name.className = "name";
    name.textContent = header.name;
    const value = document.createElement("td");
    value.textContent = header.value;
    row.append(name, value);
    headersBody.append(row);
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void runInspection(addressInput.value);
});

retryButton.addEventListener("click", () => {
  void runInspection(addressInput.value);
});

copyButton.addEventListener("click", async () => {
  if (lastReport === null) return;
  try {
    const result = await bridge.copy(formatReport(lastReport));
    setStatus(result.ok ? "已复制检查报告。" : result.message ?? "复制失败。", result.ok ? "info" : "error");
  } catch {
    setStatus("复制失败。", "error");
  }
});

closeButton.addEventListener("click", () => bridge.close());

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || event.isComposing) return;
  bridge.close();
});

bridge.onItem(({ item }) => {
  const text = item.text.trim();
  addressInput.value = text.length > MAX_INPUT ? text.slice(0, MAX_INPUT) : text;
  void runInspection(addressInput.value);
});
