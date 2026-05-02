// Phase 3 god rays + glass refraction. Single WebGL2 fragment shader paints:
//   - 14 volumetric rays from an off-canvas apex with per-ray alpha + jitter
//   - distance-from-source radial falloff
//   - inside the glass card: Snell-style horizontal-bending refraction,
//     frosted scatter, warm interior glow, Fresnel left-edge specular
//   - past the glass right edge: caustic re-emergence (dimmed + offset)
//     with a brief shadow band before it establishes
//   - glacial drift (~88s + ~200s) on apex + angle wobble
//   - per-ray seeded breathing so individual rays brighten/dim independently
// Ported verbatim from the v39 mockup; behaviour is identical.

const VERT_SRC =
  '#version 300 es\n' +
  'in vec2 aPosition;\n' +
  'void main() {\n' +
  '  gl_Position = vec4(aPosition, 0.0, 1.0);\n' +
  '}\n';

const FRAG_SRC =
  '#version 300 es\n' +
  'precision highp float;\n' +
  'out vec4 outColor;\n' +
  '\n' +
  'uniform vec2  uResolution;\n' +
  'uniform float uDpr;\n' +
  'uniform float uTime;\n' +
  'uniform vec2  uApex;\n' +
  'uniform vec4  uGlass;\n' +
  'uniform float uGlassRadius;\n' +
  'uniform int   uReducedMotion;\n' +
  '\n' +
  '#define NUM_RAYS 14\n' +
  'uniform vec4 uRays[NUM_RAYS];\n' +
  'uniform vec2 uJitter[NUM_RAYS];\n' +
  '\n' +
  'const vec3 EMBER = vec3(0.898, 0.663, 0.102);\n' +
  'const float BASE_ANGLE = 2.0;\n' +
  'const float PI = 3.14159265359;\n' +
  '\n' +
  'float hash21(vec2 p) {\n' +
  '  p = fract(p * vec2(123.34, 456.21));\n' +
  '  p += dot(p, p + 45.32);\n' +
  '  return fract(p.x * p.y);\n' +
  '}\n' +
  'float vnoise(vec2 p) {\n' +
  '  vec2 i = floor(p);\n' +
  '  vec2 f = fract(p);\n' +
  '  vec2 u = f * f * (3.0 - 2.0 * f);\n' +
  '  return mix(\n' +
  '    mix(hash21(i + vec2(0.0,0.0)), hash21(i + vec2(1.0,0.0)), u.x),\n' +
  '    mix(hash21(i + vec2(0.0,1.0)), hash21(i + vec2(1.0,1.0)), u.x),\n' +
  '    u.y\n' +
  '  );\n' +
  '}\n' +
  '\n' +
  'vec2 driftedApex() {\n' +
  '  float drift = uReducedMotion == 1 ? 0.0 : 1.0;\n' +
  '  float t = uTime * 0.001;\n' +
  '  float dx = (sin(t * 0.071) + sin(t * 0.031 + 11.71)) * 0.5;\n' +
  '  float dy = (sin(t * 0.071 + 17.13) + sin(t * 0.031 + 22.4)) * 0.5;\n' +
  '  return uApex + vec2(dx * 18.0, dy * 10.0) * drift;\n' +
  '}\n' +
  '\n' +
  'float angleWobble() {\n' +
  '  float drift = uReducedMotion == 1 ? 0.0 : 1.0;\n' +
  '  float t = uTime * 0.001;\n' +
  '  return (sin(t * 0.071 + 31.0) + sin(t * 0.031 + 47.0)) * 0.5 * 2.0 * drift;\n' +
  '}\n' +
  '\n' +
  'float distFalloff(float t) {\n' +
  '  float ramp = clamp(t / 0.04, 0.0, 1.0);\n' +
  '  float decay = clamp(1.0 - (t - 0.04) / 0.96, 0.0, 1.0);\n' +
  '  return min(ramp, decay);\n' +
  '}\n' +
  '\n' +
  'float rayContribution(vec2 frag, vec2 apex, float wobble, vec4 ray, float maxLen, float breathe) {\n' +
  '  vec2 toFrag = frag - apex;\n' +
  '  float dist = length(toFrag);\n' +
  '  if (dist < 1.0) return 0.0;\n' +
  '\n' +
  '  float fragAngle = atan(toFrag.y, toFrag.x) * 180.0 / PI;\n' +
  '  float rayAngle = BASE_ANGLE + wobble + ray.x;\n' +
  '  float angDelta = abs(fragAngle - rayAngle);\n' +
  '  if (angDelta > ray.y) return 0.0;\n' +
  '\n' +
  '  float angT = angDelta / ray.y;\n' +
  '  float angFalloff = 1.0 - pow(angT, 2.5);\n' +
  '\n' +
  '  float distT = dist / maxLen;\n' +
  '  return ray.z * breathe * angFalloff * distFalloff(distT);\n' +
  '}\n' +
  '\n' +
  'float perRayBreathe(int idx, float amp) {\n' +
  '  float drift = uReducedMotion == 1 ? 0.0 : 1.0;\n' +
  '  float t = uTime * 0.001;\n' +
  '  float seed = float(idx) + 10.0;\n' +
  '  float n = (sin(t * 0.071 + seed * 17.13) + sin(t * 0.031 + seed * 11.71)) * 0.5;\n' +
  '  return 1.0 + n * amp * drift;\n' +
  '}\n' +
  '\n' +
  'float computeRayField(vec2 frag, vec2 apex, float wobble) {\n' +
  '  float maxLen = length(uResolution) * 1.4;\n' +
  '  float total = 0.0;\n' +
  '  for (int i = 0; i < NUM_RAYS; i++) {\n' +
  '    vec2 rayApex = apex + uJitter[i];\n' +
  '    float breathe = perRayBreathe(i, uRays[i].w);\n' +
  '    total += rayContribution(frag, rayApex, wobble, uRays[i], maxLen, breathe);\n' +
  '  }\n' +
  '  return total;\n' +
  '}\n' +
  '\n' +
  'float radialFalloff(vec2 frag, vec2 apex) {\n' +
  '  float d = length(frag - apex);\n' +
  '  float maxR = length(uResolution) * 1.05;\n' +
  '  float t = d / maxR;\n' +
  '  if (t < 0.45) return 1.0;\n' +
  '  if (t < 0.70) return mix(1.0, 0.55, (t - 0.45) / 0.25);\n' +
  '  if (t < 0.90) return mix(0.55, 0.18, (t - 0.70) / 0.20);\n' +
  '  if (t < 1.00) return mix(0.18, 0.0, (t - 0.90) / 0.10);\n' +
  '  return 0.0;\n' +
  '}\n' +
  '\n' +
  'float roundedRectSDF(vec2 p, vec2 center, vec2 halfSize, float radius) {\n' +
  '  vec2 q = abs(p - center) - halfSize + vec2(radius);\n' +
  '  return min(max(q.x, q.y), 0.0) + length(max(q, vec2(0.0))) - radius;\n' +
  '}\n' +
  '\n' +
  'void main() {\n' +
  '  vec2 frag = gl_FragCoord.xy / uDpr;\n' +
  '  frag.y = uResolution.y - frag.y;\n' +
  '\n' +
  '  vec2 apex = driftedApex();\n' +
  '  float wobble = angleWobble();\n' +
  '\n' +
  '  vec2 glassCenter = uGlass.xy + uGlass.zw * 0.5;\n' +
  '  vec2 glassHalf = uGlass.zw * 0.5;\n' +
  '  float glassSDF = roundedRectSDF(frag, glassCenter, glassHalf, uGlassRadius);\n' +
  '\n' +
  '  float intensity = 0.0;\n' +
  '\n' +
  '  if (glassSDF < 0.0) {\n' +
  '    float depthIn = frag.x - uGlass.x;\n' +
  '    float n1 = vnoise(frag * 0.04 + uTime * 0.00005);\n' +
  '    float n2 = vnoise(frag * 0.04 + vec2(100.0) + uTime * 0.00005);\n' +
  '    vec2 refrOffset = vec2(\n' +
  '      -depthIn * 0.06 + (n1 - 0.5) * 9.0,\n' +
  '      -depthIn * 0.10 + (n2 - 0.5) * 9.0\n' +
  '    );\n' +
  '    vec2 sampleAt = frag + refrOffset;\n' +
  '    intensity = computeRayField(sampleAt, apex, wobble) * radialFalloff(sampleAt, apex);\n' +
  '    vec2 toUL = uGlass.xy - frag;\n' +
  '    float ulDist = length(toUL);\n' +
  '    intensity += exp(-ulDist * 0.012) * 0.04;\n' +
  '    intensity += exp(-depthIn * 0.06) * 0.18;\n' +
  '  } else {\n' +
  '    intensity = computeRayField(frag, apex, wobble) * radialFalloff(frag, apex);\n' +
  '    if (glassSDF > 0.0) {\n' +
  '      float dx = frag.x - apex.x;\n' +
  '      if (dx > 1.0) {\n' +
  '        float tL = (uGlass.x - apex.x) / dx;\n' +
  '        if (tL > 0.0 && tL < 1.0) {\n' +
  '          float yAtCardL = apex.y + tL * (frag.y - apex.y);\n' +
  '          float cardT = uGlass.y;\n' +
  '          float cardB = uGlass.y + uGlass.w;\n' +
  '          float soft = 8.0;\n' +
  '          float inShadow = smoothstep(cardT - soft, cardT + soft, yAtCardL)\n' +
  '                         * (1.0 - smoothstep(cardB - soft, cardB + soft, yAtCardL));\n' +
  '          if (inShadow > 0.001) {\n' +
  '            float distPast = max(0.0, frag.x - (uGlass.x + uGlass.z));\n' +
  '            vec2 causticSample = frag + vec2(0.0, -uGlass.w * 0.04);\n' +
  '            float caustic = computeRayField(causticSample, apex, wobble)\n' +
  '                          * radialFalloff(causticSample, apex);\n' +
  '            caustic *= 0.55;\n' +
  '            caustic *= smoothstep(0.0, 14.0, distPast);\n' +
  '            caustic *= clamp(1.0 - distPast / 110.0, 0.0, 1.0);\n' +
  '            float horizontalFade = clamp(1.0 - distPast / 90.0, 0.0, 1.0);\n' +
  '            float belowCard = max(0.0, frag.y - (uGlass.y + uGlass.w));\n' +
  '            float verticalFade = clamp(1.0 - belowCard / 24.0, 0.0, 1.0);\n' +
  '            float effectiveShadow = inShadow * horizontalFade * verticalFade;\n' +
  '            intensity = mix(intensity, caustic, effectiveShadow);\n' +
  '          }\n' +
  '        }\n' +
  '      }\n' +
  '    }\n' +
  '  }\n' +
  '\n' +
  '  intensity = 1.0 - exp(-intensity * 1.6);\n' +
  '\n' +
  '  outColor = vec4(EMBER * intensity, intensity);\n' +
  '}\n';

