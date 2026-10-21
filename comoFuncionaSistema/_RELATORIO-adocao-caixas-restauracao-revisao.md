# Revisão — adoção de domínios e caixas depois de restaurar o e-mail (commit 67f0a83, 21/10/2026)

## Veredito: REPROVADO

Motivo único e bloqueante: **a adoção no fim da restauração nunca roda em produção.** O botão Sincronizar funciona; o caminho automático, que é o caso real do dono (VPS nova, restaurar o backup e ver os 2 domínios e 4 caixas), falha sempre e mostra no registro da restauração um aviso com texto técnico em inglês.

## B1 (bloqueante) — `app.mailService` não existe no escopo raiz

- `apps/server/src/app.ts:194` chama `app.mailService.adoptFromStalwart()` no `app` RAIZ de `buildApp`.
- `apps/server/src/routes/mail.ts:284` decora `mailService` DENTRO do plugin de rotas do e-mail, registrado sem `fastify-plugin` (`app.ts:428`, `export default mailRoutes` em `mail.ts:895`). O Fastify isola esse decorator: no escopo raiz ele é `undefined`. O próprio repositório já registrou esse mesmo problema em `apps/server/src/services/mail-reputation-service.ts:7-12` (a checagem de blacklist “nunca rodou” pelo mesmo motivo).
- Prova com o `buildApp()` real (data dir temporário): `app.hasDecorator("mailService") === false`, `typeof app.mailService === "undefined"` e a chamada exatamente como em `app.ts:194` lança `Cannot read properties of undefined (reading 'adoptFromStalwart')`.
- Efeito: em `backup-service.ts` (`adoptRestoredEmail`) o erro é capturado e vira o aviso “Não foi possível cadastrar no painel os domínios e caixas do e-mail (Cannot read properties of undefined (reading 'adoptFromStalwart')). …”. Nada é apagado e a restauração não falha, mas o painel continua mostrando só o que já conhecia — exatamente o sintoma relatado.
- Por que os testes não pegaram: `backup-service.test.ts` injeta um `mailAdopt` falso; nenhum teste monta o `buildApp` e confere a ligação. O typecheck passa porque a declaração de tipo (`declare module "fastify"` em `routes/mail.ts:42`) vale globalmente.
- A afirmação do relatório do executor (linha 15) e de `comoFuncionaSistema/email/sincronizar.json:40` (“um objeto só, o decorator app.mailService, para a tela e para a restauração”) é falsa no código entregue.
- Correção sugerida (a critério do executor): o plugin do e-mail entrega o serviço à restauração, no padrão já usado para as notificações (`notificationService.setEmailSender` em `routes/mail.ts:287-292`) — por exemplo um `backupService.setMailAdopter(() => service.adoptFromStalwart())` —, ou o `MailService` passa a nascer no escopo raiz. Mais um teste que monte o app real e prove que a restauração chega ao serviço da tela.

## Validação contra Stalwart v0.11.8 real

Imagem fixada em `packages/core/src/images.ts` (digest a5ce06…), rede Docker `--internal` (sem saída), container e rede removidos ao final. Criados 2 domínios (alpha/beta.example.com, com DKIM) e 4 caixas (postmaster@ com abuse@ e dmarc@ em cada um, contato@alpha, loja@beta). Painel com alpha + postmaster@alpha (senha conhecida) e um projeto de slug `loja`.

