# Relatório — rede de e-mail e serviços com `network_mode`

## O problema
Projeto cassino com e-mail habilitado falhava no deploy: "service web declares mutually exclusive `network_mode` and `networks`". Com e-mail, todos os serviços ganhavam `networks` (rede paas-mail) no override, inclusive `web` e `caddy`, que usam `network_mode: service:wallet`. O compose proíbe os dois juntos.

## O que mudou (pelo comportamento)
- Serviço com `network_mode` nunca recebe `networks` no override (nem a rede de e-mail, nem a do proxy).
- Com `network_mode: service:X`, quem entra na rede de e-mail é o dono X, mesmo que X não estivesse na lista; web e caddy alcançam o servidor de e-mail pela rede do dono. Cadeia (A usa B, B usa C) leva ao último dono.
- `host`, `none`, `bridge`, `container:...`, dono inexistente e ciclo: nada é gerado para o serviço e o log avisa que ele não alcança o servidor de e-mail. O override nunca fica inválido.
- Se o serviço do proxy usa `network_mode`, a rede do proxy (com o alias do projeto) vai para o dono.
- Log do deploy: continua "Env vars injetadas nos serviços"; acrescenta "Rede de e-mail paas-mail ligada em: ..." e "E-mail: ... compartilham a rede de X (network_mode) e usam a dela...".
- Containers já rodando (migração/ligar projeto): os que compartilham a rede de outro não recebem `network connect` (o Docker recusa) e não entram na contagem.

## Testes
Unitários para cada tipo de `network_mode`, cadeia, ciclo, dono inexistente; integração com compose no formato do cassino validada com `docker compose config` real; engine confere override e logs.

## Não testado
Deploy real numa VPS com o cassino e o Stalwart (só `docker compose config`, sem subir containers).
