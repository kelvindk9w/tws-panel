# Relatório: validar o backup do banco restaurando em outro projeto

Data: 22/10/2026 (1ª entrega e correção da revisão 1). Detalhes técnicos e API: `backups/validar-restaurando-em-teste.json`.

## O que o recurso faz (comportamento)

- Na aba Backups do projeto há o cartão "Validar o backup do banco restaurando em outro projeto". Vem DESLIGADO. O fluxo de backup, restauração e verificação que já existia não mudou.
- Para ligar: escolher um destino elegível (outro projeto, mesmo motor de banco, banco detectado, sem teste próprio) e digitar o nome dele. Frequência: após cada backup (padrão), no máximo 1 vez por dia ou por semana.
- Depois de um backup do projeto de origem que deixou cópia na VPS (também quando a cópia externa falhou), a MESMA fila do BackupService roda o teste: o painel cria um **banco temporário** (`tws_rc_...`) no servidor de banco do destino, restaura o dump nele **parando no primeiro erro**, confere que **cada tabela** do dump existe e que as **linhas batem**, e apaga o temporário (inclusive em falha e prazo estourado). "Testar agora" roda com o último backup, com a mesma confirmação digitada.
- "Ok" só quando a restauração terminou sem nenhum erro e a conferência bateu. Dump lixo, cortado, com erro no meio, sem tabelas, ou que o servidor do destino não aceita aparece como "falhou", com motivo curto fixo (nunca texto do banco).
- Resultado persistido por projeto (ok, falhou, não executado, em andamento; data, destino, duração, o que foi conferido), na aba do projeto e como selo em Configurações, Backups. Falha avisa pelos canais de falha de backup; ações são auditadas sem senha nem dado.

## Decisão que mudou o desenho original (precisa de ciência do Kelvin)

O pedido original dizia "restaurar automaticamente no projeto de teste". Na revisão ficou provado que restaurar DENTRO do banco do destino não prova nada de forma confiável (o psql sai com 0 mesmo com erros; "pelo menos uma tabela" é sempre verdadeiro a partir do 2º teste; esquema mais novo no destino dá "ok" sem nenhuma linha do backup) e que, no MongoDB, trocava os usuários do destino pelos da produção. A correção adotada, pedida pela revisão, restaura num banco temporário: a prova é rigorosa, e o banco do projeto de destino NÃO recebe os dados de produção (o ambiente de teste não é atualizado por este recurso). Isso também reduz o risco de LGPD. Se o Kelvin quiser também popular o banco de teste, é um passo opcional a mais (com confirmação própria) que não foi feito.

## Correções da revisão 1

