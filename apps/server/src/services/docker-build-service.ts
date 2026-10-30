/**
 * docker-build-service.ts — Saúde da VPS → Docker e BuildKit.
 *
 * Dois lugares precisam do plugin buildx:
 *  - o CLI do Docker DENTRO do painel (é ele que faz os builds dos deploys). Vem na imagem do painel, que roda
 *    com o sistema de arquivos somente leitura: aqui só se verifica, e quem corrige é a atualização do painel;
 *  - o Docker da própria VPS (o que a pessoa usa por SSH). Lido e, com confirmação de identidade, corrigido pelo
 *    host bridge (allowlist própria em packages/security/src/host-buildx.ts, cada comando auditado). O pacote
 *    certo depende de onde o Docker veio; origem não reconhecida mostra os comandos manuais e não instala nada.
 */
import type { DockerBuildStatusResponse } from "@paas/core";
import {
  HOST_BUILDX_STATUS_COMMAND,
  buildBuildxInstallCommand,
  buildxManualCommands,
  isFixableDockerOrigin,
  parseBuildxStatus,
} from "@paas/security";
import type { AccessAudit, AccessRunner } from "./access-service.js";
import { httpError } from "./http-error.js";

export interface PanelBuildxCheck {
  ok: boolean;
  version?: string;
  detail?: string;
}

export interface DockerBuildServiceOptions {
  /** null = fora da VPS real (desenvolvimento/teste). */
  runner: AccessRunner | null;
  /** `docker buildx version` no CLI do painel. */
  panelCheck: () => Promise<PanelBuildxCheck>;
  audit?: AccessAudit;
}

/** Instalar pacote pode baixar do repositório: prazo generoso. */
const INSTALL_TIMEOUT_MS = 300_000;

function firstLine(text: string): string {
  return text.split("\n").map((l) => l.trim()).find(Boolean)?.slice(0, 200) ?? "";
}

export class DockerBuildService {
  constructor(private readonly opts: DockerBuildServiceOptions) {}

  async status(): Promise<DockerBuildStatusResponse> {
    const panelResult = await this.opts.panelCheck();
    const panel = {
      buildx: panelResult.ok,
      version: panelResult.ok ? (panelResult.version ?? null) : null,
      detail: panelResult.ok ? null : (panelResult.detail ?? null),
    };
    const host = await this.hostStatus();
    return { panel, host, ok: panel.buildx && host.buildx !== false };
  }

  private async hostStatus(): Promise<DockerBuildStatusResponse["host"]> {
    const none = { buildx: null, origin: null, fixable: false, manualCommands: [] as string[] };
    if (!this.opts.runner) {
      return {
        ...none,
        available: false,
        reason: "Esta checagem só existe no painel instalado na VPS (modo de desenvolvimento ou teste não alcança o servidor).",
      };
    }
    try {
      await this.opts.runner.ensureReady();
      const r = await this.opts.runner.exec(HOST_BUILDX_STATUS_COMMAND, { timeoutMs: 30_000 });
      const parsed = parseBuildxStatus(r.stdout);
      if (r.code !== 0 || parsed.buildx === null) {
        return { ...none, available: false, reason: `Não foi possível ler o Docker da VPS: ${firstLine(r.stderr) || `código ${r.code}`}` };
      }
      return {
        available: true,
        reason: null,
        buildx: parsed.buildx,
        origin: parsed.origin,
        fixable: !parsed.buildx && isFixableDockerOrigin(parsed.origin),
        manualCommands: parsed.buildx ? [] : buildxManualCommands(parsed.origin),
      };
    } catch (err) {
      return { ...none, available: false, reason: `Não foi possível falar com a VPS: ${firstLine(err instanceof Error ? err.message : String(err))}` };
    }
  }

  /** Instala o plugin no Docker da VPS (origem reconhecida) e devolve o estado novo. */
  async fix(actor: string): Promise<DockerBuildStatusResponse> {
    const runner = this.opts.runner;
    if (!runner) {
      throw httpError(409, "docker_build_unavailable", "Esta correção só existe no painel instalado na VPS.");
    }
    await runner.ensureReady();
    const probe = await runner.exec(HOST_BUILDX_STATUS_COMMAND, { timeoutMs: 30_000 });
    const parsed = parseBuildxStatus(probe.stdout);
    if (probe.code !== 0 || parsed.buildx === null) {
      throw httpError(502, "host_failed", `Não foi possível ler o Docker da VPS: ${firstLine(probe.stderr) || `código ${probe.code}`}`);
    }
    if (parsed.buildx) throw httpError(409, "buildx_present", "O buildx já está instalado nesta VPS. Atualize a página.");
    if (!isFixableDockerOrigin(parsed.origin)) {
      throw httpError(
        409,
        "docker_origin_unknown",
        "O painel não reconhece de onde veio o Docker desta VPS e, por segurança, não instala nada. Rode os comandos mostrados na tela por SSH.",
      );
    }
    const r = await runner.exec(buildBuildxInstallCommand(parsed.origin), { timeoutMs: INSTALL_TIMEOUT_MS });
    if (r.code !== 0) {
      await this.audit(actor, "docker.buildx_failed", `Instalação do buildx (${parsed.origin}) falhou: ${firstLine(r.stderr) || `código ${r.code}`}.`);
      throw httpError(502, "host_failed", `A instalação do buildx falhou: ${firstLine(r.stderr) || firstLine(r.stdout) || `código ${r.code}`}`);
    }
    await this.audit(actor, "docker.buildx_installed", `Plugin buildx instalado no Docker da VPS (origem ${parsed.origin}) pelo painel.`);
    return this.status();
  }

  private async audit(actor: string, action: string, detail: string): Promise<void> {
    await this.opts.audit?.record({ action, detail, actor, target: "Docker da VPS" }).catch(() => undefined);
  }
}
