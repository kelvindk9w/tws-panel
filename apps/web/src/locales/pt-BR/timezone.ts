// Namespace "timezone" (pt-BR). Chaves planas; plural com sufixos _one/_other.
export default {
  // TimezonePicker
  "picker.ariaLabel": "Fuso horário",
  "picker.placeholder": "Busque pela cidade ou pelo nome do fuso",
  "picker.optionWithPlace": "{zone} — Brasil: {place}",

  // TimezoneSettings (helpers)
  "setting.host": "Igual ao da VPS",
  "setting.image": "Padrão da imagem",
  "source.env": "O arquivo /opt/tws-panel/.env define TZ={zone}. Ele manda no painel: depois de um reinício do painel, volta a valer esse fuso. Para o painel seguir a VPS, apague a linha TZ desse arquivo.",
  "source.saved": "Último fuso lido da VPS (agora não deu para ler de novo).",
  "source.localtime": "Lido do /etc/localtime da VPS montado no container. Se você trocou o fuso pelo SSH, pode estar desatualizado.",
  "source.default": "Não deu para descobrir o fuso da VPS; o painel usa UTC.",

  // ProjectRestartResults
  "restart.failed": ": não reiniciou — {error}",
  "restart.running": ": reiniciando com o fuso novo. <link>Acompanhe em Deploys</link>.",

  // TimezoneSettings
  "error.generic": "Não foi possível concluir agora. Tente de novo em instantes.",
  "loading": "Carregando…",
  "applied": "A VPS agora está em {zone}. O painel e a agenda dos backups já usam esse fuso.",
  "card.title": "Fuso horário",
  "card.description": "O fuso da VPS define o horário dos backups (03:00) e as datas dos registros. Trocar aqui muda o fuso da VPS inteira, sem precisar de SSH.",
  "current": "A VPS está em <b>{zone}</b>. Agora são <clock>{time}</clock> lá.",
  "panelUsing": "O painel está usando {zone}.",
  "newZone": "Fuso novo",
  "newZoneHint": "Os do Brasil aparecem primeiro. Busque pela cidade ou pelo estado.",
  "projects.legend": "Aplicar também nestes projetos",
  "projects.help": "Os marcados passam a usar “Igual ao da VPS” e reiniciam com o fuso novo (sem baixar código novo). Os outros mantêm o fuso que têm.",
  "projects.markAll": "Marcar todos",
  "projects.markNone": "Nenhum",
  "projects.today": "— hoje: {setting}",
  "projects.following_one": "{names} segue o fuso da VPS, mas só pega o fuso novo depois de reiniciar ou reimplantar.",
  "projects.following_other": "{names} seguem o fuso da VPS, mas só pegam o fuso novo depois de reiniciar ou reimplantar.",
  "apply": "Aplicar na VPS",
  "applying": "Aplicando…",
} as const;
