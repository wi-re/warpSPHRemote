"""Extract one numerical display frame for the particle-antialias browser check.

Requires the optional Python file adapter (numpy/h5py), never a simulation runtime.
Keep --output outside source and choose a fresh directory. See the report.
"""
import argparse
import json
from pathlib import Path
from warpsph_remote.recordings import read_recording


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--recording', type=Path, required=True)
    parser.add_argument('--index', type=int, default=0)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--domain', type=json.loads, help='Optional JSON with min/max/periodic arrays.')
    args = parser.parse_args()
    if args.output.exists():
        parser.error('choose a fresh output directory outside source')
    recording = dict(path=str(args.recording.resolve()), mode='trajectory', name=args.recording.parent.name)
    if args.domain:
        recording['domain'] = args.domain
    metadata = json.loads(read_recording(recording)[0])
    metadata['id'] = 'particle-aa-fixture'
    frame = read_recording(recording, 'frame', args.index, 'densities')[0]
    args.output.mkdir(parents=True, exist_ok=False)
    (args.output / 'metadata.json').write_text(json.dumps(metadata, indent=2))
    (args.output / 'frame.wpr1').write_bytes(frame)


if __name__ == '__main__':
    main()
