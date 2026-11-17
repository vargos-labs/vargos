"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { flushSync } from "react-dom";
import {
  Mic,
  MicOff,
  Pause,
  Play,
  PhoneOff,
  ArrowLeft,
  X,
  Radio,
  Pin,
  Search,
  LocateFixed,
  GripHorizontal,
  Columns2,
  Maximize2,
  Minimize2,
  CircleGauge,
  Sparkles,
  Ellipsis,
  Check,
  TriangleAlert,
} from "lucide-react";
import type { WorkspaceCommand } from "@vargos/lib/voice";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { SpatialReactor } from "@/components/spatial/reactor";
import { useVoiceConversation } from "@/lib/use-voice-conversation";
import { api } from "@/lib/api";
import type { TranscriptEvent } from "@/lib/types";
import {
  definitionFor,
  definitions,
  relatedResources,
  type SceneNode,
  type Relationship,
  type NavigationFrame,
  type ResourceAction,
} from "@/lib/spatial/model";
import { useSpatialResources, type LiveResource } from "@/lib/spatial/live";
import styles from "./world.module.css";

import { pinchCamera, type Camera, type Point } from "@/lib/spatial/gestures";
type Visit = NavigationFrame & { camera: Camera };
const home: Camera = { x: 0, y: 0, zoom: 1 };
const clusters = [
  {
    id: "conversations",
    title: "Conversations",
    x: 32,
    y: 24,
  },
  {
    id: "work",
    title: "Activity",
    x: 77,
    y: 24,
  },
  { id: "connections", title: "Channels", x: 83, y: 67 },
  { id: "knowledge", title: "Memory", x: 25, y: 75 },
  {
    id: "runtime",
    title: "Runtime",
    x: 12,
    y: 49,
  },
  {
    id: "abilities",
    title: "Connected tools",
    x: 85,
    y: 47,
  },
].map((group) => ({
  ...group,
  kinds: Object.entries(definitions)
    .filter(([, definition]) => definition.group === group.id)
    .map(([kind]) => kind),
}));
function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((block) =>
        block &&
        typeof block === "object" &&
        "text" in block &&
        typeof block.text === "string"
          ? block.text
          : "",
      )
      .filter(Boolean)
      .join("\n");
  return "";
}
function SavedTranscript({ path }: { path: string }) {
  const [events, setEvents] = useState<TranscriptEvent[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [includeTools, setIncludeTools] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError("");
    void api
      .transcript(path)
      .then((data) => {
        if (!disposed) setEvents(data.events);
      })
      .catch(() => {
        if (!disposed) setError("Unable to load this transcript.");
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [path, retry]);
  const messages = events.filter(
    (event) =>
      event.kind === "message" &&
      (includeTools || event.role === "user" || event.role === "assistant") &&
      (!query ||
        textContent(event.content).toLowerCase().includes(query.toLowerCase())),
  );
  return (
    <div className={styles.thread} aria-busy={loading}>
      <div className={styles.threadTools}>
        <input
          aria-label="Find in conversation"
          placeholder="Find in this conversation…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <label>
          <input
            type="checkbox"
            checked={includeTools}
            onChange={(e) => setIncludeTools(e.target.checked)}
          />{" "}
          Tool messages
        </label>
      </div>
      {loading && <p>Reading session…</p>}
      {error && (
        <p role="alert">
          {error}{" "}
          <button onClick={() => setRetry((value) => value + 1)}>Retry</button>
        </p>
      )}
      {!loading && !error && !messages.length && (
        <p>
          {query
            ? "No messages match this search."
            : "No conversation messages yet."}
        </p>
      )}
      {!loading && !error && (
        <small>
          {messages.length} messages{query ? " matching" : ""}
        </small>
      )}
      {!loading &&
        !error &&
        messages.map(
          (event, index) =>
            event.kind === "message" && (
              <article key={index} data-role={event.role}>
                <small>
                  {event.role} ·{" "}
                  {event.at ? new Date(event.at).toLocaleTimeString() : ""}
                </small>
                <p>
                  {textContent(event.content) ||
                    "Tool or structured event · no outward text"}
                </p>
              </article>
            ),
        )}
    </div>
  );
}
function MemorySearch() {
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [hits, setHits] = useState<
    { citation: string; content: string; score: number }[] | null
  >(null);
  async function search() {
    if (!query.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await api.rpc("memory.search", {
        query: query.trim(),
        maxResults: 8,
      });
      if (!result.ok) throw Error(result.error ?? "Search failed");
      setHits((result.result ?? []) as typeof hits);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Search failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <form
        className={styles.search}
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <input
          aria-label="Search memory"
          placeholder="Find a thought, decision, or memory…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button disabled={busy || !query.trim()}>
          {busy ? "Searching…" : "Explore ↗"}
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
      {hits?.length === 0 && <p>No matching memories.</p>}
      {hits?.map((hit, i) => (
        <article className={styles.memory} key={i}>
          <small>{hit.citation}</small>
          <details className={styles.passage}>
            <summary>
              {hit.content.slice(0, 160)}
              {hit.content.length > 160 ? "…" : ""}
              <span>Read passage</span>
            </summary>
            <p>{hit.content}</p>
          </details>
        </article>
      ))}
    </>
  );
}

export default function SpatialWorld() {
  const [neighborhoodPage, setNeighborhoodPage] = useState(0);
  const [panelOrigin, setPanelOrigin] = useState<Point | null>(null);
  const [activityOpen, setActivityOpen] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 641px)");
    const sync = () => setActivityOpen(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  const voice = useVoiceConversation(controlWorkspace);
  const [quiet, setQuiet] = useState(false);
  const [reactorFocused, setReactorFocused] = useState(false);
  const [completion, setCompletion] = useState<{
    id: string;
    label: string;
  } | null>(null);
  const activityStates = useRef(new Map<string, string>());
  useEffect(() => {
    for (const item of voice.activities) {
      if (
        item.state === "completed" &&
        activityStates.current.get(item.id) === "running"
      ) {
        setCompletion({ id: item.id, label: item.label });
      }
    }
    activityStates.current = new Map(
      voice.activities.map((item) => [item.id, item.state]),
    );
    if (!voice.activities.length) setCompletion(null);
  }, [voice.activities]);
  useEffect(() => {
    if (!completion) return;
    const timer = setTimeout(() => setCompletion(null), 4500);
    return () => clearTimeout(timer);
  }, [completion]);
  const live = useSpatialResources();
  const [pinned, setPinned] = useState<string[]>([]);
  const [compareWith, setCompareWith] = useState<string | null>(null);
  const [comparison, setComparison] = useState<
    readonly [string, string] | null
  >(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const panelScroll = useRef(new Map<string, number>());
  const [panelPositions, setPanelPositions] = useState<Record<string, Point>>(
    {},
  );
  const controlTouch = useRef<{ id: number; x: number; y: number } | null>(
    null,
  );
  const panelDrag = useRef<{
    id: string;
    pointer: number;
    x: number;
    y: number;
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const [query, setQuery] = useState("");
  const [operation, setOperation] = useState<
    Record<string, { busy: boolean; message: string; failed?: boolean }>
  >({});
  const [confirmation, setConfirmation] = useState<{
    resource: LiveResource;
    action: ResourceAction;
  } | null>(null);
  const [captionVisible, setCaptionVisible] = useState(false);
  const [layoutReady, setLayoutReady] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [history, setHistory] = useState<Visit[]>([]);
  const [camera, setCamera] = useState<Camera>(home);
  const [gesturing, setGesturing] = useState(false);
  const cameraRef = useRef(camera);
  useEffect(() => {
    cameraRef.current = camera;
  }, [camera]);
  const pointers = useRef(new Map<number, Point>());
  const pinch = useRef<{
    distance: number;
    midpoint: Point;
    camera: Camera;
  } | null>(null);
  const ignoreClickUntil = useRef(0);
  const [wheel, setWheel] = useState<{
    id: string;
    x: number;
    y: number;
  } | null>(null);
  const [time, setTime] = useState("");
  const viewport = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const scrollRestore = useRef(0);
  const drag = useRef<{
    x: number;
    y: number;
    camera: Camera;
    moved: boolean;
  } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const origin = useRef<HTMLElement | null>(null);
  const hold = useRef<ReturnType<typeof setTimeout> | null>(null);
  const held = useRef(false);
  const resourceMap = useMemo(() => {
    const map = new Map<string, LiveResource>(
      live.resources.map((r) => [r.id, r]),
    );
    map.set("find", {
      id: "find",
      kind: "collection",
      title: "Find in workspace",
      summary: "",
      status: {
        dimension: "availability",
        value: "available",
        label: "",
        tone: "neutral",
      },
      actions: [],
    });
    map.set("voice-context", {
      id: "voice-context",
      kind: "context",
      title: "Voice usage",
      summary:
        "Input and output tokens reported for the latest response.",
      status: {
        dimension: "availability",
        value: voice.usage ? "available" : "unknown",
        label: voice.usage ? "Last response" : "No response usage yet",
        tone: "neutral",
      },
      actions: [],
      facts: voice.usage
        ? [
            {
              label: "Input tokens",
              value: voice.usage.inputTokens.toLocaleString(),
            },
            {
              label: "Output tokens",
              value: voice.usage.outputTokens.toLocaleString(),
            },
          ]
        : undefined,
    });
    map.set("voice", {
      id: "voice",
      kind: "voice",
      title: "Voice conversation",
      summary: voice.sessionKey || "Your conversation starts here",
      status: {
        dimension: "session",
        value: voice.active ? "running" : "idle",
        label: voice.status,
        tone: "neutral",
      },
      actions: [],
    });
    for (const item of voice.activities)
      map.set(`activity:${item.id}`, {
        id: `activity:${item.id}`,
        kind:
          item.kind === "tool"
            ? "tool-call"
            : item.kind === "task"
              ? "task"
              : "tool-call",
        title: item.label,
        summary:
          item.kind === "task"
            ? "Delegated agent task"
            : item.kind === "skill"
              ? "Skill usage"
              : "Tool execution",
        status: {
          dimension: "execution",
          value: item.state,
          label:
            item.state === "running" && !voice.active
              ? "Last seen running"
              : item.state,
          tone:
            item.state === "failed"
              ? "attention"
              : item.state === "running"
                ? "active"
                : "neutral",
        },
        actions: [],
      });
    for (const group of clusters) {
      const members = [...map.values()].filter((r) =>
        group.kinds.includes(r.kind),
      );
      map.set(group.id, {
        id: group.id,
        kind: "collection",
        title: group.title,
        summary:
          !live.updatedAt && group.id !== "work"
            ? "Reading live state…"
            : `${members.length} ${group.id === "work" ? (members.length === 1 ? "activity" : "activities") : group.id === "conversations" ? "conversations" : group.id === "connections" ? "channels" : group.id === "runtime" ? "runtime components" : group.id === "knowledge" ? "memory indexes" : "tool connections"}`,
        status: {
          dimension: "availability",
          value: "available",
          label: `${members.length} in this field`,
          tone: "neutral",
        },
        actions: [],
      });
    }
    return map;
  }, [
    live.resources,
    live.updatedAt,
    voice.activities,
    voice.sessionKey,
    voice.status,
    voice.active,
    voice.usage,
  ]);
  const relationships = useMemo(() => {
    const links: Relationship[] = [
      ...live.relationships,
      {
        from: "voice",
        to: "voice-context",
        label: "response usage",
        inverseLabel: "voice conversation",
      },
    ];
    for (const group of clusters)
      for (const r of resourceMap.values())
        if (group.kinds.includes(r.kind))
          links.push({
            from: group.id,
            to: r.id,
            label: "contains",
            inverseLabel: "in collection",
          });
    for (const item of voice.activities) {
      const serviceId = item.method
        ? `service:${item.method.split(".")[0]}`
        : undefined;
      if (serviceId && resourceMap.has(serviceId))
        links.push({
          from: `activity:${item.id}`,
          to: serviceId,
          label: "uses service",
          inverseLabel: "used by",
        });
      links.push({
        from: "voice",
        to: `activity:${item.id}`,
        label: item.kind === "task" ? "delegated" : "used",
        inverseLabel: "from voice conversation",
      });
    }
    return links;
  }, [resourceMap, live.relationships, voice.activities]);
  const selectedResource = selected ? resourceMap.get(selected) : undefined;
  const selectedGroup = clusters.find((c) => c.id === selected);
  const related = selected ? relatedResources(selected, relationships) : [];
  const neighborhood = selectedGroup
    ? [...resourceMap.values()].filter((resource) =>
        selectedGroup.kinds.includes(resource.kind),
      )
    : related.flatMap((link) => {
        const resource = resourceMap.get(link.resourceId);
        return resource && resource.kind !== "collection" ? [resource] : [];
      });
  const nodes: SceneNode[] = selected
    ? neighborhood
        .slice(neighborhoodPage * 8, (neighborhoodPage + 1) * 8)
        .map((resource, index, all) => ({
          id: `node:${resource.id}`,
          resourceId: resource.id,
          representation: "word",
          position: {
            x: 29 + Math.cos((index / all.length) * Math.PI * 2) * 22,
            y: 49 + Math.sin((index / all.length) * Math.PI * 2) * 29,
          },
        }))
    : clusters
        .filter((group) => group.id !== "work")
        .map((group) => ({
          id: `node:${group.id}`,
          resourceId: group.id,
          representation: "word",
          position: { x: group.x, y: group.y },
        }));
  const running = voice.activities.filter(
    (item) => item.state === "running",
  ).length;
  const visibleActivities = voice.activities.filter(
    (item) => item.state === "running" || item.state === "failed",
  );
  const showInstruments =
    voice.active || voice.activities.length > 0 || voice.usage !== null;
  const elapsed = `${Math.floor(voice.seconds / 60)
    .toString()
    .padStart(2, "0")}:${(voice.seconds % 60).toString().padStart(2, "0")}`;
  const displayStatus = voice.paused
    ? "Audio paused"
    : voice.muted && voice.status === "Listening"
      ? "Microphone muted"
      : voice.status;
  function pin(id: string) {
    if (comparison?.includes(id)) setComparison(null);
    setPinned((items) =>
      items.includes(id) ? items.filter((item) => item !== id) : [...items, id],
    );
    setWheel(null);
  }
  async function runAction(
    resource: LiveResource,
    action: ResourceAction,
    confirmed = false,
  ) {
    if (action.disabledReason || resource.stale || operation[resource.id]?.busy)
      return;
    if (action.command === "navigate") {
      open(action.resourceId);
      return;
    }
    if (action.confirmation && !confirmed) {
      setConfirmation({ resource, action });
      setWheel(null);
      return;
    }
    setConfirmation(null);
    setWheel(null);
    setOperation((items) => ({
      ...items,
      [resource.id]: { busy: true, message: `${action.label}…` },
    }));
    try {
      const response = await api.rpc(action.method, action.params ?? {});
      if (!response.ok) throw new Error(response.error || "Request failed");
      setOperation((items) => ({
        ...items,
        [resource.id]: {
          busy: false,
          message: `${action.label} completed.`,
        },
      }));
      live.refresh();
    } catch (error) {
      setOperation((items) => ({
        ...items,
        [resource.id]: {
          busy: false,
          failed: true,
          message:
            error instanceof Error
              ? error.message
              : "Request failed. Inspect state before retrying.",
        },
      }));
    }
  }
  function controlWorkspace(command: WorkspaceCommand) {
    const id = command.target ?? selected;
    if (command.action === "find")
      return {
        selected,
        objects: [...resourceMap.values()]
          .filter((resource) =>
            `${resource.title} ${resource.summary}`
              .toLowerCase()
              .includes((command.query ?? "").toLowerCase()),
          )
          .slice(0, 30)
          .map(({ id, title, kind }) => ({ id, title, kind })),
      };
    if (command.action === "back") {
      back();
      return { status: "applied" };
    }
    if (!id || !resourceMap.has(id))
      return { error: "Find and select an existing object first." };
    if (command.action === "compare") {
      if (!selected || selected === id)
        return {
          error:
            "Open a different object first, then compare with this target.",
        };
      setComparison([selected, id]);
      setPinned((items) => [...new Set([...items, selected, id])]);
    }
    if (command.action === "pin")
      setPinned((items) => [...new Set([...items, id])]);
    if (command.action === "move") {
      if (!command.position) return { error: "Choose left, right or center." };
      const width = Math.min(window.innerWidth * 0.43, 680);
      setPanelPositions((items) => ({
        ...items,
        [id]: {
          x:
            window.innerWidth <= 640
              ? 8
              : command.position === "left"
                ? 24
                : command.position === "right"
                  ? window.innerWidth - width - 24
                  : (window.innerWidth - width) / 2,
          y: Math.min(180, window.innerHeight * 0.2),
        },
      }));
    }
    open(id);
    return { status: "applied", id, title: resourceMap.get(id)?.title };
  }
  function transitionWorkspace(update: () => void) {
    if (
      quiet ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
      !document.startViewTransition
    ) {
      update();
      return;
    }
    const transition = document.startViewTransition(() => flushSync(update));
    void transition.ready.catch(() => {});
  }
  function open(id: string, element?: HTMLElement) {
    transitionWorkspace(() => openResource(id, element));
  }
  function openResource(id: string, element?: HTMLElement) {
    if (!resourceMap.has(id)) return;
    if (element) {
      origin.current = element;
      const rect = element.getBoundingClientRect();
      setPanelOrigin({
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
      });
    } else setPanelOrigin(null);
    setNeighborhoodPage(0);
    if (window.matchMedia("(max-width: 640px)").matches) setActivityOpen(false);
    setExpanded(null);
    if (
      compareWith &&
      id !== compareWith &&
      resourceMap.get(id)?.kind !== "collection"
    ) {
      setComparison([compareWith, id]);
      setPinned((items) => [...new Set([...items, compareWith, id])]);
      setCompareWith(null);
    }
    if (selected && selected !== id && !(selected === "find" && compareWith))
      setHistory((h) => [
        ...h,
        {
          resourceId: selected,
          mode: "inspect",
          scrollTop: surface.current?.scrollTop ?? 0,
          camera,
        },
      ]);
    scrollRestore.current = panelScroll.current.get(id) ?? 0;
    setSelected(id);
    setWheel(null);
  }
  function back() {
    transitionWorkspace(returnToPrevious);
  }
  function returnToPrevious() {
    if (expanded) {
      setExpanded(null);
      return;
    }
    if (compareWith) {
      setSelected(compareWith);
      setCompareWith(null);
      return;
    }
    if (wheel) {
      setWheel(null);
      origin.current?.focus();
      return;
    }
    setNeighborhoodPage(0);
    const previous = history.at(-1);
    setHistory((h) => h.slice(0, -1));
    setSelected(previous?.resourceId ?? null);
    setCamera(previous?.camera ?? home);
    scrollRestore.current = previous?.scrollTop ?? 0;
    if (!previous) origin.current?.focus();
  }
  function reset() {
    setSelected(null);
    setExpanded(null);
    setCompareWith(null);
    setHistory([]);
    setWheel(null);
    setCamera(home);
    origin.current?.focus();
  }
  function showMenu(id: string, x: number, y: number, element: HTMLElement) {
    origin.current = element;
    setWheel({
      id,
      x: Math.max(135, Math.min(innerWidth - 135, x)),
      y: Math.max(145, Math.min(innerHeight - 145, y)),
    });
  }
  useEffect(() => {
    try {
      const saved = JSON.parse(
        localStorage.getItem("vargos:v2:layout") || "null",
      );
      if (saved?.version === 1) {
        if (Array.isArray(saved.pinned))
          setPinned(
            saved.pinned
              .filter((id: unknown) => typeof id === "string")
              .slice(0, 12),
          );
        if (typeof saved.selected === "string") setSelected(saved.selected);
        if (saved.positions && typeof saved.positions === "object")
          setPanelPositions(
            Object.fromEntries(
              Object.entries(saved.positions)
                .filter((entry): entry is [string, Point] => {
                  const point = entry[1] as Point | null;
                  return (
                    !!point &&
                    Number.isFinite(point.x) &&
                    Number.isFinite(point.y)
                  );
                })
                .map(([id, point]) => [
                  id,
                  {
                    x: Math.max(8, Math.min(innerWidth - 320, point.x)),
                    y: Math.max(80, Math.min(innerHeight - 180, point.y)),
                  },
                ]),
            ),
          );
        if (
          saved.camera &&
          [saved.camera.x, saved.camera.y, saved.camera.zoom].every(
            Number.isFinite,
          )
        )
          setCamera({
            x: Math.max(-innerWidth, Math.min(innerWidth, saved.camera.x)),
            y: Math.max(-innerHeight, Math.min(innerHeight, saved.camera.y)),
            zoom: Math.max(0.55, Math.min(1.8, saved.camera.zoom)),
          });
      }
    } catch {
      /* Private browsing or an old snapshot must not block the workspace. */
    }
    setLayoutReady(true);
  }, []);
  useEffect(() => {
    if (!layoutReady) return;
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(
          "vargos:v2:layout",
          JSON.stringify({
            version: 1,
            pinned,
            camera,
            selected,
            positions: panelPositions,
          }),
        );
      } catch {
        /* Storage is optional. */
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [pinned, camera, selected, panelPositions, layoutReady]);
  useEffect(() => {
    if (!voice.messages.length) return;
    setCaptionVisible(true);
    const timer = setTimeout(() => setCaptionVisible(false), 12000);
    return () => clearTimeout(timer);
  }, [voice.messages]);
  useEffect(() => {
    const tick = () =>
      setTime(
        new Date().toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }),
      );
    tick();
    const timer = setInterval(tick, 1000);
    return () => {
      clearInterval(timer);
      if (hold.current) clearTimeout(hold.current);
    };
  }, []);
  useEffect(() => {
    function key(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        open("find");
      }
      if (e.key === "Escape") {
        if (confirmation) setConfirmation(null);
        else back();
      }
    }
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  useEffect(() => {
    if (selected) {
      surface.current
        ?.querySelector<HTMLElement>("h1")
        ?.focus({ preventScroll: true });
      if (surface.current) surface.current.scrollTop = scrollRestore.current;
    }
  }, [selected]);
  useEffect(() => {
    if (wheel)
      menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [wheel]);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    function zoom(e: WheelEvent) {
      if ((e.target as HTMLElement).closest("button")) return;
      e.preventDefault();
      setCamera((c) => ({
        ...c,
        zoom: Math.max(0.55, Math.min(1.8, c.zoom - e.deltaY * 0.001)),
      }));
    }
    element.addEventListener("wheel", zoom, { passive: false });
    return () => element.removeEventListener("wheel", zoom);
  }, []);
  const voiceControls = (
    <div
      className={styles.voiceControls}
      role="group"
      aria-label="Voice controls"
      onPointerDown={(e) => {
        if (e.pointerType === "touch")
          controlTouch.current = {
            id: e.pointerId,
            x: e.clientX,
            y: e.clientY,
          };
      }}
      onPointerCancel={() => {
        controlTouch.current = null;
      }}
      onPointerUp={(e) => {
        const start = controlTouch.current;
        controlTouch.current = null;
        if (
          e.pointerType !== "touch" ||
          start?.id !== e.pointerId ||
          Math.hypot(e.clientX - start.x, e.clientY - start.y) > 12
        )
          return;
        const button = (e.target as HTMLElement).closest("button");
        if (
          !button ||
          !button.contains(document.elementFromPoint(e.clientX, e.clientY))
        )
          return;
        e.preventDefault();
        // Activate on touch release even after captured drags; keep keyboard/native mouse clicks.
        button.click();
      }}
      onClickCapture={(e) => {
        if (
          e.nativeEvent instanceof PointerEvent &&
          e.nativeEvent.pointerType === "touch"
        ) {
          e.preventDefault();
          e.stopPropagation();
        }
      }}
    >
      <button
        disabled={!voice.active}
        onClick={voice.toggleMuted}
        aria-label={voice.muted ? "Unmute microphone" : "Mute microphone"}
        aria-pressed={voice.muted}
      >
        {voice.muted ? <MicOff /> : <Mic />}
        <span>{voice.muted ? "Unmute" : "Mute"}</span>
      </button>
      <button
        disabled={!voice.active}
        onClick={voice.togglePaused}
        aria-label={voice.paused ? "Resume audio" : "Pause audio"}
        title={
          voice.paused
            ? "Resume audio"
            : "Pause audio; background work continues"
        }
        aria-pressed={voice.paused}
      >
        {voice.paused ? <Play /> : <Pause />}
        <span>{voice.paused ? "Resume" : "Pause audio"}</span>
      </button>
      <button
        disabled={!voice.active}
        onClick={voice.stop}
        aria-label="End voice call"
        title="End voice call; background work may continue"
      >
        <PhoneOff />
        <span>Hang up</span>
      </button>
    </div>
  );
  return (
    <main
      className={`${styles.world} ${quiet ? styles.quiet : ""} ${showInstruments ? styles.voiceWorkspace : ""}`}
      data-focused={!!selected}
      data-pinned={pinned.length > 0}
      data-detail={
        camera.zoom < 0.8 ? "overview" : camera.zoom > 1.2 ? "close" : "normal"
      }
      style={{ "--scene-zoom": camera.zoom } as CSSProperties}
    >
      <header className={styles.masthead}>
        <span>
          VARGOS <b>FIELD / 02</b>
        </span>
        <span
          className={styles.linkStatus}
          title={
            live.resources.find((resource) => resource.id === "gateway")?.status
              .label ?? "Connecting"
          }
          aria-label="Gateway connection"
        >
          <i
            data-online={
              !!live.resources.find(
                (r) =>
                  r.id === "gateway" &&
                  !r.stale &&
                  r.status.value === "connected",
              )
            }
          />
        </span>
        <button
          className={styles.utility}
          onClick={() => open("find")}
          aria-label="Find in workspace"
          title="Find in workspace (Ctrl/⌘ K)"
        >
          <Search size={18} />
        </button>
        <button
          className={styles.utility}
          onClick={() => setCamera(home)}
          aria-label="Recenter world"
          title="Recenter world"
        >
          <LocateFixed size={18} />
        </button>
        <button
          className={styles.utility}
          onClick={() => setQuiet((value) => !value)}
          aria-label="Quiet visuals"
          aria-pressed={quiet}
          title="Reduce ambient motion"
        >
          <Sparkles size={18} />
        </button>
        <time>{time || "--:--:--"}</time>
      </header>
      <div
        ref={viewport}
        className={`${styles.viewport} ${selected ? styles.exploring : ""} ${gesturing ? styles.gesturing : ""}`}
        aria-label="Spatial workspace"
        onDoubleClick={(e) => {
          if (!(e.target as HTMLElement).closest("button")) reset();
        }}
        onPointerDown={(e) => {
          if (e.pointerType === "touch") {
            pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (pointers.current.size === 2) {
              const [a, b] = [...pointers.current.values()];
              pinch.current = {
                distance: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
                midpoint: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
                camera: cameraRef.current,
              };
              if (hold.current) clearTimeout(hold.current);
              ignoreClickUntil.current = performance.now() + 400;
              drag.current = null;
              setGesturing(true);
              for (const id of pointers.current.keys())
                e.currentTarget.setPointerCapture(id);
              e.preventDefault();
              return;
            }
          }
          if ((e.target as HTMLElement).closest("button") || e.button !== 0)
            return;
          drag.current = {
            x: e.clientX,
            y: e.clientY,
            camera: cameraRef.current,
            moved: false,
          };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (pointers.current.has(e.pointerId))
            pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
          if (pinch.current && pointers.current.size >= 2) {
            const [a, b] = [...pointers.current.values()];
            const bounds = e.currentTarget.getBoundingClientRect();
            const next = pinchCamera(
              pinch.current.camera,
              pinch.current.midpoint,
              { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
              Math.hypot(b.x - a.x, b.y - a.y) / pinch.current.distance,
              {
                x: bounds.left + bounds.width / 2,
                y: bounds.top + bounds.height / 2,
              },
            );
            cameraRef.current = next;
            setCamera(next);
            e.preventDefault();
            return;
          }
          const d = drag.current;
          if (!d) return;
          const dx = e.clientX - d.x,
            dy = e.clientY - d.y;
          if (Math.abs(dx) + Math.abs(dy) > 5) {
            d.moved = true;
            setGesturing(true);
          }
          if (d.moved) {
            const next = {
              ...d.camera,
              x: d.camera.x + dx,
              y: d.camera.y + dy,
            };
            cameraRef.current = next;
            setCamera(next);
          }
        }}
        onPointerUp={(e) => {
          pointers.current.delete(e.pointerId);
          if (pinch.current) {
            ignoreClickUntil.current = performance.now() + 400;
            pinch.current = null;
            const remaining = [...pointers.current.values()][0];
            drag.current = remaining
              ? { ...remaining, camera: cameraRef.current, moved: true }
              : null;
            setGesturing(!!remaining);
          } else {
            drag.current = null;
            setGesturing(false);
          }
        }}
        onPointerCancel={() => {
          pointers.current.clear();
          pinch.current = null;
          drag.current = null;
          setGesturing(false);
          if (hold.current) clearTimeout(hold.current);
        }}
      >
        <div
          className={styles.space}
          style={{
            transform: `translate(${camera.x}px,${camera.y}px) scale(${camera.zoom})`,
          }}
        >
          <svg
            className={styles.grid}
            viewBox="0 0 1400 900"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <defs>
              <pattern
                id="field-grid"
                width="65"
                height="65"
                patternUnits="userSpaceOnUse"
              >
                <path
                  d="M65 0H0V65"
                  fill="none"
                  stroke="#59caff"
                  strokeOpacity=".045"
                />
              </pattern>
              <radialGradient id="field-fade">
                <stop stopColor="white" />
                <stop offset="1" stopColor="black" />
              </radialGradient>
              <mask id="field-mask">
                <rect width="1400" height="900" fill="url(#field-fade)" />
              </mask>
            </defs>
            <rect
              width="1400"
              height="900"
              fill="url(#field-grid)"
              mask="url(#field-mask)"
            />
            <ellipse
              cx="700"
              cy="550"
              rx="520"
              ry="180"
              fill="none"
              stroke="#83dfff"
              strokeOpacity=".08"
            />
            <ellipse
              cx="700"
              cy="550"
              rx="410"
              ry="140"
              fill="none"
              stroke="#83dfff"
              strokeOpacity=".04"
            />
          </svg>
          <svg
            className={styles.edges}
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            {selected &&
              nodes.map((node) => (
                <path
                  data-active={
                    resourceMap.get(node.resourceId)?.status.dimension ===
                      "execution" &&
                    resourceMap.get(node.resourceId)?.status.value === "running"
                  }
                  key={node.id}
                  d={`M29 49 Q29 ${node.position.y} ${node.position.x} ${node.position.y}`}
                />
              ))}
          </svg>
          {selectedResource && selected !== "voice" && (
            <div className={styles.focusAnchor}>
              <small>
                {selectedGroup
                  ? "FIELD"
                  : definitionFor(selectedResource.kind).label}
              </small>
              <strong>{selectedResource.title}</strong>
              <span>{selectedResource.status.label}</span>
              {neighborhood.length > 8 && (
                <div
                  className={styles.orbitPages}
                  aria-label="Explore related objects"
                >
                  <button
                    disabled={neighborhoodPage === 0}
                    onClick={() => setNeighborhoodPage((page) => page - 1)}
                    aria-label="Previous objects"
                  >
                    ←
                  </button>
                  <span>
                    {neighborhoodPage * 8 + 1}–
                    {Math.min((neighborhoodPage + 1) * 8, neighborhood.length)}{" "}
                    / {neighborhood.length}
                  </span>
                  <button
                    disabled={(neighborhoodPage + 1) * 8 >= neighborhood.length}
                    onClick={() => setNeighborhoodPage((page) => page + 1)}
                    aria-label="Next objects"
                  >
                    →
                  </button>
                </div>
              )}
            </div>
          )}
          {nodes.map((node) => {
            const resource = resourceMap.get(node.resourceId)!;
            const definition = definitionFor(
              clusters.find((c) => c.id === resource.id)?.kinds[0] ??
                resource.kind,
            );
            const cluster = clusters.find((c) => c.id === resource.id);
            const executing =
              voice.active &&
              voice.activities.some(
                (item) =>
                  item.state === "running" &&
                  (resource.id === `activity:${item.id}` ||
                    (item.method &&
                      resource.id === `service:${item.method.split(".")[0]}`) ||
                    (resource.id === "runtime" &&
                      item.method &&
                      resourceMap.has(`service:${item.method.split(".")[0]}`))),
              );
            return (
              <button
                className={`${styles.node} ${styles[definition.family]} ${resource.status.tone === "attention" ? styles.attention : ""}`}
                key={node.id}
                data-state={resource.status.value}
                data-executing={executing}
                style={{
                  left: `${node.position.x}%`,
                  top: `${node.position.y}%`,
                }}
                onClick={(e) => {
                  if (performance.now() < ignoreClickUntil.current) return;
                  if (held.current) {
                    held.current = false;
                    return;
                  }
                  open(resource.id, e.currentTarget);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  showMenu(resource.id, e.clientX, e.clientY, e.currentTarget);
                }}
                onKeyDown={(e) => {
                  if (e.key === "F10" && e.shiftKey) {
                    e.preventDefault();
                    const box = e.currentTarget.getBoundingClientRect();
                    showMenu(
                      resource.id,
                      box.x + box.width / 2,
                      box.y + box.height / 2,
                      e.currentTarget,
                    );
                  }
                }}
                onPointerDown={(e) => {
                  if (e.pointerType !== "touch") return;
                  const element = e.currentTarget;
                  hold.current = setTimeout(() => {
                    held.current = true;
                    showMenu(resource.id, e.clientX, e.clientY, element);
                  }, 550);
                }}
                onPointerUp={() => {
                  if (hold.current) clearTimeout(hold.current);
                }}
                onPointerMove={() => {
                  if (hold.current) clearTimeout(hold.current);
                }}
                onPointerCancel={() => {
                  if (hold.current) clearTimeout(hold.current);
                }}
              >
                <span className={styles.nodeGlyph} aria-hidden="true" />
                <span>
                  {!cluster && <small>{definition.label}</small>}
                  <strong>
                    {resource.title}
                    {executing && (
                      <span className={styles.workingLabel}> · Working</span>
                    )}
                  </strong>
                  <em>
                    {resource.kind === "collection"
                      ? resource.summary
                      : `${selected ? `${related.find((link) => link.resourceId === resource.id)?.label ?? "contains"} · ` : ""}${resource.stale ? "Last known · " : ""}${resource.status.label}`}
                  </em>
                  {!cluster && (
                    <span className={styles.nodePreview}>
                      {resource.summary}
                    </span>
                  )}
                </span>
                <b aria-hidden="true">↗</b>
              </button>
            );
          })}
          <div
            className={`${styles.core} ${selected === "voice" ? styles.voiceScene : ""}`}
          >
            <button
              className={styles.reactorTarget}
              onPointerEnter={() => setReactorFocused(true)}
              onPointerLeave={() => setReactorFocused(false)}
              onFocus={() => setReactorFocused(true)}
              onBlur={() => setReactorFocused(false)}
              aria-label={
                voice.active ? "Open voice conversation" : "Start conversation"
              }
              onClick={(e) => {
                if (performance.now() < ignoreClickUntil.current) return;
                if (voice.active) open("voice", e.currentTarget);
                else voice.start();
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                showMenu("voice", e.clientX, e.clientY, e.currentTarget);
              }}
            >
              <SpatialReactor
                inputLevel={voice.inputLevel}
                outputLevel={voice.outputLevel}
                active={voice.active}
                paused={voice.paused}
                muted={voice.muted}
                status={voice.status}
                focused={reactorFocused || selected === "voice-context"}
                quiet={quiet || !!selected}

              />
            </button>
            {voice.active && (
              <>
                <div className={styles.coreCaption} role="status">
                  <small>{displayStatus}</small>
                  <span>
                    {elapsed}
                    {running
                      ? ` · ${running} running ${running === 1 ? "activity" : "activities"}`
                      : ""}
                  </span>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
      {voice.active && <div className={styles.callAnchor}>{voiceControls}</div>}
      <aside
        className={styles.activityPanel}
        aria-label="Live background activity"
      >
        <details
          className={styles.activityDrawer}
          open={activityOpen}
          onToggle={(event) => setActivityOpen(event.currentTarget.open)}
        >
          <summary>
            <Radio aria-hidden="true" />
            <span>Context &amp; work</span>
            <strong aria-live="polite">
              {running}
              {voice.activities.some((item) => item.state === "failed")
                ? " · !"
                : completion
                  ? " · ✓"
                  : ""}
            </strong>
          </summary>
          <div className={styles.activityList}>
            <button
              className={styles.contextInstrument}
              onClick={() => {
                if (window.matchMedia("(max-width: 640px)").matches)
                  setActivityOpen(false);
                open("voice-context");
              }}
              onPointerEnter={() => setReactorFocused(true)}
              onPointerLeave={() => setReactorFocused(false)}
              onFocus={() => setReactorFocused(true)}
              onBlur={() => setReactorFocused(false)}
              aria-label="Inspect voice token usage"
              title="Provider-reported input and output tokens for the latest response."
            >
              <CircleGauge aria-hidden="true" />
              <span>
                <strong>Voice usage</strong>
                {voice.usage && (
                  <small>
                    Last response · In{" "}
                    {voice.usage.inputTokens.toLocaleString()} · Out{" "}
                    {voice.usage.outputTokens.toLocaleString()} tokens
                  </small>
                )}
              </span>
            </button>
            {visibleActivities.length === 0 && (
              <p className={styles.activityEmpty}>No background work</p>
            )}
            {visibleActivities.map((item) => (
              <button
                key={item.id}
                className={styles.activityChip}
                data-state={
                  item.state === "failed"
                    ? "failed"
                    : voice.active
                      ? "running"
                      : "unknown"
                }
                onClick={() => {
                  if (window.matchMedia("(max-width: 640px)").matches)
                    setActivityOpen(false);
                  open(`activity:${item.id}`);
                }}
                aria-label={`Inspect ${item.label}`}
              >
                {item.state === "failed" ? (
                  <TriangleAlert size={14} aria-hidden="true" />
                ) : (
                  <span className={styles.activityPulse} aria-hidden="true" />
                )}
                <span>
                  <small>
                    {item.state === "failed" ? "Needs attention · " : ""}
                    {item.kind === "task"
                      ? "Delegated task"
                      : item.kind === "skill"
                        ? "Skill"
                        : "Tool"}
                  </small>
                  {item.label}
                </span>
                <span aria-hidden="true">↗</span>
              </button>
            ))}
            {completion && (
              <button
                className={styles.completionNotice}
                onClick={() => {
                  if (window.matchMedia("(max-width: 640px)").matches)
                    setActivityOpen(false);
                  open(`activity:${completion.id}`);
                }}
              >
                <Check size={14} aria-hidden="true" />
                <span>
                  <small>Completed</small>
                  {completion.label}
                </span>
              </button>
            )}
          </div>
        </details>
      </aside>

      {completion && (
        <button
          className={styles.keepResult}
          onClick={() => {
            const id = `activity:${completion.id}`;
            setPinned((items) => [...new Set([...items, id])]);
            open(id);
            setCompletion(null);
          }}
        >
          <Pin size={14} /> Keep completed work
        </button>
      )}
      {!!voice.messages.length && (
        <button
          className={`${styles.captions} ${captionVisible ? styles.captionVisible : ""} ${selected ? styles.compactCaptions : ""}`}
          onClick={() => open("voice")}
          onFocus={() => setCaptionVisible(true)}
          aria-label="Open recent conversation transcript"
          aria-hidden={!captionVisible}
          tabIndex={captionVisible ? 0 : -1}
        >
          {voice.messages.slice(selected ? -1 : -2).map((message, index) => (
            <span key={index}>
              <small>{message.role}</small>
              <span>{message.text}</span>
            </span>
          ))}
        </button>
      )}
      {[...new Set([...pinned, ...(selected ? [selected] : [])])].map(
        (id, panelIndex) => {
          const selectedResource = resourceMap.get(id);
          if (!selectedResource) return null;
          const selectedGroup = clusters.find((group) => group.id === id);
          const related = relatedResources(id, relationships);
          const position = panelPositions[id];
          const foreground = id === selected;
          const comparisonIndex = comparison?.indexOf(id) ?? -1;
          const searchResults =
            id === "find"
              ? [...resourceMap.values()].filter(
                  (resource) =>
                    resource.id !== "find" &&
                    (!compareWith ||
                      (resource.kind !== "collection" &&
                        resource.id !== compareWith)) &&
                    `${resource.title} ${resource.summary}`
                      .toLowerCase()
                      .includes(query.toLowerCase()),
                )
              : [];
          return (
            <section
              key={id}
              className={`${styles.surface} ${styles[definitionFor(selectedResource.kind).family]} ${selectedGroup ? styles.collectionSurface : ""} ${foreground ? styles.foreground : styles.pinnedSurface} ${comparisonIndex >= 0 ? styles.comparisonSurface : ""} ${expanded === id ? styles.expandedSurface : ""}`}
              aria-label={`${selectedResource.title} details`}
              data-template={definitionFor(selectedResource.kind).template}
              data-state={selectedResource.status.value}
              style={
                {
                  "--origin-x": panelOrigin ? `${panelOrigin.x}px` : "50vw",
                  "--origin-y": panelOrigin ? `${panelOrigin.y}px` : "50vh",
                  "--panel-x":
                    comparisonIndex >= 0
                      ? `${comparisonIndex === 0 ? 2 : 51}%`
                      : position
                        ? `${position.x}px`
                        : `${foreground ? 50 : 5 + (panelIndex % 3) * 4}%`,
                  "--panel-y":
                    comparisonIndex >= 0
                      ? "150px"
                      : position
                        ? `${position.y}px`
                        : `${16 + (panelIndex % 3) * 3}%`,
                } as CSSProperties
              }
            >
              <div className={styles.surfaceTop}>
                <button
                  onClick={() => (foreground ? back() : open(id))}
                  aria-label={
                    foreground ? "Return to previous view" : "Focus panel"
                  }
                  title={foreground ? "Back" : "Focus this panel"}
                >
                  <ArrowLeft />
                </button>

                <button
                  className={styles.panelGrip}
                  aria-label={`Move ${selectedResource.title} panel`}
                  title="Drag to move; arrow keys to move without dragging"
                  disabled={expanded === id}
                  onPointerDown={(e) => {
                    if (e.button !== 0) return;
                    setComparison(null);
                    setExpanded(null);
                    e.preventDefault();
                    const rect = e.currentTarget
                      .closest("section")!
                      .getBoundingClientRect();
                    panelDrag.current = {
                      id,
                      pointer: e.pointerId,
                      x: e.clientX,
                      y: e.clientY,
                      left: rect.left,
                      top: rect.top,
                      width: rect.width,
                      height: rect.height,
                    };
                    e.currentTarget.setPointerCapture(e.pointerId);
                  }}
                  onPointerMove={(e) => {
                    const drag = panelDrag.current;
                    if (!drag || drag.id !== id || drag.pointer !== e.pointerId)
                      return;
                    setPanelPositions((items) => ({
                      ...items,
                      [id]: {
                        x: Math.max(
                          8,
                          Math.min(
                            innerWidth - drag.width - 8,
                            drag.left + e.clientX - drag.x,
                          ),
                        ),
                        y: Math.max(
                          80,
                          Math.min(
                            innerHeight - 120,
                            drag.top + e.clientY - drag.y,
                          ),
                        ),
                      },
                    }));
                  }}
                  onPointerUp={(e) => {
                    panelDrag.current = null;
                    if (e.currentTarget.hasPointerCapture(e.pointerId))
                      e.currentTarget.releasePointerCapture(e.pointerId);
                  }}
                  onPointerCancel={() => {
                    panelDrag.current = null;
                  }}
                  onKeyDown={(e) => {
                    if (!e.key.startsWith("Arrow")) return;
                    setComparison(null);
                    e.preventDefault();
                    const rect = e.currentTarget
                      .closest("section")!
                      .getBoundingClientRect();
                    setPanelPositions((items) => ({
                      ...items,
                      [id]: {
                        x: Math.max(
                          8,
                          Math.min(
                            innerWidth - rect.width - 8,
                            rect.left +
                              (e.key === "ArrowRight"
                                ? 24
                                : e.key === "ArrowLeft"
                                  ? -24
                                  : 0),
                          ),
                        ),
                        y: Math.max(
                          80,
                          Math.min(
                            innerHeight - 120,
                            rect.top +
                              (e.key === "ArrowDown"
                                ? 24
                                : e.key === "ArrowUp"
                                  ? -24
                                  : 0),
                          ),
                        ),
                      },
                    }));
                  }}
                >
                  <GripHorizontal />
                  <span className={styles.panelLabel}>
                    {selectedResource.title}
                  </span>
                </button>
                <button
                  aria-label={`Actions for ${selectedResource.title}`}
                  title="Object actions"
                  onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    showMenu(
                      id,
                      rect.left + rect.width / 2,
                      rect.bottom,
                      event.currentTarget,
                    );
                  }}
                >
                  <Ellipsis />
                </button>
                {selectedResource.kind !== "collection" && (
                  <button
                    aria-label="Compare with another object"
                    title="Choose another object to compare"
                    onClick={() => {
                      setPinned((items) => [...new Set([...items, id])]);
                      setCompareWith(id);
                      setQuery("");
                      open("find");
                    }}
                  >
                    <Columns2 />
                  </button>
                )}
                <button
                  aria-label={
                    expanded === id ? "Restore panel size" : "Expand panel"
                  }
                  title={
                    expanded === id ? "Restore size" : "Expand for reading"
                  }
                  aria-pressed={expanded === id}
                  onClick={() => {
                    if (!foreground) open(id);
                    setExpanded(expanded === id ? null : id);
                  }}
                >
                  {expanded === id ? <Minimize2 /> : <Maximize2 />}
                </button>
                <button
                  onClick={() => pin(id)}
                  aria-label={pinned.includes(id) ? "Unpin panel" : "Pin panel"}
                  aria-pressed={pinned.includes(id)}
                  title="Keep this panel open"
                >
                  <Pin />
                </button>
                <button
                  onClick={() => {
                    setPinned((items) => items.filter((item) => item !== id));
                    if (comparison?.includes(id)) setComparison(null);
                    setExpanded(null);
                    if (id === "find" && compareWith) {
                      setSelected(compareWith);
                      setCompareWith(null);
                    } else if (foreground) {
                      setSelected(null);
                      origin.current?.focus();
                    }
                  }}
                  aria-label="Close panel"
                >
                  <X />
                </button>
              </div>
              <div
                ref={foreground ? surface : undefined}
                className={styles.surfaceBody}
                onScroll={(e) =>
                  panelScroll.current.set(id, e.currentTarget.scrollTop)
                }
                key={selectedResource.id}
              >
                {!selectedGroup && (
                  <small className={styles.eyebrow}>
                    {selectedResource.status.label}
                  </small>
                )}
                <h1 tabIndex={-1}>
                  {id === "find" && compareWith
                    ? "Choose a comparison"
                    : selectedResource.title}
                </h1>
                {id === "find" && compareWith && (
                  <p className={styles.comparePrompt}>
                    Beside {resourceMap.get(compareWith)?.title}{" "}
                    <button
                      onClick={() => {
                        setSelected(compareWith);
                        setCompareWith(null);
                      }}
                    >
                      Cancel
                    </button>
                  </p>
                )}
                {!selectedGroup &&
                  definitionFor(selectedResource.kind).template ===
                    "instrument" && (
                    <div
                      className={styles.connectionInstrument}
                      data-tone={selectedResource.status.tone}
                    >
                      <span
                        className={styles.instrumentBeacon}
                        aria-hidden="true"
                      />
                      <div>
                        <small>
                          {selectedResource.status.dimension === "runtime"
                            ? "Registration"
                            : selectedResource.status.dimension}
                        </small>
                        <strong>
                          {selectedResource.stale ? "Last known · " : ""}
                          {selectedResource.status.label}
                        </strong>
                      </div>
                      {selectedResource.actions.some(
                        (action) => !action.disabledReason,
                      ) && (
                        <span>
                          {
                            selectedResource.actions.filter(
                              (action) => !action.disabledReason,
                            ).length
                          }{" "}
                          available actions
                        </span>
                      )}
                    </div>
                  )}
                {selectedResource.stale && (
                  <p role="status">
                    Last known state · source unavailable.{" "}
                    <button onClick={live.refresh}>Retry</button>
                  </p>
                )}
                {!!selectedResource.actions.length && (
                  <div className={styles.resourceActions}>
                    {selectedResource.actions.map((action) => (
                      <button
                        key={action.id}
                        disabled={
                          !!action.disabledReason ||
                          selectedResource.stale ||
                          operation[id]?.busy
                        }
                        title={action.disabledReason}
                        onClick={() => void runAction(selectedResource, action)}
                      >
                        {action.label}
                      </button>
                    ))}
                  </div>
                )}
                {operation[id] && (
                  <p role={operation[id].failed ? "alert" : "status"}>
                    {operation[id].message}
                  </p>
                )}
                {id === "find" && (
                  <>
                    <input
                      className={styles.findInput}
                      aria-label="Find objects"
                      placeholder="Conversation, channel, service…"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                    {!searchResults.length && (
                      <p role="status">
                        No matching objects. Try a channel name or conversation
                        date.
                      </p>
                    )}
                    <div className={styles.related}>
                      {searchResults.map((resource) => (
                        <button
                          key={resource.id}
                          onClick={() => open(resource.id)}
                        >
                          <span>
                            <strong>{resource.title}</strong>
                            <small>
                              {resource.stale
                                ? "Last known state"
                                : resource.status.label}
                            </small>
                          </span>
                          <span>↗</span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
                {selectedResource.id === "voice" ? (
                  <>
                    <div
                      className={styles.thread}
                      role="log"
                      aria-label="Conversation transcript"
                    >
                      {!voice.messages.length && (
                        <p>
                          Your words, spoken replies and agent progress appear
                          here.
                        </p>
                      )}
                      {voice.messages.map((message, index) => (
                        <article key={index} data-role={message.role}>
                          <small>
                            {message.role === "Progress"
                              ? "AGENT PROGRESS"
                              : message.role}
                          </small>
                          <p>{message.text}</p>
                        </article>
                      ))}
                    </div>
                  </>
                ) : !selectedGroup ? (
                  <p>{selectedResource.summary}</p>
                ) : null}
                {id === "voice-context" && (
                  <div className={styles.contextExplanation}>
                    <p>
                      {voice.usage
                        ? "These are the input and output tokens reported for the latest response. They are not the current context size or a running total."
                        : voice.active
                          ? "Usage will appear when the voice backend reports it after a response."
                          : "Start a voice conversation to receive response usage."}
                    </p>
                    <p>History retention and compaction use the speech backend’s defaults.</p>
                  </div>
                )}
                {selectedResource.facts && (
                  <details
                    className={styles.metadata}
                    open={selectedResource.kind !== "session"}
                  >
                    <summary>
                      {selectedResource.kind === "session"
                        ? "Session information"
                        : id === "voice-context"
                          ? "Reported token usage"
                          : "Connection and details"}
                    </summary>
                    <dl className={styles.facts}>
                      {selectedResource.facts.map((fact) => (
                        <div key={fact.label}>
                          <dt>{fact.label}</dt>
                          <dd>{fact.value}</dd>
                        </div>
                      ))}
                    </dl>
                  </details>
                )}
                {selectedResource.transcriptPath && (
                  <SavedTranscript path={selectedResource.transcriptPath} />
                )}
                {(selectedResource.kind === "memory-index" ||
                  selectedResource.id === "knowledge") && <MemorySearch />}
                {selectedResource.id.startsWith("activity:") && (
                  <div className={styles.execution}>
                    <ol
                      className={styles.executionSteps}
                      aria-label="Execution state"
                    >
                      <li data-reached="true">Started</li>
                      <li
                        data-reached={
                          selectedResource.status.value === "running"
                        }
                      >
                        {voice.active ? "Running" : "Last observed"}
                      </li>
                      <li
                        data-reached={
                          selectedResource.status.value === "completed" ||
                          selectedResource.status.value === "failed"
                        }
                      >
                        {selectedResource.status.value === "failed"
                          ? "Failed"
                          : "Completed"}
                      </li>
                    </ol>
                    <span>{selectedResource.status.label}</span>
                    <p>
                      {selectedResource.status.value === "running"
                        ? voice.active
                          ? "Work is in progress. Stopping speech does not cancel this work."
                          : "The call ended while this work was running. Its current state is unknown."
                        : selectedResource.status.value === "failed"
                          ? "The operation reported a failure. Open its conversation for the available explanation."
                          : "The operation reported completion. Open its conversation for the available response."}
                    </p>
                  </div>
                )}
                {!!related.length && (
                  <div
                    className={`${styles.related} ${selectedGroup ? styles.collectionList : ""}`}
                  >
                    {!selectedGroup && <small>Related</small>}
                    {related.map((link, index) => {
                      const target = resourceMap.get(link.resourceId);
                      return (
                        target && (
                          <button
                            className={
                              styles[definitionFor(target.kind).family]
                            }
                            data-tone={target.status.tone}
                            key={`${link.resourceId}:${index}`}
                            onClick={() => open(target.id)}
                          >
                            {selectedGroup && (
                              <i
                                className={styles.nodeGlyph}
                                aria-hidden="true"
                              />
                            )}
                            <span>
                              <strong>{target.title}</strong>
                              <small>
                                {selectedGroup
                                  ? `${target.stale ? "Last known · " : ""}${target.status.label}`
                                  : `${link.label} · ${target.status.label}`}
                              </small>
                            </span>
                            <span>↗</span>
                          </button>
                        )
                      );
                    })}
                  </div>
                )}
                {selectedGroup && !related.length && (
                  <p className={styles.empty}>
                    Nothing here yet.{" "}
                    {selectedGroup.id === "work"
                      ? "Ask Vargos to use a tool or investigate something; activity will appear as it happens."
                      : "Connected resources appear here when available."}
                  </p>
                )}
                {selectedResource.kind === "service" && (
                  <p className={styles.empty}>
                    Loaded state reports registration in the runtime. It does
                    not measure service health.
                  </p>
                )}
              </div>
            </section>
          );
        },
      )}
      {!!pinned.length && (
        <nav className={styles.pins} aria-label="Pinned panels">
          {comparison && (
            <button
              onClick={() => setComparison(null)}
              aria-label="End comparison"
            >
              End comparison
            </button>
          )}
          {pinned.map((id) => (
            <button
              key={id}
              onClick={() =>
                resourceMap.has(id)
                  ? open(id)
                  : setPinned((items) => items.filter((item) => item !== id))
              }
              aria-pressed={selected === id}
            >
              {resourceMap.get(id)?.title ?? "Unavailable panel · remove"}
            </button>
          ))}
        </nav>
      )}
      {confirmation && (
        <Dialog open onOpenChange={(open) => { if (!open) setConfirmation(null); }}>
          <DialogContent
            className={styles.confirmation}
            title={confirmation.resource.title}
            description={confirmation.action.command === "method" ? confirmation.action.confirmation : undefined}
          >
            <button autoFocus onClick={() => setConfirmation(null)}>
              Cancel
            </button>
            <button
              onClick={() =>
                void runAction(confirmation.resource, confirmation.action, true)
              }
            >
              {confirmation.action.label}
            </button>
          </DialogContent>
        </Dialog>
      )}
      {(voice.error || live.error) && (
        <div className={styles.alert} role="alert">
          {voice.error || live.error}
          {live.error && <button onClick={live.refresh}>Retry sources</button>}
        </div>
      )}
      {wheel && (
        <div
          className={styles.menuBackdrop}
          onClick={() => {
            setWheel(null);
            origin.current?.focus();
          }}
        >
          <div
            ref={menuRef}
            className={styles.wheel}
            role="dialog"
            aria-modal="true"
            aria-label="Resource actions"
            style={{ left: wheel.x, top: wheel.y }}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              const buttons = Array.from(
                e.currentTarget.querySelectorAll("button"),
              );
              const directions: Record<string, number> = {
                ArrowUp: 0,
                ArrowRight: 1,
                ArrowDown: 2,
                ArrowLeft: 3,
              };
              if (e.key in directions) {
                e.preventDefault();
                buttons[directions[e.key]]?.focus();
              }
              if (e.key === "Tab") {
                e.preventDefault();
                const index = buttons.indexOf(
                  document.activeElement as HTMLButtonElement,
                );
                buttons[(index + (e.shiftKey ? 3 : 1)) % 4]?.focus();
              }
            }}
          >
            <span>{resourceMap.get(wheel.id)?.title}</span>
            <button onClick={() => open(wheel.id)}>Open ↑</button>
            <button onClick={() => pin(wheel.id)}>
              {pinned.includes(wheel.id) ? "Unpin" : "Keep open"} →
            </button>
            <button
              onClick={() => {
                setWheel(null);
                origin.current?.focus();
              }}
            >
              Dismiss ↓
            </button>
            <button
              onClick={() => {
                const resource = resourceMap.get(wheel.id);
                const action = resource?.actions[0];
                if (resource && action) {
                  open(resource.id);
                  void runAction(resource, action);
                } else {
                  setCamera(home);
                  setWheel(null);
                }
              }}
              disabled={
                !!resourceMap.get(wheel.id)?.actions[0]?.disabledReason ||
                resourceMap.get(wheel.id)?.stale
              }
            >
              ← {resourceMap.get(wheel.id)?.actions[0]?.label ?? "Recenter"}
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
