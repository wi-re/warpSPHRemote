// Hierarchical exclusive u32 scan. No subgroup feature or global barrier assumed.
struct Parameters { count: u32, a: u32, b: u32, c: u32 }
@group(0) @binding(0) var<storage, read> input: array<u32>;
@group(0) @binding(1) var<storage, read_write> output: array<u32>;
@group(0) @binding(2) var<storage, read_write> blocks: array<u32>;
@group(0) @binding(3) var<uniform> p: Parameters;
var<workgroup> scratch: array<u32, 128>;
@compute @workgroup_size(128)
fn scan(@builtin(global_invocation_id) id: vec3u,
  @builtin(local_invocation_id) local: vec3u, @builtin(workgroup_id) group: vec3u) {
  var original = 0u;
  if (id.x < p.count) { original = input[id.x]; }
  scratch[local.x] = original;
  workgroupBarrier();
  for (var step = 1u; step < 128u; step *= 2u) {
    var left = 0u;
    if (local.x >= step) { left = scratch[local.x - step]; }
    workgroupBarrier();
    scratch[local.x] += left;
    workgroupBarrier();
  }
  if (id.x < p.count) { output[id.x] = scratch[local.x] - original; }
  if (local.x == 127u) { blocks[group.x] = scratch[127]; }
}
@compute @workgroup_size(128)
fn addBlocks(@builtin(global_invocation_id) id: vec3u) {
  if (id.x < p.count) { output[id.x] += blocks[id.x / 128u]; }
}