- **O `/api/principal` do v0.11.8 devolve `secrets` com a senha EM TEXTO PURO** (ex.: `"secrets":"SenhaForte-Contato-123"`), não um hash como supõe o teste falso. O cliente (`packages/mailer/src/client.ts`, `listPrincipals`) monta cada item campo a campo e descarta: confirmado que o `mail.json` gravado não contém nenhuma das senhas.
- `type=individual`/`type=domain` filtram de verdade; `limit` e `page` paginam (limit=2: página 1 e 2 com 2 itens, página 3 vazia, `total` sempre 4). O laço do cliente está correto.
- `emails` vem como texto quando há um endereço e como lista quando há aliases: o cliente trata os dois.
- Adoção real: `{"domains":["beta.example.com"],"mailboxes":["contato@alpha.example.com","loja@beta.example.com","postmaster@beta.example.com"],"skipped":[]}`; duas chamadas simultâneas devolvem o mesmo objeto; repetir devolve tudo vazio; postmaster@alpha manteve a senha conhecida; abuse@/dmarc@ não viraram caixas; `loja@beta` ficou do projeto `loja`; `listMailboxes` mostra `passwordUnknown: true` e nenhuma senha.
- DKIM: `GET /api/dkim/<id inexistente>` → 404. Novo `POST /api/dkim` com id existente → HTTP **200** com `{"error":"fieldAlreadyExists", … "value":o texto da chave privada em PEM (omitido aqui)}` e a chave **não** é sobrescrita (mesma pública antes e depois). O cliente descarta o corpo (só lê `data`), então a chave privada não vaza. Observação: o `catch` de 400 em `createDkimSignature` não é o que acontece no v0.11.8 (é 200), mas o resultado é o mesmo.

## Itens pedidos

1. **Segredo** — OK. `secrets` nunca sai do cliente; não aparece em `mail.json`, resposta, auditoria (só contagens), avisos (só nomes) nem logs (a adoção não loga). `mail_sync_failed` repassa `detail/title` do Stalwart, que nas rotas de listagem não carrega segredo.
2. **Idempotência/concorrência** — OK na mesma instância (comprovado no real). Duas instâncias: ver B1 (a da restauração nem existe). Observação O1: `save()` grava o objeto inteiro em memória sem reler sob trava; a instância do reparo do 401 (`app.ts`, `new MailService(...)`) grava `tls` no `mail.json` e a instância da tela, ao salvar a adoção logo depois, devolve o `tls` antigo (problema anterior a este commit, agora mais provável porque a adoção salva logo após o reparo).
3. **Endereços hostis** — OK: minúsculas, `__proto__`/`constructor` (falham na expressão ou viram chaves com `@`), domínio inválido vai para `skipped`. Observações: O2 — o limite de 40 páginas × 500 trunca acima de 20 000 itens sem avisar; O3 — um principal cujo nome é alias de outro some sem entrar em `skipped` (`mail-adopt.ts:64`); O4 — `skipped` não tem teto na resposta da rota.
4. **abuse/dmarc/postmaster** — OK quando são aliases da postmaster@. O5: se o Stalwart tiver abuse@/dmarc@ como caixas próprias, entram como `kind: "user"` com nome reservado que o painel não deixa criar (`SYSTEM_LOCAL_PARTS`, `mail-service.ts:105`). O6: o domínio adotado não recebe `dmarcAlias`; na próxima rodada de TLS, `ensureDmarcAliases` escreve no Stalwart (inclui dmarc@ na postmaster@) e, se o domínio não tiver postmaster@, registra falha no log a cada hora.
5. **Caixa sem senha** — OK: e-mail de teste recusa com 409 `mailbox_no_password`; leitura de entrega pula; `envForProject` não injeta `SMTP_PASS` vazio; aviso do painel por e-mail explica; credenciais não usam senha; ativar o e-mail do projeto numa caixa adotada exige senha nova (`password_required`).
6. **Falhas** — OK: 401/403 → `mail_auth_failed`, sem conexão → 502 `mail_unreachable`, outro → `mail_sync_failed`; nada é apagado; a restauração não falha. O7: quando o reparo do 401 falha, a adoção é pulada em silêncio e o aviso existente não cita Sincronizar. O8: pior caso de tempo (15 s por pedido, até 80 páginas + 3 pedidos por domínio) segura a restauração por minutos.
7. **Dono pelo slug** — conforme pedido. O9: casa em qualquer domínio e com locais genéricos (`contato@` vira caixa de um projeto de slug `contato`); a caixa passa a `kind: "project"`.
8. **DKIM** — sem sobrescrita no v0.11.8 (comprovado). Efeito colateral: falha que não seja 401/403 no GET (500, timeout) também dispara o POST; cria assinatura nova apenas se não existia. Sugestão: só criar em 404.
9. **Rota** — OK: sessão e CSRF pelo gancho global de `/api/` (`plugins/auth.ts:119-150`), limite 10/min. Observação: com domínio novo, o `refreshInBackground({ force: true })` pode reiniciar o Stalwart (mesmo comportamento de cadastrar domínio); não está dito na tela.
10. **Docs/locales** — OK: pt-BR e en com as mesmas chaves, GLOSSARY, TSV de mensagens, JSONs de `comoFuncionaSistema` válidos, guia do site em pt-br e en, `check-no-real-hosts`: ok, sem IP/domínio real. Exceção: `email/sincronizar.json:40` e o relatório do executor descrevem uma ligação que não funciona (B1).

