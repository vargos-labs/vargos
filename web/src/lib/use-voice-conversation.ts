"use client";

import { useEffect, useRef, useState } from "react";
import type {
  VoiceActivity,
  WorkspaceCommand,
  VoiceModelInfo,
} from "@vargos/lib/voice";
import { VoiceClient, type VoiceResponseUsage } from "./voice-client";

/** One existing voice transport, independent of which surface is being inspected. */
export function useVoiceConversation(
  workspace?: (command: WorkspaceCommand) => unknown,
) {
  const workspaceHandler = useRef(workspace);
  useEffect(() => {
    workspaceHandler.current = workspace;
  }, [workspace]);
  const client = useRef<VoiceClient | null>(null);
  const [active, setActive] = useState(false);
  const [muted, setMuted] = useState(false);
  const [paused, setPaused] = useState(false);
  const [status, setStatus] = useState("Standby");
  const [error, setError] = useState("");
  const [inputLevel, setInputLevel] = useState(0);
  const [outputLevel, setOutputLevel] = useState(0);
  const [sessionKey, setSessionKey] = useState("");
  const [seconds, setSeconds] = useState(0);
  const [model, setModel] = useState<VoiceModelInfo | null>(null);
  const [usage, setUsage] = useState<VoiceResponseUsage | null>(null);
  const [messages, setMessages] = useState<{ role: string; text: string }[]>(
    [],
  );
  const [activities, setActivities] = useState<VoiceActivity[]>([]);
  useEffect(() => () => client.current?.stop(), []);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [active]);
  function start() {
    if (client.current) return;
    setError("");
    setStatus("Connecting");
    setActive(true);
    setMuted(false);
    setPaused(false);
    setMessages([]);
    setActivities([]);
    setSeconds(0);
    setUsage(null);
    setModel(null);
    setSessionKey("");
    const voice = new VoiceClient({
      workspace: (command) =>
        workspaceHandler.current?.(command) ?? {
          error: "Workspace is unavailable.",
        },
      status: setStatus,
      usage: setUsage,
      model: setModel,
      error: setError,
      level: setInputLevel,
      outputLevel: setOutputLevel,
      session: setSessionKey,
      transcript: (role, text) =>
        setMessages((items) => [...items.slice(-199), { role, text }]),
      activity: (activity) =>
        setActivities((items) =>
          items.some((item) => item.id === activity.id)
            ? items.map((item) => (item.id === activity.id ? activity : item))
            : [...items.slice(-99), activity],
        ),
      closed: () => {
        client.current = null;
        setActive(false);
        setPaused(false);
        setStatus("Disconnected");
      },
    });
    client.current = voice;
    void voice.start();
  }
  return {
    active,
    muted,
    paused,
    status,
    error,
    inputLevel,
    outputLevel,
    sessionKey,
    seconds,
    usage,
    model,
    messages,
    activities,
    start,
    stop: () => client.current?.stop(),
    interrupt: () => client.current?.interrupt(),
    toggleMuted: () => {
      client.current?.setMuted(!muted);
      setMuted(!muted);
    },
    togglePaused: () => {
      void client.current?.setPaused(!paused);
      setPaused(!paused);
    },
  };
}
