# Relatório — Lote 1: perda silenciosa de dados

Data: 2026-10-16 · Branch: `fix/lote1-perda-de-dados` (a partir de `origin/dev` 983851c) · Sem push.

Achados de `CODE_REVIEW.md` tratados: 15 (auditoria), 8 (variáveis), 5 (2FA), 2 (restauração do painel),
3 (7-Zip código 1), 14 (Redis SAVE), 13 (nomes colidindo). Todo teste de concorrência usa `Promise.all`
real em disco, numa pasta temporária, sem relógio simulado.

## Causa comum e helper

Nos stores de arquivo JSON, a leitura do estado atual acontecia FORA da fila que protegia a gravação
(ou não havia fila, ou a carga marcava "carregado" antes de ler). Duas alterações paralelas partiam
da mesma leitura e a última apagava a outra. Além disso, as gravações eram `writeFile` direto no
arquivo final: uma queda no meio deixa o JSON pela metade.

Helper novo: `apps/server/src/services/json-file.ts`

- fila por arquivo (caminho absoluto), comum a todas as instâncias do processo;
- gravação atômica (temporário `.tmp` + fsync + rename + fsync da pasta; o backup do painel já ignora `.tmp`);
- criação única de arquivo (chaves de cifra: nunca duas chaves);
- `JsonFile`: ler → alterar → gravar dentro da fila, sem cópia em memória; arquivo ilegível é guardado
  como `<arquivo>.corrompido-<data>` em vez de sobrescrito; erro de disco que não seja "não existe" é lançado.

Testes: `apps/server/tests/json-file.test.ts`.

## Por achado

### 15 — Auditoria (`audit-service.ts`)
- **Era:** carga com flag antes de ler e rotação (`audit.1.json`) lida/gravada fora da fila.
- **Reproduzido (falhou no código antigo):** 11 registros paralelos na subida → ficava 1; com 1.500
  entradas no disco, 2 registros paralelos → sobrava 1 (as 1.500 sumiam); rotação em paralelo → `audit.1.json`
  com JSON corrompido; `audit.1.json` ilegível era sobrescrito.
- **Mudou:** cada registro é uma transação na fila do `audit.json`, com a rotação dentro. Se arquivar falha,
  as antigas ficam no ativo (passa do teto, nada se perde); registro cuja gravação falhou entra na próxima.
- **Testes:** `apps/server/tests/audit-service.test.ts` (bloco "auditoria com registros em paralelo"); o teste
  antigo "falha ao gravar arquivo de rotação" passou a exigir que o evento antigo continue lá.

### 8 — Variáveis dos projetos (`project-env.ts`)
- **Era:** ler-alterar-gravar sem fila; chave `project-env-key` criada sem exclusão.
- **Reproduzido:** variáveis de 3 projetos gravadas em paralelo → perdia projetos; remover + salvar ao mesmo
  tempo → um apagava o outro; as 6 primeiras gravações em paralelo → duas chaves e erro "unable to authenticate
  data" ao ler; duas instâncias na mesma pasta; arquivo ilegível sobrescrito.
- **Mudou:** `JsonFile.update` e `loadOrCreateKey` (uma chave só, também entre processos).
- **Testes:** `apps/server/tests/project-env.test.ts`.

### 5 — Verificação em duas etapas (`two-factor.ts`, `user-store.ts`)
- **Era:** o código era conferido contra o usuário lido antes e consumido depois, fora da fila do `users.json`.
- **Reproduzido (relógio real):** o mesmo código TOTP aceito 3 vezes em paralelo; o mesmo código de recuperação
  aceito 2 vezes; consumir dois códigos diferentes juntos devolvia um à lista (sobravam 9 dos 10 em vez de 8);
  verificação aceita com o segredo antigo depois de desativar; duas chaves `two-factor-key`.
- **Mudou:** `UserStore.updateTwoFactor` decide e grava dentro da fila; se o 2FA mudou desde a leitura, recusa.
  Chave via `loadOrCreateKey`; `users.json` atômico.
