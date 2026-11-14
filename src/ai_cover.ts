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

/** Where a device stands on the floor plan, in millimetres, and the way it faces, in degrees clockwise from the +y axis of the plan: the geometry the observation service uses to tell where a radar track falls in a camera's picture. */
export type PlanPose = { x_mm: number; y_mm: number; yaw_deg: number };
type Sized = { id?: unknown; x?: unknown; y?: unknown; node?: unknown; heading?: unknown; fov?: unknown; range?: unknown; mirror?: unknown };

function planSize(site: Record<string, unknown>): { width: number; depth: number } | undefined {
  const dimensions = (typeof site.dimensions === "object" && site.dimensions !== null ? site.dimensions : {}) as { width?: unknown; depth?: unknown };
  const width = numeric(dimensions.width), depth = numeric(dimensions.depth);
  return width !== undefined && depth !== undefined && width > 0 && depth > 0 ? { width, depth } : undefined;
}

function poseOf(item: Sized, size: { width: number; depth: number }): PlanPose | undefined {
  const x = numeric(item.x), y = numeric(item.y), heading = numeric(item.heading);
  // The way it faces is needed: a guess would put every track on the wrong side of the picture, so a device that does not say it has no pose.
  if (x === undefined || y === undefined || heading === undefined) return undefined;
  return { x_mm: Math.round(x / 100 * size.width * 1000), y_mm: Math.round(y / 100 * size.depth * 1000), yaw_deg: heading };
}

/** The pose, the field of view (degrees) and the reach (millimetres) of a camera from the design; each part is absent when the design does not give it. */
export function cameraGeometry(site: Record<string, unknown> | null, cameraId: string): { pose?: PlanPose; fov_deg?: number; range_mm?: number } {
  if (!site) return {};
  const size = planSize(site);
  const camera = (Array.isArray(site.cameras) ? site.cameras as Sized[] : []).find(item => item.id === cameraId);
  if (!size || !camera) return {};
  const pose = poseOf(camera, size), fov = numeric(camera.fov), range = numeric(camera.range);
  return { ...(pose ? { pose } : {}), ...(fov !== undefined && fov >= 20 && fov <= 180 ? { fov_deg: fov } : {}), ...(range !== undefined && range > 0 ? { range_mm: Math.round(range * 1000) } : {}) };
}

/** The pose of the radar of a node, and whether its sideways axis is mirrored; undefined when the design places no radar for the node or places several of them (it could not say which one a track belongs to). */
export function nodeGeometry(site: Record<string, unknown> | null, nodeId: string): { pose: PlanPose; mirror: boolean } | undefined {
  if (!site) return undefined;
  const size = planSize(site);
  const sensors = (Array.isArray(site.sensors) ? site.sensors as Sized[] : []).filter(item => item.node === nodeId);
  if (!size || sensors.length !== 1) return undefined;
  const pose = poseOf(sensors[0]!, size);
  return pose ? { pose, mirror: sensors[0]!.mirror === true } : undefined;
}

/** The tracks a radar counts, as the observation service reads them (x to the right of the radar, y ahead of it, millimetres); at most 16. */
export function trackPoints(targets: ReadonlyArray<{ x_mm: number; y_mm: number; counted?: boolean }>, mirror: boolean): Array<{ x_mm: number; y_mm: number }> {
  return targets.filter(target => target.counted !== false && Number.isFinite(target.x_mm) && Number.isFinite(target.y_mm)).slice(0, 16)
    .map(target => ({ x_mm: Math.round(mirror ? -target.x_mm : target.x_mm), y_mm: Math.round(target.y_mm) }));
}
