"""WPR1 binary packets: 8-byte prefix, padded JSON header, aligned array payloads."""
import json
import struct
import numpy as np

MAGIC = b"WPR1"
DEFAULT_SNAPSHOT_BYTES = 128 * 1024 * 1024


def encode_frame(arrays, *, index, time, metadata=None):
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
    header = json.dumps({"version": 1, "index": index, "time": time, "arrays": fields, **(metadata or {})},
                        separators=(",", ":"), allow_nan=False).encode()
    return MAGIC + struct.pack("<I", len(header)) + header + bytes((-len(header)) % 8) + b"".join(chunks)


def validate_packet(packet):
    """Validate descriptors without decoding/copying numerical payloads."""
    if len(packet) < 8 or packet[:4] != MAGIC:
        raise ValueError("Invalid numerical packet signature.")
    size = struct.unpack('<I', packet[4:8])[0]
    if size > min(len(packet)-8, 65536):
        raise ValueError("Invalid numerical packet header size.")
    try:
        header = json.loads(packet[8:8+size])
        import math
        if header['version'] != 1 or type(header['index']) is not int or not math.isfinite(header['time']):
            raise ValueError("Invalid numerical packet metadata.")
        arrays = header['arrays']
        if not isinstance(arrays, dict) or not 1 <= len(arrays) <= 64:
            raise ValueError("Invalid numerical array catalogue.")
        base = 8+(size+7)//8*8
        for name, spec in arrays.items():
            shape, offset, count = spec['shape'], spec['offset'], spec['bytes']
            width = {'<f4':4, '<i4':4, '<i8':8}.get(spec['dtype'])
            if (not width or len(name)>80 or not isinstance(shape,list) or len(shape) not in (1,2)
                or any(type(n) is not int or n<1 for n in shape)
                or type(offset) is not int or offset<0 or (base+offset)%width
                or math.prod(shape)*width != count or base+offset+count>len(packet)):
                raise ValueError("Invalid numerical array descriptor.")
        return header
    except (KeyError, TypeError, UnicodeError, OverflowError) as e:
        raise ValueError("Invalid numerical packet header.") from e
