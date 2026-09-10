/**
 * arthash — TypeScript SDK.
 *
 * Backed by `arthash-rs` compiled to WebAssembly via wasm-bindgen.
 * Works in browser and Node (>= 18, native `Uint8Array` + WebAssembly).
 *
 * Quick start:
 * ```ts
 * import { encode, decode, toSvg, codec, Preset, encodeImage } from "arthash";
 *
 * // Plain RGB buffer
 * const hash = await encode(rgbBytes, width, height, codec.triangle({ n: 64 }));
 * const { w, h, rgba } = await decode(hash, codec.triangle({ n: 64 }));
 *
 * // Named preset
 * const hash2 = await encode(rgbBytes, w, h, codec.preset(Preset.LargeTriangle));
 *
 * // Browser convenience: load image, resize, encode in one call
 * const hash3 = await encodeImage(imgUrl, codec.triangle({ n: 64 }));
 * ```
 *
 * The wasm module loads automatically on first call. If you want to control
 * timing (e.g. preload), call `await init()` explicitly.
 */

import initWasm, {
  encodeRgb as wasmEncodeRgb,
  encodeRgba as wasmEncodeRgba,
  decode as wasmDecode,
  toSvg as wasmToSvg,
} from "../wasm/pkg/arthash_wasm.js";

import * as palettes from "./palettes.js";
export { palettes };
export { palette, type Palette } from "./palette.js";
import type { Palette } from "./palette.js";

// ---------------------------------------------------------------------------
// Codec — discriminated union + factory helpers
// ---------------------------------------------------------------------------

export const Shape = {
  DCT: "dct",
  CIRCLE: "circle",
  TRIANGLE: "triangle",
  PIXEL: "pixel",
  SQUARE: "square",
  RECT: "rect",
  ROTATED_RECT: "rotrect",
} as const;
export type Shape = (typeof Shape)[keyof typeof Shape];

// `palette` and `Palette` are now defined in `./palette.ts` to avoid the
// `index.ts ↔ palettes.ts` circular import (palettes.ts builds its presets by
// calling `palette.fromHex` at module top level — that ran before the inline
// `export const palette = {...}` here had initialized, throwing TDZ).

/** Color encoding for shape / PIXEL modes. */
export type ColorMode =
  | { type: "rgb565" }
  | { type: "rgb888" }
  | { type: "palette"; palette: Palette };

interface CodecBase {
  color?: ColorMode;
}

/** Codec — byte-format contract. Construct via `codec.dct()`, `codec.triangle(...)`,
 *  etc. The same Codec value MUST be passed to both encode and decode. */
export type Codec =
  | { kind: "dct" }
  | ({ kind: "circle"; n: number } & CodecBase)
  | ({ kind: "triangle"; n: number } & CodecBase)
  | ({ kind: "square"; n: number } & CodecBase)
  | ({ kind: "rect"; n: number } & CodecBase)
  | ({ kind: "rotrect"; n: number; thetaBits?: number } & CodecBase)
  | ({ kind: "pixel"; n: number; gridAspect?: number } & CodecBase)
  | { kind: "raw"; spec: RawCodecSpec };

/** Low-level codec spec — every SPEC field exposed. Use via `codec.raw(...)`
 *  for advanced controls (overriding bit widths, custom alpha levels). */
export interface RawCodecSpec {
  shape: Shape;
  nShapes?: number;
  cxBits?: number;
  cyBits?: number;
  rBits?: number;
  alphaBits?: number;
  colorBits?: 16 | 24;
  thetaBits?: number;
  palette?: Uint8Array;
  paletteK?: number;
  gridAspect?: number;
}

/** Named codec recipes. Use `codec.preset(Preset.LargeTriangle)`.
 *
 *  Two axes:
 *  - **size** — `Small*` (n=12, pixel n=16, ~50–80 B) → `Medium*` (n=24,
 *    ~100–150 B) → `Large*` (n=64, ~270–400 B).
 *  - **shape** — `Triangle` / `Circle` / `Pixel` / `Rect` / `Square`.
 *
 *  Plus `Preset.Dct` — the frequency-domain placeholder (~21 B), outside the
 *  size axis. Actual byte counts vary ±1 B with image aspect.
 *
 *  Pre-0.3 names (`TinyDct` / `Placeholder*` / `Detail*`) are kept as
 *  deprecated aliases for source compatibility; they will be removed in 1.0. */
