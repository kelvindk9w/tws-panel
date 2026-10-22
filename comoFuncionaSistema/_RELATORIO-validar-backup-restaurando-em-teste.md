# Relatório: validar o backup do banco restaurando em outro projeto

Data: 22/10/2026. Detalhes técnicos e API: `backups/validar-restaurando-em-teste.json`.

## O que passou a acontecer

- Na aba Backups do projeto há um cartão novo, "Validar o backup do banco restaurando em outro projeto". Vem DESLIGADO. O fluxo de backup/restauração/verificação existente não mudou.
- Ligar exige escolher um destino entre os elegíveis (outro projeto, mesmo motor de banco, banco detectado) e digitar o nome do destino. Há aviso claro: substitui as tabelas do banco do destino, copia dados reais para o ambiente de teste (LGPD), só o banco é restaurado.
- Frequência: após cada backup (padrão), no máximo 1 vez por dia ou por semana.
- Depois de um backup do projeto de origem que deixou cópia na VPS, a MESMA fila do BackupService restaura o dump do banco no banco do destino e confere que ele tem tabelas (só a contagem; nenhuma linha é lida; MongoDB vale pelo código de saída).
- "Testar agora" roda com o último backup completo, com a mesma confirmação digitada.
- Resultado por projeto: ok, falhou (motivo curto fixo, sem texto do banco), não executado ou em andamento, com data, destino e duração. Aparece na aba do projeto e como selo em Configurações, Backups. Falha avisa pelos canais de falha de backup e fica no histórico; ação auditada sem senha nem dado.
- Projeto sem banco detectado/marcado: a opção explica por que não está disponível.

## Salvaguardas

Destino diferente da origem; mesmo motor; banco do destino precisa estar em execução (nada é ligado ou reiniciado); destino reservado durante o teste (deploy dele é recusado; se já está em deploy, "não executado"); uma operação por vez na fila, com prazo (30 min) e checagem de espaço; destino ou origem apagado/renomeado desliga a opção com aviso; painel reiniciado no meio: "em andamento" vira "falhou, o banco de teste pode estar incompleto" na subida; backup incompleto ou sem senha (VPS nova) vira "não executado". Nunca se restauram volumes, arquivos, código, `.env`, variáveis, e-mail nem a configuração da origem.

## Decisões onde o desenho deixava espaço

- Cópia externa falhou: valida mesmo assim a cópia da VPS (ela é o que existe). Sem cópia na VPS, "Testar agora" usa a externa (baixa e decifra com a senha guardada).
- Encadeamento A para B para A é proibido: um projeto que é destino não pode ser origem de teste ligado, e vice-versa (nunca restaurar em cima da produção).
- MySQL/MariaDB/Mongo recriam o banco pelo nome no dump; por isso só são elegíveis destinos com o MESMO nome de banco.
- Postgres: restaura o banco principal DENTRO do banco do destino, sem os papéis (o arquivo de papéis leva o hash da senha do usuário da origem e trocaria as credenciais do destino).
- O restore reaproveita o mesmo código da restauração de projeto (`restoreDatabaseDump`); nada duplicado.

## Furos encontrados (descritos, não relaxados)

- Postgres: tabelas que só existem no destino continuam lá (`--clean` só apaga o que o dump conhece). O destino não fica idêntico à origem.
- Destino já cheio: a contagem de tabelas sozinha não prova que o restore as criou; vale o código de saída mais a contagem de avisos.
- Falha no meio do restore deixa o destino parcialmente restaurado (dito no resultado); o próximo teste ok refaz.
- Na expiração do prazo o painel interrompe o cliente docker, mas o `exec` pode continuar no container.
- A aplicação do destino continua rodando durante o restore (não é parada, por desenho); um deploy do destino nesse intervalo recebe o 409 genérico "deploy em andamento".
- O backup do painel carrega `data/backups.json`, então o destino configurado viaja com ele.
- O teste valida que o dump restaura e que há tabelas; não compara linhas nem esquema.

## Não verificado

- Extração parcial (`7zz x arquivo manifesto.json bancos`) com um 7zz real: não instalado aqui; o teste unitário confere só os argumentos.
- Docker real só com Postgres (postgres:16-alpine, nome único, limpo no fim). MySQL, MariaDB e MongoDB só com Docker de mentira.
- Nenhuma checagem em navegador real; a interface foi coberta por testes de componente.
- `docker pull ubuntu` não funciona neste ambiente (testes que dependem disso não são deste trabalho).

## Verificação

Typecheck de todos os pacotes; coverage de server (mínimos atingidos), web, core, deploy e mailer; build do site, `docs:links`, `docs:site-url` e `check-no-real-hosts` ok. O `--no-bail` do briefing não é aceito por esta versão do vitest (o padrão já não interrompe).
