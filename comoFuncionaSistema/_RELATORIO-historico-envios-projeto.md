# Relatório — histórico de envios por SMTP do projeto (22/10/2026)

Repositório público: nada aqui tem IP, domínio, token ou bucket reais. `example.com`,
`exemplo.net` e `203.0.113.x` são valores de exemplo. Módulo descrito em
`email/saidas.json`.

## O pedido

Ver o que o APP de um projeto envia por SMTP pela caixa do projeto (de, para, hora, assunto,
texto, estado e motivo do erro), por projeto e no global, com assunto e corpo ocultos por
padrão, retenção configurável e envio nunca atrasado pelo registro.

## Como capturamos (e o que descartamos)

Testado contra um Stalwart v0.11.8 REAL em Docker (rede `--internal`).

| Opção | Resultado |
|---|---|
| MTA hook (`session.hook`, fase `data`) | ESCOLHIDA. Traz login, id da fila, envelope, cabeçalhos e a mensagem inteira. Filtro `!is_empty(authenticated_as)` deixa de fora o correio recebido na porta 25 (conferido). |
| Webhooks de eventos | Sem assunto nem corpo. Não serve sozinho. |
| Histórico/tracing do Stalwart | Só na edição Enterprise. |
| Registro (docker logs) | Sem conteúdo; já usado para ESTADO e MOTIVO (mecanismo existente de Envios). |
| API da fila | Só o que está na fila agora; usada na reconciliação. |

Estado e motivo continuam vindo do registro do container (a cada 5 min); o id da fila do aviso
(hexadecimal) é o mesmo número decimal do registro.

## Decisões

- **Envio não depende do registro:** `tempfail-on-error = false`, timeout de 2 s. Painel parado:
  envio aceito sem atraso (medido no teste real). Falha ao gravar vira contador, sem conteúdo.
- **Receptor separado** (porta 9100, `PAAS_MAIL_HOOK_PORT`, 0 desliga), fora do Caddy e fora do
  `ports:` do compose. Motivo: o plugin de auth do painel só cobre `/api/*`, então uma rota no
  servidor principal ficaria pública pelo Caddy.
- **Segredo derivado** (HMAC do adminSecret): nada novo para guardar, trocar ou restaurar.
  Comparação em tempo constante, antes de ler o corpo.
- **Retenção:** metadados 90 dias, corpo 14 dias (propostos pelo pedido), corpo máx. 64 KiB,
  total 100 MiB, anexos só nome e tamanho.
- **Backup:** metadados entram; conteúdo (assunto/corpo) NÃO. Sensível, efêmero e inútil
  numa VPS nova.
- **Revelar é POST auditado** (`mail.send.reveal`, sem conteúdo), com `no-store`.
- Recebidos de fora e entregas locais não viram "envio": registros só do log existem apenas para
  remetentes conhecidos.

## Correções da 1ª revisão (22/10/2026)

1. Remetente forjado na porta 25 não vira "envio do projeto": registro só pelo log vale apenas para destinatário de fora do servidor.
2. HTML para texto agora é uma passada linear, com teto de entrada menor (2x o corpo); teste de tempo com HTML hostil.
3. O ouvido sobe com o painel (em container) mesmo sem servidor de e-mail criado; instalação nova não precisa reiniciar.
4. `envios-conteudo` entra em `PANEL_PRESERVED`: a restauração do painel não o copia para "antes da restauração".
5. Assunto e corpo só de caixas de PROJETO; webmail e caixas pessoais guardam só os dados da mensagem (texto na aba Privacidade, site e CHANGELOG).
6. Só o container do Stalwart é aceito (origem conferida) e as tentativas ruins contam por origem.
7. `PAAS_MAIL_HOOK_PORT` repassada pelo docker-compose e documentada em `global/configuracao.json`.
8. O destinatário de um evento do log tem de estar entre os da mensagem (texto remoto não cria destinatário falso).
9. Corpo máximo 8 MiB, 2 pedidos ao mesmo tempo, fila de 16 avisos.
10. Conteúdo só é marcado como apagado depois que o arquivo realmente saiu.
11. Mensagem própria ao desligar a gravação e confirmação no checkbox do projeto.
12. "Último envio registrado" é do projeto.
13. Registro só pelo log: hora da entrega, tamanho 0, sem caixa (documentado).
14. Tela: a lista velha sai quando a recarga falha; rótulo do Exibir resumido; datas no mesmo formato.

## Limites e riscos

1. O receptor escuta em `0.0.0.0` dentro do container; outra rede Docker em que o painel esteja
   ligado o alcança. Proteção = segredo + limite de taxa. Não publique a porta.
2. Mensagem > 8 MiB é enviada, mas sem assunto/corpo (só metadados pelo log).
3. Recusa antes da fila (senha errada) não aparece.
4. Entregue/falhou pode demorar até 5 min (intervalo da leitura do log).
5. Atualizar o painel muda o `config.toml`: a primeira sincronização reinicia o Stalwart uma vez.
6. Assunto/corpo ficam em claro em `data/envios-conteudo/` (0700/0600) por até 14 dias; quem tem
   acesso ao disco da VPS os lê. Quem tem sessão no painel os lê pelo Exibir (auditado).

## Verificação feita

- Mailer 451 testes, ramos 98,16%. Servidor 2513 testes (cobertura 97,58/93,5/98,07/98,77).
  Web 1382 testes. `pnpm -r typecheck` e `check-no-real-hosts` ok.
- Integração real: `node_modules/.bin/tsx scripts/test-mail-send-log.mts` — 7 verificações:
  envio autenticado pela caixa do projeto aparece (projeto, anexo nome/tamanho); domínio
  inexistente = falha `no_mx` com o texto técnico guardado; recebido de fora não aparece;
  listagem sem assunto/corpo; Exibir devolve o conteúdo; painel parado = envio aceito e
  reconstruído depois só com metadados. Cria e remove os contêineres `paas-sendlog-*` e a rede
  `paas-sendlog-it`.

## Como validar na VPS (`/opt/tws-panel`)

1. `cd /opt/tws-panel && git pull && docker compose up -d --build`
2. Painel → E-mail: aguarde a sincronização (o Stalwart reinicia uma vez).
3. Envie um e-mail pelo app do projeto e abra Projeto → Envios; confira o estado após até 5 min.
4. Clique em Exibir e confira o registro de auditoria (`mail.send.reveal`, sem texto).
5. Não publique a porta 9100 (`docker ps` não deve mostrar `9100->`).