// 14 rays — [offset, halfWidth, alpha, breatheAmp].
// Heroes hold stable as focal points; mids swing wide; whispers stay quiet.
const RAYS: ReadonlyArray<readonly [number, number, number, number]> = [
  [3, 0.5, 0.012, 0.25],
  [5, 2.2, 0.105, 0.18],
  [6, 0.3, 0.008, 0.25],
  [9, 2.8, 0.035, 0.45],
  [14, 0.7, 0.018, 0.25],
  [22, 4.0, 0.115, 0.18],
  [26, 0.4, 0.010, 0.25],
  [28, 1.4, 0.025, 0.45],
  [38, 2.3, 0.040, 0.45],
  [42, 0.6, 0.013, 0.25],
  [52, 5.0, 0.090, 0.18],
  [56, 0.4, 0.009, 0.25],
  [64, 3.2, 0.022, 0.45],
  [73, 0.9, 0.014, 0.25],
];

const JITTER: ReadonlyArray<readonly [number, number]> = [
  [-5, -2], [-2, 0], [0, 1], [3, -3], [5, 2],
  [-6, 4], [-3, 5], [1, 3],
  [6, -1], [4, 2],
  [-2, 6], [2, 7], [4, 3], [6, 5],
];

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error('Failed to create shader');
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error('Shader compile error:\n' + log);
  }
  return sh;
}

