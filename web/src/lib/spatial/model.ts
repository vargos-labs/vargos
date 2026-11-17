import type { MethodInfo } from "@vargos/core/types";

/** Renderer-independent view objects. Backend schemas remain owned by the bus. */
export type Family = "continuity" | "work" | "knowledge" | "connection";
export type SurfaceTemplate =
  | "thread"
  | "trace"
  | "document"
  | "instrument"
  | "schedule"
  | "blueprint"
  | "inspector";
export type SurfaceMode = "inspect" | "edit" | "history";
export type ResourceStatus = {
  label: string;
  tone: "neutral" | "active" | "attention";
} & (
  | {
      dimension: "connection";
      value:
        "connected" | "connecting" | "disconnected" | "disabled" | "unknown";
    }
  | {
      dimension: "execution";
      value:
        "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled";
    }
  | { dimension: "persistence"; value: "draft" | "saving" | "saved" | "failed" }
  | { dimension: "session"; value: "running" | "idle" | "unknown" }
  | {
      dimension: "availability";
      value: "available" | "unavailable" | "unknown";
    }
  | { dimension: "runtime"; value: "loaded" | "unloaded" | "unknown" }
);
export type ResourceAction = {
  id: string;
  label: string;
  disabledReason?: string;
} & (
  | { command: "navigate"; resourceId: string; mode?: SurfaceMode }
  // An adapter supplies canonical params and transport; the renderer does not invent them.
  | { command: "method"; method: string; params?: Record<string, unknown>; confirmation?: string }
);
export interface SpatialResource {
  id: string;
  /** Open identifier: new services can use the default inspector without a core union change. */
  kind: string;
  title: string;
  summary: string;
  status: ResourceStatus;
  actions: readonly ResourceAction[];
}
export interface ResourceDefinition {
  group:
    | "conversations"
    | "work"
    | "knowledge"
    | "connections"
    | "runtime"
    | "intelligence"
    | "automation"
    | "abilities"
    | "blueprints";
  family: Family;
  label: string;
  template: SurfaceTemplate;
}
export interface SceneNode {
  id: string;
  resourceId: string;
  position: { x: number; y: number };
  representation: "word" | "instrument" | "preview";
}
export interface Relationship {
  from: string;
  to: string;
  label: string;
  inverseLabel: string;
}
export interface SurfaceTarget {
  resourceId: string;
  mode: SurfaceMode;
}
export interface NavigationFrame extends SurfaceTarget {
  scrollTop: number;
}

/** Presentation defaults, not a second method registry or a global navigation menu. */
export const definitions = {
  gateway: {
    group: "runtime",
    family: "connection",
    label: "GATEWAY",
    template: "instrument",
  },
  "tool-definition": {
    group: "abilities",
    family: "work",
    label: "TOOL",
    template: "inspector",
  },
  "memory-index": {
    group: "knowledge",
    family: "knowledge",
    label: "MEMORY INDEX",
    template: "instrument",
  },
  session: {
    group: "conversations",
    family: "continuity",
    label: "CONVERSATION",
    template: "thread",
  },
  task: { group: "work", family: "work", label: "WORK", template: "trace" },
  "tool-call": {
    group: "work",
    family: "work",
    label: "TOOL CALL",
    template: "trace",
  },
  memory: {
    group: "knowledge",
    family: "knowledge",
    label: "KNOWLEDGE",
    template: "document",
  },
  channel: {
    group: "connections",
    family: "connection",
    label: "CHANNEL",
    template: "instrument",
  },
  "mcp-server": {
    group: "abilities",
    family: "connection",
    label: "MCP SERVER",
    template: "instrument",
  },
  service: {
    group: "runtime",
    family: "connection",
    label: "SERVICE",
    template: "instrument",
  },
  provider: {
    group: "intelligence",
    family: "connection",
    label: "PROVIDER",
    template: "instrument",
  },
  model: {
    group: "intelligence",
    family: "connection",
    label: "MODEL",
    template: "instrument",
  },
  schedule: {
    group: "automation",
    family: "work",
    label: "AUTOMATION",
    template: "schedule",
  },
  skill: {
    group: "abilities",
    family: "knowledge",
    label: "SKILL",
    template: "document",
  },
  "agent-profile": {
    group: "intelligence",
    family: "knowledge",
    label: "AGENT PROFILE",
    template: "document",
  },
  template: {
    group: "blueprints",
    family: "knowledge",
    label: "BLUEPRINT",
    template: "blueprint",
  },
  voice: {
    group: "conversations",
    family: "continuity",
    label: "VOICE",
    template: "instrument",
  },
  context: {
    group: "conversations",
    family: "continuity",
    label: "CONTEXT",
    template: "instrument",
  },
} as const satisfies Record<string, ResourceDefinition>;
const fallback: ResourceDefinition = {
  group: "runtime",
  family: "connection",
  label: "RESOURCE",
  template: "inspector",
};
export function definitionFor(kind: string): ResourceDefinition {
  return Object.hasOwn(definitions, kind)
    ? definitions[kind as keyof typeof definitions]
    : fallback;
}
export function relatedResources(
  id: string,
  relationships: readonly Relationship[],
) {
  return relationships.flatMap((link) =>
    link.from === id
      ? [{ resourceId: link.to, label: link.label }]
      : link.to === id
        ? [{ resourceId: link.from, label: link.inverseLabel }]
        : [],
  );
}

/** Availability is a projection, never authorization. The server remains authoritative. */
export function availableActions(
  actions: readonly ResourceAction[],
  methods: readonly Pick<MethodInfo, "name">[],
  permittedMethods: ReadonlySet<string>,
): readonly ResourceAction[] {
  const registered = new Set(methods.map((method) => method.name));
  return actions.map((action) => {
    if (action.command !== "method" || action.disabledReason) return action;
    const disabledReason = !registered.has(action.method)
      ? "Method is not registered"
      : !permittedMethods.has(action.method)
        ? "Not available through this web connection"
        : undefined;
    return { ...action, disabledReason };
  });
}
