/** Pixel-box filtering for minified disks. The four signed quadrant integrals
 * give circle/pixel intersection area, retaining πr² coverage below one pixel.
 * Large disks use a symmetric distance filter to avoid cancellation of large
 * integral values at float32 precision and keep resolved particles inexpensive.
 */
export const particleCoverageGLSL = `
float circleIntegral(float x,float radius){
 float h=sqrt(max(0.0,radius*radius-x*x));
 return 0.5*(x*h+radius*radius*asin(clamp(x/radius,0.0,1.0)));
}
float circleQuadrant(vec2 p,float radius){
 vec2 q=min(abs(p),vec2(radius));
 float area=q.x*q.y;
 if(dot(q,q)>radius*radius){
  float split=sqrt(max(0.0,radius*radius-q.y*q.y));
  area=q.y*split+circleIntegral(q.x,radius)-circleIntegral(split,radius);
 }
 return sign(p.x)*sign(p.y)*area;
}
float diskCoverage(vec2 uv,float radius){
 if(radius>8.0){
  float distance=length(uv);
  float width=max(fwidth(distance),1.e-6);
  return 1.0-smoothstep(1.0-0.5*width,1.0+0.5*width,distance);
 }
 vec2 p=uv*radius;
 if(length(max(abs(p)-0.5,vec2(0.0)))>=radius)return 0.0;
 if(length(abs(p)+0.5)<=radius)return 1.0;
 return clamp(circleQuadrant(p+0.5,radius)
  -circleQuadrant(p+vec2(-0.5,0.5),radius)
  -circleQuadrant(p+vec2(0.5,-0.5),radius)
  +circleQuadrant(p-0.5,radius),0.0,1.0);
}
`;
