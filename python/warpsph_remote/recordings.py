"""Read existing exports at a producer safe boundary, or after its writer closes.

No SWMR bypass, file-lock disabling or second recording is needed. An active
producer calls this on its simulation thread between output writes. The daemon
only calls it directly for a terminal producer that has closed its writer.
"""
import json
from pathlib import Path

from .protocol import encode_frame
from .sources import HDF5Source, Source, natural_key


class CheckpointHistory(Source):
    format = "warpSPH checkpoints"

    def __init__(self, directory):
        directory = Path(directory)
        self.name = directory.parent.name
        paths = sorted(directory.glob("state_*.h5"), key=natural_key)
        initial = directory / "initialState.h5"
        if initial.is_file():
            paths.insert(0, initial)
        self.sources = [HDF5Source(path) for path in paths]
        if not self.sources:
            raise ValueError("No completed frames have been exported yet.")
        self.times = [source.times[0] for source in self.sources]
        self._finish()

    def read(self, index, field=None):
        if not 0 <= index < len(self.sources):
            raise ValueError("Recorded frame is out of range.")
        return self.sources[index].read(0, field)


def read_recording(recording, operation="metadata", index=None, field=None):
    path = Path(recording["path"])
    if not path.exists():
        raise ValueError("No completed frames have been exported yet.")
    source = HDF5Source(path) if recording["mode"] == "trajectory" else CheckpointHistory(path)
    if operation == "metadata":
        metadata = source.metadata()
        metadata["domain"] = recording.get("domain")
        metadata["name"] = recording.get("name", source.name)
        return json.dumps(metadata, allow_nan=False).encode(), "application/json"
    if operation != "frame" or type(index) is not int or not 0 <= index < len(source.times):
        raise ValueError("Recorded frame is out of range.")
    arrays = source.read(index, field)
    geometry=source.frame_metadata(index) if hasattr(source,"frame_metadata") else {}
    model=recording.get('physicalModel')
    if model and model.get('kind')=='kidder':
        import math
        t=source.times[index]
        if 0<=t<model['tau']:
            scale=math.sqrt(1-(t/model['tau'])**2)
            geometry['physicalBounds']=[[model['inner']*scale],[model['outer']*scale]]
    return encode_frame(arrays, index=index, time=source.times[index], metadata=geometry), "application/octet-stream"
