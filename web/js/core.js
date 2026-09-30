/* The ROYAL Core: a controlled artificial sun, drawn by one fragment shader.

   Layers, inside out: a near-white core, electric-lime plasma (domain-warped
   noise), a translucent shell with a bright limb, a corona with filaments and
   occasional arcs, a fine orbital structure, sparse particles, and energy
   paths reaching toward specialists when ROYAL delegates.

   It eases every frame toward the parameters of the current state
   (web/js/state.js).  Tiers: HIGH, MEDIUM, LOW (fewer octaves, no particles,
   lower resolution), a Canvas 2D fallback when WebGL is unavailable, and a
   reduced-motion mode that keeps light but removes movement.  The frame rate
   is watched; a slow device steps down a tier on its own.  Rendering pauses
   when the page is hidden and drops to 30 fps at rest. */

const VERT = "attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}";
const FRAG = `
precision mediump float;
uniform vec2 u_res; uniform float u_time, u_phase;
uniform vec2 u_center; uniform float u_radius;
uniform float u_energy, u_coherence, u_corona, u_converge, u_warm, u_crit, u_dim, u_amp, u_oct, u_particles;
uniform vec3 u_touch;
uniform vec3 u_nodes[6];
float hash(vec2 p){ p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }
float noise(vec2 p){ vec2 i=floor(p), f=fract(p); float a=hash(i), b=hash(i+vec2(1.,0.)), c=hash(i+vec2(0.,1.)), d=hash(i+vec2(1.,1.));
  vec2 u=f*f*(3.-2.*f); return mix(mix(a,b,u.x),mix(c,d,u.x),u.y); }
float fbm(vec2 p){ float v=0., a=.5; for(int i=0;i<5;i++){ if(float(i)>=u_oct) break; v+=a*noise(p); p=p*2.03+vec2(1.7,9.2); a*=.5; } return v; }
void main(){
  vec2 fc=vec2(gl_FragCoord.x, u_res.y-gl_FragCoord.y);
  vec2 d=(fc-u_center)/u_radius; float r=length(d); float ang=atan(d.y,d.x); float t=u_phase;
  vec3 lime=vec3(.584,.996,.0), pale=vec3(.95,1.,.86), amber=vec3(1.,.70,.26), red=vec3(1.,.34,.28);
  vec3 ec=mix(mix(lime,amber,u_warm),red,u_crit);
  vec3 col=vec3(.010,.012,.011);
  col+=vec3(.018,.026,.010)*exp(-r*.55)*(1.-u_dim);
  if(r<1.12){
    vec2 q=d*1.5; float turb=mix(1.5,.5,u_coherence);
    float w=fbm(q*1.3-vec2(t*.21,t*.17));
    float n=fbm(q*2.3+vec2(t*.33,-t*.27)+turb*w);
    float body=smoothstep(1.02,.95,r); float sph=smoothstep(1.,0.,r);
    col+=ec*body*(.30+.70*n)*(.45+.55*sph)*.95*u_energy;
    col+=mix(pale,ec,.18)*exp(-r*r*7.)*1.25*u_energy;
    col+=ec*smoothstep(.78,1.,r)*smoothstep(1.08,1.,r)*.38*u_energy;
  }
  if(r>=.9 && r<4.2){
    float cr=max(.35,u_corona*(1.+.28*u_amp));
    float fil=fbm(vec2(ang*3.+t*.12, r*1.8-t*.35));
    float cor=exp(-max(r-1.,0.)*3.1/cr)*(.55+.9*fil)*smoothstep(.93,1.03,r);
    col+=ec*cor*.52*u_energy;
    float arcs=pow(max(0., fbm(vec2(ang*5.5+.3*sin(t*.05), t*.08))-.47)*2.1, 3.)*exp(-(r-1.)*1.9/cr);
    col+=mix(ec,pale,.2)*arcs*.55*u_energy;
    vec2 e=vec2(d.x*.955-d.y*.296,(d.x*.296+d.y*.955)*3.4);
    col+=ec*exp(-abs(length(e)-1.72)*55.)*.07*u_energy*(.55+.45*sin(ang*2.-t*.5));
    if(u_particles>.5){
      float pr=r/mix(1.,.62,u_converge);
      vec2 pg=vec2(ang*14.3+t*.06*(1.+3.*u_converge), pr*5.-t*.10*(1.-u_converge));
      vec2 cell=floor(pg); vec2 fcl=fract(pg)-.5; float h=hash(cell);
      float sp=smoothstep(.09,0.,length(fcl-(vec2(hash(cell+3.1),hash(cell+7.7))-.5)*.6))*step(.88,h);
      col+=mix(pale,ec,.5)*sp*smoothstep(1.05,1.3,r)*smoothstep(4.1,1.8,r)*.75*u_energy;
    }
  }
  for(int i=0;i<6;i++){
    vec3 nd=u_nodes[i]; if(nd.z>.001){
      vec2 ba=nd.xy-u_center; vec2 pa=fc-u_center; float h=clamp(dot(pa,ba)/dot(ba,ba),0.,1.);
      float dist=length(pa-ba*h); float beam=exp(-dist*dist/3.2)*smoothstep(.0,.12,h)*smoothstep(1.,.9,h);
      float ph=fract(u_time*.55+float(i)*.21); float pulse=exp(-pow((h-ph)*9.,2.));
      col+=ec*beam*nd.z*(.22+.9*pulse);
    }
  }
  if(u_touch.z<1.6){ float dd=length(fc-u_touch.xy)/u_radius; col+=ec*exp(-pow(dd-u_touch.z*2.4,2.)*16.)*(1.-u_touch.z/1.6)*.22; }
  col*=mix(1.,.30,u_dim);
  col=1.-exp(-col*1.3);
  vec2 uv=fc/u_res; col*=.86+.14*smoothstep(1.25,.2,length(uv-.5)*1.4);
  gl_FragColor=vec4(col,1.);
}`;

