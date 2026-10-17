"""Only these installed case factories can be started by a browser."""

import json
import math
from pathlib import Path

CATALOGUE = json.loads(Path(__file__).with_name("presets.json").read_text())


def validate_launch(data):
    if not isinstance(data, dict) or set(data) - {
        "preset",
        "scheme",
        "variant",
        "nx",
        "duration",
        "steps",
    }:
        raise ValueError("Use a registered preset and its bounded parameters.")
    case = next((c for c in CATALOGUE if c["id"] == data.get("preset")), None)
    if case is None:
        raise ValueError("Unknown simulation preset.")
    scheme, variant = data.get("scheme", case["schemes"][0]), data.get(
        "variant", "standard"
    )
    if scheme not in case["schemes"] or variant not in case["variants"]:
        raise ValueError("Unsupported scheme or case variant.")
    nx, duration, steps = (
        data.get("nx", case["nx"]),
        data.get("duration", case["duration"]),
        data.get("steps"),
    )
    if type(nx) is not int or not 8 <= nx <= case.get("maxNx", 512):
        raise ValueError(
            f"Resolution nx must be 8–{case.get("maxNx",512)} for this case."
        )
    if (
        type(duration) not in (int, float)
        or not math.isfinite(duration)
        or not 0.000001 <= duration <= 10000
    ):
        raise ValueError("Duration must be finite and positive (at most 10000).")
    if steps is not None and (type(steps) is not int or not 1 <= steps <= 10000000):
        raise ValueError("Step limit must be 1–10000000.")
    return dict(
        preset=case["id"],
        scheme=scheme,
        variant=variant,
        nx=nx,
        duration=duration,
        steps=steps,
    )