export const Preset = {
  Dct: "dct",
  SmallTriangle: "small_triangle",
  SmallCircle: "small_circle",
  SmallPixel: "small_pixel",
  SmallRect: "small_rect",
  SmallSquare: "small_square",
  MediumTriangle: "medium_triangle",
  MediumCircle: "medium_circle",
  MediumPixel: "medium_pixel",
  MediumRect: "medium_rect",
  MediumSquare: "medium_square",
  LargeTriangle: "large_triangle",
  LargeCircle: "large_circle",
  LargePixel: "large_pixel",
  LargeRect: "large_rect",
  LargeSquare: "large_square",
  /** @deprecated Renamed to `Preset.Dct`. */
  TinyDct: "tiny_dct",
  /** @deprecated Renamed to `Preset.SmallTriangle`. */
  PlaceholderTriangle: "placeholder_triangle",
  /** @deprecated Renamed to `Preset.SmallCircle`. */
  PlaceholderCircle: "placeholder_circle",
  /** @deprecated Renamed to `Preset.SmallPixel`. */
  PlaceholderPixel: "placeholder_pixel",
  /** @deprecated Renamed to `Preset.LargeTriangle`. */
  DetailTriangle: "detail_triangle",
  /** @deprecated Renamed to `Preset.LargeCircle`. */
  DetailCircle: "detail_circle",
  /** @deprecated Renamed to `Preset.LargePixel`. */
  DetailPixel: "detail_pixel",
} as const;
export type Preset = (typeof Preset)[keyof typeof Preset];

/** Factory namespace — `codec.dct()`, `codec.triangle({ n: 64 })`, …
 *
 *  Each factory's return type is inferred to its narrowed shape (e.g.
 *  `{ kind: 'rect', n: number, color?: ColorMode }`) rather than the broad
 *  `Codec` union. This narrowing lets `RenderStyle<C>`'s conditional type
 *  enforce `cornerRadius` is only allowed for rect-family codecs at call
 *  sites. Returns are still assignable to `Codec` since every narrow type
 *  is a member of the union. */
