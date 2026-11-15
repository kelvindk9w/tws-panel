---
title: "Disco maior que o espaço em uso (ampliar a partição)"
description: "Por que, depois de aumentar o disco no provedor, a VPS continua com o espaço antigo, como o painel avisa e o passo a passo seguro para ampliar a partição e o sistema de arquivos."
sidebar:
  label: "Ampliar o disco"
---

Quando você aumenta o disco da VPS no painel do provedor (um upgrade de plano, por exemplo de 100 GB para
200 GB), o provedor aumenta o **disco**, mas quase nunca a **partição** e o **sistema de arquivos** que estão
dentro dele. O resultado é este:

```text
$ lsblk -d
NAME SIZE TYPE
sda  200G disk

$ df -h /
Filesystem  Size  Used Avail Use% Mounted on
/dev/sda1    96G   75G   22G  78% /
```

O disco tem 200 GB, mas o sistema continua enxergando só 96 GB. O espaço novo existe, mas ainda não pode ser
usado: nenhum arquivo cabe nele até a partição e o sistema de arquivos serem ampliados.

## O que o painel mostra

O painel mede o espaço do sistema de arquivos onde ficam os dados dele (o mesmo número do `df`). Por isso, sem
ampliar, ele continua mostrando o espaço antigo e a previsão de "enche em X dias" conta só esse espaço.

Quando o disco é bem maior que o sistema de arquivos, o painel avisa:

- **Dashboard, cartão Disco**: "O disco tem 200 GB, mas o sistema usa só 95,8 GB. O restante (100 GB) ainda
  não foi liberado", com o dispositivo (por exemplo `Disco /dev/sda, partição /dev/sda1 (ext4)`) e o link para este
  guia. Se houver previsão de encher, o cartão diz que ela conta só o espaço em uso.
- **Lista de atenção da Saúde da VPS**: se o disco já está em atenção (quase cheio ou enchendo rápido), o item
  do disco ganha a mesma explicação e o botão **Como ampliar o disco**. Se o disco está em ordem, aparece um
  item só **informativo**, que não conta como problema.

O "restante" é o que ampliar de fato libera. Ele é um pouco menor que a conta disco − sistema de arquivos
(200 − 95,8), porque o sistema de arquivos sempre é um pouco menor que a partição: o ext4 guarda as tabelas de
inodes fora do total que o `df` mostra (cerca de 1,5% a 3% no padrão, mais com muitos inodes), e o painel
desconta essas tabelas.

O aviso aparece quando esse espaço passa de **10% do disco e de 5 GB** ao mesmo tempo, o que fica bem acima da
diferença normal entre partição e sistema de arquivos.

O painel **nunca amplia nada sozinho**. Mexer na tabela de partições é com você, e ele também não avisa quando
não consegue ter certeza do arranjo do disco (LVM, RAID, partição lógica, sistema de arquivos que não seja
ext4 ou xfs). Depois de ampliar, o aviso some em até 5 minutos.

## Antes de começar

1. **Faça um snapshot** (ou backup do disco) no painel do provedor. Ampliar uma partição é uma operação segura
   e comum, mas é a tabela de partições do disco onde está o sistema: com o snapshot, qualquer erro tem volta.
2. Os comandos são rodados **na VPS**, por SSH, com um usuário que tenha `sudo`. Não é preciso parar o painel nem
   os projetos: o ext4 e o xfs são ampliados com o sistema montado e funcionando, sem reiniciar.
3. Instale o `growpart`, se ainda não tiver (no Ubuntu e no Debian ele vem no pacote `cloud-guest-utils`; nas
   imagens de nuvem já costuma estar instalado):

   ```bash
   sudo apt install cloud-guest-utils
   ```

## Passo a passo