function linkProgram(gl: WebGL2RenderingContext, vs: WebGLShader, fs: WebGLShader): WebGLProgram {
  const p = gl.createProgram();
  if (!p) throw new Error('Failed to create program');
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('Program link error:\n' + gl.getProgramInfoLog(p));
  }
  return p;
}

/**
 * Initialize the WebGL2 god-rays + glass refraction renderer on the given canvas.
 * The shader paints both the volumetric rays AND the interior of the attention
 * card, so the `card` element should be styled with a transparent background.
 *
 * Returns a teardown function. Call it before the canvas is removed from the DOM.
 */
export function initOverviewRays(canvas: HTMLCanvasElement, card: HTMLElement): () => void {
  const body = canvas.parentElement;
  if (!body) {
    return () => {};
  }

  const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true });
  if (!gl) {
    return () => {};
  }

  const dpr = Math.max(1, window.devicePixelRatio || 1);
  let width = 0;
  let height = 0;
  let rafId: number | null = null;
  let lastDraw = 0;
  const minFrameMs = 1000 / 30;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const vs = compileShader(gl, gl.VERTEX_SHADER, VERT_SRC);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
  const program = linkProgram(gl, vs, fs);
  gl.useProgram(program);

  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
    gl.STATIC_DRAW,
  );
  const aPosition = gl.getAttribLocation(program, 'aPosition');
  gl.enableVertexAttribArray(aPosition);
  gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 0);

  const uResolution = gl.getUniformLocation(program, 'uResolution');
  const uDpr = gl.getUniformLocation(program, 'uDpr');
  const uTime = gl.getUniformLocation(program, 'uTime');
  const uApex = gl.getUniformLocation(program, 'uApex');
  const uGlass = gl.getUniformLocation(program, 'uGlass');
  const uGlassRadius = gl.getUniformLocation(program, 'uGlassRadius');
  const uReducedMotion = gl.getUniformLocation(program, 'uReducedMotion');
  const uRays = gl.getUniformLocation(program, 'uRays');
  const uJitter = gl.getUniformLocation(program, 'uJitter');

  const raysFlat = new Float32Array(RAYS.length * 4);
  const jitterFlat = new Float32Array(JITTER.length * 2);
  for (let i = 0; i < RAYS.length; i++) {
    const ray = RAYS[i]!;
    const jit = JITTER[i]!;
    raysFlat[i * 4 + 0] = ray[0];
    raysFlat[i * 4 + 1] = ray[1];
    raysFlat[i * 4 + 2] = ray[2];
    raysFlat[i * 4 + 3] = ray[3];
    jitterFlat[i * 2 + 0] = jit[0];
    jitterFlat[i * 2 + 1] = jit[1];
  }
  gl.uniform4fv(uRays, raysFlat);
  gl.uniform2fv(uJitter, jitterFlat);
  gl.uniform1f(uDpr, dpr);
  gl.uniform1i(uReducedMotion, reduced ? 1 : 0);

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

  function updateGlassRect() {
    const bodyRect = body!.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const gx = cardRect.left - bodyRect.left;
    const gy = cardRect.top - bodyRect.top;
    gl!.uniform4f(uGlass, gx, gy, cardRect.width, cardRect.height);
    gl!.uniform1f(uGlassRadius, 12);
  }

  function resize() {
    const rect = body!.getBoundingClientRect();
    width = Math.max(1, Math.floor(rect.width));
    height = Math.max(1, Math.floor(rect.height));
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    gl!.viewport(0, 0, canvas.width, canvas.height);
    gl!.uniform2f(uResolution, width, height);
    // apex: 22% across, -8% above body
    gl!.uniform2f(uApex, 0.22 * width, -0.08 * height);
    updateGlassRect();
  }

  function draw(now: number) {
    gl!.uniform1f(uTime, now);
    updateGlassRect();
    gl!.clearColor(0, 0, 0, 0);
    gl!.clear(gl!.COLOR_BUFFER_BIT);
    gl!.drawArrays(gl!.TRIANGLES, 0, 6);
  }

  function tick(now: number) {
    if (now - lastDraw >= minFrameMs) {
      draw(now);
      lastDraw = now;
    }
    rafId = requestAnimationFrame(tick);
  }
  function start() {
    if (rafId == null) {
      lastDraw = 0;
      rafId = requestAnimationFrame(tick);
    }
  }
  function stop() {
    if (rafId != null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  resize();

  let ro: ResizeObserver | null = null;
  let resizeListener: (() => void) | null = null;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => resize());
    ro.observe(body);
    ro.observe(card);
  } else {
    resizeListener = () => resize();
    window.addEventListener('resize', resizeListener);
  }

  const visListener = () => {
    if (document.hidden) stop();
    else start();
  };
  document.addEventListener('visibilitychange', visListener);

  if (reduced) {
    draw(0);
  } else {
    start();
  }

  return () => {
    stop();
    if (ro) ro.disconnect();
    if (resizeListener) window.removeEventListener('resize', resizeListener);
    document.removeEventListener('visibilitychange', visListener);
    gl!.deleteProgram(program);
    gl!.deleteShader(vs);
    gl!.deleteShader(fs);
    gl!.deleteBuffer(buf);
    gl!.deleteVertexArray(vao);
  };
}