export const codec = {
  dct() {
    return { kind: "dct" as const };
  },
  circle(opts: { n?: number; color?: ColorMode } = {}) {
    return { kind: "circle" as const, n: opts.n ?? 12, color: opts.color };
  },
  triangle(opts: { n?: number; color?: ColorMode } = {}) {
    return { kind: "triangle" as const, n: opts.n ?? 12, color: opts.color };
  },
  square(opts: { n?: number; color?: ColorMode } = {}) {
    return { kind: "square" as const, n: opts.n ?? 12, color: opts.color };
  },
  rect(opts: { n?: number; color?: ColorMode } = {}) {
    return { kind: "rect" as const, n: opts.n ?? 12, color: opts.color };
  },
  rotatedRect(opts: {
    n?: number;
    thetaBits?: number;
    color?: ColorMode;
  } = {}) {
    return {
      kind: "rotrect" as const,
      n: opts.n ?? 12,
      thetaBits: opts.thetaBits,
      color: opts.color,
    };
  },
  pixel(opts: {
    n?: number;
    gridAspect?: number;
    color?: ColorMode;
  } = {}) {
    return {
      kind: "pixel" as const,
      n: opts.n ?? 12,
      gridAspect: opts.gridAspect,
      color: opts.color,
    };
  },
  preset(p: Preset): Codec {
    switch (p) {
      case Preset.Dct: return codec.dct();
      case Preset.SmallTriangle: return codec.triangle({ n: 12 });
      case Preset.SmallCircle: return codec.circle({ n: 12 });
      case Preset.SmallPixel: return codec.pixel({ n: 16 });
      case Preset.SmallRect: return codec.rect({ n: 12 });
      case Preset.SmallSquare: return codec.square({ n: 12 });
      case Preset.MediumTriangle: return codec.triangle({ n: 24 });
      case Preset.MediumCircle: return codec.circle({ n: 24 });
      case Preset.MediumPixel: return codec.pixel({ n: 24 });
      case Preset.MediumRect: return codec.rect({ n: 24 });
      case Preset.MediumSquare: return codec.square({ n: 24 });
      case Preset.LargeTriangle: return codec.triangle({ n: 64 });
      case Preset.LargeCircle: return codec.circle({ n: 64 });
      case Preset.LargePixel: return codec.pixel({ n: 64 });
      case Preset.LargeRect: return codec.rect({ n: 64 });
      case Preset.LargeSquare: return codec.square({ n: 64 });
      // Deprecated aliases — same codec as their replacement.
      case Preset.TinyDct: return codec.dct();
      case Preset.PlaceholderTriangle: return codec.triangle({ n: 12 });
      case Preset.PlaceholderCircle: return codec.circle({ n: 12 });
      case Preset.PlaceholderPixel: return codec.pixel({ n: 16 });
      case Preset.DetailTriangle: return codec.triangle({ n: 64 });
      case Preset.DetailCircle: return codec.circle({ n: 64 });
      case Preset.DetailPixel: return codec.pixel({ n: 64 });
    }
  },
  /** Convenience: switch a codec's color mode to palette indexing. */
  withPalette(c: Codec, palette: Palette): Codec {
    if (c.kind === "dct" || c.kind === "raw") return c;
    return { ...c, color: { type: "palette", palette } };
  },
  /** Low-level escape hatch — set any SPEC field. For conformance tests and
   *  advanced controls. Normal users should prefer the named factories. */
  raw(spec: RawCodecSpec): Codec {
    return { kind: "raw", spec };
  },
  /** True if this codec stores per-shape palette indices instead of full color. */
  isPaletteMode(c: Codec): boolean {
    if (c.kind === "raw") return c.spec.palette !== undefined;
    if (c.kind === "dct") return false;
    return c.color?.type === "palette";
  },
  /** Total byte length of a hash produced by this codec (header + body, rounded
   *  up to the byte). Matches Python's `Codec.bytes_total()` and Rust's
   *  `Codec::bytes_total()`. */
  bytesTotal(c: Codec): number {
    const cfg = codecToSpecFields(c);
    return computeBytesTotal(cfg);
  },
} as const;

interface SpecFields {
  shape: Shape;
  nShapes: number;
  cxBits: number;
  cyBits: number;
  rBits: number;
  alphaBits: number;
  colorBits: number;
  thetaBits: number;
  paletteK: number;
  hasPalette: boolean;
}

const DEFAULT_SPEC: SpecFields = {
  shape: Shape.DCT,
  nShapes: 12,
  cxBits: 5,
  cyBits: 5,
  rBits: 4,
  alphaBits: 3,
  colorBits: 16,
  thetaBits: 5,
  paletteK: 0,
  hasPalette: false,
};

function codecToSpecFields(c: Codec): SpecFields {
  if (c.kind === "raw") {
    const s = c.spec;
    const paletteLen = s.palette?.length ?? 0;
    const k = s.paletteK ?? (paletteLen > 0 ? paletteLen / 3 : 0);
    return {
      ...DEFAULT_SPEC,
      shape: s.shape,
      nShapes: s.nShapes ?? DEFAULT_SPEC.nShapes,
      cxBits: s.cxBits ?? DEFAULT_SPEC.cxBits,
      cyBits: s.cyBits ?? DEFAULT_SPEC.cyBits,
      rBits: s.rBits ?? DEFAULT_SPEC.rBits,
      alphaBits: s.alphaBits ?? DEFAULT_SPEC.alphaBits,
      colorBits: s.colorBits ?? DEFAULT_SPEC.colorBits,
      thetaBits: s.thetaBits ?? DEFAULT_SPEC.thetaBits,
      hasPalette: paletteLen > 0,
      paletteK: k,
    };
  }
  if (c.kind === "dct") return { ...DEFAULT_SPEC, shape: Shape.DCT };

  const out: SpecFields = { ...DEFAULT_SPEC, shape: c.kind, nShapes: c.n };
  if (c.kind === "rotrect" && c.thetaBits !== undefined) {
    out.thetaBits = c.thetaBits;
  }
  const color = c.color;
  if (color && color.type === "rgb888") {
    out.colorBits = 24;
  } else if (color && color.type === "palette") {
    out.hasPalette = true;
    out.paletteK = color.palette.k ?? color.palette.bytes.length / 3;
  }
  return out;
}

