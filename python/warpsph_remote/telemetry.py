"""Low-rate process/device monitoring; never synchronizes simulation CUDA work."""
from collections import deque
import csv
import math
import os
from pathlib import Path
import shutil
import subprocess
import time


class StepTiming:
    """Rolling completed-boundary wall throughput, excluding deliberate pauses."""
    def __init__(self):
        self.previous = None
        self.samples = deque(maxlen=512)

    def observe(self, step, simulation_time, now):
        if self.previous is not None and step == self.previous[0] and simulation_time == self.previous[1]:
            return self.metrics()
        if self.previous is not None:
            old_step, old_time, old_wall = self.previous
            count, elapsed = step - old_step, now - old_wall
            if count > 0 and elapsed > 0:
                self.samples.append((count, max(0, simulation_time - old_time), elapsed))
                # Retain at least one slow step, otherwise roughly five active seconds.
                while len(self.samples) > 1 and sum(x[2] for x in self.samples) - self.samples[0][2] >= 5:
                    self.samples.popleft()
            elif count < 0 or simulation_time < old_time:
                self.samples.clear()
        self.previous = (step, simulation_time, now)
        return self.metrics()

    def metrics(self):
        if not self.samples:
            return {}
        count, advance, elapsed = map(sum, zip(*self.samples))
        return dict(stepMs=elapsed * 1000 / count, simulationRate=advance / elapsed)

    def exclude_pause(self, seconds):
        if self.previous is not None:
            step, sim, wall = self.previous
            self.previous = (step, sim, wall + seconds)


def _number(value, scale=1):
    try:
        result = float(value) * scale
        return result if math.isfinite(result) and result >= 0 else None
    except (ValueError, TypeError):
        return None


class ResourceSampler:
    """Run only on the publisher I/O thread. NVIDIA device stats are device-wide.

    Attribute GPUs using this process's compute PID, never an assumed GPU ordinal
    (CUDA_VISIBLE_DEVICES can remap ordinals). Unsupported counters stay absent.
    """
    def __init__(self):
        self.next_sample = 0
        self.value = None
        self.smi = shutil.which('nvidia-smi')

    def _query(self, kind, fields):
        result = subprocess.run([self.smi, f'--query-{kind}={fields}', '--format=csv,noheader,nounits'],
                                capture_output=True, text=True, timeout=1, check=True)
        return list(csv.reader(result.stdout.splitlines(), skipinitialspace=True))

    def sample(self):
        now = time.monotonic()
        if now < self.next_sample:
            return self.value
        self.next_sample = now + 2
        value = dict(sampledAt=time.time(), gpus=[])
        try:
            value['processRamBytes'] = int(Path('/proc/self/statm').read_text().split()[1]) * os.sysconf('SC_PAGE_SIZE')
            mem = {k: int(v.split()[0]) * 1024 for k, v in
                   (line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines())}
            value.update(systemRamTotalBytes=mem['MemTotal'], systemRamUsedBytes=mem['MemTotal'] - mem['MemAvailable'])
        except (OSError, ValueError, KeyError, IndexError):
            pass
        if self.smi:
            try:
                processes = self._query('compute-apps', 'pid,gpu_uuid,used_memory')
                owned = {}
                for row in processes:
                    if len(row) == 3 and row[0].strip() == str(os.getpid()):
                        owned[row[1].strip()] = _number(row[2], 1024**2)
                devices = self._query('gpu', 'uuid,name,memory.used,memory.total,utilization.gpu,power.draw,temperature.gpu')
                for row in devices:
                    if len(row) != 7 or row[0].strip() not in owned:
                        continue
                    uuid, name, used, total, utilization, power, temperature = row
                    gpu = dict(uuid=uuid.strip(), name=name.strip())
                    for key, number in dict(processVramBytes=owned[uuid.strip()],
                            usedVramBytes=_number(used, 1024**2), totalVramBytes=_number(total, 1024**2),
                            utilizationPercent=_number(utilization), powerWatts=_number(power),
                            temperatureC=_number(temperature)).items():
                        if number is not None:
                            gpu[key] = number
                    value['gpus'].append(gpu)
                if not value['gpus']:
                    value['gpuUnavailable'] = 'No GPU attributed to the simulation PID (or process counters unavailable).'
            except (OSError, subprocess.SubprocessError):
                value['gpuUnavailable'] = 'NVIDIA counters could not be queried.'
        else:
            value['gpuUnavailable'] = 'NVIDIA monitoring is unavailable on this system.'
        self.value = value
        return value


def validate_telemetry(data):
    """Bound metadata received from a producer; reject nonfinite/unknown values."""
    def numeric(record, fields):
        if not isinstance(record, dict) or set(record) - set(fields):
            raise ValueError('Invalid telemetry fields.')
        for value in record.values():
            if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
                raise ValueError('Invalid telemetry number.')
    if 'performance' in data:
        numeric(data['performance'], ('stepMs', 'simulationRate', 'targetTime', 'targetStep', 'captureMs', 'encodeMs', 'publishMs', 'captureBytes', 'captureStep'))
    if 'pipeline' in data:
        p=data['pipeline']
        if not isinstance(p,dict) or set(p)!={'solver','solverSeconds','capture'} or p['solver'] not in ('initializing','running','paused','video_viewer','video_frame') or p['capture'] not in ('idle','copying','queued','configuration','history','encoding','publishing','transfers_paused','not_attached','awaiting_ack','capture_interval','next_step'):
            raise ValueError('Invalid pipeline telemetry.')
        numeric({'solverSeconds':p['solverSeconds']},('solverSeconds',))
    if 'storageEstimate' in data:
        e=data['storageEstimate']
        if not isinstance(e,dict) or type(e.get('estimated')) is not bool: raise ValueError('Invalid recording estimate.')
        numeric({k:v for k,v in e.items() if k!='estimated'},('everySteps','bytesPerFrame','initialBytes','frames','totalBytes'))
    if 'resources' in data:
        resources = data['resources']
        if not isinstance(resources, dict):
            raise ValueError('Invalid resource telemetry.')
        numeric({k:v for k,v in resources.items() if k not in ('gpus', 'gpuUnavailable')},
                ('sampledAt', 'processRamBytes', 'systemRamUsedBytes', 'systemRamTotalBytes'))
        reason = resources.get('gpuUnavailable', '')
        gpus = resources.get('gpus', [])
        if not isinstance(reason, str) or len(reason) > 200 or not isinstance(gpus, list) or len(gpus) > 32:
            raise ValueError('Invalid GPU telemetry.')
        for gpu in gpus:
            if not isinstance(gpu, dict) or any(not isinstance(gpu.get(k), str) or len(gpu[k]) > 200 for k in ('uuid', 'name')):
                raise ValueError('Invalid GPU identity.')
            numeric({k:v for k,v in gpu.items() if k not in ('uuid', 'name')},
                    ('processVramBytes', 'usedVramBytes', 'totalVramBytes', 'utilizationPercent', 'powerWatts', 'temperatureC'))
