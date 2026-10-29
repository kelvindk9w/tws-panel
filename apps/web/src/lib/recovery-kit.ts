import type { RecoveryKitResponse } from "@paas/core";
import { t } from "@/i18n";

/**
 * Kit de recuperação em texto puro (serve para imprimir e para baixar). Não leva segredo nenhum:
 * o servidor já não manda senha, chave privada nem códigos; aqui só se organiza o que veio.
 */
export function kitText(kit: RecoveryKitResponse): string {
  const lines: string[] = [];
  const add = (...l: string[]) => lines.push(...l);
  add(t("access.kit.doc.title"), "=".repeat(48), t("access.kit.doc.generated", { date: new Date(kit.generatedAt).toLocaleString() }), "");
  if (kit.panelAddress) add(`${t("access.kit.doc.panel")}: https://${kit.panelAddress}`);
  if (kit.panelAddressIp && kit.panelAddressIp !== kit.panelAddress) add(`${t("access.kit.doc.panelIp")}: ${kit.panelAddressIp}`);
  if (kit.linuxUser) add(`${t("access.kit.doc.user")}: ${kit.linuxUser}`);
  if (kit.sshPort) add(`${t("access.kit.doc.port")}: ${kit.sshPort}`);
  add("", `${t("access.kit.doc.keys")}:`);
  if (kit.keys.length === 0) add(`  ${t("access.kit.doc.noKeys")}`);
  for (const k of kit.keys) add(`  - ${k.fingerprint}  ${k.type}${k.bits ? ` ${k.bits}` : ""}  ${k.comment || t("access.keys.noComment")}`);
  if (kit.hostKeys.length > 0) {
    add("", `${t("access.kit.doc.hostKeys")}:`);
    for (const h of kit.hostKeys) add(`  - ${h}`);
  }
  add("", t("access.kit.doc.codes", { count: kit.recoveryCodesLeft }));
  add(t("access.kit.doc.emailCode", { state: kit.emailCodeEnabled ? t("access.kit.doc.emailCodeOn") : t("access.kit.doc.emailCodeOff") }));
  add("", t("access.kit.doc.stepsTitle"), "-".repeat(32));
  add(`1. ${t("access.kit.doc.step1")}`);
  add(`2. ${t("access.kit.doc.step2", { dir: kit.installDir })}`);
  add(`3. ${t("access.kit.doc.step3")}`);
  add(`4. ${t("access.kit.doc.step4")}`);
  add(`5. ${t("access.kit.doc.step5")}`);
  add("", t("access.kit.doc.top"), t("access.kit.doc.guide"), "");
  return lines.join("\n");
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Abre uma janela só com o texto e chama a impressão. Devolve false se o navegador bloqueou a janela. */
export function printText(title: string, text: string): boolean {
  const w = window.open("", "_blank");
  if (!w) return false;
  w.document.write(
    `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
      `<style>body{font:14px/1.5 ui-monospace,Menlo,Consolas,monospace;margin:24px}pre{white-space:pre-wrap}</style>` +
      `</head><body><pre>${escapeHtml(text)}</pre></body></html>`,
  );
  w.document.close();
  w.focus();
  w.print();
  return true;
}

/** Baixa um texto como arquivo .txt. */
export function downloadText(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}
