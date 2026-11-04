import type { GuardrailReport } from "@paas/core";

export interface HttpError extends Error {
  statusCode: number;
  code: string;
  /** Payload extra (ex.: relatório de guardrails no erro guardrail_blocked). */
  report?: GuardrailReport;
  /** Variáveis obrigatórias sem valor (erro missing_env). */
  missing?: string[];
  /** Campos extras devolvidos no corpo do erro (ex.: existingMail no domain_receives_mail). */
  details?: Record<string, unknown>;
}

export function httpError(statusCode: number, code: string, message: string): HttpError {
  const err = new Error(message) as HttpError;
  err.statusCode = statusCode;
  err.code = code;
  return err;
}
