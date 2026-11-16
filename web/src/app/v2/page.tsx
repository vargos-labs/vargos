"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  Mic,
  MicOff,
  Pause,
  Play,
  Square,
  PhoneOff,
  ArrowLeft,
  X,
  Radio,
} from "lucide-react";
import { SpatialReactor } from "@/components/spatial/reactor";
import { useVoiceConversation } from "@/lib/use-voice-conversation";
import { api } from "@/lib/api";
import type { TranscriptEvent } from "@/lib/types";
import {
  definitionFor,
  relatedResources,
  type SceneNode,
  type Relationship,
  type NavigationFrame,
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
    kinds: ["session"],
    x: 22,
    y: 24,
  },
  {
    id: "work",
    title: "Agent work",
    kinds: ["task", "tool-call", "skill"],
    x: 77,
    y: 24,
  },
  { id: "connections", title: "Channels", kinds: ["channel"], x: 83, y: 67 },
  { id: "knowledge", title: "Memory", kinds: ["memory-index"], x: 25, y: 75 },
  {
    id: "runtime",
    title: "Runtime",
    kinds: ["service", "gateway"],
    x: 12,
    y: 49,
  },
  {
    id: "abilities",
    title: "Connected tools",
    kinds: ["mcp-server"],
    x: 85,
    y: 47,
  },
];
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
  }, [path]);
  return (
    <div className={styles.thread}>
      {loading && <p>Reading session…</p>}
      {error && <p role="alert">{error}</p>}
      {events
        .filter((e) => e.kind === "message")
        .slice(-100)
        .map(
          (event, index) =>
            event.kind === "message" && (
              <article key={index}>
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
          <small>
            {hit.citation} · relevance {hit.score.toFixed(2)}
          </small>
          <p>{hit.content}</p>
        </article>
      ))}
    </>
  );
}