## Checagens executadas (worktree descartável no commit 67f0a83)

- `pnpm typecheck`: ok.
- Cobertura completa (`test:coverage`): core 120/120, mailer 366/366, deploy 215/215, security 833/833, web 1053/1053, server 2120 passados + 2 ignorados (`--no-bail --maxWorkers=2`) — todos com código de saída 0 (mínimos de cobertura atendidos).
- `docs:links` ok (56 arquivos), `docs:site-url` ok, `check-no-real-hosts` ok.

## Resíduos

Os três testes de prova do B1 criaram diretórios de dados temporários em `/tmp/rev-root-*` (fora do scratchpad; não apaguei por regra). Container `rev-stalwart-adopt` e rede `revnet-adopt` removidos.

---

# 2ª rodada — commit 48f0430

## Veredito: REPROVADO

O bloqueio B1 está resolvido e provado (app real + Stalwart real). Reprovo por uma regressão nova, ligada ao teste apagado: **o projeto não consegue mais ativar o e-mail na própria caixa restaurada.**

## B2 (bloqueante) — caixa `<slug>@` adotada bloqueia o e-mail do projeto; o teste que cobria isso foi apagado

- `apps/server/src/services/mail-adopt.ts:79-81` só dá dono quando `data.projects[id].domain` é o domínio da caixa. Depois de restaurar **só o e-mail** numa VPS nova (o caso real do dono), `data.projects` está vazio, então nenhuma caixa vira caixa de projeto: `loja@` entra como `kind: "user"`.
- Ativar o e-mail do projeto `loja` em `loja@beta` cai em `requireFreeAddress` (`mail-service.ts:1587`), que recusa caixa existente que não seja `kind: "project"`. Medido com Stalwart real: `409 address_in_use — "O endereço loja@beta.example.com já é de outra caixa ou de outro projeto."`, com e sem `generatePassword`. Para sair, a pessoa teria de apagar a caixa (e as mensagens restauradas) ou usar outro endereço.
- O teste removido ("ativar o e-mail de um projeto numa caixa adotada pede a senha e a define") cobria exatamente esse risco. A remoção **não é legítima**: o comportamento antigo do teste era o certo. Ele foi apagado porque a regra nova o quebrava, e nenhum teste novo cobre "caixa adotada + ativar e-mail do projeto". O teste da linha 353 (`SMTP_PASS` vazio) cobre outra coisa.
- A doc afirma o contrário do que acontece: `comoFuncionaSistema/email/sincronizar.json:66` e `_RELATORIO-adocao-caixas-restauracao.md:19` dizem "a pessoa ativa o e-mail do projeto e escolhe a senha".
- Exigido:
  - repor o teste, adaptado: projeto de slug `loja` com `loja@<domínio>` adotada e sem senha; ativar sem senha → `password_required`; ativar com senha → define no Stalwart, caixa vira do projeto, `SMTP_PASS` correto, nada apagado;
  - corrigir o código para isso passar. Por exemplo, `enableProjectEmail`/`requireFreeAddress` aceitam uma caixa adotada (`password === ""`, `kind: "user"`, sem outro projeto ligado) cujo local é o slug, e a convertem para caixa do projeto exigindo senha nova. Ou a adoção volta a ligar pelo slug quando o projeto não tem e-mail configurado em domínio nenhum, mantendo a regra do domínio quando tem.

## Item 1 — ligação da restauração (resolvido)

