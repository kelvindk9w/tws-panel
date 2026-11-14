# Testes e Docker

**A suíte de testes não toca o Docker real da máquina de quem roda. Integração com Docker só com `PAAS_TEST_REAL_DOCKER=1`.**

Quem roda a suíte (uma pessoa ou um agente) pode ter na máquina containers, redes e imagens de projetos de verdade.
Um teste que criasse a `paas-net`, removesse um `paas-<slug>-app-next` ou apagasse a imagem `paas-<slug>:latest`
mexeria em dados reais. Por isso a regra vale para todos os pacotes, sem exceção.

## Como a regra é garantida

### 1. Barreira (todos os pacotes)

`scripts/testes/barreira-docker.ts` é o primeiro `setupFiles` de todo `vitest.config.ts` (o teste
`apps/server/tests/barreira-docker.test.ts` confere isso). Sem `PAAS_TEST_REAL_DOCKER=1`, antes de qualquer teste:

- um `docker` (e um `docker-compose`) falso vai para a frente do `PATH`. Ele não fala com daemon nenhum: registra a
  chamada e sai com erro, dizendo `teste tentou usar o Docker real: <argumentos>`;
- `DOCKER_HOST` aponta para um socket que não existe, e `DOCKER_CONTEXT` sai do ambiente;
- a conexão com o socket do daemon (`/var/run/docker.sock`, `/run/docker.sock`, o do `DOCKER_HOST` original, o
  rootless e o do Docker Desktop) falha pelo evento de erro, com a mesma mensagem. Um socket de dublê que o próprio
  teste cria na pasta temporária (ex.: `tmp/docker.sock`) continua funcionando.

O registro vai para o arquivo de `PAAS_TEST_DOCKER_LOG` (se não for definido, um arquivo temporário). Cada linha diz o
comando e o teste que o pediu (`docker ps -a	# arquivo.test.ts > nome do teste`). Para conferir que a suíte inteira
não chamou o Docker:

```bash
export PAAS_TEST_DOCKER_LOG="$(mktemp)"
pnpm -r --workspace-concurrency=1 --no-bail run test:coverage
wc -l < "$PAAS_TEST_DOCKER_LOG"   # tem de dar 0
```

A barreira é a rede de proteção, não o jeito normal de testar: um teste que cai nela está errado e deve ganhar um
dublê ou virar integração (abaixo).

### 2. Dublês (o jeito normal)

- **Servidor (`apps/server`)**: `tests/setup-no-docker.ts` troca o `node:child_process` de todos os arquivos pelo de
  `tests/helpers/docker-duble.ts`. Comando `docker` não cria processo: o dublê anota (`dockerDuble.chamadas`, com o
  `DOCKER_HOST` em `dockerDuble.hosts`) e responde como uma máquina sem Docker (código 1, daemon fora do ar). Isso
  cobre o painel inteiro (buildApp, DeployService, o motor e o Caddy do `@paas/deploy`, o `@paas/mailer`, o backup).
  Teste que precisa de outra resposta troca `dockerDuble.responder`; o setup volta ao padrão antes de cada teste.
  Programas que não são o docker (git, sh…) rodam de verdade, e o docker falso que um teste põe no próprio `PATH` (na
  pasta temporária) continua sendo dele.
- **Pacotes (`packages/*`)**: o padrão é o `vi.mock("../src/exec.js")` com um `run`/`runStream` que anota e responde,
  como nos testes do motor, ou injetar o executor (ex.: `loadCanonicalCompose(args, executor)`).

### 3. Integração com Docker real

Teste que só faz sentido contra o Docker de verdade fica num arquivo `*.docker-real.test.ts` e é pulado sem a
variável (ele não chama nem `docker info` para decidir). No servidor, o arquivo chama `usarDockerReal()` de
`tests/helpers/docker-duble.ts` para o dublê sair do caminho quando a variável está ligada.

| Arquivo | O que prova contra o Docker real |
| --- | --- |
| `apps/server/tests/docker-service.docker-real.test.ts` | a lista de containers pelo socket padrão e pelo informado |
| `apps/server/tests/restore-reconciliation.docker-real.test.ts` | o probe de um container: inexistente, parado, rodando, removido |
| `apps/server/tests/backup-restore-validate.docker-real.test.ts` | dump e restauração numa cópia descartável do Postgres |
| `apps/server/tests/terminal-service-pty.docker-real.test.ts` | o terminal com PTY de verdade (`docker exec` com Tty) |
| `packages/deploy/tests/compose-hostil.docker-real.test.ts` | compose hostis pelo `docker compose config` |
| `packages/deploy/tests/compose-override.docker-real.test.ts` | o `paas.override.yml` aceito pelo `docker compose config` |
| `packages/security/tests/phase*.docker-real.test.ts` | as fases do hardening num Ubuntu 24.04 em container |

O `packages/mailer/tests/stalwart-deliverability.integration.test.ts` pede, além disso, `STALWART_INTEGRATION=1` e as
imagens já baixadas; ele não roda no CI.

Para rodar a integração (só quando pedido, e sabendo que ela cria e remove containers e redes com nomes próprios do
teste):

```bash
pnpm test:docker-real    # cada pacote roda só os *.docker-real.test.ts, com PAAS_TEST_REAL_DOCKER=1
```

## No CI

O job `ci` roda a suíte com a barreira (`pnpm test:coverage`) e, num passo separado, `pnpm test:docker-real`. O CI
pode ligar a variável porque cada job do GitHub Actions roda numa máquina virtual nova
([About GitHub-hosted runners](https://docs.github.com/en/actions/concepts/runners/github-hosted-runners): "each
GitHub-hosted runner is a new virtual machine (VM) hosted by GitHub"), sem dado de ninguém, e a imagem
`ubuntu-latest` já traz Docker Engine e Compose
([Ubuntu 24.04 — software instalado](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md)).
Assim a integração continua rodando a cada PR, e a suíte comum continua provando que não depende do Docker.

## Ao escrever um teste novo

- Precisa que o painel "fale com o Docker"? Use o dublê e confira o que o painel pediu.
- Precisa mesmo do Docker de verdade? Arquivo `*.docker-real.test.ts`, `describe.skipIf(process.env.PAAS_TEST_REAL_DOCKER !== "1")`,
  nomes únicos para tudo o que criar e remoção no fim.
- Nunca sonde o Docker no topo do arquivo (`docker info`, `docker compose version`, `docker images`) sem antes olhar a
  variável: a sondagem já é uma chamada ao Docker da máquina.
