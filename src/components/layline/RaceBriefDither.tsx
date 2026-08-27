"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import styles from "./bootSea.module.css";
import { useReplay } from "./store";

const DPR_CAP = 1.25;
const QUALITY_SCALE = [1, 0.8, 0.64] as const;
const QUALITY_WINDOW_MS = 2400;
const SLOW_FRAME_MS = 22;
const MIN_QUALITY_SAMPLES = 48;

const COLOR_DARK = [0.098039, 0.145098, 0.666667] as const;
const COLOR_LIGHT = [0.717647, 0.72549, 0.827451] as const;

const DEFAULTS = {
  matrixSize: 8,
  bias: 0.1,
  scaleResolution: 1,
  opacity: 0.46,
  trailIntensityMultiplier: 1.02,
  biasNoiseScale: 1.4,
  biasNoiseSpeed: 94,
  biasPulseSpeed: 3.1,
  biasNoiseWeight: 0.77,
  biasPulseWeight: 0.87,
  biasAnimationStrength: 0.29,
} as const;

const TRAIL_DEFAULTS = {
  initialRadius: 0.066,
  initialRadiusMultiplier: 0.015,
  borderSize: 0.129,
  borderSizeMultiplier: 0.054,
  decayRate: 0.057,
} as const;

/* Captured OCI effect time scale. Raw seconds made the bias field flash. */
const ANIM_TIME_SCALE = 0.001;

const VERT = [
  "varying vec2 vUv;",
  "",
  "void main() {",
  "  vUv = position.xy * 0.5 + 0.5;",
  "  gl_Position = vec4(position.xy, 0.0, 1.0);",
  "}",
].join("\n");

/* The Bayer screen, noise functions, trail response, and captured uniforms come
   from .tmp/oci-layline-copy-preview-20260825/scripts/webgl.mjs. The original
   sampled a hero image. Here its luminance comes from a procedural sea field so
   the existing CSS gradient stays visible and remains the background. */
