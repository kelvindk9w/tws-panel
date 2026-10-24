---
title: "Publicar um projeto Next.js"
description: "Os três caminhos para colocar um site Next.js no ar (estático, servidor automático, Dockerfile ou compose seu), quando usar cada um, como o painel constrói a imagem, variáveis NEXT_PUBLIC_, memória do build e limpeza."
sidebar:
  label: "Next.js"
---

O Next.js pode virar um site de arquivos prontos ou um servidor Node que roda o tempo todo (páginas
renderizadas no servidor, rotas de API, middleware, ISR, otimização de imagens). O painel publica os dois,
e ainda deixa você assumir o controle com um Dockerfile seu. Esta página mostra os **três caminhos**, quando
usar cada um e o que o painel faz em cada um.

> Se você usa um compose ou um Dockerfile seu, veja também as [regras do compose](compose-rules.md).

---

## Os três caminhos

O painel olha o repositório nesta ordem e **para no primeiro que casa**:

| Prioridade | O que ele encontra | Caminho | Tipo na tela |
|---|---|---|---|
| 1 | Um arquivo `compose.yml` / `docker-compose.yml` (ou variantes `.prod`) | Seu compose é adotado | compose adotado |
| 2 | Um `Dockerfile` na raiz | Seu Dockerfile é usado | dockerfile |
| 3 | `next` nas dependências e `output: "export"` no `next.config` | Site estático (pasta `out/`) | estático (Node) |
| 4 | `next` nas dependências, **sem** `output: "export"` | Servidor automático | **Next.js (servidor)** |

### 1. Site estático (`output: "export"`)

Use quando o site **não precisa de servidor**: páginas que podem ser geradas no build, sem rotas de API,
sem middleware, sem `next/image` otimizado em tempo real, sem ISR. O `next build` gera a pasta `out/` e o painel
a serve com um servidor web simples.

- É o mais leve e o mais barato: não há processo Node rodando.
- Variáveis de ambiente **não existem** em tempo de execução (não há servidor para lê-las). As `NEXT_PUBLIC_*`
  valem só se estiverem no código ou no build.
- O painel lê o `next.config.js`, `.mjs`, `.cjs`, `.ts` ou `.mts` **como texto** (nunca executa o arquivo)
  e procura `output: "export"` escrito direto. Se o valor vier de uma expressão (`process.env.X ? "export" : …`),
  o painel não sabe qual é o resultado e trata o projeto como servidor: escreva o valor direto no arquivo.

### 2. Servidor automático (o caminho novo)

Use quando o projeto **usa o servidor do Next.js** e você não quer escrever Dockerfile. É o caso de quase todo
projeto criado com `create-next-app` que usa rotas de API, `middleware.ts`, Server Actions, páginas dinâmicas,
`revalidate` (ISR) ou `next/image`.

O painel:

1. gera o Dockerfile **fora do seu repositório** (nada é gravado no seu código; ele fica na pasta de trabalho do
   painel e é refeito a cada deploy);
2. constrói a imagem (multi-stage) com a instalação **congelada pelo lockfile** e roda o `next build`;
3. sobe um container com a imagem final mínima, como **usuário comum** (não root), sem capabilities e **sem
   publicar porta no servidor**: o acesso é só pelo domínio, pelo Caddy, com HTTPS;
4. confere se o site respondeu (health check) como nos outros tipos.

O que ele detecta sozinho:

| Detecção | De onde vem |
|---|---|
| Gerenciador de pacotes | campo `packageManager` do `package.json`, depois o lockfile (`pnpm-lock.yaml`, `yarn.lock`, `package-lock.json`), senão npm |
| Versão do Node | `engines.node` do `package.json`, depois `.nvmrc`, depois `.node-version`; sem nada, **Node 22 (LTS)**. O painel oferece **20, 22 e 24**; outra versão volta ao 22 e avisa no log |
| Modo standalone | `output: "standalone"` escrito direto no `next.config` |
| Porta | 3000 por padrão; dá para trocar no assistente |

**Standalone ou `next start`?**

- Com `output: "standalone"` a imagem final leva só o necessário e roda `node server.js`. É a imagem **bem
  menor** (dezenas de MB em vez de centenas) e começa mais rápido. **Recomendado.**
