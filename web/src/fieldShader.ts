/** Frozen-frame LIC texture advection. Two staggered phases hide the reset;
 * bounded backward traces follow velocity direction in physical coordinates.
 * This visual animation never changes particle positions or simulation time. */
export const fieldFragment = `
uniform sampler2D uLIC, uVelocity, uField, uPalette;
uniform float uHasLIC, uLICAnimate, uLICTime, uLICSpeed, uMin, uMax, uNorm;
uniform vec2 uGridSize, uDomainSize, uPeriodic;
varying vec2 vUv;
float transformValue(float v){if(uNorm<0.5)return v;if(uNorm<1.5)return log(max(v,1.e-30));float a=abs(v);return sign(v)*(a<0.01?a*(1.0-a*(0.5-a/3.0)):log(1.0+a));}
vec2 wrapUV(vec2 p){return mix(p,fract(p),uPeriodic);}
bool inside(vec2 p){return (uPeriodic.x>0.5||(p.x>=0.0&&p.x<=1.0))&&(uPeriodic.y>0.5||(p.y>=0.0&&p.y<=1.0));}
vec3 velocityAt(vec2 uv){
  vec2 g=wrapUV(uv)*uGridSize-0.5,base=floor(g),f=fract(g);
  vec2 sum=vec2(0.0);
  for(int y=0;y<2;y++)for(int x=0;x<2;x++){
    vec2 p=(base+vec2(float(x),float(y))+0.5)/uGridSize;
    if(!inside(p))return vec3(0.0);
    vec4 v=texture2D(uVelocity,wrapUV(p));
    if(v.z<0.5)return vec3(0.0);
    float w=(x==0?1.0-f.x:f.x)*(y==0?1.0-f.y:f.y);
    sum+=w*v.xy;
  }
  return vec3(sum,1.0);
}
float advectedNoise(float phase, float fallback){
  vec2 p=vUv;
  float stepLength=phase*2.0*min(uDomainSize.x/uGridSize.x,uDomainSize.y/uGridSize.y);
  for(int j=0;j<4;j++){
    vec3 v=velocityAt(p);float speed=length(v.xy);
    if(v.z<0.5||speed<1.e-12)return fallback;
    vec2 middle=p-0.5*stepLength*(v.xy/speed)/uDomainSize;
    if(!inside(middle))return fallback;
    vec3 m=velocityAt(middle);float ms=length(m.xy);
    if(m.z<0.5||ms<1.e-12)return fallback;
    p-=stepLength*(m.xy/ms)/uDomainSize;
    if(!inside(p))return fallback;
    p=wrapUV(p);
  }
  // Check the final sample too, so texture motion cannot cross a masked cell.
  if(velocityAt(p).z<0.5)return fallback;
  float n=texture2D(uLIC,p).r;
  return n==n?n:fallback;
}
void main(){
 float v=texture2D(uField,vUv).r;if(v!=v||abs(v)>3.4e38)discard;
 if(uNorm>0.5&&uNorm<1.5&&v<=0.0){gl_FragColor=vec4(0.5,0.5,0.5,1.0);return;}
 float t=clamp((transformValue(v)-transformValue(uMin))/(transformValue(uMax)-transformValue(uMin)),0.0,1.0);
 vec3 color=texture2D(uPalette,vec2(t,0.5)).rgb;
 if(uHasLIC>0.5){
   float n=texture2D(uLIC,vUv).r;if(n!=n)discard;
   if(uLICAnimate>0.5){float phase=fract(uLICTime*uLICSpeed/8.0);n=mix(advectedNoise(phase,n),advectedNoise(fract(phase+0.5),n),abs(2.0*phase-1.0));}
   color*=0.25+1.1*n;
 }
 gl_FragColor=vec4(color,1.0);
}`;
