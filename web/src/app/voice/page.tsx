"use client";

import { useEffect, useRef, useState } from "react";
import { Mic, MicOff, Phone, PhoneOff, Pause, Play, Square, Wrench, Sparkles, Check, LoaderCircle, CircleAlert, AudioLines, MessagesSquare } from "lucide-react";
import type { VoiceActivity } from "@vargos/lib/voice";
import { VoiceClient } from "@/lib/voice-client";
import { VoiceOrb } from "@/components/voice/voice-orb";
import { PageHeader } from "@/components/hud/page-header";
import { Panel } from "@/components/hud/panel";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export default function VoicePage() {
  const client = useRef<VoiceClient | null>(null);
  const [active, setActive] = useState(false);
  const [muted, setMuted] = useState(false);
  const [paused, setPaused] = useState(false);
  const [status, setStatus] = useState("Ready when you are");
  const [error, setError] = useState("");
  const [level, setLevel] = useState(0);
  const [outputLevel, setOutputLevel] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [messages, setMessages] = useState<{ role: string; text: string }[]>([]);
  const [activities, setActivities] = useState<VoiceActivity[]>([]);
  const transcriptEnd = useRef<HTMLDivElement | null>(null);
  useEffect(() => () => client.current?.stop(), []);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setSeconds(s => s + 1), 1000);
    return () => clearInterval(timer);
  }, [active]);
  useEffect(() => { transcriptEnd.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }, [messages]);

  function start() {
    setError(""); setStatus("Connecting"); setActive(true); setMuted(false); setPaused(false); setMessages([]); setActivities([]); setSeconds(0);
    const voice = new VoiceClient({
      status: setStatus, level: setLevel, outputLevel: setOutputLevel, error: setError,
      activity: activity => setActivities(current => {
        const existing = current.find(item => item.id === activity.id);
        return existing ? current.map(item => item.id === activity.id ? activity : item) : [...current.slice(-99), activity];
      }),
      transcript: (role, text) => setMessages(current => [...current.slice(-99), { role, text }]),
      closed: () => { setActive(false); setPaused(false); setStatus("Conversation ended"); },
    });
    client.current = voice;
    void voice.start();
  }
  function pause() {
    const next = !paused;
    setPaused(next);
    void client.current?.setPaused(next);
  }
  const running = activities.filter(item => item.state === "running");
  const tools = activities.filter(item => item.kind === "tool").length;
  const skills = activities.filter(item => item.kind === "skill").length;
  const displayStatus = paused ? "Paused" : muted && status === "Listening" ? "Microphone muted" : status;
  const elapsed = `${Math.floor(seconds/60).toString().padStart(2, "0")}:${(seconds%60).toString().padStart(2, "0")}`;

  return <>
    <PageHeader title="Voice assistant" eyebrow="Vargos / Voice" description="A conversation with your agent. Ask, explore, or put Vargos to work." actions={<span className="flex items-center gap-2 font-mono text-xs text-muted-foreground"><span className={cn("size-1.5 rounded-full", active ? "bg-primary" : "bg-muted-foreground/40")} />{active ? elapsed : "STANDBY"}</span>} />
    <div className="grid items-stretch gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(300px,1fr)]">
      <Panel className="overflow-hidden" bodyClassName="relative flex min-h-[530px] flex-col items-center justify-center px-6 py-8">
        <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(ellipse_at_center,var(--hud-glow),transparent_65%)] opacity-20" />
        <div className="relative mb-2 font-mono text-[10px] tracking-[.32em] text-muted-foreground">V A R G O S · VOICE LINK</div>
        <VoiceOrb active={active} paused={paused} status={status} level={paused ? 0 : Math.max(level, outputLevel)} />
        <div className="relative -mt-1 text-center">
          <p role="status" aria-live="polite" className="text-xl font-medium tracking-tight">{displayStatus}</p>
          <p className="mt-2 max-w-sm text-sm text-muted-foreground">{!active ? "Start a conversation. Your microphone stays off until you do." : paused ? "Audio is paused. Agent work already started continues." : status === "Working" ? "Your agent is working in the background. You can keep talking." : status === "Speaking" ? "You can speak at any time to interrupt." : "Speak naturally. Vargos will respond when you finish."}</p>
        </div>
        <div className="relative mt-7 flex items-center gap-3">
          <Button variant="outline" size="icon" className="size-11 rounded-full" disabled={!active} onClick={() => { client.current?.setMuted(!muted); setMuted(!muted); }} aria-label={muted ? "Unmute microphone" : "Mute microphone"} aria-pressed={muted} title={muted ? "Unmute microphone" : "Mute microphone"}>{muted ? <MicOff /> : <Mic />}</Button>
          <Button variant="outline" size="icon" className="size-11 rounded-full" disabled={!active} onClick={pause} aria-label={paused ? "Resume conversation" : "Pause conversation"} aria-pressed={paused} title={paused ? "Resume conversation" : "Pause conversation"}>{paused ? <Play /> : <Pause />}</Button>
          <Button size="icon" className={cn("size-14 rounded-full shadow-lg", active && "bg-destructive text-white hover:bg-destructive/90")} onClick={() => active ? client.current?.stop() : start()} aria-label={active ? "End conversation" : "Start conversation"} title={active ? "End conversation" : "Start conversation"}>{active
            ? <PhoneOff className="size-5" />
            : <Phone className="size-5" />}
          </Button>
          <Button variant="outline" size="icon" className="size-11 rounded-full" disabled={!active || paused} onClick={() => client.current?.interrupt()} aria-label="Interrupt reply" title="Interrupt reply"><Square className="size-3.5" /></Button>
        </div>
        <div role="meter" aria-label="Microphone level"
          aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level*100)} className="relative mt-6 h-1 w-32 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary transition-all" style={{ width: `${level*100}%` }} /></div>
        <span className="mt-2 font-mono text-[9px] tracking-widest text-muted-foreground uppercase">{muted ? "MIC MUTED" : paused ? "AUDIO PAUSED" : active ? "MIC INPUT" : "MIC OFF"}</span>
        {error && <p role="alert" className="relative mt-4 max-w-md text-center text-sm text-destructive">{error}</p>}
      </Panel>
      <Panel title="Agent activity" icon={<AudioLines />} actions={<span className="font-mono text-[10px] text-muted-foreground">{active && running.length ? `${running.length} ACTIVE` : "LIVE"}</span>} bodyClassName="flex min-h-[300px] flex-col">
        <div className="mb-4 grid grid-cols-2 gap-3">
          <div className="rounded-lg border border-border/70 bg-background/40 px-3 py-3"><span className="flex items-center gap-2 text-xs text-muted-foreground"><Wrench className="size-3.5" />Tools</span><span className="mt-1 block font-mono text-2xl">{tools.toString().padStart(2, "0")}</span></div>
          <div className="rounded-lg border border-border/70 bg-background/40 px-3 py-3"><span className="flex items-center gap-2 text-xs text-muted-foreground"><Sparkles className="size-3.5" />Skills loaded</span><span className="mt-1 block font-mono text-2xl">{skills.toString().padStart(2, "0")}</span></div>
        </div>
        <div role="log" aria-label="Agent activity" className="max-h-[380px] flex-1 space-y-2 overflow-y-auto">
          {!activities.length && <div className="flex h-full min-h-44 flex-col items-center justify-center gap-3 px-4 text-center"><Wrench className="size-6 text-primary/40" /><p className="text-sm text-muted-foreground">Tools and skills appear here when Vargos uses them.</p><p className="text-xs text-muted-foreground/70">Simple conversation may not need any tools.</p></div>}
          {activities.map(item => <div key={item.id} className={cn("flex items-start gap-3 rounded-lg border px-3 py-3", item.state === "running" && active ? "border-primary/30 bg-primary/5" : "border-border/60 bg-background/30")}>
            {item.state === "running" ? <LoaderCircle className={cn("mt-0.5 size-4 shrink-0 text-primary", active && "animate-spin motion-reduce:animate-none")} /> : item.state === "failed" ? <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" /> : <Check className="mt-0.5 size-4 shrink-0 text-success" />}
            <div className="min-w-0 flex-1"><p className="break-words text-sm font-medium">{item.label}</p><p className="mt-1 text-[10px] tracking-wider text-muted-foreground uppercase">{item.kind === "task" ? "Agent task" : item.kind === "skill" ? "Skill" : "Tool"} · {item.state === "running" ? active ? "Running" : "Last seen running" : item.state === "failed" ? "Failed" : "Completed"}</p></div>
          </div>)}
        </div>
      </Panel>
    </div>
    <div className="mt-5"><Panel title="Conversation transcript" icon={<MessagesSquare />} actions={<span className="font-mono text-[10px] text-muted-foreground">{messages.length} UPDATES</span>}>
      <div role="log" aria-label="Conversation transcript" className="max-h-80 space-y-5 overflow-y-auto pr-2">
        {!messages.length && <p className="py-3 text-sm text-muted-foreground">Your words, spoken replies, and agent progress will appear here.</p>}
        {messages.map((message, index) => <div key={index} className={cn("border-l-2 pl-3", message.role === "You" ? "border-border" : message.role === "Progress" ? "border-accent" : "border-primary/60")}><p className="font-mono text-[10px] tracking-widest text-muted-foreground uppercase">{message.role === "Progress" ? "Agent progress" : message.role}</p><p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed">{message.text}</p></div>)}
        <div ref={transcriptEnd} />
      </div>
    </Panel></div>
  </>;
}
