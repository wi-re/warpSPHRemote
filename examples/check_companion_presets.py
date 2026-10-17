"""Smoke-test installed default presets through an already-running local companion.

Writes only to a new evidence directory. Never prints or saves pairing tokens.
"""

import argparse
import json
from pathlib import Path
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from warpsph_remote.catalogue import CATALOGUE
from warpsph_remote.daemon import descriptor


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--runtime", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    a = p.parse_args()
    a.output.mkdir(parents=True, exist_ok=False)
    info = descriptor(a.runtime)

    def request(path, data=None):
        req = Request(
            info["endpoint"] + path,
            data=json.dumps(data).encode() if data is not None else None,
            headers={
                "Authorization": "Bearer " + info["token"],
                "Content-Type": "application/json",
            },
        )
        with urlopen(req, timeout=10) as r:
            return json.load(r)

    results = []
    for case in CATALOGUE:
        until = time.monotonic() + 120
        while True:
            try:
                run = request(
                    "/v1/runs", dict(preset=case["id"], nx=16, duration=0.001, steps=2)
                )
                break
            except HTTPError as error:
                if error.code != 409 or time.monotonic() > until:
                    raise
                time.sleep(
                    0.5
                )  # Previous worker may be cleaning up CUDA after final status.
        finished = False
        try:
            while time.monotonic() < until:
                row = next(
                    r for r in request("/v1/runs")["runs"] if r["id"] == run["id"]
                )
                if row["status"] in ("completed", "failed", "stopped"):
                    finished = True
                    break
                time.sleep(0.25)
            if not finished:
                raise TimeoutError(f"{case['id']} exceeded its smoke-test deadline")
            results.append(dict(preset=case["id"], **row))
            (a.output / "results.json").write_text(json.dumps(results, indent=2) + "\n")
            print(case["id"], row["status"], flush=True)
            if row["status"] != "completed":
                raise RuntimeError(
                    f"{case['id']} failed; inspect its local simulation.log"
                )
        finally:
            if not finished:
                request(f"/v1/runs/{run['id']}/stop", {})
    print(a.output / "results.json")


if __name__ == "__main__":
    main()
