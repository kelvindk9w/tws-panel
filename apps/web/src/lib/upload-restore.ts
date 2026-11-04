/**
 * upload-restore.ts — apoio da tela "Restaurar de um arquivo": o envio do arquivo com progresso (XMLHttpRequest, o
 * único jeito de ter o progresso do ENVIO no navegador), os primeiros bytes para a conferência prévia e a porcentagem.
 * O arquivo vai como corpo cru (nunca lido para a memória): o navegador o lê do disco enquanto envia.
 */
import { SETUP_TOKEN_HEADER } from "@paas/core";
import { t } from "@/i18n/react";
import { ApiRequestError, SESSION_EXPIRED_EVENT, getSetupToken } from "@/lib/api";

/** Quantos bytes do começo do arquivo vão na conferência prévia (o servidor reconhece o formato por eles). */
export const PRECHECK_BYTES = 8192;

/** O envio foi cancelado pela pessoa. */
export class UploadAborted extends Error {
  constructor() {
    super("upload aborted");
    this.name = "UploadAborted";
  }
}

export interface UploadHandle<T> {
  promise: Promise<T>;
  /** Cancela o envio; o servidor apaga o que já recebeu. */
  abort(): void;
}

/** Porcentagem inteira de 0 a 100 (sem tamanho conhecido, 0). */
export function percentOf(loaded: number, total: number): number {
  if (!(total > 0)) return 0;
  return Math.min(100, Math.max(0, Math.floor((loaded / total) * 100)));
}

/** Os primeiros bytes do arquivo, sem ler o resto. */
export async function readHead(file: Blob, bytes = PRECHECK_BYTES): Promise<ArrayBuffer> {
  return file.slice(0, bytes).arrayBuffer();
}

/** Envia `body` como corpo cru (`application/octet-stream`) com um PUT, avisando o progresso. */
export function putRaw<T>(url: string, body: Blob, onProgress: (loaded: number, total: number) => void): UploadHandle<T> {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<T>((resolve, reject) => {
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.setRequestHeader("Accept", "application/json");
    const token = getSetupToken();
    if (token) xhr.setRequestHeader(SETUP_TOKEN_HEADER, token);
    xhr.responseType = "text";
    xhr.upload.onprogress = (e) => onProgress(e.loaded, e.lengthComputable ? e.total : body.size);
    xhr.onload = () => {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(xhr.responseText) as Record<string, unknown>;
      } catch {
        // resposta que não é JSON: segue com o status
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(parsed as T);
        return;
      }
      const code = typeof parsed.error === "string" ? parsed.error : "http_error";
      const message = typeof parsed.message === "string" ? parsed.message : t("common.api.httpError", { status: xhr.status });
      if (xhr.status === 401 && code === "unauthorized") window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
      reject(new ApiRequestError(xhr.status, code, message, parsed));
    };
    xhr.onerror = () => reject(new ApiRequestError(0, "network_error", t("common.api.networkError")));
    xhr.onabort = () => reject(new UploadAborted());
    xhr.send(body);
  });
  return { promise, abort: () => xhr.abort() };
}
