"""Timing forecasts, process attribution and bounded metadata; no physical GPU required."""
import os
import math
import pytest
from warpsph_remote.telemetry import StepTiming, ResourceSampler, validate_telemetry


def test_completed_step_timing_excludes_startup_and_pause():
    timing = StepTiming()
    assert timing.observe(0, 0, 100) == {}
    assert timing.observe(10, 1, 101) == dict(stepMs=100, simulationRate=1)
    # Heartbeats during the same paused boundary must not advance the baseline.
    assert timing.observe(10, 1, 110) == dict(stepMs=100, simulationRate=1)
    timing.exclude_pause(20)
    assert timing.observe(20, 2, 122) == dict(stepMs=100, simulationRate=1)
    # Adaptive dt changes simulated-time throughput independently of step time.
    assert timing.observe(30, 2.5, 123) == dict(stepMs=100, simulationRate=2.5/3)
    assert timing.observe(0, 0, 124) == {}


def test_slow_step_kept_and_old_startup_cost_rolls_out():
    timing = StepTiming()
    timing.observe(0, 0, 0)
    assert timing.observe(1, .1, 20)['stepMs'] == 20000
    for i in range(2, 9):
        result = timing.observe(i, i / 10, 19 + i)
    assert result['stepMs'] == 1000


def test_resources_use_process_uuid_not_first_gpu_and_are_throttled(monkeypatch):
    sampler = ResourceSampler()
    sampler.smi = 'fixture-smi'
    calls = []
    def query(kind, fields):
        calls.append(kind)
        if kind == 'compute-apps':
            return [[str(os.getpid()), 'GPU-b', '128'], ['1', 'GPU-a', '900']]
        return [['GPU-a', 'Wrong GPU', '900', '16000', '99', '300', '90'],
                ['GPU-b', 'Simulation GPU', '512', '24000', '37', '123.5', '48']]
    monkeypatch.setattr(sampler, '_query', query)
    result = sampler.sample()
    assert sampler.sample() is result
    assert len(calls) == 2
    assert result['gpus'] == [dict(uuid='GPU-b', name='Simulation GPU',
        processVramBytes=128*1024**2, usedVramBytes=512*1024**2,
        totalVramBytes=24000*1024**2, utilizationPercent=37, powerWatts=123.5, temperatureC=48)]
    validate_telemetry(dict(resources=result))


def test_unavailable_counters_are_not_zero(monkeypatch):
    sampler = ResourceSampler()
    sampler.smi = 'fixture-smi'
    monkeypatch.setattr(sampler, '_query', lambda *args: [[str(os.getpid()), 'GPU-a', '[N/A]']] if args[0] == 'compute-apps' else [['GPU-a','GPU','[N/A]','1000','[N/A]','[N/A]','[N/A]']])
    result = sampler.sample()
    assert result['gpus'][0] == dict(uuid='GPU-a', name='GPU', totalVramBytes=1000*1024**2)
    validate_telemetry(dict(resources=result))


@pytest.mark.parametrize('data', [
    dict(performance=dict(stepMs=math.nan)), dict(performance=dict(stepMs=-1)),
    dict(performance=dict(targetTime=True)), dict(performance=dict(unknown=1)),
    dict(resources=dict(gpus='GPU')), dict(resources=dict(gpus=[dict(uuid='x',name='x',powerWatts=math.inf)])),
    dict(resources=dict(token='secret')), dict(resources=dict(gpus=[{}])),
])
def test_reject_invalid_or_unbounded_telemetry(data):
    with pytest.raises(ValueError):
        validate_telemetry(data)