Os exemplos usam o disco `/dev/sda` e a partição `1` (`/dev/sda1`), o caso mais comum. Use os nomes que o
cartão Disco do painel mostra; as variações para outros discos estão [mais abaixo](#outros-nomes-de-disco).

### 1. Confira o disco e a partição

```bash
lsblk
```

```text
NAME    MAJ:MIN RM   SIZE RO TYPE MOUNTPOINTS
sda       8:0    0   200G  0 disk
├─sda1    8:1    0    99G  0 part /
├─sda14   8:14   0     4M  0 part
├─sda15   8:15   0   106M  0 part /boot/efi
└─sda16 259:0    0   913M  0 part /boot
```

O disco (`sda`, `TYPE disk`) tem 200 GB e a partição do sistema (`sda1`, montada em `/`) tem 99 GB. Confira
também que o `TYPE` da linha montada em `/` é `part`. Se for `lvm`, **pare**: veja
[Quando não fazer](#quando-não-fazer).

Se o `lsblk` ainda mostra o tamanho antigo do disco, o sistema não percebeu o aumento: reinicie a VPS (ou siga
a orientação do provedor) e confira de novo.

### 2. Confira o tipo do sistema de arquivos

```bash
df -T /
```

```text
Filesystem     Type  1K-blocks     Used Available Use% Mounted on
/dev/sda1      ext4  100476656 78643200  21833456  78% /
```

A coluna `Type` diz qual comando usar no passo 5: `ext4` (também `ext2` ou `ext3`) ou `xfs`.

### 3. Simule a ampliação da partição

```bash
sudo growpart --dry-run /dev/sda 1
```

Repare no espaço entre `/dev/sda` e o `1`: o primeiro é o **disco**, o segundo é o **número** da partição.
Nada é alterado; o comando só diz o que faria:

```text
CHANGE: partition=1 start=2099200 old: size=207615967 end=209715166 new: size=417331167 end=419430366
```

- `CHANGE`: a partição pode crescer até o fim do disco (ou até o começo da próxima partição). Siga em frente.
- `NOCHANGE: partition 1 is size ... it cannot be grown`: não há espaço livre logo depois da partição. Não
  continue; veja [Quando não fazer](#quando-não-fazer). Se a partição já foi ampliada e só falta o sistema de
  arquivos, pule para o passo 5.

### 4. Amplie a partição

```bash
sudo growpart /dev/sda 1
```

Confira com `lsblk`: a `sda1` passa a ter quase o tamanho do disco. O `df` ainda mostra o tamanho antigo,
porque falta o sistema de arquivos.

### 5. Amplie o sistema de arquivos

Para **ext4** (e ext2/ext3), indique a **partição**:

```bash
sudo resize2fs /dev/sda1
```

Para **xfs**, indique a **pasta onde ele está montado** (a raiz, no exemplo):

```bash
sudo xfs_growfs -d /
```

Sem tamanho, o `resize2fs` ocupa a partição inteira; o `-d` do `xfs_growfs` amplia a área de dados até o máximo.

### 6. Confira

```bash
df -h /
```

```text
Filesystem  Size  Used Avail Use% Mounted on
/dev/sda1   194G   75G  119G  39% /
```

Em até 5 minutos o aviso some do Dashboard. A previsão de "enche em X dias" passa a contar o espaço novo
(a mudança grande no uso pode fazer a previsão recomeçar e voltar depois de alguns dias).

## Outros nomes de disco

O número da partição vai separado no `growpart` e junto no nome da partição. O cartão Disco do painel mostra os
nomes certos da sua VPS.

| Disco | Simular | Ampliar a partição | ext4 | xfs |
|---|---|---|---|---|
| `/dev/sda` (SCSI/SATA) | `sudo growpart --dry-run /dev/sda 1` | `sudo growpart /dev/sda 1` | `sudo resize2fs /dev/sda1` | `sudo xfs_growfs -d /` |
| `/dev/vda` (virtio) | `sudo growpart --dry-run /dev/vda 1` | `sudo growpart /dev/vda 1` | `sudo resize2fs /dev/vda1` | `sudo xfs_growfs -d /` |
| `/dev/xvda` (Xen) | `sudo growpart --dry-run /dev/xvda 1` | `sudo growpart /dev/xvda 1` | `sudo resize2fs /dev/xvda1` | `sudo xfs_growfs -d /` |
| `/dev/nvme0n1` (NVMe) | `sudo growpart --dry-run /dev/nvme0n1 1` | `sudo growpart /dev/nvme0n1 1` | `sudo resize2fs /dev/nvme0n1p1` | `sudo xfs_growfs -d /` |

No NVMe a partição tem um `p` antes do número (`nvme0n1p1`), mas o `growpart` recebe o disco (`/dev/nvme0n1`)
e o número (`1`) separados.

**Sistema de arquivos no disco inteiro, sem partição** (comum em um volume extra do provedor, quando o cartão
diz "sem partição"): não há partição a ampliar. Pule os passos 3 e 4 e amplie só o sistema de arquivos:
`sudo resize2fs /dev/sdb` (ext4) ou `sudo xfs_growfs -d <pasta onde ele está montado>` (xfs).

## Quando não fazer

Nestes casos os passos acima **não** se aplicam (e o painel não mostra o aviso, porque não consegue ter
certeza do arranjo):

- **LVM** (`lsblk` mostra `TYPE lvm`, nomes como `/dev/mapper/ubuntu--vg-ubuntu--lv`): o espaço passa pelo
  volume físico e pelo volume lógico (`pvresize`, `lvextend`), um procedimento diferente. Siga a documentação
  da sua distribuição.
- **A partição do sistema não é a última do disco** (por exemplo, uma partição de swap depois dela): o
  `growpart` só usa o espaço livre logo depois da partição e para no começo da próxima. Não tente mover
  partições numa VPS em uso; peça ajuda ao provedor ou recrie o disco a partir de um backup.
- **RAID por software** (`TYPE raid1` e parecidos) ou **partição lógica** dentro de uma estendida (`sda5`):
  procedimento diferente.
- **Tabela MBR (`dos`) em disco maior que 2 TB**: o MBR não endereça além de 2 TB. Confira com
  `sudo fdisk -l /dev/sda` (linha `Disklabel type`); se for `dos` e o disco passar de 2 TB, o espaço depois disso
  não é aproveitado sem converter a tabela para GPT, o que deve ser feito com snapshot e com cuidado.

## Referências

- [`growpart(1)`](https://manpages.ubuntu.com/manpages/noble/man1/growpart.1.html), do cloud-utils: "Only
  report what would be done" (`-N`, `--dry-run`); a partição termina "at the end of the disk, or at the
  beginning of the next partition". Código: [canonical/cloud-utils](https://github.com/canonical/cloud-utils).
- [`resize2fs(8)`](https://man7.org/linux/man-pages/man8/resize2fs.8.html): amplia o ext4 montado ("it can be
  used to expand the size of the mounted file system"); sem tamanho, usa o tamanho da partição.
- [`xfs_growfs(8)`](https://man7.org/linux/man-pages/man8/xfs_growfs.8.html): "The filesystem must be mounted
  to be grown"; o `-d` amplia a área de dados "to the largest size possible".
