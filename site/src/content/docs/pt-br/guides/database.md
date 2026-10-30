---
title: "Aba Banco do projeto"
description: "Como ver o banco do projeto, esvaziar tabelas, zerar o banco, rodar comandos do Laravel e usar o console SQL, com senha, 2FA e backup antes das ações que apagam dados."
sidebar:
  label: "Aba Banco"
---

A aba **Banco** da página do projeto mostra o banco de dados que o projeto usa e permite trabalhar nele sem sair do painel.
Ela funciona por completo com **PostgreSQL**, **MySQL** e **MariaDB**. Para MongoDB, Redis e SQLite a aba mostra um aviso de
que o suporte ainda não existe.

## O que a aba mostra

- Motor, versão, nome do banco e tamanho total.
- Lista de tabelas com o número **aproximado** de linhas e o tamanho de cada uma (são estimativas do próprio banco).
- Botão **Atualizar**. Só olhar não pede senha: a leitura usa a sessão normal e nunca mostra a senha do banco.

Se o banco estiver parado ou o Docker fora do ar, a aba explica o motivo em vez de mostrar uma tela vazia.

## Ações que alteram dados

Esvaziar tabelas, zerar o banco, rodar um comando do framework e executar SQL de escrita pedem sempre:

1. sua **senha** do painel e o **código do app autenticador** (a verificação em duas etapas é obrigatória), mais o código
   por e-mail se você o ativou em Configurações;
2. **digitar o nome do projeto** para confirmar;
3. escolher o **backup**: "Backup completo do banco antes" (padrão) ou "Não fazer backup". Em projetos marcados como
   **"Este é um projeto de desenvolvimento"** (Configurações do projeto, seção geral) o padrão é não fazer backup.

O backup é o mesmo "Fazer backup agora" da aba Backups. Se ele falhar, terminar com aviso, demorar mais de 30 minutos ou,
com o teste de restauração ligado, não passar na validação, a ação **não roda** e nada é alterado. Se o teste de
restauração estiver desligado (ou não tiver rodado para esse backup), a ação segue e a tela mostra "validação não
executada". Não existe backup só de algumas tabelas.

Tokens de API e o MCP **não** alcançam a aba: essas ações só funcionam com uma pessoa logada. Cada ação fica no log de
auditoria (quem fez, qual ação, quais tabelas), nunca com o SQL, valores ou credenciais.

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

- **Leitura** (`SELECT`, `SHOW`, `EXPLAIN`...): roda com a sessão normal, em uma transação **somente leitura imposta pelo
  banco** contra alteração de dados, com prazo de 15 segundos, no máximo 500 linhas e no máximo 2 consultas ao mesmo tempo.
- **Escrita** (qualquer outra coisa): é uma ação destrutiva e pede senha, 2FA, nome do projeto e escolha de backup.
- A transação somente leitura não bloqueia funções que agem fora das tabelas quando o usuário do banco é administrador
  (ler arquivos do servidor, encerrar conexões, `SLEEP`, `INTO OUTFILE`...). Por isso o painel trata essas consultas como
  **escrita**: elas pedem senha e 2FA em vez de rodar direto.
- Nas ações, o próprio banco também recebe prazos (espera de bloqueio de 15 s e limite de execução), para que um comando
  não continue rodando se o painel desistir de esperar. Se mesmo assim passar do prazo, a tela avisa que ele **pode ainda
  estar rodando**: confira antes de repetir.
- **Uma instrução por vez.** O painel recusa textos com vários comandos, comandos do cliente (`\` no psql, `source` no
  mysql) e comentários executáveis do MySQL. Assim a proteção de somente leitura não pode ser desligada por um `COMMIT`
  escondido no texto. No MySQL/MariaDB o texto é enviado ao servidor já fechado em uma única instrução (`PREPARE`), sem
  passar pelo separador do cliente.
- Por ser uma instrução só, **criar funções ou procedimentos cujo corpo tem ponto e vírgula não funciona no console**. Use um
  arquivo de migração ou restaure um backup. Alguns comandos que o `PREPARE` do MySQL não aceita (como `SHOW ERRORS`) também
  precisam do fluxo de escrita.
