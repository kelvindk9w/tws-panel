---
title: "Aba Banco do projeto"
description: "Como ver o banco do projeto, esvaziar tabelas, zerar o banco, rodar comandos do Laravel e usar o console SQL, liberando a edição uma vez (senha e 2FA) e com backup opcional antes."
sidebar:
  label: "Aba Banco"
---

A aba **Banco** da página do projeto mostra o banco de dados que o projeto usa e permite trabalhar nele sem sair do painel.
Ela funciona por completo com **PostgreSQL**, **MySQL** e **MariaDB**. Para MongoDB, Redis e SQLite a aba mostra um aviso de
que o suporte ainda não existe.

## O que a aba mostra

- Motor, versão, nome do banco e tamanho total.
- Lista de tabelas com o número **aproximado** de linhas e o tamanho de cada uma (são estimativas do próprio banco).
- Botão **Atualizar**. Só olhar não pede senha nem liberação: a leitura usa a sessão normal e nunca mostra a senha do banco.

Se o banco estiver parado ou o Docker fora do ar, a aba explica o motivo em vez de mostrar uma tela vazia.

## Liberar a edição do banco

Ver o banco e rodar consultas de leitura usa só a sessão normal. **Alterar dados** (esvaziar tabelas, zerar o banco, comandos do
framework e SQL de escrita) exige antes **liberar a edição do banco**, uma vez:

1. clique em **Liberar edição** na aba Banco;
2. informe sua **senha** do painel e o **código do app autenticador** (a verificação em duas etapas é obrigatória), mais o
   código por e-mail se você o ativou em Configurações;
3. escolha se quer **"Fazer backup completo do projeto ao liberar"**. Vem marcado nos projetos comuns e desmarcado nos
   marcados como **"Este é um projeto de desenvolvimento"** (Configurações do projeto, seção geral).

Se o backup falhar, terminar com aviso, demorar mais de 30 minutos ou, com o teste de restauração ligado, não passar na
validação, a edição **não é liberada** e nada é alterado. É o mesmo "Fazer backup agora" da aba Backups; não existe backup só
de algumas tabelas.

Liberada a edição, a aba mostra **"Edição liberada, expira em mm:ss"** e o botão **Bloquear agora**. Quando o tempo acaba, a
tela volta sozinha ao estado bloqueado. Dentro desse prazo você **não digita senha nem código de novo**:

- **Console SQL**: o SQL de escrita roda direto, sem nenhuma pergunta.
- **Esvaziar tabelas**: um botão de confirmação simples (com a escolha de backup antes, pois é uma ação grande e rara).
- **Zerar o banco**: pede o **nome do projeto digitado** (apaga tudo) e a escolha de backup.
- **Comandos do Laravel**: confirmação simples; `migrate:fresh --seed` conta como "zerar" e pede o nome do projeto.

A liberação vale **só para a sua sessão e só para aquele projeto**, e fica **só na memória do painel**: sair do painel, a
sessão expirar ou reiniciar o painel encerra tudo, e outro projeto ou outra sessão continuam bloqueados. A duração (15 min,
30 min, 1 h, 2 h, 4 h ou "até eu sair") e a opção **Renovar com o uso** (cada comando estende a liberação até o prazo cheio)
ficam em **Configurações, Banco de dados**; o padrão é 30 minutos, renovando. Alongar o prazo ou ligar a renovação pede senha e
código; encurtar só pede a sessão. Encurtar também corta as liberações em andamento.

Tokens de API e o MCP **não** alcançam a aba nem criam liberações: só uma pessoa logada. A auditoria registra "edição
liberada" (quem, projeto e duração), "liberação encerrada" (prazo, botão ou fim da sessão) e cada comando de escrita (quem, qual
ação, quais tabelas), nunca o SQL, valores ou credenciais.

### Esvaziar tabelas

Escolha uma ou mais tabelas. No PostgreSQL o painel usa `TRUNCATE ... RESTART IDENTITY`; a opção **CASCADE**, que também
esvazia as tabelas que dependem das escolhidas, vem desmarcada e traz um aviso. No MySQL/MariaDB as chaves estrangeiras são
desligadas só durante o comando. **No MySQL/MariaDB o esvaziamento não é atômico**: o `TRUNCATE` confirma sozinho, então se
falhar no meio, as tabelas anteriores já foram esvaziadas.

### Zerar o banco

