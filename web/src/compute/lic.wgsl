struct Params { size: vec2<u32>, periodic: vec2<u32>, span: vec2<f32>, steps: u32, seed: u32, contrast: f32, _pad: vec3<f32> }
@group(0) @binding(0) var<storage,read> velocity: array<vec4<f32>>;
@group(0) @binding(1) var<storage,read_write> output: array<f32>;
@group(0) @binding(2) var<uniform> params: Params;
fn noise(x:u32,y:u32)->f32 {
 var h=x*374761393u+y*668265263u+params.seed*1442695041u;
 h=(h^(h>>13u))*1274126177u;h=h^(h>>16u);return f32(h&65535u)/65535.;
}
// Positions are local world coordinates. z marks valid interpolation, never inferred from NaNs.
fn sample(p:vec2<f32>)->vec3<f32> {
 let g=p/params.span*vec2<f32>(params.size)-vec2<f32>(.5);let base=vec2<i32>(floor(g+vec2<f32>(1e-4)));let t=max(vec2<f32>(0.),g-vec2<f32>(base));var out=vec2<f32>(0.);
 for(var y=0;y<2;y++){for(var x=0;x<2;x++){
   var xy=base+vec2<i32>(x,y);
   for(var c=0;c<2;c++){let n=i32(params.size[c]);if(params.periodic[c]!=0u){xy[c]=((xy[c]%n)+n)%n;}else if(xy[c]<0||xy[c]>=n){return vec3<f32>(0.);}}
   let v=velocity[u32(xy.y)*params.size.x+u32(xy.x)];if(v.z<.5){return vec3<f32>(0.);}
   let w=select(1.-t.x,t.x,x==1)*select(1.-t.y,t.y,y==1);out+=w*v.xy;
 }}
 return vec3<f32>(out,1.);
}
fn textureNoise(p:vec2<f32>)->f32{
 let g=p/params.span*vec2<f32>(params.size)-vec2<f32>(.5);let base=vec2<i32>(floor(g));let t=fract(g);var out=0.;
 for(var y=0;y<2;y++){for(var x=0;x<2;x++){
 var xy=base+vec2<i32>(x,y);
 for(var c=0;c<2;c++){let n=i32(params.size[c]);if(params.periodic[c]!=0u){xy[c]=((xy[c]%n)+n)%n;}else{xy[c]=clamp(xy[c],0,n-1);}}
 out+=noise(u32(xy.x),u32(xy.y))*select(1.-t.x,t.x,x==1)*select(1.-t.y,t.y,y==1);
 }}return out;
}
@compute @workgroup_size(128)
fn lic(@builtin(global_invocation_id) id:vec3<u32>){
 let i=id.x;if(i>=params.size.x*params.size.y){return;}
 let xy=vec2<u32>(i%params.size.x,i/params.size.x);let cell=params.span/vec2<f32>(params.size);let origin=(vec2<f32>(xy)+vec2<f32>(.5))*cell;
 let initial=sample(origin);output[i]=-1.;if(initial.z<.5||length(initial.xy)<1e-12 || (params.periodic.x==0u && (xy.x<1u||xy.x+2u>=params.size.x)) || (params.periodic.y==0u && (xy.y<1u||xy.y+2u>=params.size.y))){return;}
 let step=.6*min(cell.x,cell.y);var sum=noise(xy.x,xy.y);var weight=1.;
 for(var side=0;side<2;side++){
   let sign=select(-1.,1.,side==1);var p=origin;
   for(var j=1u;j<=params.steps;j++){
     let v=sample(p);let speed=length(v.xy);if(v.z<.5||speed<1e-12){break;}
     let middle=p+sign*step*.5*v.xy/speed;let mv=sample(middle);let ms=length(mv.xy);if(mv.z<.5||ms<1e-12){break;}
     let next=p+sign*step*mv.xy/ms;if(sample(next).z<.5){break;}
     let win=.5+.5*cos(3.141592653589793*f32(j)/f32(params.steps+1u));
     sum+=win*textureNoise(next);weight+=win;p=next;
   }
 }
 output[i]=clamp(.5+(sum/weight-.5)*params.contrast,0.,1.);
}