const HALFTONE_FRAG = /* glsl */ `
precision highp float;

uniform vec2 uResolution;
uniform vec3 uColorDark;
uniform vec3 uColorLight;
uniform float uMatrixSize;
uniform float uBias;
uniform float uScaleResolution;
uniform float uOpacity;
uniform float uTime;
uniform sampler2D uTrail;
uniform float uTrailIntensityMultiplier;
uniform float uBiasNoiseScale;
uniform float uBiasNoiseSpeed;
uniform float uBiasPulseSpeed;
uniform float uBiasNoiseWeight;
uniform float uBiasPulseWeight;
uniform float uBiasAnimationStrength;

varying vec2 vUv;

vec4 permute(vec4 x){return mod(((x*34.0)+1.0)*x, 289.0);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159 - 0.85373472095314 * r;}
vec3 fade(vec3 t) {return t*t*t*(t*(t*6.0-15.0)+10.0);}

float cnoise(vec3 P){
  vec3 Pi0 = floor(P);
  vec3 Pi1 = Pi0 + vec3(1.0);
  Pi0 = mod(Pi0, 289.0);
  Pi1 = mod(Pi1, 289.0);
  vec3 Pf0 = fract(P);
  vec3 Pf1 = Pf0 - vec3(1.0);
  vec4 ix = vec4(Pi0.x, Pi1.x, Pi0.x, Pi1.x);
  vec4 iy = vec4(Pi0.yy, Pi1.yy);
  vec4 iz0 = Pi0.zzzz;
  vec4 iz1 = Pi1.zzzz;
  vec4 ixy = permute(permute(ix) + iy);
  vec4 ixy0 = permute(ixy + iz0);
  vec4 ixy1 = permute(ixy + iz1);

  vec4 gx0 = ixy0 / 7.0;
  vec4 gy0 = fract(floor(gx0) / 7.0) - 0.5;
  gx0 = fract(gx0);
  vec4 gz0 = vec4(0.5) - abs(gx0) - abs(gy0);
  vec4 sz0 = step(gz0, vec4(0.0));
  gx0 -= sz0 * (step(0.0, gx0) - 0.5);
  gy0 -= sz0 * (step(0.0, gy0) - 0.5);

  vec4 gx1 = ixy1 / 7.0;
  vec4 gy1 = fract(floor(gx1) / 7.0) - 0.5;
  gx1 = fract(gx1);
  vec4 gz1 = vec4(0.5) - abs(gx1) - abs(gy1);
  vec4 sz1 = step(gz1, vec4(0.0));
  gx1 -= sz1 * (step(0.0, gx1) - 0.5);
  gy1 -= sz1 * (step(0.0, gy1) - 0.5);

  vec3 g000 = vec3(gx0.x,gy0.x,gz0.x);
  vec3 g100 = vec3(gx0.y,gy0.y,gz0.y);
  vec3 g010 = vec3(gx0.z,gy0.z,gz0.z);
  vec3 g110 = vec3(gx0.w,gy0.w,gz0.w);
  vec3 g001 = vec3(gx1.x,gy1.x,gz1.x);
  vec3 g101 = vec3(gx1.y,gy1.y,gz1.y);
  vec3 g011 = vec3(gx1.z,gy1.z,gz1.z);
  vec3 g111 = vec3(gx1.w,gy1.w,gz1.w);

  vec4 norm0 = taylorInvSqrt(vec4(dot(g000, g000), dot(g010, g010), dot(g100, g100), dot(g110, g110)));
  g000 *= norm0.x;
  g010 *= norm0.y;
  g100 *= norm0.z;
  g110 *= norm0.w;
  vec4 norm1 = taylorInvSqrt(vec4(dot(g001, g001), dot(g011, g011), dot(g101, g101), dot(g111, g111)));
  g001 *= norm1.x;
  g011 *= norm1.y;
  g101 *= norm1.z;
  g111 *= norm1.w;

  float n000 = dot(g000, Pf0);
  float n100 = dot(g100, vec3(Pf1.x, Pf0.yz));
  float n010 = dot(g010, vec3(Pf0.x, Pf1.y, Pf0.z));
  float n110 = dot(g110, vec3(Pf1.xy, Pf0.z));
  float n001 = dot(g001, vec3(Pf0.xy, Pf1.z));
  float n101 = dot(g101, vec3(Pf1.x, Pf0.y, Pf1.z));
  float n011 = dot(g011, vec3(Pf0.x, Pf1.yz));
  float n111 = dot(g111, Pf1);
  vec3 fade_xyz = fade(Pf0);
  vec4 n_z = mix(vec4(n000, n100, n010, n110), vec4(n001, n101, n011, n111), fade_xyz.z);
  vec2 n_yz = mix(n_z.xy, n_z.zw, fade_xyz.y);
  return 2.2 * mix(n_yz.x, n_yz.y, fade_xyz.x);
}

const float bayerMatrix2x2[4] = float[4](
  0.0 / 4.0, 2.0 / 4.0,
  3.0 / 4.0, 1.0 / 4.0
);

const float bayerMatrix4x4[16] = float[16](
   0.0 / 16.0,  8.0 / 16.0,  2.0 / 16.0, 10.0 / 16.0,
  12.0 / 16.0,  4.0 / 16.0, 14.0 / 16.0,  6.0 / 16.0,
   3.0 / 16.0, 11.0 / 16.0,  1.0 / 16.0,  9.0 / 16.0,
  15.0 / 16.0,  7.0 / 16.0, 13.0 / 16.0,  5.0 / 16.0
);

const float bayerMatrix8x8[64] = float[64](
   0.0/64.0, 48.0/64.0, 12.0/64.0, 60.0/64.0,  3.0/64.0, 51.0/64.0, 15.0/64.0, 63.0/64.0,
  32.0/64.0, 16.0/64.0, 44.0/64.0, 28.0/64.0, 35.0/64.0, 19.0/64.0, 47.0/64.0, 31.0/64.0,
   8.0/64.0, 56.0/64.0,  4.0/64.0, 52.0/64.0, 11.0/64.0, 59.0/64.0,  7.0/64.0, 55.0/64.0,
  40.0/64.0, 24.0/64.0, 36.0/64.0, 20.0/64.0, 43.0/64.0, 27.0/64.0, 39.0/64.0, 23.0/64.0,
   2.0/64.0, 50.0/64.0, 14.0/64.0, 62.0/64.0,  1.0/64.0, 49.0/64.0, 13.0/64.0, 61.0/64.0,
  34.0/64.0, 18.0/64.0, 46.0/64.0, 30.0/64.0, 33.0/64.0, 17.0/64.0, 45.0/64.0, 29.0/64.0,
  10.0/64.0, 58.0/64.0,  6.0/64.0, 54.0/64.0,  9.0/64.0, 57.0/64.0,  5.0/64.0, 53.0/64.0,
  42.0/64.0, 26.0/64.0, 38.0/64.0, 22.0/64.0, 41.0/64.0, 25.0/64.0, 37.0/64.0, 21.0/64.0
);

vec3 orderedDither(vec2 uv, float lum, float trailIntensity, float animatedBias) {
  float threshold = 0.0;
  if (uMatrixSize == 2.0) {
    int x = int(mod(floor(uv.x * uResolution.x), 2.0));
    int y = int(mod(floor(uv.y * uResolution.y), 2.0));
    threshold = bayerMatrix2x2[y * 2 + x];
  } else if (trailIntensity < 0.5) {
    int x = int(mod(floor(uv.x * uResolution.x), 4.0));
    int y = int(mod(floor(uv.y * uResolution.y), 4.0));
    threshold = bayerMatrix4x4[y * 4 + x];
  } else {
    int x = int(mod(floor(uv.x * uResolution.x), 8.0));
    int y = int(mod(floor(uv.y * uResolution.y), 8.0));
    threshold = bayerMatrix8x8[y * 8 + x];
  }
  float value = threshold + animatedBias * (1.0 + 2.0 * trailIntensity);
  return mix(uColorDark, uColorLight, step(value, lum));
}

void main() {
  vec2 screenUv = gl_FragCoord.xy / uResolution.xy;
  float trailIntensity = texture2D(uTrail, screenUv).r;
  float noiseValue = cnoise(vec3(vUv * uBiasNoiseScale, uTime * uBiasNoiseSpeed));
  float timePulse = sin(uTime * uBiasPulseSpeed) * 0.5 + 0.5;
  float animatedBias = uBias + (noiseValue * uBiasNoiseWeight + timePulse * uBiasPulseWeight) * uBiasAnimationStrength;

  float vertical = smoothstep(0.05, 0.95, vUv.y);
  float swell = sin(vUv.x * 8.0 + noiseValue * 2.4) * 0.035;
  float lum = clamp(0.28 + vertical * 0.46 + swell + noiseValue * 0.12 + trailIntensity * 0.28, 0.0, 1.0);
  vec3 dithered = orderedDither(
    gl_FragCoord.xy / (uResolution.xy * uScaleResolution),
    lum,
    trailIntensity * uTrailIntensityMultiplier,
    animatedBias
  );
  float alpha = uOpacity * mix(0.72, 1.0, trailIntensity);
  gl_FragColor = vec4(dithered, alpha);
}
`;

