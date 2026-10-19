# Relatório — Lote 6: defeitos que apagam ou perdem dados do usuário

Data: 2026-10-19 · Branch: `fix/lote6-perda-de-dados` (a partir de `origin/dev`, que já tem o lote 5) · Sem push, sem PR.

Achados tratados: A5, A6, M4, M5, M6, M7. Um commit por achado (mais um complemento do M7).

Método: para cada achado, primeiro um teste que falha pelo motivo certo no código anterior, depois a correção
mínima. A reprodução foi conferida contra o código antigo (guardando as mudanças de `src` com `git stash`).

## Aviso sobre o insumo

O arquivo `RELATORIO-AUDITORIA.md` (e as provas em `logica/`) citado no pedido **não existe** no caminho indicado
(`.../scratchpad/auditoria/`); a pasta não foi encontrada em nenhum lugar do disco. Os seis achados foram
tratados a partir da descrição do pedido e do código. **A seção BAIXO/INFORMATIVO da auditoria não foi lida**, então
nenhum item dela foi triado neste lote. Itens parecidos que vi no código e deixei de fora estão em "Fora do lote".

## M6 — erro passageiro de leitura gerava chave nova

- **Era:** `credential-vault`, chave dos backups, das notificações e `session-secret` trocavam qualquer erro de
  leitura por uma chave nova gravada por cima; o que estava cifrado com a antiga ficava ilegível para sempre.
  O segredo de sessão aceitava 32+ caracteres não-hexa (`Buffer.from(...,"hex")` virava chave vazia, e o HMAC
  seguia assinando com ela).
- **Teste que reproduziu:** `apps/server/tests/chaves-falha-fechada.test.ts` (leitura da chave falha com EIO em
  cada um dos quatro; 5 de 5 falhavam no código antigo, o caso não-hexa mostra a assinatura de chave vazia).
- **Mudou:** os quatro usam `loadOrCreateKey` (`json-file.ts`). Só "não existe" cria chave; qualquer outro erro
  falha a carga e o arquivo fica como estava; a MESMA chave volta a valer quando o disco volta. Conteúdo que não é
  hexa do tamanho certo é guardado em `<arquivo>.corrompido-<data>` (antes era apagado) e uma chave nova é criada.
  A leitura é estrita (64 caracteres hexa exatos para 32 bytes).
- **Risco de migração:** um `session-secret` antigo com 32 a 63 caracteres hexa (antes aceito) passa a ser
  substituído: todos saem da sessão uma vez. Instalações normais têm 64 caracteres e não são afetadas.

## M7 — arquivo de dados ilegível virava lista vazia e era gravado por cima

- **Era:** ~15 stores faziam `try { JSON.parse(readFile) } catch { vazio }`. Pior caso: `projects.json` — o boot
  recalculava o Caddyfile sem nenhum projeto. Também `users.json` (sem admin reabre o assistente) e `mail.json` (nova
  senha de admin do Stalwart).
- **Teste que reproduziu:** `apps/server/tests/stores-falha-fechada.test.ts` (12 de 12 falhavam; erro EIO injetado
  na leitura, e arquivos com JSON quebrado), mais `json-file.test.ts` (bloco `loadJson`).
- **Mudou:** novos `loadJson`/`loadJsonInLock` em `json-file.ts`: arquivo inexistente = vazio; erro de disco é
  lançado sem tocar no arquivo; JSON inválido ou formato desconhecido vai para `.corrompido-<data>` (nome nunca
  sobrescreve outro guardado no mesmo instante) ou, em `strict`, a carga falha com mensagem clara. Aplicado em:
  contas (estrito), sessões, alertas, cofre, backups (config e histórico), notificações (config e histórico), e-mail
  (`mail.json`, estrito), reputação, envios, domínio do painel, certificados manuais, webmail, assistente de
  instalação, monitor, histórico de segurança (na gravação), e `DeployService` (`projects.json` estrito;
  `deploy-jobs.json` à parte). Em todos, a carga que falhou é descartada e a chamada seguinte tenta de novo.
  O boot (`ensurePanelRoute`) não recalcula o Caddyfile sem projetos: o teste confere que `syncCaddy` não é chamado
  com erro de leitura e que, voltando o disco, é chamado com os projetos de verdade.
- **Testes antigos ajustados:** os que simulavam "falha de gravação" trocando o arquivo por uma pasta antes da
  carga passaram a carregar antes (o que falha neles é a gravação). O teste de `users.json` corrompido mudou de
  "store vazio" para "carga falha e arquivo intacto".