Apaga as **tabelas e os objetos comuns** (visões, sequências, tipos, funções, rotinas e eventos), mas **mantém o banco, os
usuários e as permissões**. Também **não apaga**: extensões e esquemas; no PostgreSQL, objetos grandes (large objects),
operadores, collations, configurações de busca de texto, publicações e servidores externos; no MySQL/MariaDB, usuários e
permissões. No MySQL/MariaDB a ação **não é atômica** (cada `DROP` confirma sozinho): se falhar no meio, parte dos objetos
já foi apagada. No PostgreSQL o painel apaga os objetos um a um em um único comando e preserva extensões e permissões dos
esquemas; ele não usa `DROP SCHEMA public CASCADE`, que levaria essas coisas junto. Depois de zerar, recrie a estrutura com
as migrações do app ou restaure um backup.

### Restaurar um backup

A aba tem um atalho para a aba **Backups**, onde fica o fluxo de restauração que já existe.

### Comando do framework

Em projetos **Laravel** (detectados por `laravel/framework` no `composer.json` e pelo arquivo `artisan`) aparecem três
comandos fixos: `migrate:fresh --seed`, `migrate --force` e `db:seed --force`. Eles rodam dentro do container do app, e a
saída aparece na tela com um botão **Copiar**. Não é possível digitar outros comandos. Se mais de um container tiver o
`artisan` (por exemplo o app e um worker), a tela pede para você escolher onde rodar; o container do nginx, que não tem o
`artisan`, nunca é usado.

### Console SQL

- **Várias instruções por execução** (até 50), separadas por `;`. O painel separa o texto como o banco o leria: um `;` dentro
  de texto entre aspas, comentário, crases ou corpo `$$ ... $$` (PostgreSQL) não separa, e a última instrução pode ficar sem
  `;`. Cada instrução mostra o próprio resultado; se uma falhar, a execução **para ali** e a tela diz o **número** da
  instrução que falhou.
- **Só leitura** (todas as instruções são `SELECT`, `SHOW`, `EXPLAIN`...): roda com a sessão normal, numa **única transação
  somente leitura imposta pelo banco**, com prazo de 15 segundos, no máximo 500 linhas por instrução e 2 MB no total, e no
  máximo 2 consultas ao mesmo tempo. Não precisa liberar a edição.
- **Qualquer instrução de escrita** no texto: exige a **edição liberada**. Sem ela a tela mostra "Libere a edição do banco
  para rodar comandos que alteram dados" com o botão. No PostgreSQL a caixa **Executar tudo numa transação** (marcada por
  padrão) envolve tudo em `BEGIN`/`COMMIT`: se uma instrução falha, nada é gravado. Sem a caixa, as instruções anteriores à
  que falhou já foram gravadas. **No MySQL/MariaDB não há transação**: comandos de estrutura (`CREATE`, `ALTER`, `DROP`)
  confirmam sozinhos e não voltam atrás, então as anteriores à que falhou ficam aplicadas.
- A transação somente leitura não bloqueia funções que agem fora das tabelas quando o usuário do banco é administrador (ler
  arquivos do servidor, encerrar conexões, `SLEEP`, `INTO OUTFILE`...). Por isso o painel trata essas consultas como
  **escrita**: elas pedem a edição liberada em vez de rodar direto.
- No MySQL/MariaDB a consulta de leitura roda com `sql_mode` vazio, cada instrução enviada ao servidor já fechada em uma única
  instrução (`PREPARE`), sem passar pelo separador do cliente. Na prática: `||` significa OU (use `CONCAT()`), `"texto"` é um
  texto e não um nome de coluna, e consultas com marcadores `?` não funcionam.
- Nas ações, o próprio banco também recebe prazos (espera de bloqueio de 15 s e limite de execução), para que um comando
  não continue rodando se o painel desistir de esperar. Se mesmo assim passar do prazo, a tela avisa que ele **pode ainda
  estar rodando**: confira antes de repetir. Ao estourar o prazo, o painel também cancela a consulta no servidor (pelo
  banco, não só fechando a conexão) e só diz que foi interrompida se isso deu certo. No MySQL, `UPDATE`, `DELETE` e DDL
  não têm limite de tempo próprio no servidor: valem o prazo do painel e esse cancelamento.
- Continuam **recusados**: comandos do cliente (`\` no psql, `source`, `system` e `DELIMITER` no mysql) e comentários
  executáveis do MySQL (`/*! ... */`). Por isso **procedimentos do MySQL que precisam de `DELIMITER` não rodam no console**;
  no PostgreSQL, funções com corpo `$$ ... $$` funcionam. Alguns comandos que o `PREPARE` do MySQL não aceita (como `SHOW
  ERRORS`) também precisam do fluxo de escrita.
