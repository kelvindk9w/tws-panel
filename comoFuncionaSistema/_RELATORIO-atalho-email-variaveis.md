# Relatório — atalho do e-mail do projeto na aba Variáveis

## O problema
O compose do dono exige `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD` e `SMTP_FROM`. A aba Variáveis não dizia que o E-mail do projeto preenche a maioria; o dono teve de descobrir a ordem sozinho (criar o e-mail, ligar os nomes, criar `SMTP_SECURE=false`).

## O que mudou (pelo comportamento)
- Na aba Variáveis, quando o compose exige variáveis de e-mail, aparece um aviso com o estado de cada uma: fornecida pelo e-mail do projeto, ligada a um valor, ou falta.
- E-mail desligado: o aviso diz que não é preciso digitar essas variáveis e oferece o botão **Ligar o e-mail do projeto**, que abre o cartão E-mail do projeto.
- E-mail ligado, mas com nomes diferentes do padrão: botões **Ligar SMTP_PASSWORD ao valor SMTP_PASS** (um por sugestão) e **Ligar todas as sugeridas**, com a lista do que será ligado escrita antes. Só a ligação é guardada; nada é copiado para as Variáveis. As ligações que já existiam são preservadas. Acima de 30 ligações não sugere.
- Variáveis que o e-mail não fornece (`SMTP_SECURE`, `SMTP_REQUIRE_TLS`...): o aviso diz que são manuais. Para `SMTP_SECURE` explica que a porta 587 com STARTTLS pede `false` (465, TLS implícito, seria `true`) e oferece **Adicionar SMTP_SECURE=false**, que só põe a linha na tabela; salvar continua sendo com a pessoa.
- Colisão: em projeto compose o container recebe o valor do e-mail (o override vem por cima no `-f`); o valor digitado num nome padrão só vale na interpolação do `.env`. Num nome ligado, a ligação vence e o valor salvo é ignorado. O aviso diz isso.
- O botão Ligar monta o PUT a partir das ligações guardadas (sem o filtro de "o e-mail entrega agora"), então nenhuma ligação existente é apagada; não sugere quando o e-mail não entrega os valores padrão (caixa adotada de senha desconhecida) nem para nome já ligado.
- Introdução e botão "Ligar o e-mail do projeto" só aparecem se alguma variável de e-mail está faltando (não só `SMTP_SECURE`).
- Clique duplo não repete a chamada; falha da rota mostra um alerta com o nome da variável e a mensagem do servidor.
- Sem aviso quando tudo está resolvido ou o projeto não usa essas variáveis. Se não der para consultar o e-mail, o aviso diz isso e aponta para a tela do e-mail.
- O assistente de novo projeto não lista variáveis obrigatórias (só leva à aba Variáveis), então o aviso vive apenas aqui.

## Arquivos
- `apps/web/src/lib/email-env-advice.ts` (regras), `apps/web/src/components/project/EnvEmailAdvice.tsx` (aviso), `apps/web/src/components/ProjectEnvCard.tsx` (integração).
- `packages/core/src/mail.ts`: `MAX_PROJECT_EMAIL_LINKS` exportado (o servidor passou a usá-lo; sem mudança de comportamento).
- Textos: `apps/web/src/locales/{pt-BR,en}/env.ts` (chaves `email.*`). Nenhum texto novo vem do servidor.
- Testes: `apps/web/tests/env-email-advice.test.tsx`, `apps/web/tests/email-env-advice-lib.test.ts`.

## Não verificado
- Layout em 360/1024 px só por classes (quebra de linha, `overflow-wrap`); não abri no navegador.
- Estado do servidor de e-mail (parado/em pausa) não é consultado: ligar nomes é só configuração.
