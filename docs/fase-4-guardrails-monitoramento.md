# Fase 4 — Guardrails + Monitoramento contínuo: notas de implementação

> Spec: plano §5.4 e `docs/security-research.md` §6.6. Padrões seguidos:
> persistência JSON em `data/`, jobs assíncronos, alvo container em dev
> (`PAAS_TARGET=container`), UI shadcn dark pt-BR.

## 1. Guardrails de deploy (`packages/deploy/src/rules.ts`)

Sistema de regras com 3 níveis — `block` exige override explícito (auditado),
`warn` alerta, `info` informa. Relatório por regra com **evidência**
(arquivo:serviço ou arquivo:linha) + **sugestão de correção**.

| Regra | Nível | O que detecta |
|---|---|---|
| `db-port-exposed` | block | porta de banco (5432/3306/6379/27017/1433) publicada no host |
| `weak-credentials` | block | valor trivial em var sensível (~25 padrões), `user:pass` iguais, par USUÁRIO==SENHA em vars separadas (cacheta:cacheta) |
| `privileged-container` | block | `privileged: true` ou `/var/run/docker.sock` montado |
| `dev-service-in-prod` | warn | mailhog, mailpit, phpmyadmin, adminer, pgAdmin, etc. |
| `secret-in-code` | warn | scan do fonte: AWS keys, PEM private keys, tokens GitHub/Slack/Google/Stripe + alta entropia em var suspeita (regexes conservadoras; placeholders ignorados) |
| `latest-tag` | info | imagem com `:latest` ou sem tag |

Enforcement em duas camadas:
1. **API** (`DeployService.startDeploy`): se o código está disponível localmente,
   o relatório roda antes do job. Com blockers e sem override → `409
   guardrail_blocked` (corpo inclui o relatório) + alerta crítico + auditoria
   `deploy.blocked`. Com `{ guardrailOverride: true }` → deploy segue +
   auditoria `guardrail.override` (com as regras violadas) + alerta warning.
2. **Engine** (`DeployEngine.deploy`, pós-ingestão): cobre o modo git (código
   só existe após o clone) — roda os guardrails sobre o código ingerido e
   aborta com `guardrail_blocked` se houver blockers sem override.

Endpoint sob demanda: `GET /api/projects/:id/guardrails` (usado pela UI antes
do deploy; retorna `report: null` + nota quando o código ainda não foi ingerido).

A detecção da Fase 2 (`DetectResult.warnings`) continua intacta para
compatibilidade — o sistema novo é paralelo e mais completo.

## 2. Baseline + scans recorrentes (`packages/security/src/baseline.ts` + `monitor.ts`)

- **Baseline** (`POST /api/security/baseline`): snapshot do alvo (mesmo
  runner da Fase 1 — host ou container): pacotes (`dpkg-query`), portas em
  listen (`ss -tulpnH` com fallback para `/proc/net/*`) e sha256 de arquivos
  críticos (`/etc/ssh/sshd_config*`, `/etc/ufw/**`, `/etc/fail2ban/**`).
  Salvo em `data/security/baseline.json` (0600).
- **Scan recorrente**: `MonitorScheduler` (setInterval dentro do processo do
  servidor — sem tocar em cron/systemd do host, mais portátil). Intervalo
  configurável via `PUT /api/security/monitor/config` (default 6h, mínimo
  10s), persistido em `data/security/monitor.json` junto com `lastRunAt` e o
  último resultado. Ciclos sobrepostos são pulados (scan anterior em voo).
- **Diff** (`POST /api/security/monitor/run` ou via scheduler): novos pacotes,
  pacotes removidos, novas portas, portas fechadas, arquivos
  alterados/criados/removidos → **um alerta por categoria** (portas/arquivos =
  crítico, pacotes = warning). `GET /api/security/monitor/last` expõe estado +
  último diff.

## 3. Blacklist de e-mail (`packages/mailer/src/blacklist.ts`)

- DNSBLs de IP: Spamhaus ZEN, SpamCop, Barracuda (consulta DNS reversa via
  resolver do **sistema** — resolvedores públicos abertos são recusados pela
  Spamhaus). DNSBL de domínio: Spamhaus DBL (um item por domínio cadastrado).
- Respostas `127.0.0.x` = listed (com link de remoção); `127.255.255.x` =
  consulta recusada → `unknown` (nunca listed); NXDOMAIN = clean. Resolver
  injetável para testes (`127.0.0.2` é o IP reservado de teste de DNSBLs).
- `GET /api/mail/blacklist` sob demanda; o scan recorrente inclui o check
  automaticamente quando há domínios de e-mail cadastrados (hook registrado
  nas rotas de monitoramento) e gera alerta crítico se algo estiver listado.

## 4. Central de alertas + auditoria (`apps/server`)

- `data/alerts.json` (cap 500): severidade, origem
  (guardrail/scan/blacklist/sistema), título, detalhe, status
  (open/acknowledged/resolved). Alerta aberto com mesma origem+título é
  atualizado (bump) em vez de duplicado — o scan a cada 6h não gera pilha.
- `data/audit.json` (cap 2000): quem/o quê/quando/detalhe. Ações auditadas:
  `deploy.start`, `deploy.blocked`, `guardrail.override`, `project.delete`,
  `hardening.apply`, `mail.domain.add/remove`, `mail.mailbox.create`,
  `security.baseline`, `monitor.config`. Nunca contém segredos.
- Endpoints: `GET /api/alerts` (filtros status/severidade/origem + paginação),
  `POST /api/alerts/:id/ack`, `POST /api/alerts/:id/resolve`, `GET /api/audit`
  (paginado), além dos de baseline/monitor/blacklist acima.

## 5. UI (apps/web)

- **Segurança** (`/security`): Hardening Index atual + histórico, Baseline
  (criação/atualização), Monitoramento (intervalo, último scan, diff, "rodar
  agora"), Blacklist (status por DNSBL com link de remoção).
- **Alertas** (`/alerts`): filtros, badges de severidade/origem/status, ações
  reconhecer/resolver; badge com contagem de abertos na nav (polling 30s).
- **Auditoria** (`/audit`): tabela paginada de ações sensíveis.
- **Detalhe do projeto**: deploy passa pelo relatório de guardrails; com
  blockers abre modal listando evidência+correção e exigindo o checkbox
  "Entendo os riscos" antes do override (também trata o 409 da API).

## 6. Persistência

| Arquivo | Conteúdo |
|---|---|
| `data/security/baseline.json` | snapshot (pacotes, portas, hashes) |
| `data/security/monitor.json` | intervalo, lastRunAt, último resultado |
| `data/alerts.json` | alertas (cap 500) |
| `data/audit.json` | log de auditoria (cap 2000) |

## 7. Testes

`pnpm test:fase4` (`scripts/test-fase4.mts`): 17 verificações em ambiente
isolado (/tmp + containers descartáveis `paas-fase4-target`):
guardrails (6 regras com níveis corretos), deploy bloqueado (409 + alerta +
auditoria), deploy com override (202 + `guardrail.override` na auditoria +
guardrails no log do pipeline), baseline, diff real (pacote instalado + porta
aberta + arquivo alterado → 3 alertas por categoria), blacklist (endpoint +
mock listed/clean/unknown), ciclo de alertas, scheduler (roda sozinho e
persiste), auditoria paginada e limpeza completa.

Desvio consciente: o intervalo mínimo do scheduler é 10s (não 60s) para ser
testável via API; o default continua 6h.
