import shader from "./scan.wgsl?raw";
export type AllocateBuffer = (
  name: string,
  bytes: number,
  usage: GPUBufferUsageFlags,
) => GPUBuffer;
/** Reusable device-only exclusive scan for cell compaction and future CSR offsets. */
export class GPUScan {
  private constructor(
    private device: GPUDevice,
    private scan: GPUComputePipeline,
    private add: GPUComputePipeline,
  ) {}
  static async create(device: GPUDevice) {
    const module = device.createShaderModule({
      code: shader,
      label: "Exclusive prefix scan",
    });
    const [scan, add] = await Promise.all(
      ["scan", "addBlocks"].map((entryPoint) =>
        device.createComputePipelineAsync({
          layout: "auto",
          compute: { module, entryPoint },
        }),
      ),
    );
    return new GPUScan(device, scan, add);
  }
  encode(
    encoder: GPUCommandEncoder,
    input: GPUBuffer,
    output: GPUBuffer,
    count: number,
    allocate: AllocateBuffer,
  ) {
    const levels: {
      output: GPUBuffer;
      blocks: GPUBuffer;
      uniform: GPUBuffer;
      count: number;
    }[] = [];
    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    for (let level = 0; ; level++) {
      const groups = Math.ceil(count / 128),
        blocks = allocate(`scan-blocks-${level}`, groups * 4, storage),
        uniform = allocate(
          `scan-params-${level}`,
          16,
          GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        );
      this.device.queue.writeBuffer(
        uniform,
        0,
        new Uint32Array([count, 0, 0, 0]),
      );
      const bind = this.device.createBindGroup({
        layout: this.scan.getBindGroupLayout(0),
        entries: [input, output, blocks, uniform].map((buffer, binding) => ({
          binding,
          resource: { buffer },
        })),
      });
      const pass = encoder.beginComputePass({
        label: `scan cells level ${level}`,
      });
      pass.setPipeline(this.scan);
      pass.setBindGroup(0, bind);
      pass.dispatchWorkgroups(groups);
      pass.end();
      levels.push({ output, blocks, uniform, count });
      if (groups === 1) break;
      input = blocks;
      output = allocate(`scan-offsets-${level + 1}`, groups * 4, storage);
      count = groups;
    }
    for (let i = levels.length - 2; i >= 0; i--) {
      const level = levels[i];
      const bind = this.device.createBindGroup({
        layout: this.add.getBindGroupLayout(0),
        entries: [
          { binding: 1, resource: { buffer: level.output } },
          { binding: 2, resource: { buffer: levels[i + 1].output } },
          { binding: 3, resource: { buffer: level.uniform } },
        ],
      });
      const pass = encoder.beginComputePass({
        label: `add block offsets level ${i}`,
      });
      pass.setPipeline(this.add);
      pass.setBindGroup(0, bind);
      pass.dispatchWorkgroups(Math.ceil(level.count / 128));
      pass.end();
    }
  }
}
