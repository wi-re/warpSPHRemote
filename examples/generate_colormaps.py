"""Regenerate bundled 256-entry Matplotlib lookup tables (development only)."""
import json
from pathlib import Path
from matplotlib import colormaps

names = ['viridis','magma','inferno','plasma','cividis','coolwarm','twilight']
tables = {name: [round(float(v)*255) for row in colormaps[name].resampled(256)(range(256)) for v in row[:3]] for name in names}
root = Path(__file__).resolve().parents[1]
(root/'web/src/colormap-tables.ts').write_text(
    '// Matplotlib colormaps, sampled at 256 entries. See THIRD_PARTY.md.\n'
    + 'export const colormapTables:Record<string,number[]> = '
    + json.dumps(tables,separators=(',',':'))+';\n'
)
