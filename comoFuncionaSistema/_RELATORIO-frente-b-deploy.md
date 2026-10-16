# Relatório — Frente B: deploy, projetos e certificados

Data: 2026-10-16 · Branch: `fix/frente-b-deploy` (a partir de `origin/dev` 1aaf649) · Sem push.

Achados de `CODE_REVIEW.md` tratados: 9, 12, 10, 11, 7, 22 e o E2E da fase 4. Um commit por achado.
Em cada um, o teste novo foi rodado ANTES da correção e falhou pelo motivo do achado. Depois, com a
correção, passou.

## Por achado

### 9 — Excluir todas as variáveis não limpava o `.env` (`packages/deploy/src/project-dotenv.ts`)
- **Era:** com a lista vazia, `writeProjectDotenv` retornava sem mexer em nada. Como o clone fica entre
  um deploy e outro, o `.env` antigo continuava lá (ou o `paas.env`, quando o repositório versiona um
  `.env`), e o container subia com o segredo que o dono tinha acabado de apagar.
- **Reproduzido:** grava `API_KEY` e depois `{}`. O `.env` continuava existindo, e o `paas.env` também
  (no caso do `.env` versionado). Além disso, um `paas.env` antigo continuava valendo quando o `.env`
  deixava de ser versionado.
- **Mudou:** o estado vazio também é gravado. O `.env` só é apagado quando a primeira linha é o
  cabeçalho "Gerado pelo painel": o `.env` do dono, sem esse cabeçalho, fica intacto. O `paas.env`
  some, e com isso o `--env-file` deixa de ser passado ao compose.
- **Testes:** `packages/deploy/tests/project-dotenv.test.ts`, com 4 casos novos. Testado de verdade em
  disco e com git real; sem Docker.

### 12 — Health check aprovava backend fora do ar (`packages/deploy/src/health-check.ts`, novo)
- **Era:** a fase HTTP aceitava qualquer resposta de 200 a 399. Em produção, o Caddy responde 308
  (HTTP→HTTPS) sem consultar o app, então essa fase passava sempre. Na fase HTTPS, um 502 ou 503 do
  backend virava só o aviso "certificado ainda não ficou pronto", e o deploy terminava como concluído.
- **Reproduzido:** com as sondas simuladas (redirecionamento do Caddy seguido de 502 pelo HTTPS), o
  deploy passava e o log mostrava o aviso de certificado.
- **Mudou:** o health check saiu do `engine.ts`, que depende do Docker e fica fora da cobertura. A
  decisão "o deploy passou?" agora é testada sem Docker.
  - O redirecionamento para o HTTPS do mesmo host não confirma mais o app: a confirmação fica para a
    fase HTTPS.
  - Na fase HTTPS:
    - 2xx/3xx aprova;
    - erro de TLS continua sendo só um aviso, porque o DNS pode estar propagando. Quando o HTTP só
      redirecionou, o aviso diz que o app não pôde ser confirmado;
    - **5xx com certificado válido até o fim do prazo faz o deploy falhar**, com a causa certa;
    - 4xx na raiz conta como o app respondendo: gera um aviso, sem falhar.
- **Testes:** `packages/deploy/tests/health-check.test.ts`. As regras são testadas com sondas e relógio
  simulados. As sondas HTTP/HTTPS de verdade são testadas contra servidores locais (o HTTPS com
  certificado do openssl). O Caddy real não foi testado.

### 10 — Dois deploys do mesmo projeto juntos (`apps/server/src/services/deploy-service.ts`)
- **Era:** a guarda olhava só os jobs, e o job só era registrado depois de vários `await` (detecção,
  variáveis, guardrails, auditoria).
- **Reproduzido:** com a auditoria lenta, dois `startDeploy` em paralelo eram aceitos e o engine rodava
  2 vezes. O mesmo acontecia com deploy + reinício e com reinício + reinício.
- **Mudou:** `reserveProject` reserva o projeto sem nenhum `await` entre conferir e marcar. A reserva
  vale até o job existir e é liberada no `finally`, e vale tanto para `startDeploy` quanto para
  `startRecreate`. **Decisão:** o segundo pedido é recusado na hora (409 `deploy_in_progress`, com a
  mensagem de sempre), sem fila de espera. A tela já trata esse 409, e o restore "VPS nova" falha
  mostrando a mensagem. Quando um pedido é recusado antes de virar job (tipo desconhecido, variável
  faltando, guardrail, sem deploy anterior), o projeto é liberado.
- **Testes:** `apps/server/tests/deploy-concurrency.test.ts`, com 7 casos. O serviço é real e o engine
  é simulado.

### 11 — PATCH recusado alterava o projeto (`deploy-service.ts`, `updateProject`)
- **Era:** nome, fonte e branch eram gravados no objeto compartilhado antes de o domínio e o serviço de
  entrada serem validados.
- **Reproduzido:** um PATCH com nome, fonte e branch novos e um domínio já em uso era recusado, mas a
  memória ficava alterada. O PATCH válido seguinte gravava essa mudança no disco. O mesmo acontecia
  com um serviço de entrada inválido.
- **Mudou:** as mudanças são montadas à parte, todas as validações rodam primeiro, e só então elas são
  aplicadas ao projeto, de uma vez.
- **Testes:** `apps/server/tests/deploy-validation.test.ts`, com 3 casos novos. O teste relê o projeto
  do disco com uma instância nova do serviço.

### 7 — Domínios distintos com os mesmos arquivos de certificado
- **Era:** a regra do id trocava qualquer sequência que não fosse letra ou número por hífen. Por isso
  `a-b.exemplo.com` e `a.b-exemplo.com` usavam o mesmo `.crt/.key` no painel e no Caddy, e
  `mail.foo-bar.com` e `mail.foo.bar.com` usavam a mesma seção `[certificate.*]` no Stalwart.