- `routes/mail.ts:293-297` entrega o serviço da tela com `backupService.setMailAdopt`. O `backupService` é registrado no escopo principal (`app.ts:241`), antes do plugin do e-mail (`app.ts:426`), e `backupService.start()` só roda depois (`app.ts:452`): nenhuma restauração roda antes da ligação. O plugin do e-mail sempre é registrado. Sem adotador, `canAdopt` fica falso e nada quebra.
- `mail-adopt-wiring.test.ts` com a linha `setMailAdopt` removida: **falha** (`expected undefined to be defined`). Com ela: passa.
- App real (`buildApp`) + Stalwart v0.11.8 real (rede `--internal`, removidos ao final), 2 domínios e 4 caixas, painel conhecendo alpha + postmaster@alpha:
  - o `adoptRestoredEmail` real do `BackupService` registrou "Cadastrei 1 domínio e 3 caixas no painel";
  - a tela (`GET /api/mail/domains`, via inject) passou de `[alpha]` para `[alpha (2), beta (2)]`, o que prova que é o mesmo serviço;
  - `POST /api/mail/sync` em seguida devolveu zeros;
  - `mail.json` sem nenhuma senha do Stalwart; `dmarcAlias: true` no beta; postmaster@alpha com senha conhecida.

## Item 2 — os 7 menores

- dmarcAlias: ok, coerente com a postmaster@ e dmarc@ do Stalwart.
- DKIM só se não existe: ok. `findDkimPublicKey` contra o Stalwart real devolve `null` para o 404; 401, 500, rede e chave curta sobem sem criar (testado).
- Alias e abuse@/dmarc@ próprios vão para `skipped`: ok.
- Aviso quando o reparo do 401 falha: ok, cita Sincronizar.
- Teto de `skipped` (200 + `skippedTotal`) e `truncated`: ok. Detalhe: com exatamente 20 000 itens marca `truncated` sem estar cortado.
- Dono pelo slug só no domínio do projeto: implementado, mas causa o B2.
- Aviso de reinício: ok, pt-BR e en.

## Item 3 — o que foi removido ou enfraquecido de 67f0a83 para 48f0430

Só o teste do B2 foi removido (os demais `-` são texto trocado por versão corrigida: dica da tela, linha do `skipped`, doc da ligação e da DKIM). Nenhum teste foi afrouxado. Testes novos: ligação com o app real, DKIM 404/500, dmarcAlias, teto de ignorados, `truncated`, alias e reservados, dono pelo domínio.

## Item 4 — segredo

Continua sem vazar. O `findDkimPublicKey` só lê a chave pública. Na prova real, o `mail.json`, o registro da restauração e a resposta do sync não têm senha.

## Item 5 — docs

A ligação está correta agora em `sincronizar.json:40` e no relatório. Errado: a frase "a pessoa ativa o e-mail do projeto e escolhe a senha" (`sincronizar.json:66`, relatório linha 19), por causa do B2. O relatório cita a revisão como "a1cacc0", mas o commit é 48f0430.

## Checagens (48f0430)

- typecheck ok.
- Cobertura: core 120, mailer 369, deploy 215, security 833, server 2130 (+2 ignorados, `--no-bail --maxWorkers=2`), web 1054. Todos com saída 0.
  - Na primeira rodada o web teve um tempo esgotado em `i18n-hardcoded.test.ts` (5 s), com a máquina carregada pela prova em container. Sozinho passa, e a cobertura do web repetida sozinha deu saída 0.
- `docs:links`, `docs:site-url` e `check-no-real-hosts` ok; JSONs válidos.

---

# 3ª rodada — commit 1193c39

## Veredito: APROVADO (com duas ressalvas não bloqueantes)

O B2 está resolvido e provado contra o Stalwart v0.11.8 real (rede `--internal`, container e rede removidos ao final). O teste reposto falha sem a correção.

## Prova com Stalwart real

Cenário: 2 domínios e 4 caixas. `loja@beta` tem o alias `vendas@beta` e 2 mensagens entregues por SMTP antes da adoção. O painel conhecia só alpha e postmaster@alpha; projetos `loja`, `outro` e `contato`.

