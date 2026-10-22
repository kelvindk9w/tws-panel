# Relatório: validar o backup do banco restaurando num banco temporário (no servidor de outro projeto)

Data: 22/10/2026 (1ª entrega e correções das revisões 1 e 2). Detalhes técnicos e API: `backups/validar-restaurando-em-teste.json`.

## Estado desta entrega: somente PostgreSQL

Nesta etapa o teste existe **só para PostgreSQL**. MySQL, MariaDB e MongoDB ficam **indisponíveis**, na tela e no servidor, com o motivo "ainda não disponível para este motor de banco" (o servidor responde 409 ao tentar ligar, e um teste que já estivesse ligado termina como "não executado"). Foi a saída segura aceita na revisão 2: os três bloqueios dela (gatilho de MySQL/MariaDB criado no banco real, MongoDB "ok" com documentos perdidos, varredura apagando bancos reais de nome parecido) deixam de existir para esses motores porque o código deles saiu, e o terceiro foi corrigido de verdade no Postgres.

## O que o recurso faz (comportamento)

- Na aba Backups do projeto há o cartão "Validar o backup do banco restaurando num banco temporário (no servidor de outro projeto)". Vem DESLIGADO. O fluxo de backup, restauração e verificação que já existia não mudou.
- Para ligar: escolher um destino elegível (outro projeto, PostgreSQL detectado, sem teste próprio) e digitar o nome dele. Frequência: após cada backup (padrão), no máximo 1 vez por dia ou por semana.
- Depois de um backup do projeto de origem que deixou cópia na VPS (também quando a cópia externa falhou), a MESMA fila do BackupService roda o teste: o painel cria um **banco temporário** (`tws_rc_` mais 16 letras/números sorteados) no servidor de banco do destino, restaura o dump nele **parando no primeiro erro**, confere que **cada tabela** do dump existe e que as **linhas batem**, e apaga o temporário (inclusive em falha e prazo estourado). "Testar agora" roda com o último backup, com a mesma confirmação digitada.
- **O ambiente de teste NÃO recebe os dados.** O banco do projeto de destino não é alterado; o dump só passa por um banco temporário que some no fim.
- O destino precisa de: **mesmo motor (PostgreSQL), banco em execução, credencial de administrador (superusuário ou CREATEDB) e espaço em disco**. Sem a permissão, o resultado diz que é problema de permissão no destino, não do backup.
- "Ok" só quando a restauração terminou sem nenhum erro e a conferência bateu. Dump lixo, cortado, com erro no meio, sem tabelas, ou que o servidor do destino não aceita aparece como "falhou", com motivo curto fixo (nunca texto do banco).
- Resultado persistido por projeto (ok, falhou, não executado, em andamento; data, destino, duração, o que foi conferido), na aba do projeto e como selo em Configurações, Backups. Falha avisa pelos canais de falha de backup; ações são auditadas sem senha nem dado.

## Decisão que mudou o desenho original (precisa de ciência do Kelvin)

O pedido original dizia "restaurar automaticamente no projeto de teste". Na revisão 1 ficou provado que restaurar DENTRO do banco do destino não prova nada de forma confiável (o psql sai com 0 mesmo com erros; "pelo menos uma tabela" é sempre verdadeiro a partir do 2º teste; esquema mais novo no destino dá "ok" sem nenhuma linha do backup). A correção adotada restaura num banco temporário: a prova é rigorosa, e o banco do projeto de destino NÃO recebe os dados de produção. Isso também reduz o risco de LGPD. Por isso o título do cartão, o site e esta documentação passaram a falar em "banco temporário".

**Proposta (NÃO implementada):** um passo opcional, com confirmação própria, "também atualizar o banco do projeto de teste", para quem quiser o ambiente de teste com os dados do backup.

## Correções da revisão 2

1. **Bancos reais de nome parecido nunca são apagados.** Não existe mais varredura por padrão de nome. O painel gera o nome (`tws_rc_` + 16 hexadecimais aleatórios), **grava no registro (`restoreCheckTemp`, em `data/backups.json`) ANTES de criar** o banco e só apaga nomes registrados. A função de apagar recusa qualquer nome fora da forma exata. Provado com Postgres real: bancos `tws_rc_cafe`, `tws_rc_cafe_0`, `tws_rc_meu_app` e outros parecidos continuam de pé depois de todos os cenários.
2. **Restos que sobraram** (teste interrompido, painel reiniciado, apagar falhou) são apagados pelo registro: no início de cada teste, ao desligar a opção, em segundo plano ao desativar o teste e na partida do painel; nunca enquanto outro teste roda. Não conseguir apagar mantém o nome registrado; destino que não existe mais esquece os nomes sem apagar nada.
3. **Leitor do dump (Postgres)** passou a reconhecer textos entre aspas simples (inclusive `E'...'` e aspa dobrada), identificadores entre aspas duplas, corpos `$$`/`$tag$` e comentários, inclusive atravessando linhas; `$$` dentro de um `COMMENT` ou `DEFAULT` não faz mais o leitor errar (antes: falso negativo, deixava passar OWNER/GRANT).
4. **Destino sem permissão para criar bancos** vira "falhou / destination_permission" (permissão do destino), sem apagar nada.
5. **Dois testes que faltavam**: apagar o destino notifica na hora (`restore-check-off`), e backup automático com a opção desligada no meio não roda o teste.
6. **MySQL/MariaDB/MongoDB**: código e textos retirados (veja a proposta abaixo). Tela, site, `comoFuncionaSistema` e `_i18n-servidor-fase2.tsv` deixam de prometer esses motores.

