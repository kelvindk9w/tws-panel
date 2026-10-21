# Relatório — Sincronizar repara sozinho o 401 da senha de administração

Parte de `main` (8ed6adc). Sem push nem PR.

## 1. O problema

Numa VPS restaurada, E-mail → Sincronizar com o servidor de e-mail devolvia "O painel não conseguiu autenticar no servidor de e-mail… Reaplique a configuração". A senha de administração (`adminSecret`) do `mail.json` não era a do `config.toml` do contêiner, e a pessoa tinha que resolver na mão antes de sincronizar.

## 2. O que mudou (pelo comportamento)

- **Sincronizar e a adoção do fim da restauração do e-mail** (as duas usam `MailService.adoptFromStalwart`): ao receber 401/403 na leitura, o painel tenta UMA vez o reparo que já existia (`repairAdminAuth`: confere com chamada autenticada, regrava a configuração com a senha do painel, reinicia o contêiner, sem apagar dados) e repete a leitura. Com a senha certa nada é reiniciado. Não há laço: uma tentativa de reparo e uma releitura. Reparos simultâneos (botão do Dashboard, subida do painel, fim da restauração, outra sincronização) continuam coalescidos por pasta de dados: o Stalwart reinicia uma vez.
- **Se o reparo não resolve**, o erro diz o que foi tentado e o próximo passo, conforme o resultado:
  - `mail_auth_repair_failed` (409): regravou e reiniciou, o servidor continua recusando; próximo passo: parar e iniciar em E-mail → Servidor e comparar a senha dos dois lados (comando abaixo, que só diz iguais ou diferentes).
  - `mail_auth_still_refused` (409): a senha confere, mas a leitura foi recusada de novo (nada foi reiniciado).
  - `mail_unreachable` (502): o servidor não respondeu durante o reparo.
  - `mail_auth_repair_incomplete` (409): o reparo parou no meio (falha ao copiar a configuração, ao reiniciar ou o servidor demorou a voltar); a mensagem traz o motivo curto, sem a senha, e não diz que "reiniciou e continua recusando".
  - `mail_server_stopped` (409): o servidor parou no meio. Também sai agora de Sincronizar e de repair-auth.
  Nenhuma resposta nem log traz a senha (teste confere).
- **Pendência no Dashboard**: quando a sincronização termina com erro de senha, o painel abre a pendência `mail-auth`, e o aviso âmbar do Dashboard passa a oferecer **Reparar agora**.
- **Tela de E-mail**: o erro de senha traz o botão **Reparar agora** ali mesmo (com confirmação: reinicia por alguns segundos, sem apagar dados). Dando certo, sincroniza de novo sozinha. Aparece para `mail_auth_failed` e `mail_auth_repair_failed`.

## 3. Por que o reparo do Dashboard não resolveu no caso do dono

Sem acesso à VPS dele, estas são as causas encontradas no código, em ordem de probabilidade:

1. **BUG corrigido: o botão dizia "ok" sem reparar.** `POST /api/mail/server/repair-auth` respondia 200 `{ok:true}` também quando o resultado era `unreachable` (a API do Stalwart ainda subindo depois do restart/restauração, ou fora do ar) ou `not_running`. A tela desfazia o aviso como se tivesse dado certo e nada tinha sido regravado. Agora esses dois casos viram erro (502 `mail_unreachable`, 409 `mail_server_stopped`) e o botão mostra a mensagem.
2. **BUG corrigido: o aviso só existia em dois caminhos.** A pendência `mail-auth` só era criada (a) no preparo da restauração do painel, se o Stalwart já rodava, e (b) no fim da restauração do e-mail, se o reparo automático falhava. Quem chegava ao 401 por outro caminho (iniciou o servidor depois, restaurou em outra ordem, dispensou o aviso) clicava em Sincronizar e não havia aviso no Dashboard. Agora o erro de senha na sincronização abre a pendência.
3. **Comportamento a conhecer (não alterado):** a conferência do aviso (`evaluateMailAuth`) trata `not_running` (senha vazia ou contêiner parado) como resolvido e o item some. Isso é coerente (o próximo "Iniciar" grava a configuração com a senha do painel), mas se o contêiner estava parado na hora de listar e depois subiu com a configuração antiga o aviso não volta sozinho. A sincronização com erro de senha reabre a pendência.
4. **Depende de dados da VPS:** o reparo regrava `etc/config.toml` com a senha do `mail.json` e reinicia. Se mesmo assim o Stalwart recusa, as hipóteses são: (a) o contêiner não existe com o nome `paas-stalwart` (o reparo age no nome fixo); (b) o `config.toml` do contêiner não é o que o Stalwart lê (outra imagem/versão ou configuração dentro do volume de dados restaurado que prevalece sobre o arquivo); (c) o `mail.json` tem uma senha com caracteres que o TOML não aceita sem escape. Para decidir sem imprimir a senha, rode na VPS (compara os dois lados e imprime só "iguais" ou "diferentes"; a senha nunca é impressa):

```bash
a=$(sudo docker cp paas-stalwart:/opt/stalwart-mail/etc/config.toml - | tar -xO | sed -n 's/^secret = "\(.*\)"$/\1/p' | tr -d '\n' | sha256sum)
b=$(sudo docker exec tws-panel node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/data/mail/mail.json','utf8')).adminSecret)" | sha256sum)
[ "$a" = "$b" ] && echo iguais || echo diferentes
sudo docker ps -a --filter name=paas-stalwart --format '{{.Names}} {{.Status}}'
sudo docker logs paas-stalwart --tail 50
```

   "diferentes": o reparo não gravou (veja o erro do painel e `docker logs tws-panel`). "iguais": a senha confere e o problema é outro (log do Stalwart). Os comandos estão também no guia de restauração (pt-br e en).

## 4. Testes

- `apps/server/tests/mail-adopt-service.test.ts` (integração com Stalwart falso por fetch): senha certa não reinicia; 401 na primeira chamada e sucesso depois do reparo (cadastra, `adminSecret` intacto, sem segredo no log); reparo coalescido entre duas instâncias (um só `applyTls`); reparo que também falha (409 `mail_auth_repair_failed`, sem laço, cadastro intacto, sem segredo na mensagem); reparo sem resposta, "ok" mas recusado, servidor parado.
- `mail-auth-error.test.ts`, `routes-mail-sync.test.ts` (abre a pendência; falha ao gravá-la não muda a resposta), `routes-mail-auth.test.ts` (unreachable/not_running não fingem sucesso).
- `apps/web/tests/mail-page.test.tsx`: Reparar agora na tela de E-mail (confirmar, cancelar, falha do reparo, erro sem botão).
- Os testes foram escritos antes da implementação; a falha prévia foi vista para os da tela (3 falhas) e os do servidor foram rodados já com a implementação.

## 5. O que não foi testado

- Reparo contra um Stalwart e um Docker reais (dublê do gerenciador e Stalwart falso por fetch).
- A VPS do dono: as causas da seção 3 (item 4) dependem do diagnóstico acima.
