# Relatório — Frente A: segurança e hardening

Data: 2026-10-16 · Branch: `fix/frente-a-seguranca` (a partir de `origin/dev` 1aaf649) · Sem push.

Achados de `CODE_REVIEW.md` tratados: 17, 20, 21, 23, 24, 25 e 26 (reavaliação em `AVALIACAO.md`).
Em todos, o teste foi escrito antes da correção e falhou no código antigo pelo motivo do achado.
Os scripts de hardening foram testados de verdade num Ubuntu 24.04 descartável (Docker, com
`NET_ADMIN` para o UFW poder ser ativado dentro do container), e passaram no `bash -n` e no
shellcheck 0.10.0. Os avisos que sobram no shellcheck já existiam antes.

## 17 — Intervalo do monitor acima do limite do timer

- **Era:** a API e a tela Segurança aceitavam qualquer intervalo. Acima de 2^31-1 ms (~597 h) o Node
  troca o atraso do `setInterval` por 1 ms: com 720 h, o scan rodava sem parar, rodando comandos
  no host e escrevendo um aviso de ciclo pulado a cada milissegundo. O valor ficava salvo e voltava
  depois de reiniciar o painel.
- **Decisão:** limitar a 168 h, o mesmo teto da tela de Notificações. Descartei agendar em etapas
  porque um scan por semana já é o mínimo útil para monitoramento, e assim o painel fica com uma
  regra só, explicável na tela.
- **Teste que reproduziu:** `packages/security/tests/monitor.test.ts`. Um agendador de 30 dias
  rodou a tarefa 38 vezes em 40 ms. Também falharam antes da correção os testes da API (720 h
  devolvia 200), do serviço (o valor de 720 h ficava como estava) e da tela (o campo não tinha
  limite).
- **O que mudou:**
  - `MONITOR_MAX_INTERVAL_MS` (168 h) foi criado em `packages/core`.
  - A API recusa valores acima disso com 400.
  - O serviço também limita os valores vindos da variável de ambiente e de um `monitor.json`
    gravado antes do teto.
  - O agendador nunca entrega ao timer um atraso acima de 2^31-1.
  - A tela tem `max=168` e mostra "Informe um número de horas entre 1 e 168 (uma semana)."
- **Testado de verdade:** timers reais do Node (sem relógio simulado) e Fastify `inject`.
  O estado salvo em disco foi testado numa pasta temporária.

## 20 — Erro transitório na confirmação interrompe a fila

- **Era:** se o POST de confirmação falhasse, a tela tratava a falha como "desfeito pelo
  operador". A fila parava e a mensagem dizia que o rollback tinha sido executado, mas o servidor
  continuava aguardando. Um segundo clique confirmava no servidor, e mesmo assim a tela ficava presa
  no erro.
- **Teste que reproduziu:** `apps/web/tests/security-step.test.tsx`, em "falha transitória ao
  confirmar o acesso". A primeira confirmação falha na rede e a segunda dá certo. Antes da correção,
  o quadro "run-failed" aparecia logo depois da primeira falha.
- **O que mudou:** quando a confirmação falha, a tela mostra o erro e continua esperando. O polling
  segue ativo e o operador pode tentar de novo. O desfecho vem só do status do servidor: confirmado,
  desfeito ou prazo vencido. Uma confirmação que dá certo apaga o aviso da tentativa anterior.
- **Testado de verdade:** teste de interface com `apiFetch` simulado. Não foi testado com o
  servidor real.

## 21 — Relógio do navegador adiantado desabilita a confirmação

- **Era:** o alerta comparava o prazo absoluto do servidor com o `Date.now()` do navegador. Com o
  computador 10 minutos adiantado, uma janela nova de 5 minutos já aparecia vencida, e os botões
  "confirmar" e "desfazer" ficavam travados.
- **Teste que reproduziu:**
  - `apps/web/tests/access-test-alert.test.tsx`: com o relógio local 10 minutos adiantado, os botões
    apareciam desabilitados.
  - `apps/server/tests/routes-security-schema.test.ts`: a resposta não trazia o campo
    `rollbackRemainingMs`.