- Sem standalone, o painel roda `next start` com o projeto construído dentro da imagem. Funciona, só é maior.
- Para ligar o standalone, acrescente ao `next.config`: `output: "standalone"`.

**Limites do servidor automático**

- O app precisa estar **na raiz do repositório** (o `package.json` com `next` na raiz). Monorepo com o app em
  `apps/web`: o painel avisa na detecção e você usa o caminho 3 (Dockerfile seu).
- Com `output: "standalone"` em monorepo (`outputFileTracingRoot`), o caminho do `server.js` muda: o build para
  com uma mensagem explicando. Use o caminho 3.
- Yarn Plug'n'Play (sem `node_modules`) não é suportado; use `nodeLinker: node-modules`.
- Sem lockfile no repositório, a instalação **não é reprodutível** (cada deploy pode trazer versões novas): o
  painel avisa. Commite o lockfile.
- O build não tem acesso à rede interna do projeto (por exemplo, ao banco no mesmo compose). Páginas geradas no
  build que leem banco precisam de um banco alcançável de fora ou devem ser geradas em tempo de execução.
- O `.git` não entra no build (se o seu `next.config` roda `git rev-parse` para o `generateBuildId`, defina o
  id de outro jeito).

### 3. Dockerfile ou compose seu

Use quando você **precisa de controle**: monorepo, pacotes do sistema (`apk add`), banco no mesmo compose,
outro runtime, build em etapas diferentes. Coloque um `Dockerfile` (ou `compose.yml`) na raiz: ele **tem
prioridade** sobre o servidor automático, e o painel o usa como está.

Isso inclui o caso comum de quem já tinha um Dockerfile do Next.js no repositório: nada muda para esse projeto.

### Como escolher

| Situação | Caminho |
|---|---|
| Site de conteúdo, sem API nem middleware, que pode ser pré-gerado | 1. Estático |
| App com rotas de API, middleware, Server Actions, ISR ou imagens, repositório de um app só | 2. Servidor automático |
| Monorepo, banco no mesmo compose, dependências do sistema, imagem própria | 3. Dockerfile/compose seu |

Dúvida entre 1 e 2? Se o `next build` já gera tudo que você precisa em `out/` com `output: "export"`, fique no 1:
é mais barato e mais simples de operar.

---

## Variáveis de ambiente

Na seção **Variáveis** do projeto:

- **Em tempo de execução** (o servidor rodando), **todas** as variáveis do painel valem, como em qualquer projeto.
- **`NEXT_PUBLIC_*` precisam existir no build.** O Next.js troca `process.env.NEXT_PUBLIC_X` pelo valor **dentro
  do JavaScript que vai para o navegador**. Por isso o painel passa as `NEXT_PUBLIC_*` ao build. **Elas são públicas
  por definição:** qualquer visitante lê o valor no código do site. **Nunca coloque segredo numa `NEXT_PUBLIC_*`.**
- Mudou uma `NEXT_PUBLIC_*`? **Faça um novo deploy**: reiniciar o container não basta, porque o valor está dentro
  do build.
- **As demais variáveis** (senhas, chaves, `DATABASE_URL`) também ficam disponíveis ao `next build`, caso uma página
  gerada no build precise delas. O painel as entrega por um **segredo do BuildKit**, montado só durante o passo do
  `next build`: elas **não entram em nenhuma camada da imagem** nem aparecem no `docker history`. O log do deploy
  lista só os **nomes**, nunca os valores.
- Não entram no build (e valem só na execução): `PORT`, `HOSTNAME`, `NODE_ENV`, `NODE_OPTIONS`, `PATH`, `HOME`,
  `LD_*`, `npm_*` e nomes que não são identificadores válidos de shell; também valores com mais de 32 KB.
- `PORT` nas Variáveis é **ignorada**: o servidor escuta na porta do projeto (3000 por padrão) e o painel entrega
  essa porta ao Next.js. Para mudar, use o campo de porta do projeto.
- O painel sempre define `HOSTNAME=0.0.0.0`, `NODE_ENV=production` e desliga a telemetria do Next.js.

