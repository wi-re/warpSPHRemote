"""Material identity reaches the live viewer through the installed case adapter."""
from types import SimpleNamespace as NS

import numpy as np
import pytest

from test_companion import api, wait_for
from test_video_capture import setup
from warpsph_remote.protocol import validate_packet


@pytest.mark.parametrize('materials', [None, [0, 1], [0, 2**24 + 1]])
def test_case_publisher_transfers_optional_material_ids_exactly(api, materials):
    m, call, publisher, ctx, values, viewer = setup(api)
    expected = None if materials is None else np.asarray(materials, dtype=np.int32)
    if expected is not None:
        values['materials'] = expected.copy()
    try:
        wait_for(lambda: publisher.wants_snapshot)
        def captured():
            # A configuration transfer may occupy the first safe boundary.
            publisher.post_step(ctx, NS(t=.01, state=NS(**values)), 1)
            return m.runs[publisher.id].get('snapshot') is not None
        wait_for(captured)
        if expected is not None:
            values['materials'][:] = -1
        with call(f'/v1/runs/{publisher.id}/snapshot',
                  headers={'X-Viewer-Id': viewer}) as response:
            packet = response.read()
        header = validate_packet(packet)
        fields = {f['name'] for f in m.runs[publisher.id]['metadata']['fields']}
        if expected is None:
            assert 'materials' not in fields
            assert 'materials' not in header['arrays']
        else:
            assert 'materials' in fields
            descriptor = header['arrays']['materials']
            assert descriptor['dtype'] == '<i4'
            base = 8 + (int.from_bytes(packet[4:8], 'little') + 7) // 8 * 8
            actual = np.frombuffer(packet, dtype='<i4', count=len(expected),
                                   offset=base + descriptor['offset'])
            np.testing.assert_array_equal(actual, expected)
    finally:
        publisher.close('stopped')
