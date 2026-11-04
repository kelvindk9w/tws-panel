/**
 * edge-watch.ts — percebe se o painel está atrás do proxy da Cloudflare
 * ("nuvem laranja").
 *
 * Com o proxy ligado, o IP que o painel enxerga passa a ser o da borda da
 * Cloudflare: o limite de tentativas por IP deixa de separar o atacante do
 * dono (e o atacante se espalha por várias bordas). O painel deve ficar com a
 * "nuvem cinza" (só DNS) no domínio dele.
 *
 * É só um aviso: os cabeçalhos podem ser forjados por quem acessa, e o pior
 * que isso causa é um aviso a mais na tela de Segurança. Fica em memória
 * (zera ao reiniciar) e vale por 24 h depois da última vez que apareceu.
 */
const VALID_FOR_MS = 24 * 60 * 60 * 1000;

export interface EdgeStatus {
  /** Chegou requisição com cabeçalho do proxy da Cloudflare nas últimas 24 h. */
  cloudflareProxy: boolean;
  lastSeenAt: string | null;
}

export class EdgeWatch {
  private lastSeen: number | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  observe(headers: Record<string, string | string[] | undefined>): void {
    if (headers["cf-ray"] !== undefined || headers["cf-connecting-ip"] !== undefined) {
      this.lastSeen = this.now();
    }
  }

  status(): EdgeStatus {
    const active = this.lastSeen !== null && this.now() - this.lastSeen < VALID_FOR_MS;
    return { cloudflareProxy: active, lastSeenAt: this.lastSeen === null ? null : new Date(this.lastSeen).toISOString() };
  }
}