function colorFieldBits(s: SpecFields): number {
  if (s.hasPalette) {
    // ceil(log₂K). `32 - clz32(K-1)` is exact for K ≥ 1 and avoids the
    // floating-point hazards of `Math.ceil(Math.log2(K))` at K = 2ⁿ.
    const k = Math.max(2, s.paletteK);
    return 32 - Math.clz32(k - 1);
  }
  return s.colorBits;
}

function perShapeBits(s: SpecFields): number {
  const cx = s.cxBits, cy = s.cyBits, r = s.rBits;
  const col = colorFieldBits(s), a = s.alphaBits;
  switch (s.shape) {
    case Shape.CIRCLE:
    case Shape.SQUARE: return cx + cy + r + col + a;
    case Shape.RECT: return cx + cy + 2 * r + col + a;
    case Shape.ROTATED_RECT: return cx + cy + 2 * r + s.thetaBits + col + a;
    case Shape.TRIANGLE: return 3 * (cx + cy) + col + a;
    case Shape.PIXEL: return col;
    case Shape.DCT: return 0;
  }
}

function computeBytesTotal(s: SpecFields): number {
  if (s.shape === Shape.DCT) {
    // SPEC §3 — header 40 bits + 4·(28 + 16) = 216 bits / 8 = 27 B (no alpha)
    return Math.ceil((40 + 4 * (28 + 16)) / 8);
  }
  const headerBits = s.shape === Shape.PIXEL ? 8 : 8 + colorFieldBits(s);
  return Math.ceil((headerBits + s.nShapes * perShapeBits(s)) / 8);
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Hill-climb search budget for shape modes — affects encoder cost / quality
 *  but NOT byte format. */
export interface SearchOptions {
  strategy?: "primitive" | "topk_uniform";
  nRandom?: number;
  nTopk?: number;
  hillClimbSteps?: number;
  hillClimbMaxAge?: number | null;
  nAttempts?: number;
}

export interface EncodeOptions {
  /** RNG seed for shape-mode hill-climb. Default 0. */
  seed?: number;
  /** Override the encoder's tuned search defaults. */
  search?: SearchOptions;
}

/** Codec kinds where corner-rounding is meaningful. PIXEL is excluded
 *  intentionally — its tile grid would show seams between rounded cells. */
type RectFamilyKind = "rect" | "square" | "rotrect";

/** Visual styling applied at render time (decode, SVG, raster helpers).
 *  Independent of the codec byte format — same `(hash, codec)` with different
 *  `RenderStyle` produces visually distinct but byte-identical hashes.
 *
 *  Both fields are in viewBox / base-size units. When `C` is a specific
 *  codec kind, `cornerRadius` is only available for rect-family codecs;
 *  passing it to circle / triangle / pixel / DCT is a compile error
 *  (via `cornerRadius?: never` in the non-rect branch). */
export type RenderStyle<C extends Codec = Codec> = C extends {
  kind: RectFamilyKind;
}
  ? {
      /** Gaussian blur stdDeviation in viewBox units. `0` = sharp. */
      blur?: number;
      /** Round corners by this radius (viewBox units). `0` = sharp.
       *  Only available for rect / square / rotrect codecs. */
      cornerRadius?: number;
    }
  : {
      /** Gaussian blur stdDeviation in viewBox units. `0` = sharp. */
      blur?: number;
      /** cornerRadius is only supported for rect / square / rotrect.
       *  Setting it on circle / triangle / pixel / DCT is a type error. */
      cornerRadius?: never;
    };

export interface DecodeOptions {
  /** Long-edge pixel target. Default 256. */
  baseSize?: number;
  /** Override the stored aspect ratio. */
  overrideAspect?: number;
  /** SHAPE-mode supersample factor. 1 = off, 2 = 4 samples, 4 = 16 samples.
   *  Ignored by DCT / PIXEL. */
  aa?: number;
  /** PIXEL only — `"nearest"` (default) or `"bilinear"`. */
  pixelSmooth?: "nearest" | "bilinear";
  /** Visual styling — blur and (for rect/square/rotrect) cornerRadius. */
  style?: RenderStyle;
  /** Ordered (Bayer 8×8) dithering at 8-bit quantization — breaks up
   *  banding in smooth gradients. Applies to DCT decode and to blurred
   *  output (`style.blur`); no effect on sharp shape/PIXEL output. On a
   *  DCT codec carrying a render-time palette (`codec.raw`), switches the
   *  palette quantization from hard posterize to ordered dither.
   *  Default `false` (byte-stable output). */
  dither?: boolean;
  /** Dither dot pitch for the palette quantization, in output pixels —
   *  one Bayer cell covers a `ditherScale × ditherScale` block. `0`
   *  (default) = auto (`baseSize / 128`, min 1), keeping the pattern
   *  chunky-retro at large output sizes. */
  ditherScale?: number;
}

export interface SvgRenderOptions {
  baseSize?: number;
  overrideAspect?: number;
  /** Gaussian blur stdDeviation in viewBox units. `0` = no blur.
   *  @deprecated Use `style.blur` instead. Removed in 1.0. */
  blur?: number;
  /** Visual styling — blur and (for rect/square/rotrect) cornerRadius. */
  style?: RenderStyle;
}

export interface DecodeResult {
  w: number;
  h: number;
  /** RGBA pixels, row-major (4 bytes per pixel, length = 4·w·h). */
  rgba: Uint8Array;
}

// ---------------------------------------------------------------------------
// Wasm lifecycle — auto-init on first use
// ---------------------------------------------------------------------------

export type InitInput =
  | undefined
  | RequestInfo
  | URL
  | Response
  | BufferSource
  | WebAssembly.Module;

let wasmReady: Promise<void> | null = null;

/** Force the wasm module to load now. Optional — encode/decode/toSvg
 *  auto-init on first call. Safe to call repeatedly. */
export function init(input?: InitInput): Promise<void> {
  if (!wasmReady) {
    wasmReady = initWasm(
      input === undefined ? undefined : { module_or_path: input },
    ).then(() => undefined);
  }
  return wasmReady;
}

async function ready(): Promise<void> {
  if (!wasmReady) {
    wasmReady = initWasm().then(() => undefined);
  }
  await wasmReady;
}

// ---------------------------------------------------------------------------
// FFI plumbing
// ---------------------------------------------------------------------------

/** camelCase → snake_case for FFI key names. `nShapes` → `n_shapes`, `rBits`
 *  → `r_bits`. Acronyms and existing underscores are preserved. */
function toSnakeCase(key: string): string {
  return key.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());
}