- **Reproduzido:** foram 4 testes, todos falhando:
  - núcleo: ids iguais;
  - Caddy: mesmos caminhos;
  - Stalwart: seção repetida;
  - painel: o segundo certificado sobrescrevia o primeiro, e remover um apagava o par do outro.
- **Mudou:** uma regra única no `@paas/core` (`certificateFileId`) serve aos três lugares. O ponto vira
  hífen e o hífen vira hífen duplo, o que não gera colisão para hostnames válidos. Nomes sem hífen
  mantêm o id antigo, então não há nada a migrar para eles. O Caddy e o Stalwart regravam tudo a cada
  sincronização.
- **Migração no painel:** um par gravado com o nome antigo é migrado na primeira leitura, dentro da
  fila de escrita, **só se a impressão digital bater com a do índice**. Numa colisão antiga, o arquivo
  ficou com o último domínio instalado. Só esse domínio herda o arquivo; o outro fica sem par e aparece
  para reenviar, em vez de servir o certificado errado. Ao remover um certificado, o par antigo também
  é apagado se for daquele host.
- **Pendente:** arquivos com o nome antigo dentro do container do Caddy e do Stalwart ficam lá como
  sobra. Isso não causa nada, mas também não são apagados.
- **Testes:**
  - `packages/core/tests/certificate-file-id.test.ts`;
  - `apps/server/tests/certificate-store-ids.test.ts` (certificados reais do openssl, em disco);
  - `packages/deploy/tests/caddy-manual-tls.test.ts`;
  - `packages/mailer/tests/server-manager.test.ts`.

  O Caddy e o Stalwart reais não foram testados.

### 22 — Janela de restauração do painel "em andamento" para sempre (`apps/web/src/components/backups/backup-ui.tsx`)
- **Era:** em qualquer erro, o polling recolocava o mesmo registro e tentava de novo a cada 2 s, sem
  fim. Isso valia para sem conexão no reinício, 401 da sessão que deixou de valer e 404 do registro que
  sumiu junto com o histórico do backup.
- **Reproduzido:** com intervalo curto, os testes ficaram presos no laço de consultas: a janela nunca
  chegava a um desfecho.
- **Mudou:** na restauração do painel, o aviso "vai reiniciar" não encerra mais o acompanhamento. A
  janela passa por estas situações:
  - fora do ar: mostra "O painel está reiniciando…";
  - 401 ou 404: mostra "O painel reiniciou com o estado do backup. Entre de novo…" e para de consultar;
  - volta com a sessão ainda valendo: lê o histórico e mostra se a troca na subida terminou ou foi
    desfeita (com o motivo); sem registro da subida, mostra "O painel voltou. Confira…";
  - mais de 5 minutos fora do ar: para e manda conferir os logs do container.

  "Recarregar a página" aparece em todos os desfechos. Nas outras restaurações, 30 erros seguidos
  encerram a consulta com um aviso.
- **Testes:** `apps/web/tests/panel-restore-dialog.test.tsx`, com 11 casos, em jsdom com API simulada.
  O reinício real do painel não foi testado.

### E2E da fase 4 (`scripts/test-fase4.mts`, `scripts/test-mail.mts`)
- **Era:** a fixture era criada em `/tmp` e cadastrada como projeto `existing`. A API recusava
  (`source_outside_projects_dir`, regra intencional), e a cadeia `test:e2e` parava antes do
  `test:mail`. O `test:mail` tinha o mesmo problema: cadastrava `examples/compose-app`, que fica fora
  da pasta de projetos.
- **Reproduzido:** `pnpm test:fase4` real falhou no passo 1 com 400 `source_outside_projects_dir`.
- **Mudou:** os dois scripts sobem o servidor com `PAAS_PROJECTS_DIR` apontando para uma pasta
  temporária e criam a fixture dentro dela. O e-mail copia o exemplo para lá. Com isso a fase 4 chegou
  a dois passos que tinham ficado para trás, e eles foram alinhados às regras atuais:
  - o resolver "limpo" da blacklist agora responde ao ponto de teste da lista;
  - o agendador usa o piso de 60 s do monitor.
- **Testado de verdade (Docker local):**
  - `pnpm test:fase4`: **17/17 verificações**;
  - `pnpm test:mail`: passos 0 a 5 passaram, inclusive SMTP e IMAP reais e o bloqueio por guardrail.
    O deploy do passo 6 falhou por limite do Docker desta máquina ("all predefined address pools have
    been fully subnetted": as redes do Docker se esgotaram), não por causa do código. Não apaguei
    redes de terceiros para liberar espaço.

## Verificação final

- `pnpm -r --workspace-concurrency=1 --no-bail run test:coverage`: tudo passou, dentro dos mínimos
  de cobertura.

  | Pacote | Testes | Ramos |
  |---|---|---|
  | `core` | 93 | 98,61% |
  | `web` | 728 | 85,63% |
  | `deploy` | 454 | 96,36% (mínimo 95%) |
  | `mailer` | 343 | 99,4% |
  | `security` | 191 | 97,33% |
  | `server` | 1.719 (2 pulados) | 93,44% |

- `pnpm -r run typecheck`: sem erros.
- Nenhum teste unitário depende do Docker local. Os E2E estão descritos acima.

## Documentação atualizada

- `projetos/deploy.json` (achados 9, 10 e 12)
- `projetos/atualizar.json` (achado 11)
- `fuso/reiniciar.json` (achado 10)
- `certificados/manual.json` e `certificados/index.json` (achado 7)
- `backups/restaurar.json` (achado 22)
- `global/testes.json` (E2E)
