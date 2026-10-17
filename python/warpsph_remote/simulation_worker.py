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


def main():
    spec = validate_launch(json.loads(Path(sys.argv[1]).read_text()))
    c = next(c for c in CATALOGUE if c["id"] == spec["preset"])
    # Registration precedes costly CUDA compilation, so the manager shows startup.
    publisher = SimulationPublisher(
        c["name"], runtime=os.environ["WARPSPH_REMOTE_RUNTIME"], autostart=False
    )
    try:
        from warpSPHBootstrap import bootstrap

        bootstrap(precision="float32")
        from warpSPH.runner import run
        from dataclasses import replace

        case = getattr(
            importlib.import_module("warpSPH.cases." + c["module"]), c["factory"]
        )
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
            store=False,
            show=False,
            holdPlot=False,
            progress=False,
            device=os.environ.get("WARPSPH_REMOTE_DEVICE", "cuda"),
        )
        if spec["steps"] is not None:
            overrides["nSteps"] = spec["steps"]
        result = run(replace(case, postStep=post), **overrides)
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
    main()