- Adoção: 1 domínio e 3 caixas; `loja@beta` entra como caixa comum, sem senha conhecida.
- Ativar o e-mail de `loja` em `loja@beta`:
  - sem senha → `400 password_required`;
  - senha curta → `400 weak_password`.
- Recusas `409 address_in_use`:
  - postmaster@beta (caixa do sistema);
  - projeto `outro` pedindo `loja@` (não é o slug dele), antes e depois de `loja` assumir a caixa;
  - `contato@alpha` com a senha trocada antes de ativar (senha conhecida).
- Ativação digitada e gerada AO MESMO TEMPO, com Sincronizar junto:
  - as duas responderam ok e o Sincronizar devolveu zeros;
  - a senha final do `mail.json` é a que vale no Stalwart: o IMAP entra com o `SMTP_PASS` do painel e a senha antiga é recusada;
  - INBOX continua com **2 mensagens**; o principal tem o **mesmo id**; o alias `vendas@` foi preservado;
  - no Stalwart, só PATCH na caixa, sem POST nem DELETE da `loja@`;
  - a caixa virou `kind: project`, `projectId: p1`.
- Ativar de novo sem senha: ok, sem trocar a senha.
- Segredo: nenhuma senha do Stalwart nem a antiga no `mail.json` ou nos logs do serviço (vazios).

## Teste reposto

`mail-adopt-service.test.ts` ("restaurou só o e-mail: ativar o e-mail do projeto na caixa <slug>@ adotada…"). Com o `mail-service.ts` de 48f0430 ele **falha**; com 1193c39, passa. Também há um teste novo de recusa (outro endereço, senha conhecida, sistema). O caso "outro projeto" desse teste usa a postmaster@; o caso real de outro projeto foi coberto na prova acima.

## Corte de 20 000

`listPrincipalsChecked` busca a 41ª página: vazia, não marca corte; com itens, marca. Testes para exatamente 20 000 e para 20 001. Correto.

## Ressalvas (não bloqueiam; registrar como pendência)

- **R1 — alias de caixa adotada pode virar caixa nova.** O painel não registra os aliases das caixas adotadas. Ativar o e-mail de `loja` com o endereço `vendas` (alias de `loja@` no Stalwart) passou: o painel fez `POST /api/principal` e o Stalwart aceitou criar `vendas@beta` como principal próprio, com o mesmo endereço já usado como alias de `loja@`. Depois, ao trocar para `loja@`, o painel apagou esse principal novo; o alias da `loja@` ficou intacto e nada se perdeu. Mas, enquanto existiu, o mesmo endereço estava em duas contas. É uma falha que já existia para qualquer endereço que só o Stalwart conhece, não uma regressão. Sugestão: guardar os aliases na adoção (ou consultar o Stalwart) e recusar endereço que já é alias.
- **R2 — "Trocar senha" numa caixa `<slug>@` adotada impede ligá-la ao projeto.** A tela da caixa adotada recomenda Trocar senha. Quem segue isso em `loja@` depois recebe `409 "já é de outra caixa ou de outro projeto"` ao ativar o e-mail do projeto. Pela especificação desta rodada é o esperado (senha conhecida → 409), mas a mensagem engana e não há saída. Sugestão: na caixa `<slug>@` de um projeto, a tela orientar a ativar o e-mail do projeto em vez de Trocar senha, ou a recusa explicar o motivo.
- Menor: duas ativações simultâneas respondem ok às duas; quem digitou a senha recebe sucesso, mas vale a gerada. O estado final é coerente. O relatório do executor ainda cita "Revisão (a1cacc0)".

## Docs

`sincronizar.json` e o relatório do executor agora descrevem o comportamento real (ativação aceita a caixa `<slug>@` sem senha; 409 nos demais casos; corte de 20 000 sem falso aviso).

## Checagens (1193c39)

- typecheck ok.
- Cobertura com saída 0: core 120, mailer 371, deploy 215, security 833, web 1054, server 2133 (+2 ignorados, `--no-bail --maxWorkers=2`).
- `docs:links`, `docs:site-url` e `check-no-real-hosts` ok; JSON válido.
