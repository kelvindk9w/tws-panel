# Contribuindo com o TWS Panel

Versão em inglês (principal): [CONTRIBUTING.md](../../../CONTRIBUTING.md).

Obrigado por considerar contribuir! Este projeto existe porque hospedar a própria infraestrutura
não deveria exigir um painel pesado nem uma mensalidade. Toda ajuda para mantê-lo leve, seguro e
simples é bem-vinda.

Antes de começar, leia o [Código de Conduta](CODE_OF_CONDUCT.md).

## Por onde começar

- **Dúvidas e ideias:** use as [GitHub Discussions](https://github.com/kelvindk9w/tws-panel/discussions)
  ou abra uma issue com o formulário de pergunta.
- **Bugs:** abra uma issue com o formulário de bug. Remova tokens, senhas e domínios de clientes
  dos logs que você anexar.
- **Vulnerabilidades de segurança:** nunca abra uma issue pública. Siga o [SECURITY.md](SECURITY.md).
- **Correções na documentação** valem tanto quanto código. Erros de digitação, passos pouco claros e
  traduções que faltam são ótimas primeiras contribuições (veja [Documentação](#documentação)).

## Setup local

Requisitos: **Node >= 22**, **pnpm** (via `corepack enable`) e **Docker**.

```bash
git clone https://github.com/kelvindk9w/tws-panel.git && cd tws-panel
pnpm install
SETUP_TOKEN=dev-token pnpm dev
```

- API em `http://localhost:9000` e frontend com hot reload em `http://localhost:5173`
- Wizard: `http://localhost:5173/setup` (token `dev-token`)
- Comandos úteis: `pnpm build`, `pnpm typecheck`

Mais detalhes sobre a arquitetura e o modo de desenvolvimento estão no
[guia de desenvolvimento local](../../../site/src/content/docs/pt-br/development/local-development.md).

## Hooks de validação locais (pre-commit / pre-push)

O repositório versiona hooks do git em `scripts/hooks/` (bash puro, **sem husky e sem dependências
novas**). Eles são **ativados automaticamente** pelo `pnpm install` (o script `prepare` da raiz
aponta `core.hooksPath` para `scripts/hooks`), então não há nada a configurar. Os hooks dão
feedback rápido na sua máquina; **o CI continua sendo o portão final**.

- **`pre-commit`** (rápido, meta de menos de 30 s), roda só sobre o que está staged:
  1. bloqueia arquivos proibidos (`.env`, `data/`, `*.pem`, `id_rsa` etc.);
  2. faz uma varredura leve de segredos nos arquivos staged (`scripts/hooks/scan-secrets.mjs`:
     chaves AWS, blocos `PRIVATE KEY`, tokens do Slack e do GitHub, senhas atribuídas em strings),
     indicando `arquivo:linha`;
  3. roda o typecheck incremental (`tsc --noEmit`) apenas nos workspaces que você alterou.
- **`pre-push`** (completo): `pnpm test` + `pnpm test:coverage` (thresholds) + `pnpm build`. Se
  qualquer etapa falhar, o push é abortado com um resumo do erro.

**Emergências:** `git commit --no-verify` pula o pre-commit e `PAAS_SKIP_PREPUSH=1 git push` pula o
pre-push. Use com parcimônia: **o CI vai pegar** qualquer coisa que passar.

O scanner de segredos é leve de propósito, para não exigir dependências no sistema. Para uma
varredura mais profunda, recomendamos instalar o [gitleaks](https://github.com/gitleaks/gitleaks)
localmente (opcional).

## Testes

O projeto usa **Vitest** para testes unitários (pacotes, servidor e frontend) e scripts E2E
próprios (`node:assert`) para os fluxos que dependem do Docker.

```bash
pnpm test            # unitários de todos os pacotes e apps (Vitest)
pnpm test:unit       # o mesmo, de forma explícita
pnpm test:coverage   # unitários com cobertura v8 (thresholds por pacote)
pnpm test:e2e        # E2E completo: test:fase4 + test:mail (EXIGE Docker)
pnpm test:fase4      # só o E2E da fase 4 (guardrails + monitoramento)
pnpm test:mail       # só o E2E da fase 3 (e-mail)
```

Os testes unitários ficam em `tests/` dentro de cada pacote ou app (por exemplo,
`packages/deploy/tests/detect.test.ts`). O princípio central: **os testes verificam o RESULTADO de
uma ação** (o estado correto, os dados corretos, os achados gerados), nunca apenas um HTTP 200.
Cada regra de guardrail ou check precisa de um caso que a dispare, um caso que NÃO a dispare e pelo
menos um caso de borda. Resolvers de DNS, runners e serviços do Docker são injetáveis para que os
mocks sejam determinísticos.

A cobertura (`pnpm test:coverage`) foca na lógica pura. O código de engine, exec e runner conversa
com o Docker e é coberto pelos testes E2E; a lista exata de arquivos fora do escopo unitário, com o
motivo, está nos comentários do `vitest.config.ts` de cada pacote ou app. Os thresholds de cobertura
por pacote ficam no `vitest.config.ts`, e o CI falha se eles regredirem:

| Pacote/App          | Linhas | Branches | Funções |
| ------------------- | ------ | -------- | ------- |
| `packages/core`     | >= 98% | >= 98%   | >= 98%  |
| `packages/security` | >= 98% | >= 96%   | >= 98%  |
| `packages/mailer`   | >= 98% | >= 98%   | >= 98%  |
| `packages/deploy`   | >= 97% | >= 95%   | >= 97,5% |
| `apps/server`       | >= 94% | >= 91%   | >= 98%  |

As lacunas residuais conhecidas (branches defensivos inalcançáveis, catches de TOCTOU em varreduras
de disco, ramos de `system-info` que dependem do hardware do host) estão documentadas nos próprios
arquivos de configuração. Ao adicionar lógica nova, mantenha os thresholds verdes.

**Todo PR precisa de testes** que cubram a mudança (unitários para lógica pura, de componente para
a UI, E2E para fluxos de infraestrutura), e **o CI precisa estar verde**. O workflow
`.github/workflows/ci.yml` roda install, typecheck, build e testes unitários com cobertura
(thresholds) em pushes e pull requests nas branches `main` e `dev`.

## Padrões do projeto

- **TypeScript estrito** em todo o monorepo (`pnpm typecheck` precisa passar). Código e
  identificadores em **inglês**; a UI do painel e os comentários explicativos do código em
  **português do Brasil**.
- **Commits convencionais**: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, escritos em
  português ou inglês, no imperativo (por exemplo, `feat: adiciona regra de guardrail X`).
- **Persistência simples**: o estado fica em arquivos JSON em `data/` (modo 0600 quando sensível).
  Não adicione serviços externos novos sem discutir antes.
- **Segurança não é opcional**: nada de comandos de shell arbitrários montados a partir de entrada
  do usuário (o terminal web é a única exceção deliberada), nada de segredos em logs, nada de portas
  expostas por padrão. Ações sensíveis precisam gerar um registro de auditoria.
- Faça **mudanças mínimas e focadas**. Não reformate arquivos que você não está alterando.

## Documentação

Os guias são arquivos Markdown em `site/src/content/docs/<idioma>/`, publicados como um site com o
[Starlight](https://starlight.astro.build/). **O inglês (`en`) é o idioma principal**; o português
do Brasil (`pt-br`) é secundário, e a estrutura aceita mais idiomas.

- Uma página tem o **mesmo caminho relativo em todos os idiomas**. Uma página ainda não traduzida
  aparece em inglês no site, então as traduções podem ser adicionadas uma página por vez.
- Para ligar um guia a outro, use caminhos relativos para `.md` (`../guides/operations.md#ancora`).
  Eles funcionam no GitHub e são reescritos para o site na hora do build.
- Mantenha comandos, flags e caminhos idênticos em todos os idiomas e traduza apenas o texto ao
  redor. A UI do painel está, por enquanto, só em português: escreva os nomes das telas exatamente
  como aparecem na UI e, nas outras línguas, acrescente a tradução entre parênteses.
- Use `example.com` e `203.0.113.x` (faixa reservada para documentação) nos exemplos. Nunca use
  domínios, IPs, tokens ou endpoints de bucket reais.
- Veja e confira as suas mudanças:

```bash
pnpm docs:dev     # pré-visualização local com recarga automática
pnpm docs:build   # o mesmo build que o workflow do GitHub Pages executa
pnpm docs:links   # confere os links internos e as âncoras de todos os .md
```

Para adicionar um idioma, copie a pasta `en` para uma nova pasta com o nome do locale, traduza o que
puder e adicione o locale em `site/astro.config.mjs`.

## Como estender o painel

### Adicionar um check de segurança

Os checks ficam em `packages/security/src/checks.ts`. Cada check declara um id, uma severidade,
como detectar o problema (somente leitura) e, quando aplicável, como corrigi-lo (de forma
idempotente). Os scripts de correção do sistema ficam em `scripts/hardening/` (veja o `lib.sh` para
os helpers de idempotência e de backup). A spec em `docs/internal/security-research.md` (em
português) explica o que vale a pena checar e por quê.

### Adicionar uma regra de guardrail

As regras ficam em `packages/deploy/src/rules.ts`. Cada regra recebe o código-fonte do projeto
(compose, env, arquivos) e retorna achados com um **nível** (`block` | `warn` | `info`), uma
**evidência** (arquivo:serviço ou arquivo:linha) e uma **sugestão de correção**. Prefira regexes
conservadoras: um falso positivo no nível `block` é o pior resultado. Cubra a regra com testes
unitários em `packages/deploy/tests/` (um caso que a dispare, um que não a dispare e um caso de
borda) e valide o fluxo completo com `pnpm test:fase4`.

### Adicionar um pipeline de deploy

A detecção fica em `packages/deploy/src/detect.ts` e a execução em `packages/deploy/src/engine.ts`.
Um pipeline novo precisa: (1) ser detectável a partir dos arquivos do projeto, (2) construir e subir
os containers **na rede `paas-net`** e (3) passar pelos guardrails como qualquer outro deploy. Use
os exemplos em `examples/` como referência.

## Fluxo de pull request

1. Abra uma **issue** antes de uma mudança grande (ou comente em uma existente) para alinhar o
   desenho antes. Isso evita retrabalho.
2. Faça um fork do repositório e crie uma branch a partir de `dev` (por exemplo,
   `feat/minha-melhoria`).
3. Garanta que `pnpm build` e `pnpm typecheck` estejam limpos e que **`pnpm test` esteja verde**
   (mais `pnpm test:e2e`, se a mudança tocar fluxos de infraestrutura). Todo PR precisa incluir
   testes para a sua mudança.
4. Abra o PR e preencha o modelo: o que muda, por quê e como testar.
5. Responda à revisão. PRs pequenos e focados são aceitos muito mais rápido.

## Licença da sua contribuição

O TWS Panel é distribuído sob a licença [MIT](../../../LICENSE). Este projeto é open source e
continuará sendo.

Ao abrir um pull request, você declara que:

1. **A contribuição é sua**, ou você tem o direito de enviá-la. Se ela contém código de terceiros,
   você identifica a origem e a licença no próprio PR.
2. **Você concede à TWS** uma licença perpétua, mundial, irrevogável e isenta de royalties para
   usar, reproduzir, modificar, distribuir e **sublicenciar** a sua contribuição, inclusive sob
   termos diferentes dos atuais.
3. **Você mantém a autoria e o direito de usar a sua contribuição** como quiser, em qualquer outro
   lugar. Nada aqui tira nada de você.

> [!NOTE]
> **Por que isso existe, sem rodeios.** O item 2 permite que a TWS ofereça o painel sob outras
> condições no futuro, por exemplo uma edição gerenciada ou paga que financie o desenvolvimento.
> Sem essa permissão, qualquer mudança nesse sentido exigiria encontrar todas as pessoas que já
> contribuíram e obter o aceite de cada uma, e bastaria uma delas não ser encontrada para impedir
> a mudança.
>
> **O que isso NÃO significa:** o código já publicado sob a MIT continua MIT para sempre. Isso é
> irreversível pela natureza da licença, e ninguém pode tirar de você o que já está lá. Este
> repositório continua aberto e gratuito. Se você não concorda com o item 2, diga isso no PR: dá
> para conversar sobre outro arranjo, ou você pode simplesmente manter a sua contribuição em um
> fork.

Não há formulário para assinar: abrir o PR já conta como aceite.

## Reportando bugs e sugerindo funcionalidades

Use os formulários de issue no GitHub. Para **vulnerabilidades de segurança**, nunca abra uma issue
pública; siga o [SECURITY.md](SECURITY.md).
