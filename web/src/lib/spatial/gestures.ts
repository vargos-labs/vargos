export type Point = { x: number; y: number };
export type Camera = Point & { zoom: number };
export function pinchCamera(
  start: Camera,
  initial: Point,
  current: Point,
  scale: number,
  center: Point,
): Camera {
  const zoom = Math.max(0.55, Math.min(1.8, start.zoom * scale));
  const ratio = zoom / start.zoom;
  return {
    zoom,
    x: current.x - center.x - (initial.x - center.x - start.x) * ratio,
    y: current.y - center.y - (initial.y - center.y - start.y) * ratio,
  };
}
