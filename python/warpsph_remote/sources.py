"""Lazy, read-only trajectory sources and a renderer-independent frame contract.

Only numerical datasets are read. Simulator imports, checkpoint restoration and
serialized callables are deliberately unnecessary for trajectory inspection.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Protocol

import h5py
import numpy as np

BASE = ("positions", "kinds", "UIDs", "masses", "supports", "densities")
ALIASES = {"position": "positions", "velocity": "velocities", "density": "densities", "uids": "UIDs", "internalEnergy": "internalEnergies", "specificInternalEnergy": "internalEnergies"}


def natural_key(name):
    return [int(s) if s.isdigit() else s for s in re.split(r"(\d+)", str(name))]


def numeric(a):
    return np.asarray(a).dtype.kind in "fiub"


def validate(frame):
    p = np.asarray(frame["positions"])
    if p.ndim != 2 or p.shape[1] not in (2, 3) or not len(p):
        raise ValueError("Positions must be a nonempty N×2 or N×3 array.")
    if not np.isfinite(p).all():
        raise ValueError("Frame contains nonfinite positions; inspect the source simulation.")
    for name, array in frame.items():
        if np.asarray(array).ndim == 0 or len(array) != len(p):
            raise ValueError(f"Field {name!r} does not match the frame's {len(p)} particles.")
    if "kinds" not in frame:
        frame["kinds"] = np.zeros(len(p), dtype=np.int32)
    return frame


def field_descriptions(frame):
    return [{"name": name, "components": 1 if a.ndim == 1 else a.shape[1],
             "dtype": str(a.dtype)} for name, a in frame.items()
            if name not in ("positions", "times") and a.ndim in (1, 2) and numeric(a)]


class FrameSource(Protocol):
    """The viewer consumes this contract, independent of file or live acquisition."""
    name: str
    times: list[float]
    time_kind: str
    def read(self, index: int, field: str | None = None) -> dict[str, np.ndarray]: ...
    def metadata(self) -> dict: ...


class Source:
    time_kind = "simulation"
    identity = "UIDs"
    def _finish(self):
        first = self.read(0)
        self.dim = first["positions"].shape[1]
        self.fields = field_descriptions(first)
        self.bounds = [first["positions"].min(axis=0).tolist(), first["positions"].max(axis=0).tolist()]
        if "UIDs" not in first:
            self.identity = "unavailable"
        if not np.isfinite(self.times).all() or np.any(np.diff(self.times) < 0):
            raise ValueError("Frame times must be finite and nondecreasing.")

    def metadata(self):
        return {"name": self.name, "format": self.format, "frames": len(self.times),
                "times": self.times, "timeKind": self.time_kind, "dimension": self.dim,
                "fields": self.fields, "bounds": self.bounds, "identity": self.identity,
                "internalEnergyAvailable": any(f["name"]=="internalEnergies" for f in self.fields)}

    def diagnostic(self, index):
        f = self.read(index, "velocities")
        if any(x['name']=='internalEnergies' for x in self.fields):
            f['internalEnergies']=self.read(index,'internalEnergies')['internalEnergies']
        mask = f["kinds"] == 0
        result = {"index": index, "time": self.times[index], "particles": int(mask.sum()),
                  "kineticEnergy": None, "internalEnergy": None, "totalEnergy": None, "maxSpeed": None, "meanDensity": None}
        if "densities" in f and mask.any():
            rho = f["densities"][mask].reshape(-1)
            if np.isfinite(rho).all():
                result["meanDensity"] = float(rho.mean(dtype=np.float64))
        if "velocities" in f and mask.any():
            v = f["velocities"][mask].astype(np.float64)
            v2 = np.sum(v*v, axis=1)
            if np.isfinite(v2).all():
                result["maxSpeed"] = float(np.sqrt(v2.max()))
                if "masses" in f:
                    m = f["masses"][mask].reshape(-1).astype(np.float64)
                    if np.isfinite(m).all() and (m >= 0).all():
                        result["kineticEnergy"] = float(.5 * np.sum(m*v2))
        if 'internalEnergies' in f and 'masses' in f and mask.any():
            m=f['masses'][mask].reshape(-1).astype(np.float64)
            u=f['internalEnergies'][mask].reshape(-1).astype(np.float64)
            if np.isfinite(m).all() and (m>=0).all() and np.isfinite(u).all():
                energy=float(np.sum(m*u))
                if np.isfinite(energy): result['internalEnergy']=energy
        if result['kineticEnergy'] is not None and result['internalEnergy'] is not None:
            total=result['kineticEnergy']+result['internalEnergy']
            if np.isfinite(total): result['totalEnergy']=total
        return result


class NPZSource(Source):
    format = "NPZ snapshots"
    def __init__(self, path: Path):
        self.path = path
        self.files = sorted(path.glob("*.npz"), key=natural_key) if path.is_dir() else [path]
        if not self.files:
            raise ValueError("No NPZ snapshots found in this directory.")
        self.name = path.parent.name if path.name == "snapshots" else path.stem
        measurement = path.parent / "measurements.json" if path.is_dir() else path.parent / "measurements.json"
        recorded = {}
        if measurement.is_file():
            rows = json.loads(measurement.read_text()).get("frames", [])
            recorded = {int(r["step"]): float(r["time"]) for r in rows if "step" in r and "time" in r}
        self.times = []
        have_times = True
        for i, p in enumerate(self.files):
            with np.load(p, allow_pickle=False) as f:
                t = next((float(np.asarray(f[k]).item()) for k in ("time", "t") if k in f), None)
            step = re.search(r"(\d+)$", p.stem)
            if t is None and step:
                t = recorded.get(int(step[1]))
            if t is None:
                have_times = False
            self.times.append(t if t is not None else float(i))
        if not have_times:
            self.times = list(map(float, range(len(self.files))))
            self.time_kind = "frame"
        self._finish()

    def read(self, index, field=None):
        if not 0 <= index < len(self.files):
            raise IndexError("Frame index is out of range.")
        with np.load(self.files[index], allow_pickle=False) as f:
            p = np.asarray(f["positions"])
            keys = f.files if field is None else set(BASE) | {field}
            frame = {ALIASES.get(k, k): np.asarray(f[k]) for k in keys if k in f
                     and k not in ("domain_min", "domain_max", "periodic", "time", "t")
                     and f[k].ndim in (1, 2) and len(f[k]) == len(p) and numeric(f[k])}
            frame["positions"] = p
        return validate(frame)


class HDF5Source(Source):
    format = "warpSPH HDF5"
    def __init__(self, path: Path):
        self.path = path
        self.name = path.parent.name if path.stem == "trajectory" else path.stem
        with h5py.File(path, "r") as h:
            if "positions" in h and isinstance(h["positions"], h5py.Group) and len(h["positions"]):
                self.layout = "columns"
                self.keys = sorted(h["positions"], key=natural_key)
            elif "states" in h and len(h["states"]):
                self.layout = "states"
                self.keys = sorted(h["states"], key=natural_key)
            elif "state/positions" in h:
                self.layout = "checkpoint"
                self.keys = ["state"]
            else:
                raise ValueError("Unsupported HDF5 layout: expected positions/frame_*, states/*, or state/positions.")
            self.times = []
            valid_times = True
            for i, key in enumerate(self.keys):
                if f"times/{key}" in h:
                    t = float(np.asarray(h[f"times/{key}"]).item())
                else:
                    group = self._state_group(h, key) if self.layout != "columns" else h
                    t = group.attrs.get("time", group.attrs.get("t", None))
                    if t is None and self.layout == "states":
                        parent = h[f"states/{key}"]
                        t = parent.attrs.get("time", parent.attrs.get("t", None))
                    if t is None and self.layout == "checkpoint":
                        t = h.attrs.get("time", None)
                    if t is None:
                        valid_times = False
                        t = i
                self.times.append(float(t))
            if not valid_times:
                self.time_kind = "frame"
                self.times = list(map(float, range(len(self.keys))))
        self._finish()

    def _state_group(self, h, key):
        if self.layout == "checkpoint":
            return h["state"]
        g = h[f"states/{key}"]
        return g["state"] if "state" in g else g

    def read(self, index, field=None):
        if not 0 <= index < len(self.keys):
            raise IndexError("Frame index is out of range.")
        key = self.keys[index]
        frame = {}
        with h5py.File(self.path, "r") as h:
            if self.layout == "columns":
                n = h[f"positions/{key}"].shape[0]
                for name, item in h.items():
                    if isinstance(item, h5py.Group) and key in item and isinstance(item[key], h5py.Dataset):
                        ds = item[key]
                        if ds.ndim in (1, 2) and ds.shape[0] == n and ds.dtype.kind in "fiub":
                            if field is None or name in BASE or name == field:
                                frame[name] = ds[()]
                for name in ("kinds", "UIDs", "masses", "supports", "densities", "velocities", "materials"):
                    dsname = "combined" + name[0].upper() + name[1:]
                    # Dynamic columns always override initial metadata.
                    if name not in frame and dsname in h:
                        ds = h[dsname]
                        if ds.shape[0] != n:
                            if name in ("kinds", "UIDs", "masses", "supports"):
                                raise ValueError("Particle count changed but the file has only initial particle metadata.")
                            continue
                        if name in ("densities", "velocities"):
                            continue  # Initial values cannot stand in for missing dynamic data.
                        if field is None or name in BASE or name == field:
                            frame[name] = ds[()]
            else:
                g = self._state_group(h, key)
                for name, ds in g.items():
                    if isinstance(ds, h5py.Dataset) and ds.ndim in (1, 2) and ds.dtype.kind in "fiub":
                        if field is None or name in BASE or name == field:
                            frame[name] = ds[()]
        return validate(frame)


class DemoSource(Source):
    """Analytical, divergence-free fields; explicitly not solver trajectories."""
    format = "Analytical demo"
    def __init__(self, dim=2):
        self.dim = dim
        self.name = f"Taylor–Green · {dim}D analytical"
        n = 96 if dim == 2 else 24
        axis = (np.arange(n) + .5) * (2*np.pi/n)
        self.p = np.stack(np.meshgrid(*([axis]*dim), indexing="ij"), axis=-1).reshape(-1, dim)
        if dim == 3:
            self.p = self.p[np.linalg.norm(self.p-np.pi, axis=1) < np.pi*.93]
        self.dx = 2*np.pi/n
        self.times = np.linspace(0, 6, 121).tolist()
        self._finish()

    def read(self, index, field=None):
        if not 0 <= index < len(self.times):
            raise IndexError("Frame index is out of range.")
        p = self.p.copy()
        t = self.times[index]
        # Fixed sampling lattice of a decaying analytical field, not particle advection.
        x, y = p[:, 0], p[:, 1]
        amp = np.exp(-.15*t)
        v = np.stack((np.sin(x)*np.cos(y), -np.cos(x)*np.sin(y)), axis=1)*amp
        if self.dim == 3:
            v = np.column_stack((v*np.cos(p[:, 2:3]), np.zeros(len(p))))
        rho = 1 + .03*np.cos(2*x)*np.cos(2*y)*amp
        return {"positions": p.astype(np.float32), "velocities": v.astype(np.float32),
                "densities": rho.astype(np.float32), "kinds": np.zeros(len(p), dtype=np.int32),
                "UIDs": np.arange(len(p), dtype=np.int64),
                "masses": np.full(len(p), self.dx**self.dim, dtype=np.float32),
                "supports": np.full(len(p), self.dx*2, dtype=np.float32)}


def open_source(path):
    p = Path(path).expanduser().resolve(strict=True)
    if p.is_dir() and (p/"trajectory.h5").is_file():
        p = p/"trajectory.h5"
    if p.is_dir() or p.suffix.lower() == ".npz":
        return NPZSource(p)
    if p.suffix.lower() in (".h5", ".hdf5"):
        return HDF5Source(p)
    raise ValueError("Choose a warpSPH HDF5 trajectory, an NPZ snapshot, or an NPZ sequence directory.")