## Proposta para a próxima etapa (MySQL, MariaDB e MongoDB)

- **MySQL/MariaDB**: gatilhos, rotinas e views do dump podem citar o banco por nome qualificado e criar objetos FORA do banco temporário. É preciso reescrever ou recusar qualificações de banco nesses corpos e, depois da restauração, conferir em `information_schema` que nada foi criado fora de `tws_rc_`. Reaproveitar o registro de nomes (um nome por banco, registrado antes de criar).
- **MongoDB**: exigir 0 documentos que falharam ("N document(s) failed to restore"), comparar as contagens com as do arquivo, usar `--bypassDocumentValidation` e classificar o prazo estourado pelo sinal, não pelo texto.
- Em ambos, provar com Docker real os cenários que a revisão 2 mostrou (gatilho com banco qualificado, documento rejeitado por validação, bancos reais de nome parecido).

## Correções da revisão 1 (continuam valendo para o Postgres)

1. **"Ok" de verdade**: `ON_ERROR_STOP=1`, sem dono/GRANT (que podem não existir no destino), conferência por tabela (`to_regclass`) e por linhas (`count(*) FROM ONLY`). Textos da tela, do site (pt-br e en) e de `comoFuncionaSistema` só prometem isso.
2. **Prazo**: `timeout -s KILL` DENTRO do container (o cliente docker espera 30 s a mais); no estouro (ou erro), o painel derruba as sessões (`pg_terminate_backend`), apaga o temporário e CONFIRMA que sumiu. Não confirmado = "falhou: cleanup_failed". Provado com `pg_sleep(40)` e prazo de 6 s.
3. **Destino trocado com teste na fila**: cada pedido guarda o destino em que foi feito; trocar o destino descarta o pedido velho ("não executado") e o novo ocupa o lugar.
4. **Cartão**: com a origem indisponível e a opção ainda ligada há botão Desligar; seletores sem estourar a 360 px; depois de agir o foco vai para a região de resultado (`role="status"`).
5. **Origem renomeada**: nada muda (a origem é identificada pelo id; a confirmação é sempre o nome do destino).
6. **Espaço**: tamanho desconhecido é medido (disco ou listagem do armazenamento); sem medida = "não executado"; fator 6 (7 com download da cópia externa).
7. **Reinício**: teste que ainda esperava na fila vira "não executado / não começou", e não "falhou".

## Salvaguardas (continuam valendo)

Destino diferente da origem; mesmo motor; banco do destino em execução (nada é ligado ou reiniciado); destino reservado (deploy dele recusado; se já está em deploy, "não executado"); uma operação por vez na fila; prazo de 30 min; checagem de espaço; destino ou origem apagado desliga a opção com aviso; destino que também é origem de teste é recusado; nunca volumes, arquivos, código, `.env`, variáveis, e-mail nem a configuração da origem.

## Limites conhecidos

- O teste prova que o dump restaura sem erro e que tabelas e número de linhas batem. Não compara o conteúdo das linhas, nem índices, gatilhos ou permissões.
- Dump que usa uma extensão do Postgres que a imagem do destino não tem falha (sinal verdadeiro, mas o destino é que não tem a extensão).
- Depende de `timeout` no container (busybox do Alpine e coreutils das imagens Debian/Ubuntu têm). Sem ele, o prazo ainda vale no cliente docker e a limpeza derruba sessões e apaga o temporário.
- Durante o teste, dados de produção ficam no disco do servidor de banco do destino (LGPD): a tela avisa.
- O painel reiniciado no meio pode deixar um banco temporário no destino; o aviso diz isso e o painel o apaga ao iniciar e no próximo teste (o nome estava registrado).

## Não verificado

- Extração parcial do `.7z` (`7zz x arquivo manifesto.json bancos`) com um 7zz real: não instalado aqui; o teste confere só os argumentos.
- Nenhuma checagem em navegador real (a 360 px a verificação é por classes CSS, em teste de componente).
- Postgres < 13 e imagens de banco muito antigas não foram testadas.

## Verificação

Typecheck de todos os pacotes; cobertura de server, web, core, deploy e mailer; Docker real com `postgres:16-alpine` (8 cenários do módulo e o serviço inteiro); build do site, `docs:links`, `docs:site-url` e `check-no-real-hosts`. O resultado final de cada um está na resposta de entrega. O `--no-bail` do briefing não é aceito por esta versão do vitest.