const TIERS = { HIGH: { dpr: 1.75, oct: 5, particles: 1 }, MEDIUM: { dpr: 1.25, oct: 4, particles: 1 }, LOW: { dpr: 0.6, oct: 3, particles: 0 } };
const KEYS = ["energy", "scale", "speed", "coherence", "corona", "converge", "reach", "warm", "crit", "dim"];

export class RoyalCore {
  constructor(canvas, { reducedMotion = false } = {}) {
    this.canvas = canvas; this.reduced = reducedMotion;
    this.target = null; this.cur = null; this.phase = 0; this.t0 = performance.now(); this.last = this.t0;
    this.amp = 0; this.ampTarget = 0; this.touch = { x: 0, y: 0, age: 9 };
    this.layout = { cx: 0.5, cy: 0.5, r: 0.17 }; this.layoutCur = null;
    this.nodes = []; this.frames = []; this.running = false; this.onFallback = null;
    const saved = (() => { try { return localStorage.getItem("royal.quality"); } catch (_) { return null; } })();
    this.tierName = saved && TIERS[saved] ? saved : (matchMedia("(max-width: 700px)").matches ? "MEDIUM" : "HIGH");
    this.mode = this._initGL() ? "webgl" : (this._init2D() ? "2d" : "none");
    document.addEventListener("visibilitychange", () => { if (!document.hidden) this._loop(); });
  }