/** Copy own enumerable keys from `src` into `dst` with camelCase → snake_case
 *  renaming. Skips entries whose value (or transformed value) is `undefined`,
 *  so optional fields don't show up as `null` on the Rust side. Pass a
 *  `transform` map to override specific keys (return `undefined` to skip). */
function assignSnakeCase(
  dst: Record<string, unknown>,
  src: Record<string, unknown>,
  transform: Record<string, (v: unknown) => unknown> = {},
): void {
  for (const [k, v] of Object.entries(src)) {
    if (v === undefined) continue;
    const fn = transform[k];
    const transformed = fn ? fn(v) : v;
    if (transformed === undefined) continue;
    dst[toSnakeCase(k)] = transformed;
  }
}

function codecToFfi(c: Codec): Record<string, unknown> {
  if (c.kind === "raw") {
    const out: Record<string, unknown> = {};
    assignSnakeCase(out, c.spec as unknown as Record<string, unknown>, {
      // Pass the Uint8Array straight through — the wasm `get_u8_array` helper
      // bulk-copies a typed array, so converting to a number[] here would just
      // add an allocation + per-byte marshalling on both sides.
      palette: (v) => {
        const arr = v as Uint8Array;
        return arr.length > 0 ? arr : undefined;
      },
    });
    return out;
  }

  const out: Record<string, unknown> = { shape: c.kind };
  if (c.kind === "dct") return out;
  out.n_shapes = c.n;
  if (c.kind === "rotrect" && c.thetaBits !== undefined) {
    out.theta_bits = c.thetaBits;
  }
  if (c.kind === "pixel" && c.gridAspect !== undefined) {
    out.grid_aspect = c.gridAspect;
  }
  const color = c.color;
  if (color === undefined || color.type === "rgb565") {
    out.color_bits = 16;
  } else if (color.type === "rgb888") {
    out.color_bits = 24;
  } else {
    out.color_bits = 16;
    const pal = color.palette;
    out.palette = pal.bytes; // Uint8Array — bulk-copied by the wasm side.
    if (pal.k !== undefined) out.palette_k = pal.k;
  }
  return out;
}

