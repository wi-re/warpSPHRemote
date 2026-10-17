"""Build the curated shipped product demos from finished external recordings.

The output directory must be new. Copies whole saved frames without quantizing,
wrapping, interpolating or modifying source recordings. No simulator is imported.
"""
import argparse
import hashlib
import json
from pathlib import Path
from prepare_demo_recording import prepare


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--random', type=Path, required=True)
    p.add_argument('--sloshing', type=Path, required=True)
    p.add_argument('--khh', type=Path, help='optional completed 256² CRKSPH KHH recording with energy diagnostics')
    p.add_argument('--output', type=Path, required=True)
    args = p.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    assets = args.output / 'demos'
    assets.mkdir()
    entries = []
    specs = [
        ('random-wcsph-128', 'Decaying random flow · WCSPH',
         'Periodic 2D WCSPH / deltaSPH. Seeded random velocity, viscosity 0.005, no forcing. 16,384 particles.', args.random),
        ('sloshing-200', 'Sloshing tank',
         '2D moving-tank WCSPH / deltaSPH. 4,200 fluid particles plus tank boundaries; pressure and velocity recorded.', args.sloshing),
    ]
    if args.khh:
        specs.append(('khh-crksph-256', 'Kelvin–Helmholtz · CRKSPH',
          'Periodic compressible CRKSPH shear instability. 65,536 particles, unwrapped coordinates and recorded energy diagnostics; 41 saved states through t ≈ 4.', args.khh))
    for key, name, description, source in specs:
        path = assets / f'{key}.h5'
        info = prepare(source, path, interval=0.1, compression=9, static_constants=True)
        entries.append(dict(id=f'demo-{key}', name=name, description=description,
            file=path.name, bytes=info['bytes'], sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
            particles=info['particles'], frames=info['frames'], duration=info['finalTime']))
    (args.output / 'recorded-demos.json').write_text(json.dumps(entries, indent=2, ensure_ascii=False) + '\n')
    print(json.dumps(entries, indent=2, ensure_ascii=False))


if __name__ == '__main__':
    main()