const TRAIL_FRAG = /* glsl */ `
precision highp float;

uniform sampler2D u_texture;
uniform vec2 uPointer;
uniform vec2 uLastPointer;
uniform float uAspect;
uniform float uVelocity;
uniform float uTime;
uniform float uInitialRadius;
uniform float uInitialRadiusMultiplier;
uniform float uBorderSize;
uniform float uBorderSizeMultiplier;
uniform float uDecayRate;

varying vec2 vUv;

float circle(vec2 uv, vec2 discCenter, float discRadius, float borderSize) {
  uv -= discCenter;
  uv.x *= uAspect;
  float dist = sqrt(dot(uv, uv));
  return smoothstep(discRadius + borderSize, discRadius - borderSize, dist);
}

float lineSegment(vec2 p, vec2 a, vec2 b, float radius, float border) {
  p.x *= uAspect;
  a.x *= uAspect;
  b.x *= uAspect;
  vec2 pa = p - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 0.000001), 0.0, 1.0);
  float dist = length(pa - ba * h);
  return smoothstep(radius + border, radius - border, dist);
}

void main() {
  vec4 color = texture2D(u_texture, vUv);
  float radius = uInitialRadius + uVelocity * uInitialRadiusMultiplier;
  float border = uBorderSize + uVelocity * uBorderSizeMultiplier;
  float line = lineSegment(vUv, uLastPointer, uPointer, radius, border);
  float currentCircle = circle(vUv, uPointer, radius, border);
  color.rgb += max(line, currentCircle) * uVelocity;
  color.rgb = mix(color.rgb, vec3(0.0), uDecayRate);
  color.rgb = clamp(color.rgb, vec3(0.0), vec3(1.0));
  color.a = 1.0;
  gl_FragColor = color;
}
`;

