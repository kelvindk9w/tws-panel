/**
 * Textos de exemplo de /proc, /sys/fs/cgroup e da API do Docker (formato real
 * de um Ubuntu 24.04, kernel 6.8, cgroup v2). Números inventados.
 */

export const PROC_STAT = `cpu  10132153 290696 3084719 46828483 16683 0 25195 1500 0 0
cpu0 5066076 145348 1542359 23414241 8341 0 12597 750 0 0
cpu1 5066077 145348 1542360 23414242 8342 0 12598 750 0 0
intr 1462898 0 0 0 0 0 0 0 0 1 0 0 0 0 0 0 0 0 0 0
ctxt 3128567
btime 1760000000
processes 4721
procs_running 2
procs_blocked 0
softirq 2147583 0 120 1 0 0 0 0 0 0 0
`;

/** A mesma máquina um minuto depois (6000 jiffies a mais por núcleo: 2 núcleos × 60 s × 100 Hz = 12000 no total). */
export const PROC_STAT_LATER = `cpu  10135153 290696 3086719 46834483 16783 0 25295 1700 0 0
cpu0 5067576 145348 1543359 23417241 8391 0 12647 850 0 0
cpu1 5067577 145348 1543360 23417242 8392 0 12648 850 0 0
btime 1760000000
`;

export const PROC_STAT_OLD_KERNEL = `cpu  100 5 50 800
cpu0 100 5 50 800
btime 1760000000
`;

export const MEMINFO = `MemTotal:        8131364 kB
MemFree:          912340 kB
MemAvailable:    5210044 kB
Buffers:          201232 kB
Cached:          3920112 kB
SwapCached:            0 kB
SwapTotal:       2097148 kB
SwapFree:        2000000 kB
Dirty:               120 kB
`;

export const MEMINFO_NO_AVAILABLE = `MemTotal:        1000000 kB
MemFree:          100000 kB
Buffers:           50000 kB
Cached:           250000 kB
`;

export const VMSTAT = `nr_free_pages 228085
pgpgin 1238482
pswpin 120
pswpout 340
pgfault 8472913
oom_kill 2
`;

export const VMSTAT_NO_OOM = `pswpin 0
pswpout 0
`;

export const LOADAVG = "0.52 0.41 0.35 2/312 40122\n";
export const UPTIME = "523412.55 981234.20\n";

export const PRESSURE_CPU = `some avg10=1.20 avg60=2.50 avg300=3.00 total=123456789
full avg10=0.00 avg60=0.00 avg300=0.00 total=0
`;
export const PRESSURE_MEM = `some avg10=0.00 avg60=0.12 avg300=0.50 total=9999
full avg10=0.00 avg60=0.05 avg300=0.10 total=5555
`;

export const NET_DEV = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 1000000   10000    0    0    0     0          0         0  1000000   10000    0    0    0     0       0          0
  eth0: 5000000000 4000000    0    0    0     0          0         0 2000000000 3000000    0    0    0     0       0          0
docker0:  300000    1000    0    0    0     0          0         0   400000    1100    0    0    0     0       0          0
veth1a2b: 111    1    0    0    0     0          0         0   222    2    0    0    0     0       0          0
`;

export const DISKSTATS = `   7       0 loop0 100 0 800 10 0 0 0 0 0 20 10 0 0 0 0 0 0
   8       0 sda 51234 100 2400000 30000 80000 5000 6400000 90000 0 41000 120000 0 0 0 0 0 0
   8       1 sda1 51000 100 2390000 29900 79000 5000 6390000 89900 0 40900 119000 0 0 0 0 0 0
 259       0 nvme0n1 10 0 80 1 20 0 160 2 0 5 3 0 0 0 0 0 0
 253       0 dm-0 5 0 40 1 5 0 40 1 0 3 2 0 0 0 0 0 0
`;

// --- cgroup v2 -------------------------------------------------------------
export const CG_CPU_STAT = `usage_usec 91234567
user_usec 70000000
system_usec 21234567
nr_periods 0
nr_throttled 0
throttled_usec 0
`;
export const CG_MEMORY_CURRENT = "314572800\n";
export const CG_MEMORY_MAX_LIMIT = "536870912\n";
export const CG_MEMORY_MAX_NONE = "max\n";
export const CG_MEMORY_STAT = `anon 104857600
file 209715200
kernel_stack 98304
inactive_anon 0
active_anon 104857600
inactive_file 157286400
active_file 52428800
`;
export const CG_MEMORY_EVENTS = `low 0
high 0
max 0
oom 1
oom_kill 1
oom_group_kill 0
`;
export const CG_IO_STAT = `8:0 rbytes=1048576 wbytes=2097152 rios=10 wios=20 dbytes=0 dios=0
259:0 rbytes=1024 wbytes=2048 rios=1 wios=2 dbytes=0 dios=0
`;
export const PROC_PID_NET_DEV = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 500 5 0 0 0 0 0 0 500 5 0 0 0 0 0 0
  eth0: 123456 100 0 0 0 0 0 0 65432 80 0 0 0 0 0 0
`;

/** Resposta de `GET /containers/:id/stats?stream=false&one-shot=true` (cortada ao que o painel lê). */
export const DOCKER_STATS = {
  cpu_stats: { cpu_usage: { total_usage: 91234567000 } },
  memory_stats: { usage: 314572800, limit: 536870912, stats: { inactive_file: 157286400 } },
  blkio_stats: {
    io_service_bytes_recursive: [
      { major: 8, minor: 0, op: "read", value: 1048576 },
      { major: 8, minor: 0, op: "write", value: 2097152 },
      { major: 8, minor: 0, op: "Total", value: 3145728 },
    ],
  },
  networks: { eth0: { rx_bytes: 123456, tx_bytes: 65432 }, eth1: { rx_bytes: 10, tx_bytes: 20 } },
};
