"""Run an installed case; implicitly start/reuse the local companion.

Use in a working warpSPH environment with warpSPHRemote installed editable.
No rendering/file export hooks are enabled. Open the viewer and pair to attach.
"""

import argparse
from dataclasses import replace
import importlib
from warpsph_remote.catalogue import CATALOGUE, validate_launch
from warpsph_remote.publisher import run_live


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--case", choices=[c["id"] for c in CATALOGUE], default="gresho")
    p.add_argument("--nx", type=int, default=128)
    p.add_argument("--duration", type=float, default=3.0)
    p.add_argument("--scheme")
    p.add_argument("--variant", default="standard")
    p.add_argument("--runtime")
    a = p.parse_args()
    spec = dict(preset=a.case, nx=a.nx, duration=a.duration, variant=a.variant)
    if a.scheme:
        spec["scheme"] = a.scheme
    spec = validate_launch(spec)
    entry = next(c for c in CATALOGUE if c["id"] == a.case)
    from warpSPHBootstrap import bootstrap

    bootstrap(precision="float32")
    case = getattr(
        importlib.import_module("warpSPH.cases." + entry["module"]), entry["factory"]
    )
    case = replace(case, params={**case.params, **entry["variants"][a.variant]})
    run_live(
        case,
        runtime=a.runtime,
        nx=spec["nx"],
        scheme=spec["scheme"],
        tLimit=spec["duration"],
        plot=False,
        store=False,
        progress=False,
        show=False,
        holdPlot=False,
    )


if __name__ == "__main__":
    main()