- **Testes:** `apps/server/tests/two-factor-concorrencia.test.ts`.

### 2 — Restauração do painel (`panel-restore.ts`, `index.ts`, `backup-service.ts`, `scripts/restaurar-painel.sh`)
- **Era:** a troca (atual → `antes-da-restauracao`, backup → `/data`) era uma sequência de renames sem registro.
  Uma queda no meio deixava metade trocada; na subida seguinte a cópia `antes-da-restauracao` era apagada e o
  painel subia assim.
- **Reproduzido:** estado "legado" (marcador + troca pela metade, como a versão antiga deixava) → o código antigo
  perdia os dados de antes.
- **Mudou:** progresso em `data/backups/.restaurar-painel.progresso.json` (fases salvando → aplicando →
  concluindo; em falha, desfazendo-retirando → desfazendo-devolvendo). Cada fase só move o que falta, então é
  retomada depois de qualquer queda. Erro de disco desfaz e o painel sobe com o estado de antes, com motivo no
  histórico e na auditoria. Se nem desfazer der certo, o processo sai com erro (o Docker reinicia e continua) —
  nunca sobe com metade trocada. A cópia de segurança não é apagada; ao começar outra restauração, a anterior vira
  `antes-da-restauracao.anterior`. Histórico com id fixo (não duplica ao retomar). A restauração roda antes de ler
  o fuso. "Restaurar" do painel recusa com troca pela metade. O script `restaurar-painel.sh` confere o progresso
  antes de parar o painel e, depois, lê o histórico para avisar se a restauração foi desfeita.
- **Testes:** `apps/server/tests/panel-restore-interrupcao.test.ts` (queda simulada em cada etapa — promessa que
  nunca resolve — e retomada; erro em cada etapa → desfaz; queda durante o desfazer; falha dupla; `.anterior`;
  progresso ilegível; legado), `panel-restore.test.ts`, `backup-service.test.ts`, `restaurar-painel-script.test.ts`
  (inclui o conferidor JS real do script).

### 3 — 7-Zip código 1 (`backup-archive.ts`, `backup-service.ts`)
- **Era:** código 1 ("aviso") ao criar o `.7z` era aceito; o arquivo saía sem o que não foi lido, o teste do
  `.7z` passava, e o backup entrava como "Concluído" na retenção, que podia apagar a última cópia boa.
- **Reproduzido com 7-Zip real 24.09:** arquivo sem permissão de leitura → saída 1, `7z t` saída 0, `.7z` sem o
  arquivo.
- **Mudou:** código 1 ao criar = falha, com lista legível do que faltou ("painel/x (sem permissão de leitura)");
  a falha acontece antes de publicar, então não entra na retenção nem atualiza o último sucesso; avisa por
  notificação. No teste/extração o código 1 continua aceito. **Causa evitada no painel:** o backup do painel
  compacta uma cópia de `/data` feita arquivo por arquivo dentro da fila de gravação (sem `.tmp`/`.partial`; o que
  some entre listar e copiar fica de fora; arquivo ilegível faz falhar dizendo qual).
- **Retenção:** nunca apaga a última cópia completa quando nenhuma das N que ficam é completa (local e externa).
- **Testes:** `apps/server/tests/backup-archive.test.ts` (o teste com 7-Zip real roda com `PAAS_TEST_7Z=<binário>`),
  `backup-service.test.ts` (7zz falso com saída 1, arquivo sumindo durante a compactação, ilegível, sumindo entre
  listar e copiar, links e subpastas, retenção).

### 14 — Redis SAVE (`backup-service.ts`)
- **Era:** resultado do `redis-cli SAVE` ignorado (NOAUTH, erro, nada) → `dump.rdb` velho copiado como sucesso.
- **Mudou:** precisa responder `OK`; senão o backup segue com aviso explícito, status "warning", cópia marcada
  incompleta, último sucesso não anda, e a retenção protege a última completa.
