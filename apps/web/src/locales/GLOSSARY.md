# Glossário da interface / Interface glossary

Termo fixo por conceito, nos dois idiomas. Quem traduz segue esta tabela; um
termo novo entra aqui antes de entrar nos dicionários.

| pt-BR | en | Observação |
| --- | --- | --- |
| projeto | project | |
| publicar / publicação (deploy) | deploy (verb and noun) | "deploy" fica em inglês nos dois idiomas quando é o nome da ação do painel: "Fazer deploy" / "Deploy" |
| histórico de deploys | deploy history | |
| domínio | domain | |
| domínio do painel | panel domain | |
| certificado | certificate | |
| renovar certificado | renew certificate | |
| backup | backup | "cópia de segurança" só em texto explicativo |
| restaurar / restauração | restore | |
| teste de restauração | restore test | validar o backup do banco restaurando-o em outro projeto |
| projeto de destino (do teste) | destination project | o projeto de teste que recebe o banco; nunca o de origem |
| servidor de e-mail | mail server | |
| caixa de e-mail | mailbox | |
| usar uma caixa que já existe | use a mailbox that already exists | liga o e-mail do projeto a uma caixa existente do domínio, sem apagar nada; a caixa passa a ser gerenciada pelo painel |
| senha atual da caixa / manter a senha guardada / trocar por uma gerada | mailbox's current password / keep the stored password / replace with a generated one | os três caminhos de senha ao usar uma caixa existente |
| e-mail / e-mails | email / emails | sem hífen em inglês |
| envios (módulo de e-mails enviados) | sending (section "Sending") | |
| fila (de envio) | queue | |
| reputação | reputation | |
| variáveis de ambiente | environment variables | |
| serviço (do compose) | service | |
| porta | port | |
| contêiner | container | |
| repositório | repository | |
| ramo / branch | branch | "branch" nos dois |
| fuso horário | time zone | |
| autenticação em dois fatores (2FA) | two-factor authentication (2FA) | |
| código de recuperação | recovery code | |
| sessão | session | |
| configurações | settings | |
| submenu de Configurações (seta ao lado do link) | Settings submenu | |
| ajuda e feedback (menu do cabeçalho) | help and feedback | |
| relatar um problema | report a problem | formulário de bug (issue) |
| sugerir uma funcionalidade | suggest a feature | formulário de sugestão |
| painel | panel | "TWS Panel" é o nome do produto |
| assistente (de instalação) | setup wizard | |
| endurecimento / hardening | hardening | termo técnico, fica "hardening" nos dois |
| baseline | baseline | |
| varredura / scan | scan | |
| alerta | alert | |
| auditoria / registro de auditoria | audit log | |
| saúde (do servidor) | health | |
| notificação | notification | |
| integração | integration | |
| primeiros passos | getting started | |
| entrar / sair (da conta) | sign in / sign out | |
| salvar / cancelar / excluir / apagar / remover | save / cancel / delete / delete / remove | "excluir" e "apagar" = delete (apaga de vez); "remover" = remove (tira de uma lista/vínculo) |
| conectar / desconectar | connect / disconnect | |
| verificar | check / verify | "verify" para DNS/domínio/propriedade; "check" para estado geral |
| ativo / inativo | active / inactive | |
| em execução / parado | running / stopped | |
| palavra de confirmação (digitar para confirmar) | confirmation word | em fonte de código, com dica de que é literal e botão de copiar (ConfirmWordInput) |
| dispensar (um aviso) | dismiss | aviso da restauração "O painel antigo tinha X ativo" |
| sincronizar (com o servidor de e-mail) | sync (with the mail server) | cadastra no painel os domínios e caixas que o servidor de e-mail já tem; não ativa nada nem lê senhas |
| reparar | repair | reaplica a configuração do servidor de e-mail com a senha do painel e o reinicia, sem apagar dados; também é tentado uma vez, sozinho, ao sincronizar |

Termos técnicos ficam como estão nos dois idiomas: Docker, Docker Compose,
Caddy, SMTP, IMAP, DKIM, SPF, DMARC, DNS, TLS, SSH, Let's Encrypt, Git,
GitHub, UFW, Fail2ban, systemd, cron, webhook, token, root.

## Tom

- Inglês: direto, voz ativa, segunda pessoa implícita ("Save changes", "Your
  backup finished"), sem tradução palavra por palavra. Capitalização de frase
  ("Add domain"), não Title Case, exceto nomes próprios.
- Português: como já está na interface; não reescrever o que existe.
- Reticências em estados de progresso: `…` (um caractere) nos dois idiomas.
- Exemplos de domínio/e-mail: sempre `example.com`.
