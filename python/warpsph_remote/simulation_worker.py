"""Daemon-owned worker for fixed installed presets; never accepts arbitrary code."""

import importlib
import json
import os
from pathlib import Path
import sys

# Load only this package when the simulator uses a different Python environment.
# Adding the companion's entire site-packages would mix incompatible NumPy/Torch ABIs.
if not __package__:
    import importlib.util

    package_dir = Path(__file__).resolve().parent
    package_spec = importlib.util.spec_from_file_location(
        "warpsph_remote",
        package_dir / "__init__.py",
        submodule_search_locations=[str(package_dir)],
    )
    package = importlib.util.module_from_spec(package_spec)
    sys.modules["warpsph_remote"] = package
    package_spec.loader.exec_module(package)
    __package__ = "warpsph_remote"

from .catalogue import CATALOGUE, validate_launch
from .publisher import SimulationPublisher, SimulationStopped


def load_catalogue():
    from warpSPHBootstrap import bootstrap
    bootstrap(precision='float32')
    from .configuration import installed_catalogue
    return installed_catalogue()


def load_case(c):
    if c.get('registry'):
        from warpSPH.runner import getCase
        return getCase(c['registry'])
    return getattr(importlib.import_module('warpSPH.cases.' + c['module']), c['factory'])


def configured_spec(case, spec, entry):
    from warpSPH.runner import RunConfiguration
    settings = spec.get('configuration', {})
    simulation = {**settings.get('simulation', {}), 'nx': spec['nx'], 'tLimit': spec['duration']}
    if entry.get('nativeVariants'):
        simulation['dim'] = entry['dimension']
    if spec.get('steps') is not None:
        simulation['nSteps'] = spec['steps']
    return RunConfiguration(case.name, simulation=simulation,
        params={**({} if entry.get('nativeVariants') else entry['variants'][spec['variant']]), **settings.get('params', {})},
        solver={'scheme': spec['scheme'], **settings.get('solver', {})},
        variant=spec['variant'] if entry.get('nativeVariants') else 'default').resolve(case)


def configuration_query():
    from .configuration import SIMULATION_FIELDS
    try:
        catalogue = load_catalogue()
        if sys.argv[1] == '--catalogue':
            result = dict(presets=catalogue)
        else:
            spec = validate_launch(json.loads(sys.argv[2]), catalogue)
            c = next(c for c in catalogue if c['id'] == spec['preset'])
            case = load_case(c)
            from warpSPH.runner import configurationSchema, prepareContext
            if sys.argv[1] == '--describe':
                from dataclasses import replace
                described_case = replace(case, defaults={**case.defaults, 'dim':c['dimension']}) if c.get('nativeVariants') else case
                schema = configurationSchema(described_case, spec['scheme'])
                sim = schema['properties']['simulation']['properties']
                schema['properties']['simulation']['properties'] = {k:v for k,v in sim.items() if k in SIMULATION_FIELDS}
                result = dict(supported=True, schema=schema)
            else:
                prepareContext(case, configured_spec(case, spec, c))
                result = dict(valid=True)
    except Exception as e:
        result = dict(supported=False, valid=False, error=str(e))
    print('WARPSPH_CONFIGURATION_JSON:' + json.dumps(result, allow_nan=False))


def main():
    incoming = json.loads(Path(sys.argv[1]).read_text())
    if not isinstance(incoming, dict) or not isinstance(incoming.get('preset'), str):
        raise ValueError('Unknown simulation preset.')
    try:
        catalogue = load_catalogue()
    except ImportError as error:
        # A standalone companion installation can validate unknown IDs even when
        # no simulation runtime is installed. Discovery remains authoritative when present.
        if incoming['preset'] not in {c['id'] for c in CATALOGUE}:
            raise ValueError('Unknown simulation preset.') from error
        raise ValueError(f'The simulation Python cannot load warpSPH: {error}') from error
    spec = validate_launch(incoming, catalogue)
    c = next(c for c in catalogue if c["id"] == spec["preset"])
    # Registration precedes costly CUDA compilation, so the manager shows startup.
    publisher = SimulationPublisher(
        c["name"], runtime=os.environ["WARPSPH_REMOTE_RUNTIME"], autostart=False
    )
    try:
        from warpSPHBootstrap import bootstrap

        bootstrap(precision="float32")
        from warpSPH.runner import run
        from dataclasses import replace

        case = load_case(c)
        old = case.postStep

        def post(ctx, state, step):
            if old:
                old(ctx, state, step)
            publisher.post_step(ctx, state, step)

        params = {**case.params, **c["variants"][spec["variant"]]}
        overrides = dict(
            nx=spec["nx"],
            tLimit=spec["duration"],
            scheme=spec["scheme"],
            params=params,
            plot=False,
            store=spec["record"],
            storeMode="trajectory",
            exportInterval=spec["exportInterval"],
            exportRoot=str(Path(os.environ["WARPSPH_REMOTE_RUNTIME"]) / "runs" / publisher.id / "exports"),
            show=False,
            holdPlot=False,
            progress=False,
            device=os.environ.get("WARPSPH_REMOTE_DEVICE", "cuda"),
        )
        if spec["steps"] is not None:
            overrides["nSteps"] = spec["steps"]
        managed_case = replace(case, postStep=post)
        if 'configuration' in spec or c.get('nativeVariants'):
            run_spec = configured_spec(case, spec, c).merged(**{k:v for k,v in overrides.items()
                if k not in ('nx', 'tLimit', 'scheme', 'params', 'nSteps')})
            result = run(managed_case, run_spec)
        else:
            result = run(managed_case, **overrides)
        publisher.recording(result.ctx)
        publisher.update(
            step=result.nSteps,
            time=float(result.state.t),
            dt=float(result.ctx.config.dt),
            particles=int(result.state.state.positions.shape[0]),
        )
        publisher.close(
            "failed" if result.diverged or result.stopReason else "completed",
            result.stopReason or "",
        )
        if result.diverged or result.stopReason:
            raise RuntimeError(result.stopReason or "Simulation diverged.")
    except SimulationStopped:
        publisher.close("stopped")
    except BaseException as e:
        publisher.close("failed", str(e))
        raise


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] in ("--describe", "--validate", "--catalogue"):
        configuration_query()
    else:
        main()
