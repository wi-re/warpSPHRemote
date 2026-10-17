"""WPR1 binary packets: 8-byte prefix, padded JSON header, aligned array payloads."""
import json
import struct
import numpy as np

MAGIC = b"WPR1"


def encode_frame(arrays, *, index, time):
    fields, chunks = {}, []
    offset = 0
    for name, value in arrays.items():
        a = np.asarray(value)
        if a.dtype.kind == "u" and a.dtype.itemsize == 8 and a.size and a.max() > np.iinfo(np.int64).max:
            raise ValueError("Unsigned 64-bit identities above int64 range are not supported by WPR1.")
        # Preserve integer identities exactly. Floating display data uses float32.
        dtype = "<f4" if a.dtype.kind == "f" else ("<i8" if a.dtype.itemsize > 4 else "<i4")
        a = np.ascontiguousarray(a, dtype=dtype)
        pad = (-offset) % 8
        chunks.append(bytes(pad))
        offset += pad
        fields[name] = {"dtype": dtype, "shape": list(a.shape), "offset": offset, "bytes": a.nbytes}
        chunks.append(a.tobytes())
        offset += a.nbytes
    header = json.dumps({"version": 1, "index": index, "time": time, "arrays": fields},
                        separators=(",", ":"), allow_nan=False).encode()
    return MAGIC + struct.pack("<I", len(header)) + header + bytes((-len(header)) % 8) + b"".join(chunks)