- **Testes:** `backup-service.test.ts` (o teste antigo "Redis que não salva" esperava sucesso; agora aviso).

### 13 — Nomes colidindo dentro do `.7z` (`backup-service.ts`)
- **Reproduzido:** itens "a b", "a/b", "a_b", "A_B" → 2 arquivos no `.7z` (um sobrescrevia o outro).
- **Mudou:** nomes únicos sem diferenciar maiúsculas, sufixo -2, -3…, inclusive contra `_papeis.sql`. Vale para
  dumps Postgres, Redis, outros bancos, volumes e pastas. O manifesto guarda o arquivo de cada item.
- **Testes:** `backup-service.test.ts`.

## Outros stores com o mesmo padrão

Corrigidos (o helper se aplicava direto):
- `setup-state.ts` — "avançar o passo" + "concluir" juntos perdiam a conclusão (reproduzido);
- `security-service.ts` — histórico: 12 registros paralelos → 1 (reproduzido); jobs e último relatório atômicos;
- carga com flag antes de ler → promessa única, e gravação atômica na fila: `alerts-service.ts` (6 alertas → 1 ou 2,
  reproduzido), `deploy-service.ts` (4 projetos → 2, reproduzido; também `deploy-jobs.json`), `mail-service.ts`
  (podia gerar outra senha de admin do Stalwart), `webmail-service.ts`, `monitor-service.ts` (estado e baseline);
- só faltava atomicidade (já serializavam): `session-store.ts`, `credential-vault.ts`, `notification-service.ts`,
  `certificate-store.ts`, chaves de `backup-service.ts`; `mail-reputation-service.ts` também tinha a fila travando
  para sempre depois de uma gravação com erro (reproduzido, corrigido).

Não corrigidos (listados para decisão):
- `mail-envios-service.ts` (`mail/envios/estado.json`): `cancel()` grava o cursor fora do single-flight da coleta;
  estado em parte regenerável; pede reestruturar a coleta, não só trocar a gravação.
- `routes/setup-restart.ts`: token regenerado sem fila, de propósito.
- Arquivos regeneráveis dos pacotes, ainda com `writeFile` direto: `packages/deploy/src/project-dotenv.ts`
  (`excludeFromGit` pode duplicar uma linha), `packages/deploy/src/engine.ts` (`paas.override.yml`),
  `packages/deploy/src/caddy.ts` (cópia local do Caddyfile), `packages/mailer/src/server.ts` (`config.toml`).

## O que foi testado de verdade e o que não

De verdade:
- concorrência com `Promise.all` em disco real (pasta temporária), relógio real no 2FA; cada teste de reprodução foi
  rodado contra o código antigo e falhou pelo motivo descrito antes da correção;
- 7-Zip real 24.09 (Linux x64) no código 1 e no fluxo de backup do painel;
- o conferidor JS do `restaurar-painel.sh` executado com node.

Não testado de verdade:
- E2E do painel em container real (restauração com o painel parando/subindo pelo Docker, script rodando na VPS);
- queda de energia real (a queda é simulada com promessas que nunca resolvem em cada etapa);
- Redis real (o `SAVE` é um dublê de `docker exec`);
- testes que dependem do daemon Docker: nesta máquina o daemon não respondia (`docker version` travava), então
  falharam por tempo: `apps/server/tests/docker-service.test.ts` (2), `apps/server/tests/routes-misc-schema.test.ts`
  (1, `GET /api/docker/containers` → 503) e `packages/deploy` `engine-guardrail-reuse.test.ts` (1) e
  `engine-lifecycle.test.ts` (3). Nenhum deles toca código alterado (o pacote deploy não foi alterado).

## Cobertura (apps/server, sem os 2 arquivos dependentes do Docker)

1684 testes passando. Statements 97,9 · Branches 93,35 · Functions 98,42 · Lines 98,85
(mínimos 94 / 91 / 98 / 94; antes: 97,98 / 93,49 / 98,42 / 98,98).
