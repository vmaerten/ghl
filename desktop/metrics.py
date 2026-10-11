"""macOS footprint sampler: include launchd-hosted WebKit tasks attributed to the app.

RSS is descriptive; physical footprint is the primary memory measure. The
read-only responsibility lookup is an undocumented macOS API, checked at run
time. Raw per-process measurements stay in the report for auditing.
"""
import ctypes
import os
import subprocess


class Usage(ctypes.Structure):
    _fields_ = [('uuid', ctypes.c_uint8 * 16)] + [
        (name, ctypes.c_uint64) for name in (
            'user', 'system', 'idle_wakeups', 'interrupt_wakeups', 'pageins',
            'wired', 'resident', 'footprint', 'start', 'exit')]


lib = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
class Timebase(ctypes.Structure):
    _fields_ = [('numer', ctypes.c_uint32), ('denom', ctypes.c_uint32)]

timebase = Timebase()
lib.mach_timebase_info(ctypes.byref(timebase))
SECONDS_PER_TICK = timebase.numer / timebase.denom / 1e9
responsible = lib.responsibility_get_pid_responsible_for_pid
responsible.argtypes = [ctypes.c_int]
responsible.restype = ctypes.c_int
rusage = lib.proc_pid_rusage
rusage.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
rusage.restype = ctypes.c_int


def processes():
    raw = subprocess.check_output(['/bin/ps', '-axo', 'pid=,ppid=,comm='], text=True)
    result = {}
    for line in raw.splitlines():
        parts = line.strip().split(maxsplit=2)
        if len(parts) == 3:
            result[int(parts[0])] = {'parent': int(parts[1]), 'command': parts[2]}
    return result


def sample(root):
    table = processes()
    owned = {root}
    # Descendants cover Electron/TinyJS; responsibility covers XPC WebKit tasks
    # whose parent is launchd rather than the application process.
    for _ in range(len(table)):
        extra = {pid for pid, row in table.items() if row['parent'] in owned}
        if extra <= owned:
            break
        owned |= extra
    owned |= {pid for pid in table if responsible(pid) == root}
    rows = []
    for pid in sorted(owned):
        usage = Usage()
        if rusage(pid, 0, ctypes.byref(usage)) != 0:
            if pid == root:
                raise RuntimeError(f'Cannot measure root PID {pid}: errno {ctypes.get_errno()}')
            continue  # A short-lived Git/XPC task may exit between enumeration and sampling.
        row = table.get(pid, {})
        rows.append({'pid': pid, 'parent': row.get('parent'),
                     'name': os.path.basename(row.get('command', '')),
                     'responsible': responsible(pid),
                     'rss_mib': usage.resident / 1024**2,
                     'footprint_mib': usage.footprint / 1024**2,
                     'cpu_seconds': (usage.user + usage.system) * SECONDS_PER_TICK,
                     'process_start': usage.start})
    if not any(row['pid'] == root for row in rows):
        raise RuntimeError(f'App exited: {root}')
    return {'rss_mib': sum(row['rss_mib'] for row in rows),
            'footprint_mib': sum(row['footprint_mib'] for row in rows),
            'cpu_seconds': sum(row['cpu_seconds'] for row in rows), 'processes': rows}
