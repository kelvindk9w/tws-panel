# Análise dos Projetos Reais — Requisitos para o Painel

> Consolidação dos requisitos de deploy dos 3 projetos reais do usuário. Cada projeto representa
> um **modo de ingestão/pipeline** que o painel precisa suportar (Fases 2–4).

---

## 1. bomb — site estático (Next.js static export)

| Aspecto | Situação |
|---|---|
| Stack | Next.js com `output: "export"` → build gera `out/` (100% estático) |
| Env vars | **Nenhuma** |
| Banco de dados | **Nenhum** |
| Deploy | build Node → servir pasta `out/` atrás do Caddy com SSL |

**Requisitos para o painel:**
- Pipeline **estático Node → `out/`**: `pnpm install && pnpm build`, publicar o diretório gerado.
- Caddyfile mínimo gerado pelo painel: domínio → arquivos estáticos, SSL automático.
- É o projeto mais simples: candidato ideal a "primeiro deploy" da Fase 2.

## 2. trader — monorepo full-stack (Next + API + TimescaleDB + Redis)

| Aspecto | Situação |
|---|---|
| Stack | Monorepo **pnpm**; `compose.prod.yml` com Next (web), API, TimescaleDB, Redis e **Caddy próprio** |
| Env vars | `.env.production`; `NEXT_PUBLIC_*` são **build-time** (precisam existir no momento do build da imagem) |
| Git | Repo com branch de trabalho `dev` → promoção para `main` |
| E-mail | **Precisa SMTP** (transacional) — quebra sem `SMTP_*` |

**Requisitos para o painel:**
- Modo **compose existente**: o painel **adota** o `compose.prod.yml`, não reescreve.
- Suporte a `.env.production` gerenciado pelo painel, com destaque para variáveis **build-time** do Next.
- Clone com **branch configurável** (deploy de `main`, desenvolvimento em `dev`).
- Projeto com **Caddy próprio** vira *upstream interno* do Caddy central do painel.
- **Injeção de SMTP** (`SMTP_HOST/PORT/USER/PASS/MAIL_FROM`) nas envs do compose.
- Trader já tem backup diário do TimescaleDB → painel consome/agenda (Fase futura).

## 3. cachetaGrok — app WebSocket (Vite + Colyseus + Postgres)

| Aspecto | Situação |
|---|---|
| Stack | Frontend **Vite** + servidor **Colyseus (WebSocket)** + Postgres |
| Compose | **Só existe compose de dev**; produção precisa ser criada |
| Env vars | Credenciais **hardcoded** (`cacheta:cacheta`), sem `.env` |
| Git | **Não usa git** — código só existe em diretório local |
| Segurança | **Porta 5432 do Postgres exposta** no host; Mailhog (dev) na 8025 |
| E-mail | **Precisa SMTP** (transacional) |

**Requisitos para o painel:**
- Modo **upload/diretório**: deploy sem git (upload de pasta ou path local).
- Painel **gera** o compose de produção (docker build multi-serviço).
- Caddyfile precisa de **suporte a WebSocket** e timeouts altos (conexões longas do Colyseus).
- **Guardrails de deploy** (Fase 4) motivados exatamente por este projeto:
  - ❌ bloquear porta de banco publicada no host (5432);
  - ❌ alertar credenciais hardcoded/fracas;
  - ❌ alertar serviços de dev em produção (Mailhog 8025);
  - ❌ alertar secrets comitados no código.
- **Injeção de SMTP** idem trader.

## 4. Matriz de requisitos → módulos

| Requisito | bomb | trader | cachetaGrok | Módulo/fase |
|---|---|---|---|---|
| Ingestão via git (branch configurável) | ✅ | ✅ (`dev`→`main`) | — | deploy / Fase 2 |
| Ingestão via upload/diretório | — | — | ✅ | deploy / Fase 2 |
| Adoção de compose existente | — | ✅ | — | deploy / Fase 2 |
| Geração de compose de produção | — | — | ✅ | deploy / Fase 2 |
| Pipeline estático (`out/`) | ✅ | — | ✅ (Vite `dist/`) | deploy / Fase 2 |
| Env vars build-time (`NEXT_PUBLIC_*`) | — | ✅ | — | deploy / Fase 2 |
| Caddy central + SSL + WebSocket | ✅ | ✅ (upstream) | ✅ | domínios / Fase 2 |
| Injeção de SMTP | — | ✅ | ✅ | mailer / Fase 3 |
| Guardrails (portas, secrets, serviços dev) | — | ✅ | ✅✅ | segurança / Fase 4 |
