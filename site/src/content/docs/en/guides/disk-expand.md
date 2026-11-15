---
title: "Disk larger than the space in use (expanding the partition)"
description: "Why, after enlarging the disk at the provider, the VPS still has the old space, how the panel warns about it and the safe step-by-step to expand the partition and the file system."
sidebar:
  label: "Expanding the disk"
---

When you enlarge the VPS disk in the provider's dashboard (a plan upgrade, for example from 100 GB to 200 GB),
the provider enlarges the **disk**, but almost never the **partition** and the **file system** inside it. The
result looks like this:

```text
$ lsblk -d
NAME SIZE TYPE
sda  200G disk

$ df -h /
Filesystem  Size  Used Avail Use% Mounted on
/dev/sda1    96G   75G   22G  78% /
```

The disk has 200 GB, but the system still sees only 96 GB. The new space exists, but it cannot be used yet: no
file fits in it until the partition and the file system are expanded.

## What the panel shows

The panel measures the space of the file system that holds its data (the same number `df` shows). So, until you
expand it, the panel keeps showing the old space, and the "fills up in X days" forecast only counts that space.

When the disk is much larger than the file system, the panel says so:

- **Dashboard, Disk card**: "The disk has 200 GB, but the system only uses 95.8 GB. The rest (100 GB) has not
  been made available yet", with the device (for example `Disk /dev/sda, partition /dev/sda1 (ext4)`) and a link to
  this guide. If there is a fill-up forecast, the card says it only counts the space in use.
- **VPS Health attention list**: if the disk already needs attention (almost full or filling up fast), the disk
  item gets the same explanation and a **How to expand the disk** button. If the disk is fine, an
  **informational** item appears, which does not count as a problem.

"The rest" is what expanding actually frees. It is a bit smaller than disk − file system (200 − 95.8), because
the file system is always a bit smaller than the partition: ext4 keeps its inode tables outside the total `df`
shows (about 1.5% to 3% by default, more with many inodes), and the panel discounts those tables.

The notice appears when that space is above **10% of the disk and 5 GB** at the same time, well above the normal
difference between partition and file system.

The panel **never expands anything by itself**. Changing the partition table is up to you, and the panel also
stays quiet when it cannot be sure of the disk layout (LVM, RAID, logical partition, a file system other than
ext4 or xfs). After you expand it, the notice goes away within 5 minutes.

## Before you start

1. **Take a snapshot** (or a disk backup) in the provider's dashboard. Expanding a partition is a safe and common
   operation, but it is the partition table of the disk that holds the system: with a snapshot, any mistake can
   be undone.
2. The commands run **on the VPS**, over SSH, as a user with `sudo`. You do not need to stop the panel or the
   projects: ext4 and xfs are expanded while mounted and running, without a reboot.
3. Install `growpart` if you do not have it yet (on Ubuntu and Debian it comes in the `cloud-guest-utils`
   package; cloud images usually have it already):

   ```bash
   sudo apt install cloud-guest-utils
   ```

## Step by step

The examples use the disk `/dev/sda` and partition `1` (`/dev/sda1`), the most common case. Use the names the
panel's Disk card shows; the variations for other disks are [further below](#other-disk-names).

### 1. Check the disk and the partition

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