- **O que mudou:**
  - Toda resposta com job (consultar, aplicar, confirmar, desfazer) traz `rollbackRemainingMs`,
    medido no relógio do servidor. O campo existe só na resposta: não é salvo e não altera o job do
    executor.
  - O alerta conta a partir desse valor e usa o relógio local só para medir o tempo que passou.
  - Cada nova resposta ressincroniza a contagem.
  - O alerta só aparece quando o servidor mandou o tempo restante.
- **Testado de verdade:** relógio do navegador simulado (adiantado e atrasado) e Fastify `inject`.
- **Limite:** se o relógio local der um salto durante a janela (por exemplo, um ajuste do NTP), a
  contagem se desloca até a próxima resposta do servidor. Isso dura no máximo 2 segundos durante o
  polling.

## 23 — Mutex liberado enquanto a fase depende de confirmação

- **Era:** o executor liberava a trava assim que a fase entrava em "aguardando confirmação". Um
  segundo job podia então começar enquanto o primeiro ainda esperava. Como os scripts usam um id
  fixo por fase, a segunda execução sobrescrevia o backup e a reversão agendada da primeira. A
  reversão antiga ficava órfã e rodava assim mesmo, e confirmar o job antigo cancelava a proteção
  do novo.
- **Teste que reproduziu:**
  - `packages/security/tests/executor.test.ts`, em "trava enquanto a fase aguarda confirmação":
    `isBusy` ficava falso e um segundo job da fase 02 era aceito. Isso também valia para um job
    restaurado depois de reiniciar o painel.
  - `packages/security/tests/phase03-04-scripts.test.ts`: com a reversão anterior ainda viva, as
    fases 03 e 02 reaplicavam por cima.
- **O que mudou:**
  1. O executor considera ocupado também o caso de existir um job aguardando confirmação. A API
     responde 409 dizendo qual fase espera. A trava só sai quando a fase é confirmada, desfeita ou
     tem o prazo vencido (prazo + 15 s). Se o desfazer falhar no servidor, a trava continua.
  2. Nos scripts, as fases 01, 02 e 03 chamam `require_no_pending_rollback` antes de mexer em
     qualquer coisa. A fase recusa reaplicar enquanto a reversão anterior ainda vai rodar, ou seja,
     enquanto o job do `at` está na fila ou o timer está vivo. Os arquivos de uma reversão que já
     rodou não bloqueiam. Na simulação, só aparece um aviso.
- **Vínculo do rollback ao job:** não renomeei os arquivos de reversão com o id do job. Com as duas
  travas, nunca há duas aplicações da mesma fase esperando confirmação ao mesmo tempo. Por isso, o
  id fixo por fase identifica sem ambiguidade a única reversão pendente, e confirmar ou desfazer só
  vale para o job que está em `awaiting_confirmation`.
- **Testado de verdade:** o executor foi testado com um alvo falso que segue o protocolo da execução
  destacada. A guarda dos scripts foi testada no Ubuntu real: com a reversão viva, a fase 03 sai com
  código 1 e o UFW continua inativo; com o processo da reversão morto, a fase aplica normalmente.
  Não testei com o `at` instalado (o container não tem `atd`): o caminho do `atq` foi conferido só
  por leitura.

## 24 — Firewall presume SSH na porta 22

- **Era:** a fase 03 liberava só a 22 antes de ativar "deny incoming". Numa VPS com o sshd em 2222,
  novas conexões SSH ficavam bloqueadas até o rollback automático. A jail sshd do fail2ban também
  vigiava a porta errada.
- **Teste que reproduziu:** `packages/security/tests/phase03-04-scripts.test.ts`, em "porta real do
  SSH no firewall". Com o sshd em 2222, o UFW ficava ativo sem regra para a 2222.
- **O que mudou:**
  - `detect_ssh_ports` em `lib.sh` soma quatro fontes:
    - a configuração efetiva (`sshd -T`);
    - as portas em que o sshd escuta (`ss -tlnp`);
    - a ativação por socket (`ssh.socket`);
    - na falta das anteriores, as linhas `Port` dos arquivos de configuração.
  - Se nenhuma fonte der resultado, a porta é 22.
  - A fase 03 libera todas essas portas antes de ativar o UFW. Antes de ativar, confere em
    `ufw show added` que cada porta tem regra; se faltar alguma, não ativa.
  - `--ssh-port` soma uma porta às detectadas, nunca as substitui.
  - A fase 04 usa as mesmas portas na jail sshd.
