"""Restricted bridge to the installed solver's versioned configuration contract."""
import json
import subprocess
from pathlib import Path

# The companion owns paths, device selection, output, and managed run lifecycle.
SIMULATION_FIELDS = {'dt', 'adaptiveDt', 'cflFactor', 'minDt', 'maxDt', 'n_h',
                     'kernel', 'supportMode', 'gradientMode', 'laplacianMode',
                     'samplingScheme', 'densityCorrection', 'calibrateNormalization',
                     'verletScale', 'execution', 'iterationChecks', 'krylovCheckEvery'}


def restricted_configuration(value):
    if not isinstance(value, dict) or set(value) - {'params', 'solver', 'simulation'}:
        raise ValueError('configuration accepts params, solver and simulation groups only.')
    for key, group in value.items():
        if not isinstance(group, dict):
            raise ValueError(f'configuration.{key} must be an object.')
    if set(value.get('simulation', {})) - SIMULATION_FIELDS:
        raise ValueError('Unsupported managed simulation parameter.')
    if 'scheme' in value.get('solver', {}):
        raise ValueError('Select the solver using scheme.')
    try:
        text = json.dumps(value, allow_nan=False)
    except (TypeError, ValueError) as e:
        raise ValueError('Configuration must contain finite JSON values.') from e
    if len(text) > 65536:
        raise ValueError('Configuration exceeds 64 KiB.')
    return value


def query_solver(python, operation, spec):
    """Run only our fixed helper in the daemon-selected simulation environment."""
    try:
        result = subprocess.run([python, str(Path(__file__).with_name('simulation_worker.py')),
                                 operation, json.dumps(spec, allow_nan=False)],
                                capture_output=True, text=True, timeout=60)
    except subprocess.TimeoutExpired as e:
        raise ValueError('The solver configuration query timed out.') from e
    marker = 'WARPSPH_CONFIGURATION_JSON:'
    if result.returncode or marker not in result.stdout:
        raise ValueError('The installed solver could not describe this configuration. Check the daemon Python environment.')
    return json.loads(result.stdout.rsplit(marker, 1)[1])


def installed_catalogue():
    """Executed in the simulation Python; discover registered cases, never browser imports."""
    import importlib
    from .catalogue import CATALOGUE
    from warpSPH.runner import getCase, listCases
    from warpSPH.cases import importAll
    importAll()
    try:
        from warpSPH.runner import configurationCatalogue
        coverage = {c['id']: c for c in configurationCatalogue()['cases']}
    except ImportError:
        coverage = {}
    entries, represented = [], set()
    for c in CATALOGUE:
        entry = dict(c)
        try:
            case = getattr(importlib.import_module('warpSPH.cases.' + c['module']), c['factory'])
            entry['registry'] = case.name
            represented.add(case.name)
            entry['dimension'] = case.defaults.get('dim', 2)
            entry['available'] = entry['dimension'] in (1, 2, 3)
            entry['configurable'] = coverage.get(case.name, {}).get('status') == 'ready'
            if entry['configurable']:
                entry['schemes'] = [s for s in c['schemes'] if s in case.supportedSchemes]
        except (ImportError, AttributeError) as e:
            entry.update(available=False, unavailableReason=str(e), configurable=False)
        entries.append(entry)
    for name in listCases():
        if name in represented:
            continue
        case = getCase(name)
        status = coverage.get(name, {})
        ready = status.get('status') == 'ready'
        dim = case.defaults.get('dim', 2)
        descriptor = getattr(case, 'simulationParameters', {}).get('dim')
        dimensions = [d for d in (descriptor.choices if descriptor and descriptor.choices else (dim,)) if d in (1, 2, 3)]
        dim = dim if dim in dimensions else (dimensions[0] if dimensions else dim)
        available = bool(dimensions) and status.get('status') != 'invalid'
        hook_module = getattr(case.buildSystem, '__module__', '')
        family = 'compressible' if any(x in hook_module for x in ('.compressible.', '.compressibleWalls.')) else 'free-surface' if '.freeSurface.' in hook_module else 'periodic' if '.periodic.' in hook_module else 'wall-bounded' if any(x in hook_module for x in ('.wallBounded.', '.boundaries.')) else 'other'
        entries.append(dict(id=name, registry=name, name=name, description=case.description,
            family=family, image=None, dimension=dim, schemes=[case.scheme, *[s for s in getattr(case, 'supportedSchemes', ()) if s != case.scheme]],
            nx=min(64 if dim == 3 else 512, max(8, case.defaults.get('nx', 128))), maxNx=128 if dim == 3 else 16384 if dim == 1 else 512,
            duration=case.defaults.get('tLimit', 1) or 1,
            derivedEndTime=bool(getattr(getattr(case,'simulationParameters',{}).get('tLimit'),'readOnly',False)),
            variants={v:{} for v in ['default', *case.variants]} if ready else {'standard':{}}, nativeVariants=ready,
            available=available, configurable=ready,
            unavailableReason=None if available else
                (status.get('error') or 'This case does not advertise a supported 1D/2D/3D setup.')))
    return entries
