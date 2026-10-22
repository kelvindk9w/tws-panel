# Relatório — travas do login com verificação em duas etapas

Base: análise do fluxo real de login (22/10/2026, branch `dev` em `4e05f20`). Recomendação implementada:
manter o fluxo em dois passos e reforçar as travas. Cada afirmação da análise foi conferida no código antes
da mudança (rota única `POST /api/auth/login`, nenhum estado entre os passos, limite só por IP, em memória,
sem limite nas rotas com sessão aberta, sem aviso ao dono) e bateu.

## O que passou a acontecer

1. **Bloqueio por conta no código de 6 dígitos.** 5 erros seguidos, de qualquer IP, bloqueiam o código do
   app por 5 min; cada reincidência dobra (5, 10, 20, 40 min... teto de 24 h). Bloqueada, a conta recusa
   até o código certo. O estado vive no registro `twoFactor` do `users.json` (campos opcionais
   `failedCodes`, `lockLevel`, `lockedUntil`; arquivo 0600, gravação atômica) e sobrevive a reinício. A
   decisão roda dentro de `UserStore.updateTwoFactor` (a fila de gravação), por isso pedidos simultâneos de
   IPs diferentes não passam do limite (testado com 60 pedidos de 60 IPs: exatamente 5 conferidos).
2. **Saída do dono.** O código de recuperação (qualquer entrada que não seja 6 dígitos) nunca é bloqueado,
   não conta falha e, como qualquer acerto, zera o bloqueio. O `scripts/reset-2fa.sh` desliga o 2FA (o
   bloqueio vai junto) e ganhou `--so-bloqueio` (confirmação `liberar`), que mantém o 2FA e limpa só o
   bloqueio.
3. **Mensagem.** `429 two_factor_locked` com `Retry-After` ("tente mais tarde ou use um código de
   recuperação"), com `retryAfterSec`; a tela de login mostra o tempo restante. O 429 só aparece a quem já
   acertou a senha; senha errada ou usuário inexistente seguem 401 `invalid_credentials` mesmo com a conta
   bloqueada, para não enumerar usuários. Custo: o 429 confirma a senha, que os `two_factor_required` e
   `invalid_two_factor_code` anteriores já confirmavam (o "oráculo" que a análise aceitou).
4. **Senha certa sem código NÃO conta para o IP** (revisado após o aviso de tentativas restantes). O primeiro
   passo devolve a reserva: contá-lo gastava as tentativas do dono antes do primeiro erro de código.
5. **Auditoria e aviso.** Todo login legítimo com 2FA passa pelo primeiro passo (senha certa, sem código),
   então avisar nele seria ruído. O primeiro passo abre uma "pendência" por IP/64 + conta (`LoginWatch`);
   concluir o login em 5 min a apaga; ao expirar vira `auth.2fa_abandoned` (ou `auth.2fa_wrong_code` se
   houve código recusado) e entra num Alerta de origem `login`, tipo de notificação `security`. Vários erros
   (3 ou mais) antes de entrar também geram evento. Agrupamento: no máximo um alerta por tipo a cada 15 min,
   com a contagem; o AlertsService ainda reaproveita o alerta aberto de mesmo título. O bloqueio da conta
   avisa na hora (Alerta crítico + `auth.2fa_locked`). O alerta mostra o usuário do painel e o IP só
   mascarado (/24 no IPv4, /64 no IPv6); nunca senha nem código.
6. **Rotas com sessão aberta** (trocar senha, ativar e desativar 2FA, recomeçar o assistente): limite por
   conta (não por sessão nem IP), mesma regra do login (5 erros/min, bloqueio de 1 min dobrando até 30 min),
   429 `too_many_attempts`. Só a ação concluída zera; senha fraca e conflitos não contam. Código errado em
   desativar e recomeçar também soma no bloqueio da conta do 2FA.
7. **IPv6 por /64** no limitador por IP (IPv4 por endereço). IPv4 mapeado em IPv6 (`::ffff:1.2.3.4`,
   `::ffff:102:304`, `0:0:0:0:0:ffff:1.2.3.4`, com ou sem zona) é normalizado para o IPv4. O hash fictício da
   senha agora é gerado na inicialização do painel. `cf-connecting-ip` e `cf-ray` não mudam o IP contado
   (testado).
8. **Cloudflare.** Documentado nos guias de segurança (pt-br e en). `EdgeWatch` percebe `cf-ray` ou
   `cf-connecting-ip` e `GET /api/security/edge` alimenta um aviso na tela Segurança (pt-BR e en).

## Decisões

- Estado do bloqueio dentro do registro do 2FA, em vez de arquivo novo: gravação atômica e fila já
  existentes, e desligar o 2FA limpa o bloqueio sem código extra.
- Falhas consecutivas sem expirar por tempo (estilo NIST 800-63B); só o acerto zera. O nível esfria se o
  último bloqueio venceu há mais de 24 h.
- Aviso pela pendência com atraso de até 5 min (mais o ciclo de 30 s do vigia), em troca de não alarmar a
  cada login do dono. O bloqueio da conta não tem atraso.
- Chaves do limitador de ações: o IP (/64) e `sessao:<id>`, reaproveitando o `LoginLimiter`. Um limite por conta deixaria um atacante trancar o dono fora das rotas sensíveis (apontado na revisão).

## Limites e riscos

- Quem tem a senha pode trancar o código do app do dono por até 24 h. Mitigação: teto de 24 h, código de
  recuperação passa, aviso na hora, script `--so-bloqueio`. Custo para o dono: um código de recuperação.
- Dono sem código de recuperação e sem acesso SSH fica esperando o bloqueio vencer.
- Se a gravação do `users.json` falha, o erro do código não é contado (a gravação é desfeita) e a rota
  responde 500; o limite por IP segue valendo, mas o da conta não conta nesse intervalo.
- Dono que digita só a senha e desiste gera um aviso "se não foi você" depois de 5 min (aceito).
- O estado das pendências e o agrupamento ficam em memória: um reinício perde o que ainda não virou evento.
- Os cabeçalhos da Cloudflare podem ser forjados; o pior efeito é o aviso na tela Segurança.
- Com o proxy da Cloudflare ligado a proteção por IP não funciona; a recomendação segue sendo nuvem cinza.
- Primeiro passo contando como tentativa: o dono com 4 erros de código seguidos é bloqueado por IP 1 min
  (antes eram 5 erros).
- Não foi verificado em VPS real: IPv6 de ponta a ponta atrás do Caddy e o `reset-2fa.sh --so-bloqueio`
  com Docker de verdade (o `.sh` é testado com um `docker` falso que roda o `.mjs`: confirmação, ordem
  parar → gravar → subir, 0600, cancelamento, painel parado e `--help`).

## Próximos passos (fora desta rodada)

1. 2FA obrigatório ao fim do setup em HTTPS, com carência para instalações existentes.
2. Passkey/WebAuthn como segundo fator e depois como entrada principal (exige domínio estável).
3. Formulário único sem oráculo (campo do código sempre visível, erro genérico).

## Compatibilidade

Campos novos opcionais; sem migração. `users.json` antigo carrega e funciona (testado).