The disk (`sda`, `TYPE disk`) has 200 GB and the system partition (`sda1`, mounted at `/`) has 99 GB. Also check
that the `TYPE` of the line mounted at `/` is `part`. If it is `lvm`, **stop**: see [When not to do
it](#when-not-to-do-it).

If `lsblk` still shows the old disk size, the system has not noticed the change: reboot the VPS (or follow the
provider's instructions) and check again.

### 2. Check the file system type

```bash
df -T /
```

```text
Filesystem     Type  1K-blocks     Used Available Use% Mounted on
/dev/sda1      ext4  100476656 78643200  21833456  78% /
```

The `Type` column tells you which command to use in step 5: `ext4` (also `ext2` or `ext3`) or `xfs`.

### 3. Simulate expanding the partition

```bash
sudo growpart --dry-run /dev/sda 1
```

Note the space between `/dev/sda` and `1`: the first is the **disk**, the second is the partition **number**.
Nothing is changed; the command only reports what it would do:

```text
CHANGE: partition=1 start=2099200 old: size=207615967 end=209715166 new: size=417331167 end=419430366
```

- `CHANGE`: the partition can grow up to the end of the disk (or the beginning of the next partition). Go on.
- `NOCHANGE: partition 1 is size ... it cannot be grown`: there is no free space right after the partition. Do not
  go on; see [When not to do it](#when-not-to-do-it). If the partition was already expanded and only the file
  system is missing, skip to step 5.

### 4. Expand the partition

```bash
sudo growpart /dev/sda 1
```

Check with `lsblk`: `sda1` now has almost the size of the disk. `df` still shows the old size, because the file
system is still missing.

### 5. Expand the file system

For **ext4** (and ext2/ext3), give the **partition**:

```bash
sudo resize2fs /dev/sda1
```

For **xfs**, give the **directory where it is mounted** (the root, in the example):

```bash
sudo xfs_growfs -d /
```

Without a size, `resize2fs` fills the whole partition; `xfs_growfs -d` grows the data section to the maximum.

### 6. Check

```bash
df -h /
```

```text
Filesystem  Size  Used Avail Use% Mounted on
/dev/sda1   194G   75G  119G  39% /
```

Within 5 minutes the notice disappears from the Dashboard. The "fills up in X days" forecast starts counting the
new space (the big change in usage may make the forecast restart and come back after a few days).

## Other disk names

The partition number goes separately in `growpart` and attached in the partition name. The panel's Disk card
shows the right names for your VPS.

| Disk | Simulate | Expand the partition | ext4 | xfs |
|---|---|---|---|---|
| `/dev/sda` (SCSI/SATA) | `sudo growpart --dry-run /dev/sda 1` | `sudo growpart /dev/sda 1` | `sudo resize2fs /dev/sda1` | `sudo xfs_growfs -d /` |
| `/dev/vda` (virtio) | `sudo growpart --dry-run /dev/vda 1` | `sudo growpart /dev/vda 1` | `sudo resize2fs /dev/vda1` | `sudo xfs_growfs -d /` |
| `/dev/xvda` (Xen) | `sudo growpart --dry-run /dev/xvda 1` | `sudo growpart /dev/xvda 1` | `sudo resize2fs /dev/xvda1` | `sudo xfs_growfs -d /` |
| `/dev/nvme0n1` (NVMe) | `sudo growpart --dry-run /dev/nvme0n1 1` | `sudo growpart /dev/nvme0n1 1` | `sudo resize2fs /dev/nvme0n1p1` | `sudo xfs_growfs -d /` |

On NVMe the partition has a `p` before the number (`nvme0n1p1`), but `growpart` takes the disk (`/dev/nvme0n1`)
and the number (`1`) separately.

**File system on the whole disk, without a partition** (common on an extra volume from the provider, when the
card says "no partition"): there is no partition to expand. Skip steps 3 and 4 and expand only the file system:
`sudo resize2fs /dev/sdb` (ext4) or `sudo xfs_growfs -d <directory where it is mounted>` (xfs).

## When not to do it

In these cases the steps above do **not** apply (and the panel does not show the notice, because it cannot be
sure of the layout):

- **LVM** (`lsblk` shows `TYPE lvm`, names like `/dev/mapper/ubuntu--vg-ubuntu--lv`): the space goes through the
  physical volume and the logical volume (`pvresize`, `lvextend`), a different procedure. Follow your
  distribution's documentation.
- **The system partition is not the last one on the disk** (for example, a swap partition after it): `growpart`
  only uses the free space right after the partition and stops at the beginning of the next one. Do not try to
  move partitions on a VPS in use; ask the provider for help or recreate the disk from a backup.
- **Software RAID** (`TYPE raid1` and similar) or a **logical partition** inside an extended one (`sda5`): a
  different procedure.
- **MBR (`dos`) table on a disk larger than 2 TB**: MBR cannot address beyond 2 TB. Check with
  `sudo fdisk -l /dev/sda` (the `Disklabel type` line); if it is `dos` and the disk is larger than 2 TB, the space
  beyond that is not used unless the table is converted to GPT, which must be done with a snapshot and with care.

## References

- [`growpart(1)`](https://manpages.ubuntu.com/manpages/noble/man1/growpart.1.html), from cloud-utils: "Only
  report what would be done" (`-N`, `--dry-run`); the partition ends "at the end of the disk, or at the
  beginning of the next partition". Source: [canonical/cloud-utils](https://github.com/canonical/cloud-utils).
- [`resize2fs(8)`](https://man7.org/linux/man-pages/man8/resize2fs.8.html): grows a mounted ext4 ("it can be
  used to expand the size of the mounted file system"); without a size, it uses the size of the partition.
- [`xfs_growfs(8)`](https://man7.org/linux/man-pages/man8/xfs_growfs.8.html): "The filesystem must be mounted
  to be grown"; `-d` grows the data section "to the largest size possible".