- **Risco de migração:** um `users.json`/`projects.json`/`mail.json` realmente corrompido agora para o painel com
  erro claro em vez de seguir vazio (é de propósito: seguir vazio apagava o arquivo). Arquivo bom não muda.
  Falha de leitura no boot (`sessionStore.init`, `panelDomain.init`) derruba a subida: o Docker reinicia o painel.

## M4 — disco cheio durante o dump derrubava o painel

- **Era:** `DockerCli.run` (`backup-docker.ts`) não ouvia `error` do stream de gravação do dump nem do de leitura
  do arquivo da restauração; ENOSPC virava exceção sem tratamento.
- **Teste que reproduziu:** `apps/server/tests/backup-docker-erros.test.ts` — docker de mentira no `PATH` e o
  `/dev/full` real do Linux (estoura o prazo e gera erro não tratado no código antigo).
- **Mudou:** ouvintes de erro nos dois streams; o filho do docker é encerrado e a promessa do comando rejeita com
  "o disco do servidor ficou sem espaço ao gravar o backup…" (ou a causa do erro). O backup falha com aviso normal.

## M5 — a retenção podia apagar o backup recém-criado

- **Era:** a retenção ordenava pelo NOME (hora local, minuto) como texto: com fuso trocado, ou dois backups no
  mesmo minuto (`...-2.7z` ordena antes de `....7z`), o novo virava "o mais velho" e era apagado (VPS e externo).
- **Teste que reproduziu:** `apps/server/tests/backup-service.test.ts`, bloco "retenção nunca apaga o backup
  recém-criado" (dois backups no mesmo minuto; mudança de `TZ` entre dois backups) — o novo era apagado.
- **Mudou:** cada cópia guarda `createdAt` (UTC) em `backups.json`; `orderBackups` ordena por essa data (senão a
  data do arquivo na VPS / do objeto no externo, senão a do nome; empate pelo número do sufixo); o arquivo
  recém-criado nunca é candidato (`retentionVictims(..., protect)`), na VPS nem fora. Cópias antigas sem
  `createdAt` usam a data do arquivo (testado com `utimes`).
- **Risco:** cópias externas antigas sem data registrada dependem de `lastModified` do S3/R2 (se vier nulo, vale a
  data do nome). A tela "Pontos de restauração" ainda ordena pelo nome (só apresentação, não apaga nada).

## A6 — o `.env` do dono era sobrescrito sem cópia

- **Era:** `writeProjectDotenv` regravava `src/.env` sempre que ele não era versionado.
- **Teste que reproduziu:** `packages/deploy/tests/project-dotenv.test.ts` (`.env` do dono sem cabeçalho; com todas
  as variáveis excluídas; dono que apaga o arquivo) — 2 de 3 falhavam.
- **Mudou:** só se regrava o `.env` que não existe, é link (trocado, nunca seguido) ou começa com o cabeçalho do
  painel. `.env` comum do dono fica intacto, as variáveis vão para `<projeto>/paas.env` (que entra no
  `paas.up.env` por último) e o log do deploy traz o aviso de conflito e como fazer o container receber as
  variáveis. O único gravador em `src/.env` é `writeProjectDotenv`; `paas.up.env` e `paas.canonical.json` ficam
  fora do `src`.
- **Limite:** o aviso aparece no log do deploy (tela do deploy), não há banner permanente na página do projeto.
  `env_file: .env` lê só o arquivo do dono (sem as variáveis do painel), como já era com o `.env` versionado.
- **Projetos que já tiveram o `.env` sobrescrito:** o conteúdo anterior não existe mais; não há o que recuperar.

## A5 — pasta de trabalho coincidia com pasta do usuário

- **Era:** `<pasta de projetos>/<slug>`; removendo com "apagar código-fonte", o `rm -rf` apagava a pasta do outro
  projeto/usuário que tivesse esse nome; o upload apagava `slug/src` e copiava sobre si mesmo.
- **Teste que reproduziu:** `apps/server/tests/deploy-area-reservada.test.ts` (6 de 8 falhavam; nos de remoção, o
  arquivo do usuário sumia) e `packages/deploy/tests/workdir-reservado.test.ts` (upload com origem = pasta de
  trabalho: erro de cópia sobre si mesma depois de apagar `src`).
- **Mudou:**
  - Projeto novo guarda tudo em `<pasta de projetos>/.paas/<id>` (`Project.storageLayout = "reserved"`; o id é
    gerado, o nome começa com ponto e a navegação de pastas já esconde pasta com ponto).
  - Criação recusa slug que já existe como pasta (409 `slug_folder_exists`), exceto quando a pasta é a própria
    fonte do projeto de pasta existente/upload (nome igual ao da pasta é o caso comum). Fonte que seja a própria
    pasta de projetos ou a `.paas` é recusada (400 `source_reserved`, também no PATCH).
  - `workDirRemovalBlocker`: antes de `rm`, o alvo precisa estar estritamente dentro da pasta de projetos e não
    conter nem ficar dentro da fonte do projeto, da fonte de outro nem da pasta de trabalho de outro (links
    resolvidos com `realpath`). Se coincidir, nada é apagado e o log diz "Código-fonte NÃO removido: <motivo>".
  - `ingestUpload` recusa quando a origem coincide, contém ou está dentro da pasta de trabalho, ANTES de apagar `src`.
