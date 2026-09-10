import { afterEach, describe, expect, it, vi } from "vitest";

// Vitest supports virtual mocks at runtime for this generated WASM module,
// but the installed type declarations only expose the two-argument overload.
vi.mock(
  "../wasm/pkg/arthash_wasm.js",
  () => ({
    default: vi.fn(async () => undefined),
    encodeRgb: vi.fn(() => new Uint8Array([0])),
    encodeRgba: vi.fn(() => new Uint8Array([0])),
    decode: vi.fn(),
    toSvg: vi.fn(),
  }),
  // @ts-expect-error Vitest's runtime supports this virtual mock overload.
  { virtual: true },
);

import { codec, encodeImage } from "../src/index.js";

type FakeBitmap = ImageBitmap & {
  close: ReturnType<typeof vi.fn>;
};

function fakeBitmap(): FakeBitmap {
  return {
    width: 2,
    height: 1,
    close: vi.fn(),
  } as unknown as FakeBitmap;
}

function installCanvas(getImageData: () => { data: Uint8ClampedArray }) {
  const context = {
    imageSmoothingEnabled: false,
    imageSmoothingQuality: "low" as ImageSmoothingQuality,
    drawImage: vi.fn(),
    getImageData: vi.fn(getImageData),
  } as unknown as CanvasRenderingContext2D;
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => context),
  } as unknown as HTMLCanvasElement;

  vi.stubGlobal("document", {
    createElement: vi.fn(() => canvas),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("encodeImage ImageBitmap ownership", () => {
  it.each([
    ["a URL", () => "https://example.test/image.png"],
    ["a Blob", () => new Blob(["image"])],
    ["an HTMLImageElement", () => ({}) as HTMLImageElement],
  ])("closes the ImageBitmap it creates from %s", async (_label, source) => {
    const bitmap = fakeBitmap();
    const createImageBitmap = vi.fn(async () => bitmap);
    vi.stubGlobal("createImageBitmap", createImageBitmap);
    if (typeof source() === "string") {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({ blob: async () => new Blob(["image"]) })),
      );
    }
    installCanvas(() => ({
      data: new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255]),
    }));

    await expect(
      encodeImage(source(), codec.pixel({ n: 4 }), { seed: 1 }),
    ).resolves.toBeInstanceOf(Uint8Array);

    expect(createImageBitmap).toHaveBeenCalledOnce();
    expect(bitmap.close).toHaveBeenCalledOnce();
  });

  it("closes a library-created ImageBitmap when canvas processing throws", async () => {
    const bitmap = fakeBitmap();
    vi.stubGlobal("createImageBitmap", vi.fn(async () => bitmap));
    installCanvas(() => {
      throw new Error("pixel extraction failed");
    });

    await expect(
      encodeImage(new Blob(["image"]), codec.pixel({ n: 4 }), { seed: 1 }),
    ).rejects.toThrow("pixel extraction failed");

    expect(bitmap.close).toHaveBeenCalledOnce();
  });

  it("leaves no library-created ImageBitmaps live after a batch", async () => {
    const batchSize = 100;
    const liveBitmaps = new Set<number>();
    let created = 0;
    let closed = 0;
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => {
        const id = created++;
        liveBitmaps.add(id);
        const bitmap = fakeBitmap();
        bitmap.close = vi.fn(() => {
          closed++;
          liveBitmaps.delete(id);
        });
        return bitmap;
      }),
    );
    installCanvas(() => ({
      data: new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255]),
    }));

    for (let i = 0; i < batchSize; i++) {
      await encodeImage(new Blob(["image"]), codec.pixel({ n: 4 }), {
        seed: 1,
      });
    }

    // This is the deterministic equivalent of watching GPU resources grow:
    // the buggy implementation reports live=100, while the fixed one reports
    // created=100, closed=100, live=0.
    expect({ created, closed, live: liveBitmaps.size }).toEqual({
      created: batchSize,
      closed: batchSize,
      live: 0,
    });
  });

  it("does not close an ImageBitmap supplied by the caller", async () => {
    const bitmap = fakeBitmap();
    const createImageBitmap = vi.fn();
    vi.stubGlobal("createImageBitmap", createImageBitmap);
    installCanvas(() => ({
      data: new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255]),
    }));

    await expect(
      encodeImage(bitmap, codec.pixel({ n: 4 }), { seed: 1 }),
    ).resolves.toBeInstanceOf(Uint8Array);

    expect(createImageBitmap).not.toHaveBeenCalled();
    expect(bitmap.close).not.toHaveBeenCalled();
  });
});