function searchToFfi(s: SearchOptions | undefined): unknown {
  if (!s) return undefined;
  const out: Record<string, unknown> = {};
  assignSnakeCase(out, s as unknown as Record<string, unknown>);
  return out;
}

// ---------------------------------------------------------------------------
// Encode / Decode / SVG — all async (auto-init)
// ---------------------------------------------------------------------------

function assertReady(): void {
  if (!wasmReady) {
    throw new Error(
      "arthash: wasm not initialized — `await init()` first, or use the " +
        "async `encode()` / `decode()` which auto-initialize.",
    );
  }
}

/** Encode RGB bytes into a placeholder hash. */
export async function encode(
  rgb: Uint8Array,
  width: number,
  height: number,
  c: Codec,
  opts: EncodeOptions = {},
): Promise<Uint8Array> {
  await ready();
  return wasmEncodeRgb(
    rgb,
    width,
    height,
    codecToFfi(c),
    BigInt(opts.seed ?? 0),
    searchToFfi(opts.search),
  );
}

/** Synchronous encode — requires `await init()` to have completed first.
 *  Useful when you want to call from a tight hot loop with a known-ready
 *  wasm module. */
export function encodeSync(
  rgb: Uint8Array,
  width: number,
  height: number,
  c: Codec,
  opts: EncodeOptions = {},
): Uint8Array {
  assertReady();
  return wasmEncodeRgb(
    rgb,
    width,
    height,
    codecToFfi(c),
    BigInt(opts.seed ?? 0),
    searchToFfi(opts.search),
  );
}

/** Encode RGBA bytes. Shape codecs composite the alpha over white internally. */
export async function encodeRgba(
  rgba: Uint8Array,
  width: number,
  height: number,
  c: Codec,
  opts: EncodeOptions = {},
): Promise<Uint8Array> {
  await ready();
  return wasmEncodeRgba(
    rgba,
    width,
    height,
    codecToFfi(c),
    BigInt(opts.seed ?? 0),
    searchToFfi(opts.search),
  );
}

/** Coalesce deprecated `opts.blur` with `opts.style?.blur` (style wins).
 *  Optionally `console.warn` in dev when the deprecated path is used —
 *  silenced when both are set or when only `style.blur` is present. */
function resolveSvgBlur(opts: SvgRenderOptions): number {
  const styleBlur = opts.style?.blur;
  if (styleBlur != null && styleBlur > 0) return styleBlur;
  const legacy = opts.blur;
  if (legacy != null && legacy > 0) {
    // Once-per-session dev warning. Production bundlers strip this branch
    // when DEV is constant-false; otherwise the runtime check is one extra
    // property read.
    devWarnBlurDeprecation();
    return legacy;
  }
  return 0;
}