- **Testado de verdade:** no Ubuntu real, com o sshd em 2222, em 22 + 2222, sem sshd e sem
  configuração (cai para 22) e com `--ssh-port` explícito. O UFW foi ativado de verdade e ficou com
  `2222/tcp ALLOW`.
- **Não testado:** `ssh.socket`, porque o container não tem systemd. Esse caminho foi conferido só
  por leitura.

## 25 — Pacote em estado "rc" visto como instalado

- **Era:** `pkg_installed` usava `dpkg -s`, que também sai com sucesso quando o pacote foi removido
  sem purge (estado "rc"). `apt_install` não reinstalava, e a fase caía depois por falta do binário.
- **Teste que reproduziu:** `packages/security/tests/phase03-04-scripts.test.ts`. O ufw removido sem
  purge aparecia como instalado e não era reinstalado.
- **O que mudou:**
  - Só o estado "ii" do `dpkg-query` conta como instalado, a mesma regra do scanner.
  - O purge passou a usar `pkg_known` e continua limpando os restos em "rc".
- **Testado de verdade:** no Ubuntu real, o ufw em "rc" é visto como ausente e volta para "ii".

## 26 — fail2ban já ativo não aplica as regras novas

- **Era:** o pacote sobe o serviço ao instalar, com a configuração padrão. A fase só chamava
  `enable --now`, que não recarrega um serviço já rodando. As jails próprias (recidive,
  maxretry 3, e-mail) só valiam depois de um reboot.
- **Teste que reproduziu:** `packages/security/tests/phase03-04-scripts.test.ts`, em "fail2ban já
  rodando". Depois da fase, a jail recidive não estava ativa.
- **O que mudou:**
  - Com o daemon já ativo, a fase recarrega o fail2ban depois de validar o `jail.local`.
  - Em seguida, confere em `fail2ban-client status` que cada jail do `jail.local` está ativa. Se
    faltar alguma, a fase falha e indica o rollback.
  - Sem daemon respondendo (alvo sem systemd nem `service`), só avisa, como antes.
- **Testado de verdade:** no Ubuntu real, com o fail2ban rodando a configuração padrão (só a jail
  sshd). Depois da fase, a recidive está ativa e `fail2ban-client get sshd maxretry` devolve 3.
- **Não testado:** o caminho com systemd (`systemctl reload`). No container o serviço sobe pelo
  `service`.

## Reforços pedidos pela revisão (sobre o achado 24)

- **Ordem no firewall:** na fase 03, o `ufw default deny incoming` vinha antes dos `ufw allow`. Com o
  UFW já ativo, o deny valia na hora e havia uma janela sem regra para o SSH. Os padrões agora vêm
  depois das regras do SSH, de HTTP/HTTPS e de e-mail, e antes do enable.
- **Porta da sessão atual:** `detect_ssh_ports` soma sempre a porta de `$SSH_CONNECTION` (4º campo),
  se for numérica e estiver entre 1 e 65535. Cobre sshd parado ou `sshd -T` falhando (por exemplo,
  Port num Include fora de `sshd_config.d`). Sem nenhuma outra fonte, a lista fica só com essa porta.
- **`--ssh-port` na fase 04:** passou a recusar valores fora de 1-65535 (a fase 03 já recusava).
- Testado no Ubuntu real, em `packages/security/tests/phase03-04-scripts.test.ts`. Cada teste novo
  falhou antes da correção.

## Verificação geral

- `pnpm -r run typecheck`: passou em todos os pacotes.
- `pnpm -r --workspace-concurrency=1 --no-bail run test:coverage`: passou em todos os pacotes, sem falha e sem limite de cobertura reprovado (1710 testes passaram e 2 foram pulados, só no pacote da web).
- shellcheck 0.10.0 (`koalaman/shellcheck` via Docker) em `lib.sh` e nas fases 01–04: nada novo.
- Não mexi nas áreas das frentes B (deploy, projetos, certificados) e C (sessão, terminal,
  notificações, envios de e-mail).

## Documentação atualizada

- `monitoramento/configurar-monitor.json`
- `monitoramento/index.json`
- `seguranca/aplicar.json`
- `seguranca/job.json`
- `seguranca/confirmar-acesso.json`
- `seguranca/conceito-fases.json`
- `seguranca/index.json`
