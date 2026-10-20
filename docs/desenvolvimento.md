# Desenvolvimento e arquitetura

Como rodar o painel no seu computador e como o código está organizado. Para contribuir (padrões,
testes, fluxo de pull request), leia o [CONTRIBUTING.md](../CONTRIBUTING.md).

## Modo dev local

```bash
pnpm install
SETUP_TOKEN=dev-token pnpm dev
# ou, com Docker:
SETUP_TOKEN=dev-token docker compose -f docker-compose.dev.yml up
```

- Painel (build de produção servido pela API): `http://localhost:9000`
- Frontend com hot reload: `http://localhost:5173` (proxy `/api` → 9000)
- Wizard: `http://localhost:5173/setup` com o token `dev-token`
- Domínios de projeto: use `*.localhost` (servidos em HTTP puro pelo Caddy, sem SSL)

> [!NOTE]
> O painel recusa escrita (`POST`, `PUT`, `PATCH`, `DELETE`) que o navegador marca como vinda de
> outro site. No dev em `http://localhost:5173` o proxy do Vite troca o `Host` para `localhost:9000`,
> mas o navegador informa `Sec-Fetch-Site: same-origin`, e é isso que vale — o login funciona sem
> configurar nada. Se algum proxy no meio remover esse cabeçalho e você levar `403 forbidden_origin`,
> libere a origem da página: `ALLOWED_ORIGINS=http://localhost:5173 SETUP_TOKEN=dev-token pnpm dev`.
> Ao concluir o assistente o setup token é apagado e deixa de valer; para reabrir o assistente use
> `./scripts/reset-setup.sh` (gera um token novo).

Exemplos prontos para deploy em [`examples/`](../examples/README.md).

> [!WARNING]
> Os exemplos são **apenas para testes** — não os use como base de produção sem revisão.

> [!IMPORTANT]
> 🔒 **Validação automática:** o `pnpm install` ativa hooks locais de pre-commit
> (arquivos proibidos + scan de segredos + typecheck incremental) e pre-push
> (testes + cobertura + build). O CI no GitHub Actions é o portão final —
> detalhes no [CONTRIBUTING.md](../CONTRIBUTING.md).

## Arquitetura

Monorepo pnpm com TypeScript estrito de ponta a ponta:

```
tws-panel/
├── apps/
│   ├── server/                  # API Fastify: wizard, projetos, domínios, e-mail,
│   │                            # certificados, notificações, backups,
│   │                            # segurança, alertas e auditoria
│   └── web/                     # SPA React (Vite + Tailwind + shadcn/ui):
│                                # wizard /setup + dashboard dark pt-BR
├── packages/
│   ├── core/                    # tipos e constantes compartilhados
│   ├── security/                # engine de scan + hardening + baseline/diff
│   ├── deploy/                  # detecção, ingestão, guardrails, Caddy, pipelines
│   └── mailer/                  # Stalwart, DKIM, checklist DNS, blacklist,
│                                # nota de entregabilidade
├── scripts/
│   ├── install.sh               # instalador one-shot (idempotente, 100% Docker)
│   ├── hardening/               # scripts shell idempotentes por fase (00–07)
│   ├── hooks/                   # hooks git locais (pre-commit / pre-push)
│   ├── show-token.sh, reset-*.sh, reativar-acesso-ip.sh,
│   │   restaurar-painel.sh, uninstall.sh  # utilitários de operação na VPS
│   └── test-*.mts               # suítes de verificação (Fases 3 e 4)
├── examples/                    # apps de exemplo para deploy (apenas testes)
├── docs/                        # guias (instalação, operação, segurança…) e specs
├── comoFuncionaSistema/         # documentação legível por máquina (para agentes de IA)
├── Dockerfile                   # build multi-stage do painel (produção)
├── docker-compose.yml           # produção: painel em 127.0.0.1:PAAS_PORT (padrão 9000)
└── docker-compose.dev.yml       # dev local com hot reload
```

Como os módulos se relacionam:

```
                    ┌─────────────┐
        browser ───►│  apps/web   │ (SPA: wizard + dashboard)
                    └──────┬──────┘
                           │ /api
                    ┌──────▼──────┐      ┌───────────────┐
                    │ apps/server │─────►│ @paas/security│──► host (Lynis, UFW,
                    │  (Fastify)  │      └───────────────┘    fail2ban, baseline)
                    └──┬───┬───┬──┘
                       │   │   │      ┌───────────────┐
                       │   │   └─────►│  @paas/deploy │──► Docker + Caddy central
                       │   │          └───────────────┘    (SSL automático)
                       │   │          ┌───────────────┐
                       │   └─────────►│ @paas/mailer  │──► Stalwart (SMTP/IMAP/DKIM)
                       │              └───────────────┘    + Roundcube (webmail)
                       │              ┌───────────────┐
                       └─────────────►│   @paas/core  │ (tipos compartilhados)
                                      └───────────────┘
        Estado persistido no volume paas_data (/data, arquivos JSON, modo 0600)
        — sem banco de dados. Serviços externos só os que você ligar: GitHub,
        Telegram e o armazenamento S3/R2 dos backups.
```
