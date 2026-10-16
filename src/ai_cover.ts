/**
 * Which radar nodes watch what a camera sees, from the site design: a camera and a radar are placed on the plan (as a percentage of its width and depth), so a radar that stands
 * within a camera's reach (its range plus what the radar itself reaches) covers it. The observation service weighs the movement of a camera against these nodes only, and not against the
 * targets of every radar of the house: a person at the other end of the house must not turn a branch moving in front of one camera into a high alert.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
const CAMERA_REACH_M = 12;   // the default reach of a camera's view in the design
const RADAR_REACH_M = 6;     // what a radar sees (HLK-LD2450: 6 m)

type Placed = { id?: unknown; x?: unknown; y?: unknown; node?: unknown; range?: unknown };
const numeric = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/** The ids of the nodes whose radars cover the camera, or undefined when the design cannot say (no such camera, no radar tied to a node): then every node counts, as before. */
export function coveringNodes(site: Record<string, unknown> | null, cameraId: string): string[] | undefined {
  if (!site) return undefined;
  const cameras = Array.isArray(site.cameras) ? site.cameras as Placed[] : [];
  const sensors = Array.isArray(site.sensors) ? site.sensors as Placed[] : [];
  const camera = cameras.find(item => item.id === cameraId);
  const dimensions = (typeof site.dimensions === "object" && site.dimensions !== null ? site.dimensions : {}) as { width?: unknown; depth?: unknown };
  const width = numeric(dimensions.width), depth = numeric(dimensions.depth);
  const cx = numeric(camera?.x), cy = numeric(camera?.y);
  if (!camera || width === undefined || depth === undefined || cx === undefined || cy === undefined) return undefined;
  const reach = (numeric(camera.range) ?? CAMERA_REACH_M) + RADAR_REACH_M;
  const nodes = new Set<string>();
  for (const sensor of sensors) {
    const sx = numeric(sensor.x), sy = numeric(sensor.y);
    if (typeof sensor.node !== "string" || !sensor.node || sx === undefined || sy === undefined) continue;
    if (Math.hypot((cx - sx) / 100 * width, (cy - sy) / 100 * depth) <= reach) nodes.add(sensor.node);
  }
  return nodes.size > 0 ? [...nodes] : undefined;
}