1. **MongoDB e MySQL/MariaDB**: mongorestore com `--nsExclude admin.* config.* local.*` e renomeando para `tws_rc_<id>_<banco>` (sem `--drop`); os usuários do destino não mudam e o login da origem não entra. MySQL/MariaDB: o dump leva todos os bancos do servidor de origem; agora só o banco do projeto é restaurado, num temporário, sem `DROP DATABASE` nem `DEFINER`; `mysql.user` e tabelas de sistema não aparecem no arquivo restaurado (provado com MariaDB 11 real).
2. **"Ok" de verdade**: Postgres com `ON_ERROR_STOP=1`, sem dono/GRANT (que podem não existir no destino), conferência por tabela (`to_regclass`) e por linhas (`count(*) FROM ONLY`); MySQL/MariaDB com parada no primeiro erro, marca "Dump completed", conferência de cada tabela e de que as tabelas com INSERT não ficaram vazias; MongoDB com resumo do mongorestore e contagem por mongosh. Textos da tela, do site (pt-br e en) e de comoFuncionaSistema só prometem isso.
3. **Prazo**: `timeout -s KILL` DENTRO do container (o cliente docker espera 30 s a mais); no estouro (ou erro), o painel derruba as sessões (pg_terminate_backend; KILL no MariaDB; dropDatabase no Mongo), apaga o temporário e CONFIRMA que sumiu. Não confirmado = "falhou: cleanup_failed" avisando para apagar `tws_rc_` à mão; o próximo teste também varre restos. Provado com `pg_sleep(40)` e prazo de 6 s, e com `DO SLEEP(40)` no MariaDB.
4. **Destino trocado com teste na fila**: cada pedido guarda o destino em que foi feito; trocar o destino descarta o pedido velho ("não executado") e o novo ocupa o lugar; mudança sem novo pedido encerra como "não executado" mostrando o destino pedido.
5. **Testes** adicionados: renomeado durante a execução, desligar na fila, backup incompleto, erro inesperado sem texto no log, tamanho desconhecido, troca de destino, reinício com pedido na fila, e a bateria de falhas.
6. **Cartão**: com a origem indisponível e a opção ainda ligada há botão Desligar; seletores sem estourar a 360 px; depois de agir o foco vai para a região de resultado, que é `role="status"`.
7. **Origem renomeada**: nada muda (a origem é identificada pelo id; a confirmação é sempre o nome do destino); a documentação foi corrigida, em vez de implementar.
8. **Espaço**: tamanho desconhecido é medido (disco ou listagem do armazenamento); sem medida = "não executado"; fator 6 (7 com download da cópia externa).
9. **Reinício**: teste que ainda esperava na fila vira "não executado / não começou", e não "falhou".
10. Comentário de `holdProject` no lugar certo em `deploy-service.ts`.

## Salvaguardas (continuam valendo)

Destino diferente da origem; mesmo motor; banco do destino em execução (nada é ligado ou reiniciado); destino reservado (deploy dele recusado; se já está em deploy, "não executado"); uma operação por vez na fila; prazo de 30 min; checagem de espaço; destino ou origem apagado desliga a opção com aviso; destino que também é origem de teste é recusado; nunca volumes, arquivos, código, `.env`, variáveis, e-mail nem a configuração da origem.

## Limites conhecidos

- O teste prova que o dump restaura sem erro e que tabelas e número de linhas batem. Não compara o conteúdo das linhas, nem índices, gatilhos ou permissões. No MySQL/MariaDB o número exato de linhas não é conferido (só que a tabela não ficou vazia).
- Dump que usa uma extensão do Postgres que a imagem do destino não tem falha (sinal verdadeiro, mas o destino é que não tem a extensão).
- O banco "inicial" do Mongo costuma não ser o do app; por isso todos os bancos da instância (menos admin/config/local) são restaurados em temporários. Exige `mongosh` no container.
- Depende de `timeout` no container (busybox do Alpine e coreutils das imagens Debian/Ubuntu têm). Sem ele, o prazo ainda vale no cliente docker e a limpeza derruba sessões e apaga o temporário.
- Durante o teste, dados de produção ficam no disco do servidor de banco do destino (LGPD): a tela avisa.
- O painel reiniciado no meio pode deixar um banco `tws_rc_` no destino; o aviso diz isso e o próximo teste o apaga.

## Não verificado

- Extração parcial do `.7z` (`7zz x arquivo manifesto.json bancos`) com um 7zz real: não instalado aqui; o teste confere só os argumentos.
- Nenhuma checagem em navegador real (a 360 px a verificação é por classes CSS, em teste de componente).
- Imagens de banco antigas (MySQL 5.x, Mongo < 5 sem mongosh) e Postgres < 13 não foram testadas.

## Verificação

Typecheck de todos os pacotes; cobertura de server (mínimos atingidos, `--maxWorkers=2` e sem `tests/terminal-service-pty.test.ts`), web, core, deploy e mailer; Docker real com `postgres:16-alpine`, `mariadb:11` e `mongo:7` (as imagens mariadb e mongo foram baixadas para esta verificação; blocos pulam sem a imagem); build do site, `docs:links`, `docs:site-url` e `check-no-real-hosts` ok. O `--no-bail` do briefing não é aceito por esta versão do vitest.