let _blurDeprecationWarned = false;
function devWarnBlurDeprecation(): void {
  if (_blurDeprecationWarned) return;
  _blurDeprecationWarned = true;
  if (typeof console !== "undefined" && console.warn) {
    console.warn(
      "[arthash] toSvg opts.blur is deprecated since 0.3.0 — use opts.style.blur instead. Removed in 1.0.",
    );
  }
}

/** Decode a placeholder hash to RGBA pixels. The codec generic `C` lets the
 *  type system enforce that `cornerRadius` is only set on rect-family
 *  codecs (rect / square / rotrect) — TypeScript errors at the call site
 *  rather than at runtime. */
export async function decode<C extends Codec>(
  hash: Uint8Array,
  c: C,
  opts: Omit<DecodeOptions, "style"> & { style?: RenderStyle<C> } = {},
): Promise<DecodeResult> {
  await ready();
  return decodeSync(hash, c, opts);
}

/** Synchronous decode — requires `await init()` to have completed first. */
export function decodeSync<C extends Codec>(
  hash: Uint8Array,
  c: C,
  opts: Omit<DecodeOptions, "style"> & { style?: RenderStyle<C> } = {},
): DecodeResult {
  assertReady();
  const style = opts.style as RenderStyle | undefined;
  const r = wasmDecode(
    hash,
    codecToFfi(c),
    opts.baseSize ?? 256,
    opts.overrideAspect,
    opts.aa,
    opts.pixelSmooth,
    (style as { cornerRadius?: number } | undefined)?.cornerRadius,
    style?.blur,
    opts.dither,
    opts.ditherScale,
  );
  // Read w/h first, then `intoRgba()` moves the buffer out AND frees the
  // wasm-side result (no separate `free()`, no clone of the RGBA bytes).
  const w = r.w;
  const h = r.h;
  const out: DecodeResult = { w, h, rgba: r.intoRgba() };
  return out;
}

/** Render a shape-mode hash as a compact SVG string. */
export async function toSvg<C extends Codec>(
  hash: Uint8Array,
  c: C,
  opts: Omit<SvgRenderOptions, "style"> & { style?: RenderStyle<C> } = {},
): Promise<string> {
  await ready();
  return toSvgSync(hash, c, opts);
}

/** Synchronous SVG render — requires `await init()` first. */
export function toSvgSync<C extends Codec>(
  hash: Uint8Array,
  c: C,
  opts: Omit<SvgRenderOptions, "style"> & { style?: RenderStyle<C> } = {},
): string {
  assertReady();
  const blur = resolveSvgBlur(opts as SvgRenderOptions);
  const cornerRadius = (opts.style as { cornerRadius?: number } | undefined)
    ?.cornerRadius;
  return wasmToSvg(
    hash,
    codecToFfi(c),
    opts.baseSize ?? 256,
    opts.overrideAspect,
    blur,
    cornerRadius,
  );
}

// ---------------------------------------------------------------------------
// Raster output helpers (browser-only)
// ---------------------------------------------------------------------------

const NODE_RASTER_HINT =
  " is browser-only (needs ImageData / createImageBitmap). In Node, call decode() and use sharp / @napi-rs/canvas / jimp to build the bitmap yourself.";

/** Decode a hash and return an `ImageData` ready for `ctx.putImageData`.
 *  Browser-only — in Node, use `decode()` + your image library directly. */
export async function toImageData<C extends Codec>(
  hash: Uint8Array,
  c: C,
  opts: Omit<DecodeOptions, "style"> & { style?: RenderStyle<C> } = {},
): Promise<ImageData> {
  if (typeof ImageData === "undefined") {
    throw new Error("arthash.toImageData" + NODE_RASTER_HINT);
  }
  const { w, h, rgba } = await decode(hash, c, opts);
  // ImageData expects a Uint8ClampedArray view. We copy because the wasm
  // buffer may be transferable from a worker context; a fresh allocation
  // detaches ownership from the wasm memory.
  return new ImageData(new Uint8ClampedArray(rgba), w, h);
}

