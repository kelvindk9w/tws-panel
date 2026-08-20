# TWS Panel

> **Transforme qualquer VPS Ubuntu em sua própria plataforma de hospedagem — segura, com e-mail profissional e zero mensalidade de painel.**

[![Licença: MIT](https://img.shields.io/badge/licen%C3%A7a-MIT-green.svg)](LICENSE)
[![Node.js 22](https://img.shields.io/badge/node-%E2%89%A522-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Docker](https://img.shields.io/badge/docker-compose-2496ED?logo=docker&logoColor=white)](https://docs.docker.com/compose/)
[![pnpm](https://img.shields.io/badge/pnpm-monorepo-F69220?logo=pnpm&logoColor=white)](https://pnpm.io)
[![Status: beta](https://img.shields.io/badge/status-beta-yellow)](#roadmap)

---

## Por que este projeto existe?

A TWS pagava **R$50/mês** em um plano de hospedagem praticamente só para ter e-mail
profissional para **1 cliente**. Testamos painéis pesados que assumiam o controle de toda a
máquina (e quebravam stacks que já funcionavam) e hospedagens que nos deixavam na mão. Então
decidimos construir o painel que queríamos ter encontrado: **leve, não-invasivo e seguro desde
o primeiro boot** — e liberar para a comunidade sob licença MIT.

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

## Instalação — VPS limpa do zero

**Não precisa instalar Docker, Node ou mais nada manualmente — só Ubuntu e git.**

1. **Contrate uma VPS** com Ubuntu 24.04 LTS (mínimo recomendado: 1 vCPU / 2 GB RAM / 25 GB de disco).

2. **Acesse via SSH:**

   ```bash
   ssh root@SEU_IP
   ```

3. **Instale o git** (se ainda não tiver):

   ```bash
   apt update && apt install -y git
   ```

4. **Clone o repositório** (pode personalizar o diretório — o padrão sugerido é `/opt/tws-panel`):

   ```bash
   git clone https://github.com/kelvindk9w/tws-panel.git /opt/tws-panel
   cd /opt/tws-panel
   ```

5. **Rode o instalador** — ele instala o Docker se necessário, builda a imagem e sobe os containers:

   ```bash
   ./scripts/install.sh
   ```

   > **🩺 Pré-flight check:** antes de instalar qualquer coisa, o instalador faz
   > verificações **somente-leitura** (SO, RAM/disco, Docker e containers em
   > execução, portas 80/443/9000/25/587/993 e serviços como nginx, apache,
   > caddy, postfix, mysql e postgres) e exibe um relatório. Se a VPS já estiver
   > em uso, ele avisa que o painel foi feito para uma VPS limpa e pede
   > confirmação explícita (digite `continuar`) — ou use
   > `./scripts/install.sh --force` / `PAAS_FORCE=1` em automação. Ele **nunca
   > remove nem para** nada que já exista na máquina.

6. **Abra o painel** em `http://SEU_IP:9000`, cole o **setup token** exibido no terminal e siga o wizard:

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

O instalador é **idempotente**: pode ser executado de novo sem quebrar nada (rebuild + restart).
O painel roda 100% em Docker (`docker compose up -d`), com o estado persistido no volume
`paas_data` e acesso ao socket do Docker para gerenciar Caddy, Stalwart e seus projetos.

Depois do wizard: cadastre um projeto, aponte o DNS, e o painel cuida do build, do proxy e do
SSL. Guia completo de produção em [docs/production.md](docs/production.md).

### Comandos úteis (produção)

```bash
docker compose ps            # status do painel
docker compose logs -f panel # logs em tempo real
docker compose up -d --build # atualizar para uma nova versão (git pull antes)
```

### Modo dev local

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

Exemplos prontos para deploy em [`examples/`](examples/README.md) ⚠️ *(apenas para testes)*.

> 🔒 **Validação automática:** o `pnpm install` ativa hooks locais de pre-commit
> (arquivos proibidos + scan de segredos + typecheck incremental) e pre-push
> (testes + cobertura + build). O CI no GitHub Actions é o portão final —
> detalhes no [CONTRIBUTING.md](CONTRIBUTING.md).

## Arquitetura

Monorepo pnpm com TypeScript estrito de ponta a ponta:

```
tws-panel/
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
│   ├── install.sh               # instalador one-shot (idempotente, 100% Docker)
│   ├── hardening/               # scripts shell idempotentes por fase (00–06)
│   └── test-*.mts               # suítes de verificação (Fases 3 e 4)
├── examples/                    # apps de exemplo para deploy (apenas testes)
├── docs/                        # specs, guias de produção e troubleshooting
├── Dockerfile                   # build multi-stage do painel (produção)
├── docker-compose.yml           # produção: painel na porta 9000
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
                       │              └───────────────┘
                       │              ┌───────────────┐
                       └─────────────►│   @paas/core  │ (tipos compartilhados)
                                      └───────────────┘
        Estado persistido no volume paas_data (/data, JSON/SQLite, modo 0600)
        — sem serviços externos.
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

**Autenticação:** o painel nasce protegido pelo setup token gerado na instalação; no Passo 4 do
wizard você cria a conta de administrador (senha com hash argon2id, mínimo de 12 caracteres com
maiúsculas, minúsculas e números), o que conclui o setup e invalida o token para sempre. Daí em
diante todo acesso exige login (`/login`): as sessões são revogáveis, persistidas no servidor
(cookie httpOnly, SameSite=Lax, expiração de 12h — nada de JWT stateless), o login tem rate limit
de 5 tentativas/minuto por IP com lockout progressivo, e trocar a senha invalida as demais sessões.
Login, logout, falhas e criação da conta admin ficam registrados no log de auditoria.

## Documentação

| Doc | Conteúdo |
|---|---|
| [docs/production.md](docs/production.md) | Do dev à VPS real: portas, DNS, ACME, PTR, ordem recomendada |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Porta 25 bloqueada, e-mail em spam, cert não emitido, wizard inacessível… |
| [docs/README.md](docs/README.md) | Índice completo da documentação |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Como contribuir (setup, padrões, como estender o painel) |
| [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) | Código de conduta |
| [SECURITY.md](SECURITY.md) | Política de segurança e reporte de vulnerabilidades |

## Sobre a TWS

O **TWS Panel** é um projeto open source mantido pela **TWS**, software house fundada e liderada
pelo CEO **Kelvin**. A TWS desenvolve soluções web, sistemas e automações sob medida para
clientes — e este projeto nasceu de uma dor real da própria empresa: pagar hospedagem cara
praticamente só para ter e-mail profissional. Em vez de ficar só no uso interno, decidimos
liberar o painel para a comunidade, sob licença MIT.

Quer conversar sobre parcerias, projetos ou contribuições?

- 🌐 Site: [tws.tec.br](https://tws.tec.br/)
- ✉️ E-mail: [contato@tws.tec.br](mailto:contato@tws.tec.br)
- 💼 LinkedIn: [Kelvin Medeiros](https://www.linkedin.com/in/kelvin-medeiros-37920487)

**Autor:** Kelvin — CEO & Founder @ TWS

## Licença

[MIT](LICENSE) © 2026 TWS — Kelvin
