/** Recorded-fixture CPU map validation, independent brute-force neighbourhood oracle. */
import * as api from "h5wasm/node";
import assert from "node:assert/strict";
import catalogue from "../web/src/recorded-demos.json";
import { HDF5Source } from "../web/src/sources/hdf5";
import { MaterialFTLE, type FTLEQuery } from "../web/src/sources/ftle";
import {
  seedMaterial,
  materialPositions,
  deformation,
} from "../web/src/sources/material";
await api.ready;
for (const demo of catalogue) {
  const source = new HDF5Source(
    demo.id,
    demo.name,
    new api.File(`${process.cwd()}/web/public/demos/${demo.file}`, "r"),
    api,
  );
  try {
    const first = await source.read(0, "UIDs"),
      last = await source.read(source.times.length - 1, "UIDs"),
      query: FTLEQuery = {
        start: 0,
        end: source.times.length - 1,
        resolution: 64,
        radius: 0.05,
        neighbours: 24,
        maxResidual: 0.25,
      };
    const start = performance.now(),
      map = new MaterialFTLE(
        first,
        last,
        query,
        source.times[0],
        source.times.at(-1)!,
        source.domain,
      );
    let valid = 0,
      invalid = 0,
      oracle = 0,
      worst = 0;
    const values: number[] = [];
    for (let offset = 0; offset < map.width * map.height; offset += 128) {
      const batch = map.batch(offset, 128);
      for (let i = 0; i < batch.values.length; i++) {
        const value = batch.values[i];
        if (!Number.isFinite(value)) {
          invalid++;
          continue;
        }
        valid++;
        values.push(value);
        assert.ok(
          batch.residual[i] <= 0.250001 &&
            batch.condition[i] <= 1e6 &&
            batch.counts[i] >= 3,
        );
        if (oracle < 16) {
          const uid = batch.uids[i]!,
            seed = seedMaterial(
              first,
              uid,
              { mode: "radius", count: 24, radius: 0.05 },
              0,
              source.times[0],
              source.domain,
            ),
            sample = {
              index: query.end,
              time: source.times.at(-1)!,
              positions: materialPositions(last, seed.uids),
            },
            expected = deformation(seed, sample);
          assert.ok(expected.ftle != null);
          const error = Math.abs(value - expected.ftle!);
          worst = Math.max(worst, error);
          assert.ok(error < 1e-5);
          oracle++;
        }
      }
    }
    console.log(
      JSON.stringify({
        file: demo.file,
        milliseconds: performance.now() - start,
        resolution: [map.width, map.height],
        valid,
        invalid,
        range: values.length
          ? [Math.min(...values), Math.max(...values)]
          : null,
        bruteForceOracles: oracle,
        maxAbsoluteError: worst,
      }),
    );
    assert.ok(valid > 0 && oracle > 0);
  } finally {
    source.close();
  }
}
