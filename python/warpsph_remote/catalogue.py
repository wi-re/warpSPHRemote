"""Only these installed case factories can be started by a browser."""

import json
import math
from .configuration import restricted_configuration
from pathlib import Path

CATALOGUE = json.loads(Path(__file__).with_name("presets.json").read_text())


def validate_video(data):
    if not isinstance(data,dict) or set(data)-{'fps','interval','everySteps'}:
        raise ValueError('Video capture requires fps and a simulation-time interval.')
    fps,interval=data.get('fps',30),data.get('interval',.04)
    every=data.get('everySteps')
    if every is not None and (type(every) is not int or not 1<=every<=1000000000):
        raise ValueError('Video step interval must be a positive integer up to 1,000,000,000.')
    if type(fps) is not int or not 1<=fps<=120:
        raise ValueError('Video fps must be an integer between 1 and 120.')
    if type(interval) not in (int,float) or not math.isfinite(interval) or not .000001<=interval<=10000:
        raise ValueError('Video interval must be finite and between 1e-6 and 10000.')
    return dict(fps=fps,interval=float(interval),**({'everySteps':every} if every is not None else {}))


def armed_video(settings):
    return dict(active=True,armed=True,**validate_video(settings),nextTime=-1,nextStep=-1,ackTime=-1,ackStep=-1,orphaned=False)


def validate_launch(data, catalogue=None):
    if not isinstance(data, dict) or set(data) - {
        "preset",
        "scheme",
        "variant",
        "nx",
        "duration",
        "steps",
        "record",
        "exportInterval",
        "exportEverySteps",
        "video",
        "paused",
        "configuration",
        "measurements",
        "diagnosticInterval",
    }:
        raise ValueError("Use a registered preset and its bounded parameters.")
    case = next((c for c in (CATALOGUE if catalogue is None else catalogue) if c["id"] == data.get("preset")), None)
    if case is None:
        raise ValueError("Unknown simulation preset.")
    if case.get("available") is False:
        raise ValueError(case.get("unavailableReason", "Case unavailable in this environment."))
    scheme, variant = data.get("scheme", case["schemes"][0]), data.get(
        "variant", next(iter(case["variants"]))
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
            f"Resolution nx must be 8–{case.get('maxNx',512)} for this case."
        )
    if (
        type(duration) not in (int, float)
        or not math.isfinite(duration)
        or not 0.000001 <= duration <= 10000
    ):
        raise ValueError("Duration must be finite and positive (at most 10000).")
    if steps is not None and (type(steps) is not int or not 1 <= steps <= 10000000):
        raise ValueError("Step limit must be 1–10000000.")
    if 'measurements' in data and type(data['measurements']) is not bool: raise ValueError('measurements must be boolean.')
    record, export_interval = data.get("record", False), data.get("exportInterval", 0.05)
    if type(record) is not bool:
        raise ValueError("record must be a boolean; trajectory recording is opt-in.")
    if (type(export_interval) not in (int, float) or not math.isfinite(export_interval)
            or not 0.000001 <= export_interval <= 10000):
        raise ValueError("Export interval must be finite and between 1e-6 and 10000.")
    if 'paused' in data and type(data['paused']) is not bool:
        raise ValueError('Launch paused must be a boolean.')
    configuration = restricted_configuration(data["configuration"]) if "configuration" in data else None
    result = dict(
        preset=case["id"],
        scheme=scheme,
        variant=variant,
        nx=nx,
        duration=duration,
        steps=steps,
        record=record,
        exportInterval=export_interval,
    )
    if 'exportEverySteps' in data:
        every=data['exportEverySteps']
        if type(every) is not int or not 1<=every<=1000000000: raise ValueError('Export step interval must be a positive integer.')
        result['exportEverySteps']=every
    if data.get('measurements'): result['measurements']=True
    if 'diagnosticInterval' in data:
        interval=data['diagnosticInterval']
        if type(interval) not in (int,float) or not math.isfinite(interval) or not 1e-6<=interval<=10000: raise ValueError('Invalid diagnostic interval.')
        result['diagnosticInterval']=float(interval)
    if data.get("paused") or "video" in data:
        result["paused"] = True
    if "video" in data:
        result["video"] = validate_video(data["video"])
    if configuration is not None:
        result["configuration"] = configuration
    return result
