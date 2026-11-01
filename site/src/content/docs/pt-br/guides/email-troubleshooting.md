---
title: "O e-mail do meu app não chegou"
description: "Como achar por que o e-mail de um projeto não chegou: tentativas recusadas, o cartão Por que nada chegou, o teste de conexão e os casos do Laravel (fila sem worker, MAIL_MAILER=log, LOG_CHANNEL)."
sidebar:
  label: "E-mail não chegou"
---

Quando o app diz que enviou e o e-mail não aparece, o painel mostra o que o servidor de e-mail viu. Abra o
projeto, aba **Envios** (e **E-mail** para o teste de conexão). Para o panorama de todos os projetos, use
**E-mail → Envios → Saídas**.

## 1. Veja a última tentativa do app

Na aba **Envios** do projeto, a linha **Última tentativa de conexão do app** mostra quando o app falou com o
servidor de e-mail pela última vez e se foi aceito ou recusado. **Nunca vista** quer dizer que o servidor de
e-mail não registrou nenhuma tentativa: o app não está chegando até ele (variáveis erradas, e-mail desligado,
projeto não reiniciado).

## 2. Tentativas recusadas

A seção **Tentativas recusadas** lista o que o servidor recusou **antes** de aceitar a mensagem: senha errada,
bloqueio por tentativas demais, falha de TLS, remetente não permitido, limite de envios. Cada linha mostra a
hora, o motivo e o login usado. Só aparecem no projeto as tentativas **vindas da rede interna** (o app do projeto
ou o próprio painel) com o login da caixa do projeto: senha errada que veio da internet, de robôs, nunca é
atribuída ao app. Essas aparecem na página global **E-mail > Envios > Saídas**, numa lista à parte chamada
**Tentativas externas**. O teste "Testar conexão a partir do app" não conta como tentativa do app. Recusas de
TLS não trazem login e aparecem apenas na página global.

Clique na data de uma tentativa para abrir os **detalhes**: motivo, o que fazer, login, projeto, origem (rede
interna ou internet) e o listener de envio que recusou. Como a tentativa foi recusada antes de a mensagem entrar na
fila, não há destinatário nem resposta de entrega: isso só existe nos envios aceitos, na seção de envios acima.
As tentativas ficam guardadas por **30 dias** (até 300 por dia por projeto, e uma só por minuto para o mesmo
motivo e login); a lista mostra as 50 mais recentes e conta o total. Se a gravação falhar, a tentativa é
regravada na rodada seguinte (até 5 rodadas; depois o painel desiste e avisa no log). Se o painel não conseguir ler as
caixas de envio, usa a última lista que leu para ligar a tentativa ao projeto; sem nenhuma lista, ela fica sem projeto.
O teste "Testar conexão a partir do app" é reconhecido só enquanto o painel está no ar: após reiniciá-lo, uma recusa
causada pelo teste pode aparecer como tentativa do app.

| Motivo | O que fazer |
| --- | --- |
| Usuário ou senha recusados | A senha que o app usa não bate com a da caixa no servidor. Em **E-mail**, use **Sincronizar com o servidor de e-mail** (ou troque a senha da caixa) e reinicie o projeto. Confira também `MAIL_USERNAME` e `MAIL_PASSWORD` (ou ligue-os ao e-mail do painel, abaixo). |
| Conexão TLS não fechou | O app não confia no certificado do servidor de e-mail, ou usa uma versão antiga de TLS. Use o host `mail.<seu domínio>` na porta 587 com STARTTLS. |
| Remetente não permitido | O endereço de `MAIL_FROM_ADDRESS` não pertence à caixa do projeto. Use o endereço da caixa. |
| Sem autenticação | O app tentou enviar sem usuário e senha. |

## 3. Por que nada chegou?

Sem nenhum envio nas últimas 24 horas, a aba **Envios** mostra o cartão **Por que nada chegou?** com o que
se aplica ao projeto:

- o e-mail do projeto não está ligado, ou a caixa não tem senha;
- a **caixa de teste** está ligada: as mensagens estão lá, não saíram;
- o e-mail foi ligado ou mudou, mas o projeto **não foi publicado de novo**;
- `MAIL_MAILER` está como `log` ou `array`: o Laravel só escreve o e-mail num arquivo ou o descarta;
- `MAIL_HOST`, `MAIL_USERNAME` ou `MAIL_PASSWORD` não estão ligados ao SMTP do painel (em **E-mail →
  Ligar variáveis**, ligue-os a `SMTP_HOST`, `SMTP_USER` e `SMTP_PASS`);
- a **fila sem worker** (item 5);
- o servidor recusou tentativas recentes (item 2).

## 4. Testar conexão a partir do app

Na aba **E-mail** do projeto, **Testar conexão a partir do app** faz o mesmo caminho que o app: conecta em
`mail.<seu domínio>:587`, STARTTLS com **verificação do certificado** e login com a caixa do projeto. Não envia
nenhuma mensagem e nunca mostra a senha. Ele para no primeiro passo que falha e explica o motivo. O teste roda
no próprio painel, que está na mesma rede Docker dos projetos; uma regra de rede só do container do app não
é coberta.

## 5. Laravel: fila sem worker

Se `QUEUE_CONNECTION` for diferente de `sync` (por exemplo `database` ou `redis`; no Laravel 11 o padrão é
`database`) e nenhum processo rodar `queue:work`, `queue:listen` ou `horizon`, o painel avisa **Não encontramos um
worker da fila — e-mails e tarefas enfileiradas podem ficar parados**. A busca é estática (compose, Dockerfiles,
supervisor e scripts, inclusive em subpastas como `docker/` e `scripts/`, e os valores definidos em `environment:`,
`env_file` e `ENV` do Dockerfile), então um worker iniciado de outro jeito não é visto. Sem worker, os e-mails ficam
na tabela de jobs.
Duas saídas:

1. Defina `QUEUE_CONNECTION=sync` nas Variáveis do projeto (envia na hora da requisição, mais simples, mais
   lento para o usuário).
2. Adicione um serviço worker ao `docker-compose.yml`:

```yaml
services:
  worker:
    build: .
    command: php artisan queue:work --sleep=3 --tries=3 --max-time=3600
    restart: unless-stopped
    depends_on:
      - app
```

Use a mesma imagem e as mesmas variáveis do serviço do app. Os containers recebem as variáveis do projeto no
próximo deploy.

## 6. Laravel: `LOG_CHANNEL=stderr`

Por padrão o Laravel escreve os erros em `storage/logs/laravel.log`, dentro do container, e a aba **Logs** do
projeto não os vê. Defina `LOG_CHANNEL=stderr` nas Variáveis e as exceções passam a aparecer na aba Logs. É
só uma sugestão, não um erro.

## Logs do servidor

Se o problema parecer do servidor de e-mail ou do proxy, veja [Logs do servidor](server-logs.md).
