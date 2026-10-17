// Full cutoff radius h, 2D Wendland C2/C4, scatter supports h_j.
// Local coordinates preserve precision for unwrapped recorded trajectories.
struct Particle {
  position: vec2f, support: f32, volume: f32,
  field: vec4f, velocity: vec2f, flags: u32, padding: u32,
}
struct Parameters {
  span: vec2f, size: vec2u,
  bins: vec2u, radius: vec2u,
  periodic: vec2u, count: u32, kernel: u32,
  minCoverage: f32, components: u32, mapping: u32, padding: u32,
}
struct Result { field: vec4f, velocity: vec2f, coverage: f32, flags: u32 }
@group(0) @binding(0) var<storage, read> particles: array<Particle>;
@group(0) @binding(1) var<storage, read_write> counts: array<atomic<u32>>;
@group(0) @binding(2) var<storage, read> offsets: array<u32>;
@group(0) @binding(3) var<storage, read_write> sorted: array<Particle>;
@group(0) @binding(4) var<storage, read_write> results: array<Result>;
@group(0) @binding(5) var<uniform> p: Parameters;
@group(0) @binding(6) var<storage, read_write> cursors: array<atomic<u32>>;
fn particleCell(position: vec2f) -> u32 {
  let cell = vec2u(clamp(floor(position / p.span * vec2f(p.bins)), vec2f(0), vec2f(p.bins - 1u)));
  return cell.y * p.bins.x + cell.x;
}
@compute @workgroup_size(128)
fn clear(@builtin(global_invocation_id) id: vec3u) {
  if (id.x < p.bins.x * p.bins.y) { atomicStore(&counts[id.x], 0u); atomicStore(&cursors[id.x], 0u); }
}
@compute @workgroup_size(128)
fn countParticles(@builtin(global_invocation_id) id: vec3u) {
  if (id.x < p.count && (particles[id.x].flags & 1u) != 0u) {
    atomicAdd(&counts[particleCell(particles[id.x].position)], 1u);
  }
}
@compute @workgroup_size(128)
fn scatterParticles(@builtin(global_invocation_id) id: vec3u) {
  if (id.x < p.count && (particles[id.x].flags & 1u) != 0u) {
    let cell = particleCell(particles[id.x].position);
    let slot = offsets[cell] + atomicAdd(&cursors[cell], 1u);
    sorted[slot] = particles[id.x];
  }
}
fn wrap(x: i32, size: u32) -> u32 { return u32((x % i32(size) + i32(size)) % i32(size)); }
@compute @workgroup_size(128)
fn reconstruct(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= p.size.x * p.size.y) { return; }
  let position = (vec2f(f32(i % p.size.x), f32(i / p.size.x)) + 0.5) / vec2f(p.size) * p.span;
  let cell = vec2i(floor(position / p.span * vec2f(p.bins)));
  var start = cell - vec2i(p.radius);
  var stop = cell + vec2i(p.radius);
  for (var c = 0u; c < 2u; c++) {
    if (p.periodic[c] != 0u) { stop[c] = min(stop[c], start[c] + i32(p.bins[c]) - 1); }
    else { start[c] = max(start[c], 0); stop[c] = min(stop[c], i32(p.bins[c]) - 1); }
  }
  var weight = 0.0; var field = vec4f(0); var velocity = vec2f(0);
  var badField = false; var badVelocity = false;
  for (var y = start.y; y <= stop.y; y++) {
    for (var x = start.x; x <= stop.x; x++) {
      let bin = wrap(y, p.bins.y) * p.bins.x + wrap(x, p.bins.x);
      let begin = offsets[bin];
      let end = begin + atomicLoad(&counts[bin]);
      for (var j = begin; j < end; j++) {
        let particle = sorted[j];
        var delta = position - particle.position;
        for (var c = 0u; c < 2u; c++) {
          if (p.periodic[c] != 0u) { delta[c] -= floor(delta[c] / p.span[c] + 0.5) * p.span[c]; }
        }
        let q = length(delta) / particle.support;
        if (q < 1.0) {
          let t = 1.0 - q; let t2 = t*t; let t4 = t2*t2;
          var k = 7.0 * t4 * (1.0 + 4.0*q);
          if (p.kernel == 1u) { k = 9.0 * t4*t2 * (1.0 + 6.0*q + (35.0/3.0)*q*q); }
          let w = particle.volume / (3.141592653589793 * particle.support * particle.support) * k;
          weight += w; field += w * particle.field; velocity += w * particle.velocity;
          badField = badField || (particle.flags & 2u) == 0u;
          badVelocity = badVelocity || (particle.flags & 4u) == 0u;
        }
      }
    }
  }
  var flags = 0u;
  if (weight >= p.minCoverage) {
    field /= weight; velocity /= weight;
    if (!badField) { flags |= 1u; }
    if (!badVelocity) { flags |= 2u; }
  }
  results[i] = Result(field, velocity, weight, flags);
}
