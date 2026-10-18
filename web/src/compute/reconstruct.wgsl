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
  minCoverage: f32, components: u32, mapping: u32, quantity: u32,
  queryOffset: u32, queryCount: u32, padding: vec2u,
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
  let i = p.queryOffset + id.x;
  if (id.x >= p.queryCount || i >= p.size.x * p.size.y) { return; }
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
  var velocityAnchor = vec2f(0); var anchored = false;
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
          if (!anchored) { velocityAnchor = particle.velocity; anchored = true; }
          weight += w; field += w * particle.field; velocity += w * (particle.velocity - velocityAnchor);
          badField = badField || (particle.flags & 2u) == 0u;
          badVelocity = badVelocity || (particle.flags & 4u) == 0u;
        }
      }
    }
  }
  var flags = 0u;
  if (weight >= p.minCoverage) {
    let relativeMean = velocity / weight;
    if (p.quantity == 0u) { field /= weight; }
    else { field = vec4f(velocityAnchor, relativeMean); }
    velocity = velocityAnchor + relativeMean;
    if (!badField) { flags |= 1u; }
    if (!badVelocity) { flags |= 2u; }
  }
  results[i] = Result(field, velocity, weight, flags);
}

// Analytic derivative of the normalized velocity interpolant:
// d(vbar)/dx = sum_j (vj-vbar) * d(Vj Wj)/dx / coverage.
// A separate pass reuses compact cell ranges and the completed mean velocity.
@compute @workgroup_size(128)
fn differentiate(@builtin(global_invocation_id) id: vec3u) {
  let i = p.queryOffset + id.x;
  if (id.x >= p.queryCount || i >= p.size.x * p.size.y) { return; }
  if ((results[i].flags & 2u) == 0u) { results[i].flags &= ~1u; return; }
  let position = (vec2f(f32(i % p.size.x), f32(i / p.size.x)) + 0.5) / vec2f(p.size) * p.span;
  let cell = vec2i(floor(position / p.span * vec2f(p.bins)));
  var start = cell - vec2i(p.radius); var stop = cell + vec2i(p.radius);
  for (var c = 0u; c < 2u; c++) {
    if (p.periodic[c] != 0u) { stop[c] = min(stop[c], start[c] + i32(p.bins[c]) - 1); }
    else { start[c] = max(start[c], 0); stop[c] = min(stop[c], i32(p.bins[c]) - 1); }
  }
  let anchor = results[i].field.xy;
  let relativeMean = results[i].field.zw;
  var gradient = vec4f(0); // du/dx, du/dy, dv/dx, dv/dy
  for (var y = start.y; y <= stop.y; y++) {
    for (var x = start.x; x <= stop.x; x++) {
      let bin = wrap(y, p.bins.y) * p.bins.x + wrap(x, p.bins.x);
      let begin = offsets[bin]; let end = begin + atomicLoad(&counts[bin]);
      for (var j = begin; j < end; j++) {
        let particle = sorted[j]; var delta = position - particle.position;
        for (var c = 0u; c < 2u; c++) {
          if (p.periodic[c] != 0u) { delta[c] -= floor(delta[c] / p.span[c] + 0.5) * p.span[c]; }
        }
        let q = length(delta) / particle.support;
        if (q < 1.0) {
          let t = 1.0 - q; let t2 = t*t;
          var dkOverQ = -20.0 * t2*t; var norm = 7.0 / 3.141592653589793;
          if (p.kernel == 1u) { dkOverQ = -(56.0/3.0) * (5.0*q + 1.0) * t2*t2*t; norm = 9.0 / 3.141592653589793; }
          let h2 = particle.support * particle.support;
          let gradW = (particle.volume / h2) * (norm * dkOverQ / h2) * delta;
          let dv = (particle.velocity - anchor) - relativeMean;
          gradient += vec4f(dv.x * gradW.x, dv.x * gradW.y, dv.y * gradW.x, dv.y * gradW.y);
        }
      }
    }
  }
  var value = (gradient.x + gradient.w) / results[i].coverage;
  if (p.quantity == 2u) { value = (gradient.z - gradient.y) / results[i].coverage; }
  results[i].field = vec4f(value, 0, 0, 0); results[i].flags |= 1u;
}
