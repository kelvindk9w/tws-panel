# Contribuindo com o paas

Obrigado por considerar contribuir! Este projeto existe porque hospedar a própria infra não
deveria exigir um painel pesado nem uma mensalidade — toda ajuda para mantê-lo leve, seguro e
simples é bem-vinda.

Antes de começar, leia o [Código de Conduta](CODE_OF_CONDUCT.md).

## Setup local

Requisitos: **Node ≥ 22**, **pnpm** (via `corepack enable`) e **Docker**.

```bash
git clone <repo> && cd paas
pnpm install
SETUP_TOKEN=dev-token pnpm dev
```

- API em `http://localhost:9000`, frontend com hot reload em `http://localhost:5173`
- Wizard: `http://localhost:5173/setup` (token `dev-token`)
- Comandos úteis: `pnpm build`, `pnpm typecheck`

## Testes

O projeto usa **Vitest** para testes unitários (packages, servidor e frontend) e scripts
E2E próprios (`node:assert`) para os fluxos que dependem de Docker.

```bash
pnpm test            # unitários de todos os packages + apps (Vitest)
pnpm test:unit       # o mesmo, explicitamente
pnpm test:coverage   # unitários com cobertura v8 (thresholds por package)
pnpm test:e2e        # E2E completos: test:fase4 + test:mail (REQUER Docker)
pnpm test:fase4      # só o E2E da Fase 4 (guardrails + monitoramento)
pnpm test:mail       # só o E2E da Fase 3 (e-mail)
```

Os testes unitários ficam em `tests/` dentro de cada package/app
(ex.: `packages/deploy/tests/detect.test.ts`). Filosofia obrigatória: **testes verificam
o RESULTADO das ações** (estado correto, dados corretos, findings gerados) — nunca apenas
status HTTP 200. Cada regra de guardrail/check deve ter: o caso que dispara, o caso que
NÃO dispara e pelo menos um edge case. Resolvers de DNS, runners e serviços de Docker são
injetáveis justamente para permitir mocks determinísticos.

A cobertura (`pnpm test:coverage`) foca na lógica pura — engine/exec/runner falam com
Docker e são cobertos pelos E2E. Os thresholds estão nos `vitest.config.ts` de cada
package; ao adicionar lógica nova, mantenha-os verdes.

**Convenção: todo PR precisa de testes** cobrindo a mudança (unitário para lógica pura,
componente para UI, E2E para fluxos de infra) e **CI verde é obrigatório** — o workflow
`.github/workflows/ci.yml` roda install → typecheck → build → testes unitários em pushes
e PRs nas branches `main` e `dev`.

## Padrões do projeto

- **TypeScript estrito** em todo o monorepo (`pnpm typecheck` precisa passar). Código e
  identificadores em **inglês**; UI, docs e comentários explicativos em **pt-BR**.
- **Commits convencionais**: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:` —
  em português ou inglês, na linha imperativa (ex.: `feat: adiciona regra de guardrail X`).
- **Persistência simples**: estado em JSON/SQLite em `data/` (modo 0600 quando sensível),
  nunca serviços externos novos sem discussão prévia.
- **Segurança não é opcional**: nada de shell arbitrário vindo da UI, nada de segredos em
  logs, nada de portas expostas por padrão. Ações sensíveis precisam gerar registro de auditoria.
- Faça **mudanças mínimas e focadas**. Não reformate arquivos que você não está alterando.

## Como estender o painel

### Adicionar um check de segurança

Os checks ficam em `packages/security/src/checks.ts`. Cada check declara id, severidade,
como detectar o problema (read-only) e, quando aplicável, como corrigi-lo (idempotente).
Scripts de correção de sistema ficam em `scripts/hardening/` (veja `lib.sh` para os helpers
de idempotência e backup). Consulte `docs/security-research.md` — é a spec que orienta o que
vale a pena checar e por quê.

### Adicionar uma regra de guardrail

As regras ficam em `packages/deploy/src/rules.ts`. Cada regra recebe o código-fonte do
projeto (compose, env, arquivos) e retorna achados com **nível** (`block` | `warn` | `info`),
**evidência** (arquivo:serviço ou arquivo:linha) e **sugestão de correção**. Prefira regexes
conservadoras (falso positivo em `block` é o pior cenário). Cubra a regra com testes unitários em
`packages/deploy/tests/` (caso que dispara + caso que não dispara + edge case) e valide o fluxo
completo com `pnpm test:fase4`.

### Adicionar um pipeline de deploy

A detecção fica em `packages/deploy/src/detect.ts` e a execução em
`packages/deploy/src/engine.ts`. Um pipeline novo precisa: (1) ser detectável a partir dos
arquivos do projeto, (2) construir e subir containers **na rede `paas-net`**, e (3) passar
pelos guardrails como qualquer deploy. Use os exemplos em `examples/` como referência.

## Fluxo de Pull Request

1. Abra uma **issue** antes de mudanças grandes (ou comente em uma existente) para alinhar o
   desenho — evita retrabalho.
2. Faça fork, crie um branch a partir de `main` (`feat/minha-melhoria`).
3. Garanta `pnpm build` e `pnpm typecheck` limpos e **`pnpm test` verde** (mais
   `pnpm test:e2e` se a mudança tocar fluxos de infra). Todo PR precisa incluir testes
   para a mudança — o CI bloqueia o merge sem eles.
4. Abra o PR preenchendo o template: o que muda, por quê, como testar.
5. Responda à revisão — PRs pequenos e focados são aceitos muito mais rápido.

## Reportando bugs e sugerindo features

Use os templates de issue no GitHub. Para **vulnerabilidades de segurança**, nunca abra issue
pública — siga o [SECURITY.md](SECURITY.md).
