"""Synthetic live producer for browser transport/pairing regression checks.

Use --output with a fresh directory outside source. In the viewer, connect to
http://127.0.0.1:18767 with token browser-fixture-token, Watch live, pause/resume
from the plot, reload/reconnect, then Forget pairing and reload. No Warp or user
simulation data is involved. Ctrl+C or --seconds ends this isolated fixture.
"""
import argparse
from functools import partial
from http.server import ThreadingHTTPServer
import json
from types import SimpleNamespace as NS
import threading
import time
from pathlib import Path

import numpy as np
from warpsph_remote.daemon import Manager, Handler
from warpsph_remote.publisher import SimulationPublisher, SimulationStopped


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--seconds', type=float, default=600)
    args = parser.parse_args()
    root = args.output.resolve()
    if root.exists():
        parser.error('choose a fresh output directory outside source')
    if not np.isfinite(args.seconds) or args.seconds <= 0:
        parser.error('seconds must be finite and positive')
    manager = Manager(root)
    manager.token = 'browser-fixture-token'
    server = ThreadingHTTPServer(('127.0.0.1', 18767), partial(Handler, manager=manager))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    descriptor = root / 'daemon.json'
    descriptor.write_text(json.dumps(dict(endpoint='http://127.0.0.1:18767',
                                         producerToken=manager.producer_token)))
    descriptor.chmod(0o600)
    axis = np.linspace(0, 1, 16, dtype=np.float32)
    positions = np.stack(np.meshgrid(axis, axis), axis=-1).reshape(-1, 2)
    n = len(positions)
    state = NS(positions=positions, velocities=np.ones((n, 2), np.float32)*.1,
               densities=np.ones(n, np.float32), supports=np.ones(n, np.float32)*.15,
               masses=np.ones(n, np.float32)/n, kinds=np.zeros(n, np.int32),
               UIDs=np.arange(n, dtype=np.int64))
    ctx = NS(spec=NS(store=False, tLimit=9000), scratch={}, exportPath=None, scheme='test',
             config=NS(dt=.01, domain=NS(min=np.zeros(2), max=np.ones(2),
                                        periodic=np.ones(2, dtype=bool))))
    publisher = SimulationPublisher('Live controls verification', runtime=root,
                                    autostart=False, interval=.02)
    timer = threading.Timer(args.seconds, publisher.stopping.set)
    timer.daemon = True
    timer.start()
    print('Synthetic fixture: http://127.0.0.1:18767 · token browser-fixture-token', flush=True)
    try:
        for step in range(900000):
            publisher.post_step(ctx, NS(t=step*.01, state=state), step)
            time.sleep(.01)
    except (SimulationStopped, KeyboardInterrupt):
        pass
    finally:
        timer.cancel()
        publisher.close('stopped')
        server.shutdown()
        server.server_close()
        descriptor.unlink(missing_ok=True)


if __name__ == '__main__':
    main()