> [!CAUTION]
> Um segredo só no servidor (como `STRIPE_SECRET_KEY`) **nunca** deve começar com `NEXT_PUBLIC_`. Se começar, ele
> vai para o JavaScript do site.

---

## Memória e tempo do build

O `next build` é o passo mais pesado de um deploy. Em uma VPS pequena ele pode estourar a memória.

- O painel limita o heap do Node no build com `--max-old-space-size` igual a **60% da RAM do servidor**, com
  mínimo de 768 MB e máximo de 4096 MB (1 GB de RAM → 768 MB; 2 GB → 1229 MB; 4 GB → 2458 MB; 8 GB ou mais → 4096 MB).
  O valor aparece no log do deploy.
- Se o build morrer por falta de memória, o log termina com **"O build ficou sem memória"** e o que fazer.
  O que costuma resolver, nesta ordem:
  1. **Criar um arquivo de swap** na VPS (2 GB já ajudam muito). Em Ubuntu: `sudo fallocate -l 2G /swapfile`,
     `sudo chmod 600 /swapfile`, `sudo mkswap /swapfile`, `sudo swapon /swapfile`, e a linha
     `/swapfile none swap sw 0 0` em `/etc/fstab` para sobreviver ao reinício.
  2. Parar outros containers pesados durante o deploy.
  3. Usar uma VPS com mais RAM.
  4. No Next.js 15 ou mais novo, ligar `experimental.webpackMemoryOptimizations` no `next.config` para baixar o pico.
- O site que já estava no ar **continua no ar** durante o build: o container antigo só é trocado depois que a
  imagem nova ficou pronta.
- Um deploy sem mudança nas dependências costuma ser bem mais rápido: o painel guarda o cache de instalação do
  gerenciador de pacotes **por projeto** (nunca compartilhado entre projetos).

### Se o deploy falhar por causa do lockfile

A instalação é congelada: se o `package.json` e o lockfile não combinam, o log explica. Rode `pnpm install`
(ou `npm install` / `yarn install`) no seu computador, commite o lockfile atualizado e faça o deploy de novo.

---

## Disco: cache e imagens

O cache de dependências e as camadas do build ficam no BuildKit do Docker e crescem com o uso.

- **Automático:** depois de cada build bem-sucedido o painel remove a **imagem anterior do projeto** e o cache de
  build com **mais de 7 dias**.
- **Manual**, quando precisar de espaço (na VPS):
  ```bash
  docker system df
  docker builder prune --filter until=24h
  docker image prune
  ```
  Limpar o cache só deixa o próximo build mais lento; nada que está no ar é afetado.

---

## Segurança

O servidor automático segue as mesmas regras dos outros tipos:

- As travas de segurança do deploy rodam sobre o seu código antes do build.
- O container roda como `node` (não root), com `cap_drop ALL` e `no-new-privileges`, **sem pastas do servidor
  montadas** e sem porta publicada: só a rede interna do painel e o Caddy.
- A imagem base é a oficial `node:<versão>-alpine`, **fixada por digest**.
- O Dockerfile gerado não vai para o seu repositório e o segredo do build é um arquivo temporário (`0600`) apagado
  logo depois do build.
- O build roda o **seu código** (scripts de instalação, `next.config`), como qualquer build Docker: só publique
  repositórios em que você confia.

---

## Quando algo dá errado

| Sintoma | O que fazer |
|---|---|
| "O build ficou sem memória" | Crie swap, libere memória ou use mais RAM (veja acima) |
| "O lockfile não bate com o package.json" | Atualize e commite o lockfile |
| "pede output standalone, mas o build não gerou .next/standalone/server.js" | Monorepo ou `output` vindo de expressão: escreva o valor direto ou use um Dockerfile seu |
| O site abre com a página de erro 502 logo após o deploy | O servidor demora a subir: confira a aba **Logs** do projeto |
| Mudei uma `NEXT_PUBLIC_` e o site mostra o valor antigo | Faça um novo deploy (reiniciar não basta) |
| O tipo aparece como "dockerfile" mas você queria o automático | Há um `Dockerfile` na raiz: remova-o (ou renomeie) e rode a detecção de novo |
