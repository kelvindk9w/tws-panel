/**
 * mcp-approvals.ts — aprovações humanas das ações sensíveis pedidas por uma IA (recriar um projeto, aplicar
 * uma mudança de segurança de verdade).
 *
 * Fluxo: a IA pede (a ferramenta devolve "approval_required" com um número); a PESSOA aprova ou recusa na tela
 * (senha e, com 2FA, o código); a IA chama a MESMA ferramenta de novo, com o número, e só então a ação roda.
 * A aprovação vale para UMA execução, para o MESMO token e os MESMOS argumentos (impressão digital), e vence
 * em 10 minutos. Fica em memória de propósito: não deixa argumentos no disco e um reinício do painel apaga
 * os pedidos em aberto (a IA só pede de novo).
 */
import { createHash, randomBytes } from "node:crypto";
import { MCP_APPROVAL_MAX, MCP_APPROVAL_TTL_MS, type McpApprovalInfo, type McpApprovalStatus } from "@paas/core";

interface Entry {
  info: McpApprovalInfo;
  digest: string;
  expiresAtMs: number;
}

export type ConsumeResult = { ok: true } | { ok: false; status: "not_found" | "mismatch" | McpApprovalStatus };

export type DecideResult = { ok: true; info: McpApprovalInfo } | { ok: false; reason: "not_found" | "not_pending" };

/** Texto estável dos argumentos (chaves em ordem) para a impressão digital. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((k) => record[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(record[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function approvalDigest(tool: string, args: unknown): string {
  return createHash("sha256").update(`${tool}\n${stable(args)}`).digest("hex");
}

export class McpApprovals {
  private entries: Entry[] = [];

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly ttlMs: number = MCP_APPROVAL_TTL_MS,
  ) {}

  /** Aplica o vencimento (pendente ou aprovada que passou do prazo vira "expired"). */
  private refresh(): void {
    const now = this.now();
    for (const e of this.entries) {
      if ((e.info.status === "pending" || e.info.status === "approved") && e.expiresAtMs <= now) e.info = { ...e.info, status: "expired" };
    }
  }

  /** Abre um pedido pendente. null = a fila está cheia de pedidos pendentes (quem chama recusa). */
  request(input: { tokenId: string; tokenName: string; client: string; tool: string; args: Record<string, unknown> }): McpApprovalInfo | null {
    this.refresh();
    if (this.entries.length >= MCP_APPROVAL_MAX) {
      // abre vaga tirando o mais antigo que já foi decidido ou venceu; só pendentes = recusa
      const idx = this.entries.findIndex((e) => e.info.status !== "pending");
      if (idx === -1) return null;
      this.entries.splice(idx, 1);
    }
    const now = this.now();
    const info: McpApprovalInfo = {
      id: randomBytes(16).toString("hex"),
      tokenId: input.tokenId,
      tokenName: input.tokenName,
      client: input.client,
      tool: input.tool,
      args: input.args,
      status: "pending",
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.ttlMs).toISOString(),
    };
    this.entries.push({ info, digest: approvalDigest(input.tool, input.args), expiresAtMs: now + this.ttlMs });
    return info;
  }

  /** Pendentes primeiro, depois as decididas (mais novas antes). */
  list(): McpApprovalInfo[] {
    this.refresh();
    const infos = this.entries.map((e) => e.info);
    const pending = infos.filter((i) => i.status === "pending").reverse();
    const rest = infos.filter((i) => i.status !== "pending").reverse();
    return [...pending, ...rest];
  }

  /** Quantos pedidos esperam decisão. */
  pendingCount(): number {
    return this.list().filter((i) => i.status === "pending").length;
  }

  /** A IA consulta o próprio pedido: só enxerga o do seu token (de outro token = não existe). */
  statusFor(id: string, tokenId: string): McpApprovalInfo | null {
    this.refresh();
    const found = this.entries.find((e) => e.info.id === id && e.info.tokenId === tokenId);
    return found ? found.info : null;
  }

  /** A pessoa decide. Só pedido pendente e dentro do prazo; aprovado, ganha mais 10 minutos para a IA usar. */
  decide(id: string, decision: "approved" | "rejected"): DecideResult {
    this.refresh();
    const found = this.entries.find((e) => e.info.id === id);
    if (!found) return { ok: false, reason: "not_found" };
    if (found.info.status !== "pending") return { ok: false, reason: "not_pending" };
    if (decision === "approved") {
      found.expiresAtMs = this.now() + this.ttlMs;
      found.info = { ...found.info, status: "approved", expiresAt: new Date(found.expiresAtMs).toISOString() };
    } else {
      found.info = { ...found.info, status: "rejected" };
    }
    return { ok: true, info: found.info };
  }

  /** Gasta a aprovação (uma execução): confere o token, a ferramenta e os argumentos. */
  consume(id: string, tokenId: string, tool: string, args: unknown): ConsumeResult {
    this.refresh();
    const found = this.entries.find((e) => e.info.id === id && e.info.tokenId === tokenId);
    if (!found) return { ok: false, status: "not_found" };
    if (found.info.status !== "approved") return { ok: false, status: found.info.status };
    if (found.info.tool !== tool || found.digest !== approvalDigest(tool, args)) return { ok: false, status: "mismatch" };
    found.info = { ...found.info, status: "used" };
    return { ok: true };
  }
}
