"use client";

import { useEffect, useState } from "react";
import { api } from "../api";
import type { SpatialResource, Relationship } from "./model";
export interface LiveResource extends SpatialResource {
  facts?: readonly { label: string; value: string }[];
  transcriptPath?: string;
}
const empty: LiveResource[] = [];

/** Project existing read APIs; no config secrets or transport parameters enter the scene. */
export function useSpatialResources() {
  const [resources, setResources] = useState<LiveResource[]>(empty);
  const [relationships, setRelationships] = useState<Relationship[]>([]);
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState("");
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      if (document.hidden) {
        timer = setTimeout(refresh, 10000);
        return;
      }
      const [status, channels, mcp, sessions] = await Promise.allSettled([
        api.status(),
        api.channels(),
        api.mcp(),
        api.sessions(),
      ]);
      if (disposed) return;
      const objects: LiveResource[] = [];
      const links: Relationship[] = [];
      if (status.status === "fulfilled") {
        const payload = status.value;
        objects.push({
          id: "gateway",
          kind: "gateway",
          title: "Vargos gateway",
          summary: "Live agent runtime",
          status: {
            dimension: "connection",
            value: payload.gateway.online ? "connected" : "disconnected",
            label: payload.gateway.online ? "Connected" : "Offline",
            tone: payload.gateway.online ? "active" : "attention",
          },
          actions: [],
        });
        for (const service of payload.services ?? []) {
          const id = `service:${service.name}`;
          objects.push({
            id,
            kind: "service",
            title: service.name,
            summary: "Loaded runtime service",
            status: {
              dimension: "runtime",
              value: "loaded",
              label: "Loaded",
              tone: "neutral",
            },
            actions: [],
          });
          links.push({
            from: "gateway",
            to: id,
            label: "loads",
            inverseLabel: "loaded by",
          });
        }
        if (payload.memory)
          objects.push({
            id: "memory",
            kind: "memory-index",
            title: "Memory",
            summary: `${payload.memory.files} files · ${payload.memory.chunks} indexed passages`,
            status: {
              dimension: "availability",
              value: "available",
              label: "Index available",
              tone: "neutral",
            },
            facts: [
              { label: "Files", value: String(payload.memory.files) },
              { label: "Passages", value: String(payload.memory.chunks) },
              {
                label: "Last sync",
                value: payload.memory.lastSync
                  ? new Date(payload.memory.lastSync).toLocaleString()
                  : "Unknown",
              },
            ],
            actions: [],
          });
      }
      if (channels.status === "fulfilled")
        for (const channel of channels.value.configured) {
          const state = channels.value.live?.find(
            (item) => item.id === channel.id,
          )?.status;
          objects.push({
            id: `channel:${channel.id}`,
            kind: "channel",
            title: channel.id,
            summary: channel.type,
            status: {
              dimension: "connection",
              value: !channel.enabled
                ? "disabled"
                : state === "connected"
                  ? "connected"
                  : state === "disconnected"
                    ? "disconnected"
                    : "unknown",
              label: !channel.enabled
                ? "Disabled"
                : (state ?? "State unavailable"),
              tone:
                state === "connected"
                  ? "active"
                  : state === "disconnected"
                    ? "attention"
                    : "neutral",
            },
            facts: [{ label: "Transport", value: channel.type }],
            actions: [],
          });
        }
      if (mcp.status === "fulfilled")
        for (const server of mcp.value.servers)
          objects.push({
            id: `mcp:${server.name}`,
            kind: "mcp-server",
            title: server.name,
            summary: `${server.toolCount} tools · ${server.transport}`,
            status: {
              dimension: "connection",
              value: !server.enabled
                ? "disabled"
                : server.connected
                  ? "connected"
                  : "disconnected",
              label: !server.enabled
                ? "Disabled"
                : server.connected
                  ? "Connected"
                  : "Disconnected",
              tone:
                server.enabled && !server.connected ? "attention" : "neutral",
            },
            facts: [
              { label: "Tools", value: String(server.toolCount) },
              { label: "Transport", value: server.transport },
            ],
            actions: [],
          });
      if (sessions.status === "fulfilled")
        for (const file of sessions.value.channels
          .flatMap((group) => group.files)
          .sort((a, b) => b.mtimeMs - a.mtimeMs)
          .slice(0, 30)) {
          const id = `session:${file.path}`;
          objects.push({
            id,
            kind: "session",
            title: file.channel,
            summary: `${file.messageCount} entries · ${new Date(file.mtimeMs).toLocaleDateString()}`,
            status: {
              dimension: "session",
              value: "unknown",
              label: "Saved conversation",
              tone: "neutral",
            },
            transcriptPath: file.path,
            facts: [
              { label: "Model", value: file.lastModel ?? "Unknown" },
              {
                label: "Started",
                value: file.startedAt
                  ? new Date(file.startedAt).toLocaleString()
                  : "Unknown",
              },
            ],
            actions: [],
          });
          if (
            channels.status === "fulfilled" &&
            channels.value.configured.some(
              (channel) => channel.id === file.channel,
            )
          )
            links.push({
              from: `channel:${file.channel}`,
              to: id,
              label: "contains conversation",
              inverseLabel: "conversation on",
            });
        }
      setResources(objects);
      setRelationships(links);
      setUpdatedAt(new Date().toLocaleTimeString());
      const failed = [status, channels, mcp, sessions].filter(
        (item) => item.status === "rejected",
      ).length;
      setError(
        failed
          ? `${failed} data source${failed > 1 ? "s are" : " is"} unavailable. Showing the sources that responded.`
          : "",
      );
      timer = setTimeout(refresh, 10000);
    }
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, []);
  return { resources, relationships, error, updatedAt };
}
