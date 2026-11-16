import { describe, expect, it } from "vitest";
import { pinchCamera } from "../gestures";

describe("spatial pinch camera", () => {
  it("keeps the world point under the fingers while zooming and moving", () => {
    const start = { x: 20, y: -10, zoom: 1 };
    const initial = { x: 140, y: 200 },
      current = { x: 170, y: 240 },
      center = { x: 200, y: 400 };
    const next = pinchCamera(start, initial, current, 1.5, center);
    const world = {
      x: (initial.x - center.x - start.x) / start.zoom,
      y: (initial.y - center.y - start.y) / start.zoom,
    };
    expect(center.x + next.x + world.x * next.zoom).toBeCloseTo(current.x);
    expect(center.y + next.y + world.y * next.zoom).toBeCloseTo(current.y);
  });
  it("bounds zoom while preserving the focal point at either limit", () => {
    const center = { x: 200, y: 400 };
    expect(
      pinchCamera({ x: 0, y: 0, zoom: 1 }, center, center, 20, center),
    ).toEqual({ x: 0, y: 0, zoom: 1.8 });
    expect(
      pinchCamera({ x: 0, y: 0, zoom: 1 }, center, center, 0.01, center),
    ).toEqual({ x: 0, y: 0, zoom: 0.55 });
  });
});
