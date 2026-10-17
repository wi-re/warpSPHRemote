import licShader from "./lic.wgsl?raw";
import { validateLIC, type LICSettings } from "../sources/lic";
import { GPUScan } from "./scan";
import shader from "./reconstruct.wgsl?raw";
import type { RawFrame } from "../sources/core";
import type { Mapping, Source } from "../types";
import type { GridData, GridSettings } from "../sources/grid";
import { prepareParticles } from "./particles";

type Slot = { buffer: GPUBuffer; capacity: number; usage: GPUBufferUsageFlags };
/** Worker-owned device and reusable buffers. Callers serialize jobs per instance. */
export class GPUGrid {
  private slots = new Map<string, Slot>();
  private dead = "";
  private licPipeline?: GPUComputePipeline;
  private constructor(
    private device: GPUDevice,
    private pipelines: GPUComputePipeline[],
    private scan: GPUScan,
    public adapter: string,
  ) {
    void device.lost.then((info) => {
      this.dead = info.message || "WebGPU device lost.";
    });
    device.addEventListener("uncapturederror", (event) => {
      this.dead = event.error.message;
    });
  }
  static async create(): Promise<GPUGrid> {
    if (typeof navigator === "undefined" || !navigator.gpu)
      throw new Error("WebGPU is unavailable in this browser or context.");
    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: "high-performance",
    });
    if (!adapter) throw new Error("No WebGPU adapter is available.");
    const device = await adapter.requestDevice();
    try {
      device.pushErrorScope("validation");
      const module = device.createShaderModule({
        code: shader,
        label: "SPH grid kernels",
      });
      const compilation = await module.getCompilationInfo();
      const errors = compilation.messages.filter((m) => m.type === "error");
      if (errors.length)
        throw new Error(
          errors
            .map((m) => `WGSL ${m.lineNum}:${m.linePos} ${m.message}`)
            .join("; "),
        );
      const pipelines = await Promise.all(
        [
          "clear",
          "countParticles",
          "scatterParticles",
          "reconstruct",
          "differentiate",
        ].map((entryPoint) =>
          device.createComputePipelineAsync({
            label: entryPoint,
            layout: "auto",
            compute: { module, entryPoint },
          }),
        ),
      );
      const scan = await GPUScan.create(device);
      const error = await device.popErrorScope();
      if (error) throw new Error(error.message);
      const info = adapter.info;
      return new GPUGrid(
        device,
        pipelines,
        scan,
        [info?.vendor, info?.architecture, info?.description]
          .filter(Boolean)
          .join(" · ") || "WebGPU adapter",
      );
    } catch (e) {
      device.destroy();
      throw e;
    }
  }
  private buffer(name: string, size: number, usage: GPUBufferUsageFlags) {
    const old = this.slots.get(name);
    if (old && old.capacity >= size) return old.buffer;
    const limit =
      usage & GPUBufferUsage.STORAGE
        ? Math.min(
            this.device.limits.maxBufferSize,
            this.device.limits.maxStorageBufferBindingSize,
          )
        : this.device.limits.maxBufferSize;
    if (size > limit)
      throw new Error(`${name} exceeds this device's buffer limit.`);
    const capacity = Math.min(
      limit,
      Math.max(64, 2 ** Math.ceil(Math.log2(size))),
    );
    const allocated = Array.from(this.slots.values()).reduce(
      (sum, s) => sum + s.capacity,
      0,
    );
    if (allocated - (old?.capacity ?? 0) + capacity > 192 * 1024 * 1024)
      throw new Error("GPU reconstruction exceeds its 192 MiB buffer budget.");
    old?.buffer.destroy();
    const buffer = this.device.createBuffer({
      size: capacity,
      usage,
      label: `SPH ${name}`,
    });
    this.slots.set(name, { buffer, capacity, usage });
    return buffer;
  }
  async reconstruct(
    raw: RawFrame,
    source: Pick<Source, "domain">,
    field: string,
    mapping: Mapping,
    settings: GridSettings,
    index = 0,
    time = 0,
  ): Promise<GridData> {
    if (this.dead) throw new Error(this.dead);
    const started = performance.now();
    const prepared = prepareParticles(raw, source, field, mapping, settings);
    const { layout: g, data, params, bins, excluded } = prepared;
    const count = g.width * g.height,
      resultBytes = count * 32;
    if (
      2 * data.byteLength + bins[0] * bins[1] * 20 + 2 * resultBytes >
      192 * 1024 * 1024
    )
      throw new Error("GPU reconstruction exceeds its 192 MiB buffer budget.");
    const maxGroups = this.device.limits.maxComputeWorkgroupsPerDimension;
    if (
      [g.n, count, bins[0] * bins[1]].some(
        (n) => Math.ceil(n / 128) > maxGroups,
      )
    )
      throw new Error(
        "GPU reconstruction exceeds this device's dispatch limit.",
      );
    this.device.pushErrorScope("validation");
    this.device.pushErrorScope("out-of-memory");
    let readback: GPUBuffer | undefined;
    try {
      const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
      const particles = this.buffer("particles", data.byteLength, storage);
      const counts = this.buffer("cell-counts", bins[0] * bins[1] * 4, storage);
      const offsets = this.buffer(
        "cell-offsets",
        bins[0] * bins[1] * 4,
        storage,
      );
      const cursors = this.buffer(
        "cell-cursors",
        bins[0] * bins[1] * 4,
        storage,
      );
      const sorted = this.buffer("sorted-particles", data.byteLength, storage);
      const output = this.buffer(
        "grid",
        resultBytes,
        storage | GPUBufferUsage.COPY_SRC,
      );
      const uniform = this.buffer(
        "parameters",
        64,
        GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      );
      readback = this.buffer(
        "readback",
        resultBytes,
        GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      );
      this.device.queue.writeBuffer(particles, 0, data);
      this.device.queue.writeBuffer(uniform, 0, params);
      const buffers = [
        particles,
        counts,
        offsets,
        sorted,
        output,
        uniform,
        cursors,
      ];
      const encoder = this.device.createCommandEncoder({
        label: "SPH spatial index + reconstruction + readback",
      });
      // Separate passes establish the required global ordering between index writes and traversal.
      for (const [i, pipeline] of this.pipelines.entries()) {
        if (i === 4 && (!settings.quantity || settings.quantity === "field"))
          continue;
        if (i === 2)
          this.scan.encode(
            encoder,
            counts,
            offsets,
            bins[0] * bins[1],
            this.buffer.bind(this),
          );
        const layout = pipeline.getBindGroupLayout(0);
        // Auto layouts expose only statically used bindings for each entry point.
        const bindings =
          i === 0
            ? [1, 5, 6]
            : i === 1
              ? [0, 1, 5]
              : i === 2
                ? [0, 2, 3, 5, 6]
                : [1, 2, 3, 4, 5];
        const bind = this.device.createBindGroup({
          layout,
          entries: bindings.map((binding) => ({
            binding,
            resource: { buffer: buffers[binding] },
          })),
        });
        const pass = encoder.beginComputePass({ label: pipeline.label });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bind);
        pass.dispatchWorkgroups(
          Math.ceil((i === 0 ? bins[0] * bins[1] : i < 3 ? g.n : count) / 128),
        );
        pass.end();
      }
      encoder.copyBufferToBuffer(output, 0, readback, 0, resultBytes);
      this.device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ, 0, resultBytes);
      const bytes = readback.getMappedRange(0, resultBytes),
        f = new Float32Array(bytes),
        u = new Uint32Array(bytes);
      const values = new Float32Array(count).fill(NaN),
        velocity = new Float32Array(count * 2).fill(NaN),
        coverage = new Float32Array(count),
        velocityValid = new Uint8Array(count);
      for (let i = 0; i < count; i++) {
        const off = 8 * i,
          flags = u[off + 7];
        coverage[i] = f[off + 6];
        if (!Number.isFinite(coverage[i]))
          throw new Error("GPU coverage overflowed f32 precision.");
        if (flags & 1) {
          let value = f[off];
          if (
            (!settings.quantity || settings.quantity === "field") &&
            g.components > 1
          ) {
            if (mapping === "magnitude") {
              value = 0;
              for (let c = 0; c < g.components; c++) value += f[off + c] ** 2;
              value = Math.sqrt(value);
            } else value = f[off + g.component];
          }
          if (!Number.isFinite(value))
            throw new Error("GPU field overflowed f32 precision.");
          values[i] = value;
        }
        if (flags & 2) {
          if (!Number.isFinite(f[off + 4]) || !Number.isFinite(f[off + 5]))
            throw new Error("GPU velocity overflowed f32 precision.");
          velocity.set(f.subarray(off + 4, off + 6), 2 * i);
          velocityValid[i] = 1;
        }
      }
      return {
        quantity: settings.quantity ?? "field",
        index,
        time,
        width: g.width,
        height: g.height,
        bounds: [g.lo, g.hi],
        periodic: g.periodic,
        values,
        velocity,
        coverage,
        velocityValid,
        excluded,
        compute: {
          backend: "webgpu",
          milliseconds: performance.now() - started,
          adapter: this.adapter,
        },
      };
    } finally {
      if (readback?.mapState === "mapped") readback.unmap();
      const memoryError = await this.device.popErrorScope(),
        validationError = await this.device.popErrorScope();
      if (memoryError || validationError)
        throw new Error((memoryError || validationError)!.message);
    }
  }
  async lic(grid: GridData, settings: LICSettings): Promise<Float32Array> {
    validateLIC(settings);
    if (this.dead) throw new Error(this.dead);
    const count = grid.width * grid.height;
    this.device.pushErrorScope("validation");
    this.device.pushErrorScope("out-of-memory");
    let readback: GPUBuffer | undefined;
    try {
      this.licPipeline ??= await this.device.createComputePipelineAsync({
        layout: "auto",
        compute: {
          module: this.device.createShaderModule({
            code: licShader,
            label: "LIC",
          }),
          entryPoint: "lic",
        },
      });
      const data = new Float32Array(count * 4);
      for (let i = 0; i < count; i++) {
        data[4 * i] = grid.velocityValid[i] ? grid.velocity[2 * i] : 0;
        data[4 * i + 1] = grid.velocityValid[i] ? grid.velocity[2 * i + 1] : 0;
        data[4 * i + 2] = grid.velocityValid[i];
      }
      const params = new ArrayBuffer(64),
        u = new Uint32Array(params),
        f = new Float32Array(params);
      u.set([grid.width, grid.height, +grid.periodic[0], +grid.periodic[1]]);
      f.set(
        [
          grid.bounds[1][0] - grid.bounds[0][0],
          grid.bounds[1][1] - grid.bounds[0][1],
        ],
        4,
      );
      u[6] = settings.steps;
      u[7] = settings.seed;
      f[8] = settings.contrast;
      const velocity = this.buffer(
          "lic-velocity",
          data.byteLength,
          GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        ),
        output = this.buffer(
          "lic-output",
          count * 4,
          GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        ),
        uniform = this.buffer(
          "lic-params",
          64,
          GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        );
      readback = this.buffer(
        "lic-readback",
        count * 4,
        GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      );
      this.device.queue.writeBuffer(velocity, 0, data);
      this.device.queue.writeBuffer(uniform, 0, params);
      const encoder = this.device.createCommandEncoder(),
        pass = encoder.beginComputePass();
      pass.setPipeline(this.licPipeline);
      pass.setBindGroup(
        0,
        this.device.createBindGroup({
          layout: this.licPipeline.getBindGroupLayout(0),
          entries: [velocity, output, uniform].map((buffer, binding) => ({
            binding,
            resource: { buffer },
          })),
        }),
      );
      pass.dispatchWorkgroups(Math.ceil(count / 128));
      pass.end();
      encoder.copyBufferToBuffer(output, 0, readback, 0, count * 4);
      this.device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ, 0, count * 4);
      const result = new Float32Array(
        readback.getMappedRange(0, count * 4),
      ).slice();
      for (let i = 0; i < count; i++) if (result[i] < 0) result[i] = NaN;
      return result;
    } finally {
      if (readback?.mapState === "mapped") readback.unmap();
      const memory = await this.device.popErrorScope(),
        validation = await this.device.popErrorScope();
      if (memory || validation)
        throw new Error((memory || validation)!.message);
    }
  }
  close() {
    for (const slot of this.slots.values()) slot.buffer.destroy();
    this.slots.clear();
    this.device.destroy();
    this.dead = "WebGPU device closed.";
  }
}