  _initGL() {
    let gl = null;
    try { gl = this.canvas.getContext("webgl", { antialias: false, alpha: false, powerPreference: "low-power", preserveDrawingBuffer: false }); } catch (_) { gl = null; }
    if (!gl) return false;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { console.warn(gl.getShaderInfoLog(s)); return null; } return s; };
    const vs = sh(gl.VERTEX_SHADER, VERT), fs = sh(gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return false;
    const pr = gl.createProgram(); gl.attachShader(pr, vs); gl.attachShader(pr, fs); gl.linkProgram(pr);
    if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) return false;
    gl.useProgram(pr);
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(pr, "p"); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.gl = gl; this.u = {};
    ["u_res", "u_time", "u_phase", "u_center", "u_radius", "u_energy", "u_coherence", "u_corona", "u_converge", "u_warm", "u_crit", "u_dim", "u_amp", "u_oct", "u_particles", "u_touch", "u_nodes"]
      .forEach((n) => { this.u[n] = gl.getUniformLocation(pr, n); });
    this.canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); this.gl = null; this.mode = this._init2D() ? "2d" : "none"; if (this.onFallback) this.onFallback(this.mode); }, false);
    return true;
  }
  _init2D() { try { this.ctx = this.canvas.getContext("2d"); return !!this.ctx; } catch (_) { return false; } }

  set(params) { this.target = { ...params }; if (!this.cur) this.cur = { ...params }; this._loop(); }
  setLayout(l) { this.layout = { ...this.layout, ...l }; this._loop(); }
  setNodes(nodes) { this.nodes = nodes.slice(0, 6); this._loop(); }
  setAmplitude(a) { this.ampTarget = Math.max(0, Math.min(1, a)); }
  pulse(a = 0.7) { this.amp = Math.max(this.amp, a); }
  touchAt(x, y) { this.touch = { x, y, age: 0 }; this._loop(); }
  setTier(name) { if (TIERS[name]) { this.tierName = name; try { localStorage.setItem("royal.quality", name); } catch (_) {} this._resize(); } }
  get tier() { return TIERS[this.tierName]; }

  _resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, this.tier.dpr);
    const w = Math.round(innerWidth * dpr), h = Math.round(innerHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this.dpr = dpr;
  }

  /* Where the core is on screen, in CSS pixels; the stage uses it to lay out
     objects and agent nodes so they are always placed relative to ROYAL. */
  geometry() {
    const l = this.layoutCur || this.layout, m = Math.min(innerWidth, innerHeight);
    return { x: l.cx * innerWidth, y: l.cy * innerHeight, r: l.r * m * (this.cur ? this.cur.scale : 1) };
  }

  _loop() {
    if (this.running || this.mode === "none") return;
    this.running = true;
    const step = (now) => {
      if (document.hidden) { this.running = false; return; }
      const dt = Math.min(0.1, (now - this.last) / 1000); this.last = now;
      const atRest = this.target && this.target.speed <= 0.25 && this.touch.age > 1.6 && !this.nodes.some((n) => n.s > 0.01);
      if (atRest && now - (this._lastDraw || 0) < 32) { requestAnimationFrame(step); return; }
      this._lastDraw = now;
      this._ease(dt); this._draw(now); this._watch(dt);
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  _ease(dt) {
    const k = 1 - Math.exp(-dt * (this.reduced ? 10 : 3.2));
    if (this.target) for (const key of KEYS) this.cur[key] += (this.target[key] - this.cur[key]) * k;
    const L = this.layout; if (!this.layoutCur) this.layoutCur = { ...L };
    const kl = 1 - Math.exp(-dt * (this.reduced ? 12 : 4));
    for (const key of ["cx", "cy", "r"]) this.layoutCur[key] += (L[key] - this.layoutCur[key]) * kl;
    this.amp += (this.ampTarget - this.amp) * (1 - Math.exp(-dt * 12)); this.ampTarget *= Math.exp(-dt * 3);
    this.phase += dt * (this.reduced ? 0.03 : this.cur.speed);
    this.touch.age += dt;
    for (const n of this.nodes) n.cur = (n.cur || 0) + ((n.s || 0) - (n.cur || 0)) * (1 - Math.exp(-dt * 5));
  }

  _draw(now) {
    this._resize();
    const c = this.cur, g = this.geometry(), time = (now - this.t0) / 1000;
    const breathe = this.reduced ? 1 : 1 + 0.055 * Math.sin(time * 0.85) * (1 - c.speed);
    const energy = c.energy * breathe * (1 + 0.25 * this.amp);
    if (this.gl) {
      const gl = this.gl, u = this.u, d = this.dpr;
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.uniform2f(u.u_res, this.canvas.width, this.canvas.height);
      gl.uniform1f(u.u_time, this.reduced ? 0 : time); gl.uniform1f(u.u_phase, this.phase);
      gl.uniform2f(u.u_center, g.x * d, g.y * d); gl.uniform1f(u.u_radius, Math.max(8, g.r * d));
      gl.uniform1f(u.u_energy, energy); gl.uniform1f(u.u_coherence, c.coherence); gl.uniform1f(u.u_corona, c.corona);
      gl.uniform1f(u.u_converge, c.converge); gl.uniform1f(u.u_warm, c.warm); gl.uniform1f(u.u_crit, c.crit); gl.uniform1f(u.u_dim, c.dim);
      gl.uniform1f(u.u_amp, this.amp); gl.uniform1f(u.u_oct, this.tier.oct); gl.uniform1f(u.u_particles, this.reduced ? 0 : this.tier.particles);
      gl.uniform3f(u.u_touch, this.touch.x * d, this.touch.y * d, this.reduced ? 9 : this.touch.age);
      const arr = new Float32Array(18);
      this.nodes.forEach((n, i) => { arr[i * 3] = n.x * d; arr[i * 3 + 1] = n.y * d; arr[i * 3 + 2] = (n.cur || 0) * c.reach; });
      gl.uniform3fv(u.u_nodes, arr);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    } else if (this.ctx) {
      this._draw2D(g, energy, time);
    }
  }

  /* The 2D fallback: the same layers as gradients.  Lower fidelity, same
     meaning: size, brightness, colour and reach follow the same state. */
  _draw2D(g, energy, time) {
    const x = this.ctx, d = this.dpr, c = this.cur;
    const W = this.canvas.width, H = this.canvas.height, cx = g.x * d, cy = g.y * d, r = Math.max(8, g.r * d);
    const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
    const col = mix(mix([149, 254, 0], [255, 178, 66], c.warm), [255, 87, 71], c.crit);
    const rgba = (a) => "rgba(" + col[0] + "," + col[1] + "," + col[2] + "," + a + ")";
    x.fillStyle = "#030403"; x.fillRect(0, 0, W, H);
    const k = energy * (1 - 0.7 * c.dim);
    let gr = x.createRadialGradient(cx, cy, r * 0.9, cx, cy, r * 3.4 * c.corona);
    gr.addColorStop(0, rgba(0.30 * k)); gr.addColorStop(1, rgba(0)); x.fillStyle = gr; x.fillRect(0, 0, W, H);
    gr = x.createRadialGradient(cx - r * 0.15, cy - r * 0.15, 0, cx, cy, r);
    gr.addColorStop(0, "rgba(245,255,225," + (0.95 * k) + ")"); gr.addColorStop(0.35, rgba(0.9 * k)); gr.addColorStop(1, rgba(0.25 * k));
    x.fillStyle = gr; x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.fill();
    this.nodes.forEach((n) => { const s = (n.cur || 0) * c.reach; if (s < 0.02) return; x.strokeStyle = rgba(0.45 * s); x.lineWidth = 1.2 * d; x.beginPath(); x.moveTo(cx, cy); x.lineTo(n.x * d, n.y * d); x.stroke(); });
  }

  _watch(dt) {
    if (this.reduced || this.mode !== "webgl") return;
    /* 90 frames normally; far sooner when frames are very slow (a weak GPU
       or software rendering), so a struggling device steps down in seconds. */
    this.frames.push(dt);
    const spent = this.frames.reduce((x, y) => x + y, 0);
    const verySlow = this.frames.length >= 8 && spent / this.frames.length > 0.08;   /* dt is capped at 0.1 s */
    if (this.frames.length < 90 && !verySlow) return;
    const avg = this.frames.reduce((a, b) => a + b, 0) / this.frames.length; this.frames = [];
    if (avg > 0.028 && this.tierName !== "LOW") this.setTier(this.tierName === "HIGH" ? "MEDIUM" : "LOW");
  }
}