/** Decode a hash and return an `ImageBitmap` suitable for GPU upload (canvas
 *  drawImage, WebGL texSubImage, worker transferList). Browser-only. */
export async function toImageBitmap<C extends Codec>(
  hash: Uint8Array,
  c: C,
  opts: Omit<DecodeOptions, "style"> & { style?: RenderStyle<C> } = {},
): Promise<ImageBitmap> {
  if (typeof createImageBitmap === "undefined") {
    throw new Error("arthash.toImageBitmap" + NODE_RASTER_HINT);
  }
  const data = await toImageData(hash, c, opts);
  return createImageBitmap(data);
}

// ---------------------------------------------------------------------------
// Browser convenience: image → hash in one call
// ---------------------------------------------------------------------------

/** Encoder thumbnail long-edge for a codec. */
function thumbTarget(c: Codec): number {
  return c.kind === "dct" ? 100 : 48;
}

/** Browser-only: load an image source (URL string, Blob, HTMLImageElement,
 *  ImageBitmap), resize to the codec's thumbnail target, encode in one call.
 *
 *  **Node users**: this function intentionally has no Node fallback to keep
 *  the npm package canvas-free. Decode the image yourself with `sharp` /
 *  `jimp` / `@napi-rs/canvas`, resize the long edge to `48` (shape modes) or
 *  `≤ 100` (DCT), extract row-major RGB bytes, then call `encode(rgb, w, h,
 *  codec)`. Example with `sharp`:
 *
 *  ```ts
 *  import sharp from "sharp";
 *  import { encode, codec } from "arthash";
 *  const c = codec.triangle({ n: 64 });
 *  const { data, info } = await sharp("photo.jpg")
 *    .resize({ width: 48, height: 48, fit: "inside" })
 *    .removeAlpha().raw().toBuffer({ resolveWithObject: true });
 *  const hash = await encode(new Uint8Array(data), info.width, info.height, c);
 *  ```
 */
export async function encodeImage(
  source: string | Blob | HTMLImageElement | ImageBitmap,
  c: Codec,
  opts: EncodeOptions = {},
): Promise<Uint8Array> {
  await ready();
  const { rgb, w, h } = await imageToThumbRgb(source, thumbTarget(c));
  return encode(rgb, w, h, c, opts);
}

async function imageToThumbRgb(
  source: string | Blob | HTMLImageElement | ImageBitmap,
  target: number,
): Promise<{ rgb: Uint8Array; w: number; h: number }> {
  if (typeof document === "undefined") {
    throw new Error(
      "arthash.encodeImage requires a browser DOM. In Node, decode the " +
        "image yourself and call encode(rgb, w, h, codec).",
    );
  }

  let bitmap: ImageBitmap | undefined;
  let ownsBitmap = false;
  try {
    if (typeof source === "string") {
      const blob = await (await fetch(source)).blob();
      bitmap = await createImageBitmap(blob);
      ownsBitmap = true;
    } else if (source instanceof Blob) {
      bitmap = await createImageBitmap(source);
      ownsBitmap = true;
    } else if ((source as ImageBitmap).width !== undefined && (source as ImageBitmap).close) {
      bitmap = source as ImageBitmap;
    } else {
      bitmap = await createImageBitmap(source as HTMLImageElement);
      ownsBitmap = true;
    }

    const sw = bitmap.width;
    const sh = bitmap.height;
    let w: number, h: number;
    const longest = Math.max(sw, sh);
    if (longest <= target) {
      w = sw;
      h = sh;
    } else if (sw >= sh) {
      w = target;
      h = Math.max(1, Math.round((target * sh) / sw));
    } else {
      h = target;
      w = Math.max(1, Math.round((target * sw) / sh));
    }

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("arthash.encodeImage: 2D canvas context unavailable");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);
    const rgb = new Uint8Array(w * h * 3);
    for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
      rgb[j] = data[i]!;
      rgb[j + 1] = data[i + 1]!;
      rgb[j + 2] = data[i + 2]!;
    }
    return { rgb, w, h };
  } finally {
    if (ownsBitmap) bitmap?.close();
  }
}