type RenderState = "loading" | "running" | "paused" | "static" | "stopped" | "fallback";

type DitherStats = {
  state: RenderState;
  frames: number;
  framesAfterStop: number;
  qualityLevel: number;
  downgrades: number;
  dpr: number;
  lastFrameMs: number;
  averageFrameMs: number;
  reducedMotion: boolean;
};

type DitherCapture = {
  freeze: () => void;
  thaw: () => void;
  step: (milliseconds?: number) => void;
  stats: () => DitherStats;
};

type DitherController = {
  setReduced: (reduced: boolean) => void;
};

declare global {
  interface Window {
    __laylineBriefDither?: DitherCapture;
  }
}

export function RaceBriefDither({ reduced }: { reduced: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reducedRef = useRef(reduced);
  const controllerRef = useRef<DitherController | null>(null);
  reducedRef.current = reduced;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || useReplay.getState().briefDone) return;
    const wrapper = canvas.parentElement;

    let teardown: (() => void) | null = null;

    try {
      const renderer = new THREE.WebGLRenderer({
        canvas,
        alpha: true,
        antialias: false,
        powerPreference: "high-performance",
        preserveDrawingBuffer: false,
      });
      renderer.outputColorSpace = THREE.LinearSRGBColorSpace;

      const scene = new THREE.Scene();
      const trailScene = new THREE.Scene();
      const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
      camera.position.z = 10;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        "position",
        new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
      );

      const halftoneUniforms: Record<string, THREE.IUniform> = {
        uTrail: { value: null },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uColorDark: { value: new THREE.Vector3(...COLOR_DARK) },
        uColorLight: { value: new THREE.Vector3(...COLOR_LIGHT) },
        uMatrixSize: { value: DEFAULTS.matrixSize },
        uBias: { value: DEFAULTS.bias },
        uScaleResolution: { value: DEFAULTS.scaleResolution },
        uOpacity: { value: DEFAULTS.opacity },
        uTime: { value: 0 },
        uTrailIntensityMultiplier: { value: DEFAULTS.trailIntensityMultiplier },
        uBiasNoiseScale: { value: DEFAULTS.biasNoiseScale },
        uBiasNoiseSpeed: { value: DEFAULTS.biasNoiseSpeed },
        uBiasPulseSpeed: { value: DEFAULTS.biasPulseSpeed },
        uBiasNoiseWeight: { value: DEFAULTS.biasNoiseWeight },
        uBiasPulseWeight: { value: DEFAULTS.biasPulseWeight },
        uBiasAnimationStrength: { value: DEFAULTS.biasAnimationStrength },
      };
      const halftoneMaterial = new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: HALFTONE_FRAG,
        uniforms: halftoneUniforms,
        transparent: true,
        depthTest: false,
        depthWrite: false,
      });
      scene.add(new THREE.Mesh(geometry, halftoneMaterial));

      const trailUniforms: Record<string, THREE.IUniform> = {
        u_texture: { value: null },
        uPointer: { value: new THREE.Vector2(0.5, 0.5) },
        uLastPointer: { value: new THREE.Vector2(0.5, 0.5) },
        uAspect: { value: 1 },
        uVelocity: { value: 0 },
        uTime: { value: 0 },
        uInitialRadius: { value: TRAIL_DEFAULTS.initialRadius },
        uInitialRadiusMultiplier: { value: TRAIL_DEFAULTS.initialRadiusMultiplier },
        uBorderSize: { value: TRAIL_DEFAULTS.borderSize },
        uBorderSizeMultiplier: { value: TRAIL_DEFAULTS.borderSizeMultiplier },
        uDecayRate: { value: TRAIL_DEFAULTS.decayRate },
      };
      const trailMaterial = new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: TRAIL_FRAG,
        uniforms: trailUniforms,
        depthTest: false,
        depthWrite: false,
      });
      trailScene.add(new THREE.Mesh(geometry, trailMaterial));

      const targetOptions: THREE.RenderTargetOptions = {
        type: THREE.HalfFloatType,
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        depthBuffer: false,
        stencilBuffer: false,
      };
      const targetA = new THREE.WebGLRenderTarget(1, 1, targetOptions);
      const targetB = new THREE.WebGLRenderTarget(1, 1, targetOptions);
      let readTarget = targetA;
      let writeTarget = targetB;

      const drawingBuffer = new THREE.Vector2();
      const clearColor = new THREE.Color();
      const pointer = { x: 0.5, y: 0.5 };
      const previousPointer = { x: 0.5, y: 0.5 };
      const bounds = { left: 0, top: 0, width: 1, height: 1 };
      const stats = {
        state: "loading" as RenderState,
        frames: 0,
        framesAfterStop: 0,
        qualityLevel: 0,
        downgrades: 0,
        dpr: 1,
        lastFrameMs: 0,
        totalFrameMs: 0,
        timedFrames: 0,
      };

      let disposed = false;
      let stopped = false;
      let contextLost = false;
      let documentVisible = document.visibilityState !== "hidden";
      let intersecting = true;
      let storeFrozen = useReplay.getState().frozen;
      let manuallyFrozen = false;
      let pointerAttached = false;
      let elapsed = 0;
      let lastRaceTime = useReplay.getState().t;
      let smoothedVelocity = 0;
      let qualityWindowMs = 0;
      let qualityWindowFrames = 0;
      let qualitySlowFrames = 0;
      let qualityWindowTotal = 0;
      let restoreTimer = 0;

      const setState = (state: RenderState): void => {
        if (stats.state === state) return;
        stats.state = state;
        canvas.dataset.renderState = state;
        if (wrapper instanceof HTMLElement) wrapper.dataset.renderState = state;
      };
      const canRender = (): boolean =>
        !disposed &&
        !stopped &&
        !contextLost &&
        documentVisible &&
        intersecting &&
        !storeFrozen &&
        !manuallyFrozen;
      const readBounds = (): void => {
        const rect = canvas.getBoundingClientRect();
        bounds.left = rect.left;
        bounds.top = rect.top;
        bounds.width = Math.max(1, rect.width);
        bounds.height = Math.max(1, rect.height);
      };
      const clearTargets = (): void => {
        renderer.getClearColor(clearColor);
        const clearAlpha = renderer.getClearAlpha();
        renderer.setClearColor(0x000000, 0);
        renderer.setRenderTarget(targetA);
        renderer.clear();
        renderer.setRenderTarget(targetB);
        renderer.clear();
        renderer.setRenderTarget(null);
        renderer.setClearColor(clearColor, clearAlpha);
        readTarget = targetA;
        writeTarget = targetB;
        halftoneUniforms.uTrail.value = readTarget.texture;
      };
      const resize = (): void => {
        if (disposed || stopped || contextLost) return;
        readBounds();
        const dpr = Math.max(
          0.5,
          Math.min(window.devicePixelRatio || 1, DPR_CAP) * QUALITY_SCALE[stats.qualityLevel],
        );
        stats.dpr = dpr;
        canvas.dataset.dpr = dpr.toFixed(2);
        canvas.dataset.quality = String(stats.qualityLevel);
        renderer.setPixelRatio(dpr);
        renderer.setSize(bounds.width, bounds.height, false);
        renderer.getDrawingBufferSize(drawingBuffer);
        targetA.setSize(drawingBuffer.x, drawingBuffer.y);
        targetB.setSize(drawingBuffer.x, drawingBuffer.y);
        halftoneUniforms.uResolution.value.set(drawingBuffer.x, drawingBuffer.y);
        trailUniforms.uAspect.value = bounds.width / bounds.height;
        clearTargets();
      };
      const resetQualityWindow = (): void => {
        qualityWindowMs = 0;
        qualityWindowFrames = 0;
        qualitySlowFrames = 0;
        qualityWindowTotal = 0;
      };
      const sampleQuality = (frameMs: number): void => {
        if (frameMs <= 0 || frameMs >= 250) return;
        stats.lastFrameMs = frameMs;
        stats.totalFrameMs += frameMs;
        stats.timedFrames += 1;
        qualityWindowMs += frameMs;
        qualityWindowFrames += 1;
        qualityWindowTotal += frameMs;
        if (frameMs > SLOW_FRAME_MS) qualitySlowFrames += 1;
        if (qualityWindowMs < QUALITY_WINDOW_MS) return;
        const average = qualityWindowTotal / Math.max(1, qualityWindowFrames);
        const slowShare = qualitySlowFrames / Math.max(1, qualityWindowFrames);
        if (
          qualityWindowFrames >= MIN_QUALITY_SAMPLES &&
          stats.qualityLevel < QUALITY_SCALE.length - 1 &&
          (average > SLOW_FRAME_MS || slowShare > 0.58)
        ) {
          stats.qualityLevel += 1;
          stats.downgrades += 1;
          resize();
        }
        resetQualityWindow();
      };
      const render = (frameMs = 1000 / 60): void => {
        if (disposed || stopped) {
          stats.framesAfterStop += 1;
          return;
        }
        if (!canRender()) return;
        sampleQuality(frameMs);
        const delta = frameMs / 1000;
        elapsed += delta;
        halftoneUniforms.uTime.value = elapsed * ANIM_TIME_SCALE;
        trailUniforms.uTime.value = elapsed;

        const dx = pointer.x - previousPointer.x;
        const dy = pointer.y - previousPointer.y;
        const moved = Math.sqrt(dx * dx + dy * dy);
        const targetVelocity = Math.min(2.5, moved * 40);
        smoothedVelocity += (targetVelocity - smoothedVelocity) * 0.35;
        trailUniforms.uLastPointer.value.set(previousPointer.x, previousPointer.y);
        trailUniforms.uPointer.value.set(pointer.x, pointer.y);
        trailUniforms.uVelocity.value = smoothedVelocity;
        trailUniforms.u_texture.value = readTarget.texture;

        renderer.setRenderTarget(writeTarget);
        renderer.render(trailScene, camera);
        const swap = readTarget;
        readTarget = writeTarget;
        writeTarget = swap;
        halftoneUniforms.uTrail.value = readTarget.texture;
        previousPointer.x = pointer.x;
        previousPointer.y = pointer.y;
        renderer.setRenderTarget(null);
        renderer.render(scene, camera);

        stats.frames += 1;
        if (canvas.dataset.ready !== "true") canvas.dataset.ready = "true";
        setState(reducedRef.current ? "static" : "running");
      };
      const syncPauseState = (): void => {
        if (stopped) {
          setState("stopped");
          return;
        }
        if (!canRender()) {
          resetQualityWindow();
          setState(reducedRef.current ? "static" : "paused");
          return;
        }
        setState(reducedRef.current ? "static" : "running");
      };
      const onPointerMove = (event: PointerEvent): void => {
        pointer.x = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width));
        pointer.y = 1 - Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height));
        if (!documentVisible || !intersecting || stopped || contextLost) {
          previousPointer.x = pointer.x;
          previousPointer.y = pointer.y;
        }
      };
      const syncPointer = (): void => {
        const shouldAttach = !reducedRef.current && !stopped && !disposed;
        if (shouldAttach === pointerAttached) return;
        pointerAttached = shouldAttach;
        if (shouldAttach) window.addEventListener("pointermove", onPointerMove, { passive: true });
        else window.removeEventListener("pointermove", onPointerMove);
      };
      const onScroll = (): void => readBounds();
      const onVisibility = (): void => {
        documentVisible = document.visibilityState !== "hidden";
        syncPauseState();
      };
      const onContextLost = (event: Event): void => {
        event.preventDefault();
        contextLost = true;
        canvas.dataset.ready = "false";
        setState("fallback");
      };
      const onContextRestored = (): void => {
        contextLost = false;
        window.clearTimeout(restoreTimer);
        restoreTimer = window.setTimeout(() => {
          if (disposed || stopped) return;
          resize();
          render(0);
          syncPauseState();
        }, 0);
      };

      const resizeObserver = new ResizeObserver(() => {
        resize();
        if (reducedRef.current || manuallyFrozen || storeFrozen) render(0);
      });
      const intersectionObserver = new IntersectionObserver((entries) => {
        intersecting = entries[0]?.isIntersecting ?? false;
        syncPauseState();
      });
      let unsubscribeStore = (): void => undefined;
      const stop = (): void => {
        if (stopped) return;
        stopped = true;
        unsubscribeStore();
        syncPointer();
        window.removeEventListener("scroll", onScroll);
        document.removeEventListener("visibilitychange", onVisibility);
        resizeObserver.disconnect();
        intersectionObserver.disconnect();
        setState("stopped");
      };

      resize();
      resizeObserver.observe(canvas);
      intersectionObserver.observe(canvas);
      window.addEventListener("scroll", onScroll, { passive: true });
      document.addEventListener("visibilitychange", onVisibility);
      canvas.addEventListener("webglcontextlost", onContextLost);
      canvas.addEventListener("webglcontextrestored", onContextRestored);
      syncPointer();
      unsubscribeStore = useReplay.subscribe((state) => {
        if (state.briefDone) {
          stop();
          return;
        }
        storeFrozen = state.frozen;
        if (state.t === lastRaceTime) {
          syncPauseState();
          return;
        }
        const frameMs = Math.min(
          100,
          Math.max(0, (Math.abs(state.t - lastRaceTime) * 1000) / Math.max(1, state.rate)),
        );
        lastRaceTime = state.t;
        if (!storeFrozen && !reducedRef.current) render(frameMs);
        else syncPauseState();
      });

      const capture: DitherCapture = {
        freeze: () => {
          manuallyFrozen = true;
          syncPauseState();
        },
        thaw: () => {
          manuallyFrozen = false;
          syncPauseState();
        },
        step: (milliseconds = 1000 / 60) => {
          const heldStore = storeFrozen;
          manuallyFrozen = false;
          storeFrozen = false;
          render(Math.max(0, milliseconds));
          storeFrozen = heldStore;
          manuallyFrozen = true;
          syncPauseState();
        },
        stats: () => ({
          state: stats.state,
          frames: stats.frames,
          framesAfterStop: stats.framesAfterStop,
          qualityLevel: stats.qualityLevel,
          downgrades: stats.downgrades,
          dpr: stats.dpr,
          lastFrameMs: stats.lastFrameMs,
          averageFrameMs: stats.timedFrames === 0 ? 0 : stats.totalFrameMs / stats.timedFrames,
          reducedMotion: reducedRef.current,
        }),
      };
      window.__laylineBriefDither = capture;

      controllerRef.current = {
        setReduced: (nextReduced) => {
          reducedRef.current = nextReduced;
          if (wrapper instanceof HTMLElement) wrapper.dataset.reducedMotion = nextReduced ? "true" : "false";
          syncPointer();
          if (nextReduced) {
            smoothedVelocity = 0;
            clearTargets();
            render(0);
          }
          syncPauseState();
        },
      };

      render(0);
      syncPauseState();

      teardown = () => {
        if (disposed) return;
        stop();
        disposed = true;
        window.clearTimeout(restoreTimer);
        canvas.removeEventListener("webglcontextlost", onContextLost);
        canvas.removeEventListener("webglcontextrestored", onContextRestored);
        if (window.__laylineBriefDither === capture) delete window.__laylineBriefDither;
        controllerRef.current = null;
        geometry.dispose();
        halftoneMaterial.dispose();
        trailMaterial.dispose();
        targetA.dispose();
        targetB.dispose();
        renderer.dispose();
        renderer.forceContextLoss();
      };
    } catch {
      canvas.dataset.ready = "false";
      canvas.dataset.renderState = "fallback";
      if (wrapper instanceof HTMLElement) wrapper.dataset.renderState = "fallback";
    }

    return () => teardown?.();
  }, []);

  useEffect(() => {
    controllerRef.current?.setReduced(reduced);
  }, [reduced]);

  return (
    <div className={styles.briefDither} aria-hidden="true">
      <canvas className={styles.briefDitherCanvas} ref={canvasRef} data-ready="false" />
      <span className={styles.briefDitherFallback} />
    </div>
  );
}