- **Migração (compatibilidade, nada é movido):** projetos existentes continuam em `<pasta de projetos>/<slug>`
  (campo `storageLayout` ausente). Mover um diretório com bind mounts relativos de produção, containers rodando e
  `--project-directory` seria o oposto de seguro; por isso não há migração automática. Idempotente por construção
  (não faz nada), reversível por construção. Quem quiser migrar um projeto à mão: parar, mover `<slug>` para
  `.paas/<id>`, pôr `"storageLayout": "reserved"` no registro em `projects.json`, redeploy (não testado).
- **Risco que permanece:** num projeto ANTIGO cujo slug já coincide com uma pasta do usuário, o deploy em modo git
  continua gravando `src`, `repo.git` e `paas.*` dentro dessa pasta (como antes); só a REMOÇÃO e a cópia de upload
  foram protegidas. Os testes cobrem o novo layout e o antigo (compatibilidade e bloqueio).

## Testado de verdade e o que não foi

- Testado de verdade (processo real, disco real): leitura com EIO injetado, `/dev/full` com um `docker` de
  mentira, `git`/`cp`/`rm` reais nas pastas temporárias, `TZ` real do processo mudando entre backups, `utimes`.
- **Não testado:** Docker/Compose real (nenhum deste lote exige: o `docker` do M4 é um script; o `.env` do A6 foi
  testado até o arquivo, não com `docker compose up`); VPS real; S3/R2 real (o armazenamento é dublê, incluindo
  `lastModified`); migração manual de projeto antigo para `.paas/<id>`; `deploy-service.ts`, `backup-docker.ts`
  e `docker-socket.ts` estão fora do escopo de cobertura do pacote (E2E), então o que mudei neles está coberto pelos
  testes acima, mas não pela métrica.
- Verificação: `pnpm -r run typecheck` limpo; `pnpm -r --workspace-concurrency=1 --no-bail run test:coverage`
  passou em todos os pacotes (server 1831 testes: 97,8/93,3/98,3/98,9; deploy 816 testes, 95,9% de ramos; mailer
  362 testes, 98,5% de ramos).

## Fora do lote (visto, não alterado)

- `security-service.restoreJobsFromDisk`, `loadSecurityHistory` (só leitura para tela) e `readSavedTimezone`
  (cache que é regravado pelo host bridge) ainda tratam erro de leitura como vazio; nenhum deles regrava o arquivo
  a partir do valor vazio.
- A seção BAIXO/INFORMATIVO da auditoria (não encontrada, ver acima).

## Roteiro curto para o Kelvin validar na VPS

1. Atualize o painel (`cd /opt/tws-panel && git pull && docker compose up -d --build`) e confira que sobe e que os
   projetos, backups e domínio aparecem como antes.
2. A5, projeto novo: crie um projeto git; no host, `ls -a /opt/tws-projects` deve mostrar `.paas/<id>` com `src`
   e `repo.git` dentro, e nenhuma pasta nova com o nome do slug. Crie uma pasta `mkdir /opt/tws-projects/teste` e
   tente criar um projeto "Teste" em modo git: o painel deve recusar com "Já existe uma pasta".
3. A5, remoção: remova o projeto novo marcando "Apagar o código-fonte": `.paas/<id>` some e as demais pastas ficam.
   Com um projeto ANTIGO, remova com a caixa marcada: a pasta `<slug>` some (se não coincidir com nada).
4. A6: num projeto com `.env` próprio (sem versionar), salve variáveis no painel e faça o deploy: o `.env` do
   projeto fica com o conteúdo original (`cat /opt/tws-projects/.../.env`), e o log do deploy mostra o aviso.
5. M5: faça dois backups manuais do mesmo projeto no mesmo minuto com "guardar 1 cópia na VPS": o arquivo que fica
   é o `-2` (o novo). Troque o fuso em Configurações e faça outro backup: o novo permanece.
6. M7/M6: (opcional, num ambiente de teste) `chmod 000 /var/lib/docker/volumes/<volume>/_data/users.json` e
   reinicie: o painel deve recusar subir com erro de leitura, sem reabrir o assistente; devolva a permissão.
7. M4: não há como simular disco cheio com segurança na produção; confie nos testes (`/dev/full`).
