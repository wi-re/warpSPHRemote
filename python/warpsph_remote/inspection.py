"""Bounded, descriptive configuration for the viewer, never checkpoint serialization."""
from dataclasses import fields, is_dataclass
from enum import Enum
from itertools import islice
import math
from pathlib import Path


def inspect_configuration(value):
    """Read parameters without traversing function closures or copying particle arrays.

    The solver's checkpoint exporters pickle callables, including captured noise
    grids and GPU tensors. Inspection needs their names, not executable payloads.
    Bounds also keep runtime caches and cyclic objects out of the control path.
    """
    remaining = 1024
    active = set()

    def visit(v, depth=0):
        nonlocal remaining
        remaining -= 1
        if remaining < 0 or depth > 16:
            return {'omitted': 'inspection size limit'}
        if v is None or isinstance(v, (bool, int)):
            return v
        if isinstance(v, float):
            return v if math.isfinite(v) else str(v)
        if isinstance(v, str):
            return v if len(v) <= 512 else v[:512] + '… [truncated]'
        if isinstance(v, Enum):
            return v.name
        if isinstance(v, Path):
            return str(v)
        if callable(v):
            return {'callable': (getattr(v, '__module__', type(v).__module__) + '.' +
                    getattr(v, '__qualname__', type(v).__qualname__))[:512]}
        if hasattr(v, 'shape') and hasattr(v, 'dtype'):
            shape = tuple(int(n) for n in v.shape)
            if math.prod(shape) > 32:
                return {'shape': list(shape), 'dtype': str(v.dtype), 'omitted': 'array values'}
            if hasattr(v, 'detach'):
                v = v.detach().cpu()
            return visit(v.tolist(), depth+1)
        identity = id(v)
        if identity in active:
            return {'omitted': 'cyclic reference'}
        active.add(identity)
        def mapping(items):
            result = {}
            for k, x in items:
                if remaining <= 0:
                    result['__omitted__'] = 'inspection size limit'
                    break
                result[str(k)[:512]] = visit(x, depth+1)
            return result

        try:
            if is_dataclass(v) and not isinstance(v, type):
                return mapping((f.name, getattr(v, f.name)) for f in fields(v))
            if isinstance(v, dict):
                result = mapping(islice(v.items(), 128))
                if len(v) > 128:
                    result['__omitted__'] = len(v)-128
                return result
            if isinstance(v, (list, tuple)):
                result = []
                for x in v[:128]:
                    if remaining <= 0:
                        result.append({'omitted': 'inspection size limit'})
                        break
                    result.append(visit(x, depth+1))
                if len(v) > 128:
                    result.append({'omitted': len(v)-128})
                return result
            # Devices/dtypes are useful labels; arbitrary reprs can contain large
            # runtime state. Do not call object toDict/export/pickle hooks.
            if type(v).__module__ == 'torch' and type(v).__name__ in ('dtype', 'device'):
                return str(v)
            return {'type': type(v).__module__ + '.' + type(v).__qualname__}
        finally:
            active.remove(identity)

    return visit(value)
