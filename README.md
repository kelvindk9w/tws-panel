# paas

> **Transforme qualquer VPS Ubuntu em sua própria plataforma de hospedagem — segura, com e-mail profissional e zero mensalidade de painel.**

[![Licença: MIT](https://img.shields.io/badge/licen%C3%A7a-MIT-green.svg)](LICENSE)
[![Node.js 22](https://img.shields.io/badge/node-%E2%89%A522-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![pnpm](https://img.shields.io/badge/pnpm-monorepo-F69220?logo=pnpm&logoColor=white)](https://pnpm.io)
[![Status: beta](https://img.shields.io/badge/status-beta-yellow)](#roadmap)

---

## Por que este projeto existe?

Eu sou desenvolvedor freelancer e pagava **R$50/mês** em um plano de hospedagem praticamente só
para ter e-mail profissional para **1 cliente**. Tentei painéis pesados que assumiam o controle de
toda a máquina (e quebravam stacks que já funcionavam) e hospedagens que me deixavam na mão. Então
decidi construir o painel que eu queria ter encontrado: **leve, não-invasivo e seguro desde o
primeiro boot** — e liberar para a comunidade sob licença MIT.

## O que é

Um painel open-source que transforma uma VPS Ubuntu 22.04/24.04 crua em uma plataforma de
hospedagem pessoal. Você roda **um comando** e um assistente web passo a passo protege a máquina,
configura o painel e deixa tudo pronto para publicar projetos com Docker, domínios com SSL
automático e e-mail profissional com DKIM/SPF/DMARC.

**Princípios**

- **Não-invasivo** — trabalha *com* o Docker que já existe na máquina; nunca mexe em stacks que já funcionam.
- **Segurança primeiro** — nada sobe antes do hardening; baseline + monitoramento contínuo.
- **Minimalista** — a VPS fica com o mínimo de pacotes; painel leve (Fastify + SQLite, sem banco externo).
- **Open source** — MIT, pensado para contribuição desde o dia 1.

## Funcionalidades

| Módulo | O que faz |
|---|---|
| **🛡️ Wizard de segurança** | Scan com **Lynis** + checks próprios (score antes/depois), hardening idempotente em fases (SSH, UFW, fail2ban, unattended-upgrades, auditd/AIDE…), backup de cada arquivo alterado e **rollback automático** agendado — cancelado só depois que você confirma que continua com acesso. |
| **🚀 Deploy** | **3 modos de ingestão** (git com branch configurável, upload de diretório, ou adoção de um compose existente — sem reescrevê-lo), **detecção automática** de pipeline (estático Node, Dockerfile, compose), **Caddy central** com SSL automático e reload sem downtime, suporte a WebSocket/conexões longas, logs de deploy em tempo real. |
| **📧 E-mail** | Servidor **Stalwart** (SMTP + IMAP + DKIM em um container), par **DKIM RSA 2048** gerado por domínio, **checklist DNS verificável** (A/AAAA/MX/SPF/DKIM/DMARC/PTR) com valores prontos para colar no provedor, texto pronto para abrir chamado de PTR, criação de caixas com **credenciais prontas para Outlook/Gmail/Thunderbird**, e injeção automática de variáveis SMTP nos seus projetos. |
| **🚧 Guardrails** | **6 regras** de segurança de deploy em 3 níveis (`block`, `warn`, `info`): porta de banco exposta no host, credenciais fracas, container privilegiado, serviço de dev em produção, secret comitado no código, tag `:latest`. Blocks exigem **override explícito e auditado**, com evidência e sugestão de correção. |
| **📊 Monitoramento** | **Baseline** pós-hardening (pacotes, portas, hashes de arquivos críticos) + scans recorrentes com **diff** (o que mudou vira alerta), verificação de **blacklist de e-mail** (Spamhaus ZEN, SpamCop, Barracuda, Spamhaus DBL), central de alertas e **log de auditoria** de todas as ações sensíveis. |

## Quickstart (VPS Ubuntu 22.04/24.04)

```bash
git clone <este-repo> /opt/paas
cd /opt/paas
sudo ./scripts/install.sh
```

O instalador é idempotente e faz tudo: verifica o SO, instala o que faltar (Node 22, pnpm, git,
Docker), builda o monorepo, gera um **setup token** aleatório e sobe o assistente na porta 9000.
No final ele imprime a URL — abra no navegador e siga o wizard:

```
┌─────────────────────────────────────────────────────────────┐
│  Assistente de configuração — http://SEU-IP:9000/?token=…   │
├─────────────────────────────────────────────────────────────┤
│  1. Boas-vindas      → valida o setup token                 │
│  2. Saúde da máquina → CPU, RAM, disco, rede, virtualização │
│  3. Segurança        → scan Lynis → plano → hardening       │
│                        (com rollback automático em 5 min)   │
│  4. Conta admin      → usuário + senha forte do painel      │
└─────────────────────────────────────────────────────────────┘
```

Depois do wizard: cadastre um projeto, aponte o DNS, e o painel cuida do build, do proxy e do
SSL. Guia completo de produção em [docs/production.md](docs/production.md).

### Modo dev local

```bash
pnpm install
SETUP_TOKEN=dev-token pnpm dev
# ou, com Docker:
SETUP_TOKEN=dev-token docker compose up
```

- Painel (build de produção servido pela API): `http://localhost:9000`
- Frontend com hot reload: `http://localhost:5173` (proxy `/api` → 9000)
- Wizard: `http://localhost:5173/setup` com o token `dev-token`
- Domínios de projeto: use `*.localhost` (servidos em HTTP puro pelo Caddy, sem SSL)

Exemplos prontos para deploy em [`examples/`](examples/README.md) ⚠️ *(apenas para testes)*.

## Arquitetura

Monorepo pnpm com TypeScript estrito de ponta a ponta:

```
paas/
├── apps/
│   ├── server/                  # API Fastify: wizard, projetos, domínios,
│   │                            # e-mail, segurança, alertas e auditoria
│   └── web/                     # SPA React (Vite + Tailwind + shadcn/ui):
│                                # wizard /setup + dashboard dark pt-BR
├── packages/
│   ├── core/                    # tipos e constantes compartilhados
│   ├── security/                # engine de scan + hardening + baseline/diff
│   ├── deploy/                  # detecção, ingestão, guardrails, Caddy, pipelines
│   └── mailer/                  # Stalwart, DKIM, checklist DNS, blacklist
├── scripts/
│   ├── install.sh               # instalador one-shot (idempotente)
│   ├── hardening/               # scripts shell idempotentes por fase (00–06)
│   └── test-*.mts               # suítes de verificação (Fases 3 e 4)
├── examples/                    # apps de exemplo para deploy (apenas testes)
├── docs/                        # specs, guias de produção e troubleshooting
└── docker-compose.yml           # dev local do painel
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
                       │              └───────────────┘
                       │              ┌───────────────┐
                       └─────────────►│   @paas/core  │ (tipos compartilhados)
                                      └───────────────┘
        Estado persistido em data/ (JSON/SQLite, modo 0600) — sem serviços externos.
```

## Roadmap

| Item | Descrição |
|---|---|
| 2FA TOTP | Segundo fator no login do painel |
| MTA-STS / TLS-RPT | Política de TLS obrigatório + relatórios de falha |
| BIMI | Logo verificado (requer DMARC endurecido + VMC) |
| Warm-up de IP | Assistente de aquecimento de reputação para IPs novos |
| Backups na UI | Agendamento/restore de volumes Docker pela interface |
| Multi-servidor | Gerenciar várias VPS a partir de um painel (v2) |

Fases já entregues: **0** Fundação · **1** Hardening · **2** Deploy + Domínios ·
**3** E-mail · **4** Guardrails + Monitoramento · **5** Polish open source.

## Segurança

Encontrou uma vulnerabilidade? **Não abra uma issue pública.** Leia [SECURITY.md](SECURITY.md)
para saber como reportar de forma responsável.

O próprio painel foi desenhado com segurança em mente: wizard protegido por token de uso único,
nenhum shell arbitrário vindo da UI (apenas ações pré-definidas e auditadas), Docker socket nunca
exposto via TCP, CORS same-origin por padrão, rate limiting, logs com redação de segredos e
auditoria de todas as ações sensíveis.

## Documentação

| Doc | Conteúdo |
|---|---|
| [docs/production.md](docs/production.md) | Do dev à VPS real: portas, DNS, ACME, PTR, ordem recomendada |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Porta 25 bloqueada, e-mail em spam, cert não emitido, wizard inacessível… |
| [docs/README.md](docs/README.md) | Índice completo da documentação |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Como contribuir (setup, padrões, como estender o painel) |
| [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) | Código de conduta |
| [SECURITY.md](SECURITY.md) | Política de segurança e reporte de vulnerabilidades |

## Licença

[MIT](LICENSE) © 2026 Kelvin