export default function SpatialWorld() {
  const voice = useVoiceConversation();
  const live = useSpatialResources();
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
              : "skill",
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
            : `${members.length} ${group.id === "work" ? (members.length === 1 ? "activity" : "activities") : members.length === 1 ? "object" : "objects"}`,
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
  ]);
  const relationships = useMemo(() => {
    const links: Relationship[] = [...live.relationships];
    for (const group of clusters)
      for (const r of resourceMap.values())
        if (group.kinds.includes(r.kind))
          links.push({
            from: group.id,
            to: r.id,
            label: "contains",
            inverseLabel: "in collection",
          });
    for (const item of voice.activities)
      links.push({
        from: "voice",
        to: `activity:${item.id}`,
        label: item.kind === "task" ? "delegated" : "used",
        inverseLabel: "from voice conversation",
      });
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
    ? neighborhood.slice(0, 8).map((resource, index, all) => ({
        id: `node:${resource.id}`,
        resourceId: resource.id,
        representation: "word",
        position: {
          x: 29 + Math.cos((index / all.length) * Math.PI * 2) * 22,
          y: 49 + Math.sin((index / all.length) * Math.PI * 2) * 29,
        },
      }))
    : clusters.map((group) => ({
        id: `node:${group.id}`,
        resourceId: group.id,
        representation: "word",
        position: { x: group.x, y: group.y },
      }));
  const running = voice.activities.filter(
    (item) => item.state === "running",
  ).length;
  const elapsed = `${Math.floor(voice.seconds / 60)
    .toString()
    .padStart(2, "0")}:${(voice.seconds % 60).toString().padStart(2, "0")}`;
  const displayStatus = voice.paused
    ? "Audio paused"
    : voice.muted && voice.status === "Listening"
      ? "Microphone muted"
      : voice.status;
  function open(id: string, element?: HTMLElement) {
    if (!resourceMap.has(id)) return;
    if (element) origin.current = element;
    if (selected && selected !== id)
      setHistory((h) => [
        ...h,
        {
          resourceId: selected,
          mode: "inspect",
          scrollTop: surface.current?.scrollTop ?? 0,
          camera,
        },
      ]);
    scrollRestore.current = 0;
    setSelected(id);
    setWheel(null);
    setCamera({
      x: 0,
      y: 0,
      zoom: clusters.some((c) => c.id === id) ? 1.05 : 1.12,
    });
  }
  function back() {
    if (wheel) {
      setWheel(null);
      origin.current?.focus();
      return;
    }
    const previous = history.at(-1);
    setHistory((h) => h.slice(0, -1));
    setSelected(previous?.resourceId ?? null);
    setCamera(previous?.camera ?? home);
    scrollRestore.current = previous?.scrollTop ?? 0;
    if (!previous) origin.current?.focus();
  }
  function reset() {
    setSelected(null);
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
      if (e.key === "Escape") {
        back();
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
    <div className={styles.voiceControls}>
      <button
        disabled={!voice.active}
        onClick={voice.toggleMuted}
        aria-label={voice.muted ? "Unmute microphone" : "Mute microphone"}
        aria-pressed={voice.muted}
      >
        {voice.muted ? <MicOff /> : <Mic />}
      </button>
      <button
        disabled={!voice.active}
        onClick={voice.togglePaused}
        aria-label={voice.paused ? "Resume conversation" : "Pause conversation"}
        aria-pressed={voice.paused}
      >
        {voice.paused ? <Play /> : <Pause />}
      </button>
      <button
        disabled={!voice.active || voice.paused}
        onClick={voice.interrupt}
        aria-label="Interrupt reply"
      >
        <Square />
      </button>
      <button
        disabled={!voice.active}
        onClick={voice.stop}
        aria-label="End conversation"
      >
        <PhoneOff />
      </button>
    </div>
  );
  return (
    <main
      className={styles.world}
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
                (r) => r.id === "gateway" && r.status.value === "connected",
              )
            }
          />
        </span>
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
            </div>
          )}
          {nodes.map((node) => {
            const resource = resourceMap.get(node.resourceId)!;
            const definition = definitionFor(
              clusters.find((c) => c.id === resource.id)?.kinds[0] ??
                resource.kind,
            );
            const cluster = clusters.find((c) => c.id === resource.id);
            return (
              <button
                className={`${styles.node} ${styles[definition.family]} ${resource.status.tone === "attention" ? styles.attention : ""}`}
                key={node.id}
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
                  <strong>{resource.title}</strong>
                  <em>
                    {resource.kind === "collection"
                      ? resource.summary
                      : `${selected ? `${related.find((link) => link.resourceId === resource.id)?.label ?? "contains"} · ` : ""}${resource.status.label}`}
                  </em>
                </span>
                <b aria-hidden="true">↗</b>
              </button>
            );
          })}
        </div>
        <div
          className={`${styles.core} ${selected === "voice" ? styles.voiceScene : ""}`}
        >
          <button
            className={styles.reactorTarget}
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
            />
          </button>
          {voice.active && (
            <>
              <div className={styles.coreCaption} role="status">
                <small>{displayStatus}</small>
                <span>
                  {elapsed}
                  {running
                    ? ` · ${running} active ${running === 1 ? "task" : "tasks"}`
                    : ""}
                </span>
              </div>
              {voiceControls}
            </>
          )}
        </div>
      </div>
      {selectedResource && (
        <section
          className={`${styles.surface} ${styles[definitionFor(selectedResource.kind).family]} ${selectedGroup ? styles.collectionSurface : ""}`}
          aria-label="Resource details"
        >
          <div className={styles.surfaceTop}>
            <button onClick={back} aria-label="Return to previous view">
              <ArrowLeft />
            </button>

            <button onClick={reset} aria-label="Return to world">
              <X />
            </button>
          </div>
          <div
            ref={surface}
            className={styles.surfaceBody}
            key={selectedResource.id}
          >
            {!selectedGroup && (
              <small className={styles.eyebrow}>
                {selectedResource.status.label}
              </small>
            )}
            <h1 tabIndex={-1}>{selectedResource.title}</h1>
            {selectedResource.id === "voice" ? (
              <>
                <div
                  className={styles.thread}
                  role="log"
                  aria-label="Conversation transcript"
                >
                  {!voice.messages.length && (
                    <p>
                      Your words, spoken replies and agent progress appear here.
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
            {selectedResource.facts && (
              <dl className={styles.facts}>
                {selectedResource.facts.map((fact) => (
                  <div key={fact.label}>
                    <dt>{fact.label}</dt>
                    <dd>{fact.value}</dd>
                  </div>
                ))}
              </dl>
            )}
            {selectedResource.transcriptPath && (
              <SavedTranscript path={selectedResource.transcriptPath} />
            )}
            {(selectedResource.kind === "memory-index" ||
              selectedResource.id === "knowledge") && <MemorySearch />}
            {selectedResource.id.startsWith("activity:") && (
              <div className={styles.execution}>
                <Radio />
                <span>{selectedResource.status.label}</span>
                <p>
                  Reported by the voice agent. Tool arguments and raw results
                  are not included in this activity stream.
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
                        className={styles[definitionFor(target.kind).family]}
                        data-tone={target.status.tone}
                        key={`${link.resourceId}:${index}`}
                        onClick={() => open(target.id)}
                      >
                        {selectedGroup && (
                          <i className={styles.nodeGlyph} aria-hidden="true" />
                        )}
                        <span>
                          <strong>{target.title}</strong>
                          <small>
                            {selectedGroup
                              ? target.status.label
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
                Loaded state reports registration in the runtime. It does not
                measure service health.
              </p>
            )}
          </div>
        </section>
      )}
      {(voice.error || live.error) && (
        <div className={styles.alert} role="alert">
          {voice.error || live.error}
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
            <span>FIELD</span>
            <button onClick={() => open(wheel.id)}>Expand ↑</button>
            <button
              onClick={() => {
                if (wheel.id === "voice") {
                  setWheel(null);
                  if (voice.active) voice.toggleMuted();
                  else voice.start();
                } else open(wheel.id);
              }}
            >
              →{" "}
              {wheel.id === "voice"
                ? voice.active
                  ? voice.muted
                    ? "Unmute"
                    : "Mute"
                  : "Speak"
                : "Inspect"}
            </button>
            <button
              onClick={() => {
                setWheel(null);
                origin.current?.focus();
              }}
            >
              Return ↓
            </button>
            <button
              onClick={() => {
                const link = relatedResources(wheel.id, relationships)[0];
                if (link) open(link.resourceId);
                else open(wheel.id);
              }}
            >
              ← Related
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
