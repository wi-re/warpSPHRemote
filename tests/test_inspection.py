"""Configuration inspection does not serialize case closures or runtime storage."""
from dataclasses import dataclass
from enum import Enum
import json
import numpy as np
from warpsph_remote.inspection import inspect_configuration


def test_inspection_retains_parameters_without_pickle_or_copying_noise_closure():
    class Mode(Enum):
        periodic = 1
    class Noise:
        def __reduce__(self):
            raise AssertionError('Noise must never be pickled')
        def __call__(self, x):
            return x
    noise = Noise()
    def force(x):
        return noise(x)
    @dataclass
    class Boundary:
        forcingFunctions: list
        mode: Mode
    @dataclass
    class Config:
        nx: int
        diffusionStrength: float
        boundaryConditions: list
        cache: object
    class LargeArray:
        shape = (1024, 1024)
        dtype = 'float32'
        def tolist(self):
            raise AssertionError('Large arrays must never be read or copied')
    value = inspect_configuration(Config(512, .1, [Boundary([force], Mode.periodic)], LargeArray()))
    assert value['nx'] == 512 and value['diffusionStrength'] == .1
    assert value['boundaryConditions'][0]['mode'] == 'periodic'
    assert value['boundaryConditions'][0]['forcingFunctions'][0]['callable'].endswith('.force')
    assert value['cache'] == dict(shape=[1024,1024],dtype='float32',omitted='array values')
    assert len(json.dumps(value,allow_nan=False)) < 2048


def test_inspection_bounds_nested_data_and_handles_cycles_and_small_arrays():
    cycle = {}; cycle['self'] = cycle
    value = inspect_configuration(dict(bounds=np.array([[-1.,-1.],[1.,1.]]), cycle=cycle,
        dt=float('inf'),large=[{str(i): 'x'*4096 for i in range(150)} for _ in range(150)]))
    assert value['bounds'] == [[-1.,-1.],[1.,1.]]
    assert value['cycle']['self']['omitted'] == 'cyclic reference'
    assert value['dt'] == 'inf'
    assert len(json.dumps(value,allow_nan=False).encode()) < 1024*1024
