"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, Square, Loader2, Phone, Waves } from "lucide-react";
import { PageHeader } from "@/components/hud/page-header";
import { Panel } from "@/components/hud/panel";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface StsResult {
  replyText: string;
  audioPath: string;
  duplex: string;
  timingMs: { stt: number; agent: number; tts: number };
}

interface Turn {
  id: number;
  role: "user" | "sts";
  text?: string;
  userAudioUrl?: string;
  replyAudioUrl?: string;
  timingMs?: StsResult["timingMs"];
  error?: string;
}

function useSessionKey() {
  const [key, setKey] = useState<string | null>(null);
  useEffect(() => {
    let k = localStorage.getItem("sts-test-session");
    if (!k) {
      k = `sts:test:${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem("sts-test-session", k);
    }
    setKey(k);
  }, []);
  return key;
}

export default function StsTestPage() {
  const sessionKey = useSessionKey();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [muted, setMuted] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const nextId = useRef(1);

  useEffect(() => () => stopStream(), []);

  function stopStream() {
    if (timerRef.current) clearInterval(timerRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      const rec = new MediaRecorder(stream, { mimeType: mime });
      chunksRef.current = [];
      rec.ondataavailable = (e) => e.data.size > 0 && chunksRef.current.push(e.data);
      rec.onstop = () => {
        stopStream();
        const blob = new Blob(chunksRef.current, { type: mime });
        const reader = new FileReader();
        reader.onload = () => sendTurn({ audioBase64: String(reader.result).split(",")[1], mimeType: mime });
        reader.readAsDataURL(blob);
      };
      recorderRef.current = rec;
      rec.start(250);
      setRecording(true);
      setElapsed(0);
      timerRef.current = setInterval(() => setElapsed((e) => e + 1), 1000);
    } catch (err) {
      pushTurn({ role: "sts", error: `Mic unavailable: ${err instanceof Error ? err.message : String(err)}` });
    }
  }, []);

  const stopRecording = useCallback(() => {
    recorderRef.current?.stop();
    setRecording(false);
  }, []);

  const pushTurn = (t: Omit<Turn, "id">) =>
    setTurns((prev) => [...prev, { ...t, id: nextId.current++ }]);

  const sendTurn = useCallback(
    async (body: { audioBase64?: string; mimeType?: string; text?: string }) => {
      if (!sessionKey) return;
      setBusy(true);
      const userAudioUrl =
        body.audioBase64 && body.mimeType
          ? `data:${body.mimeType};base64,${body.audioBase64}`
          : undefined;
      pushTurn({ role: "user", text: body.text, userAudioUrl });
      try {
        const res = await fetch("/api/sts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...body, sessionKey }),
        });
        const json = (await res.json()) as { ok: boolean; result?: StsResult; error?: string };
        if (!json.ok || !json.result) throw new Error(json.error ?? `HTTP ${res.status}`);
        const r = json.result;
        pushTurn({
          role: "sts",
          text: r.replyText,
          replyAudioUrl: `/api/sts/audio?path=${encodeURIComponent(pathBase(r.audioPath))}`,
          timingMs: r.timingMs,
        });
      } catch (err) {
        pushTurn({ role: "sts", error: err instanceof Error ? err.message : String(err) });
      } finally {
        setBusy(false);
      }
    },
    [sessionKey],
  );

  return (
    <div>
      <PageHeader
        eyebrow="Speech-to-speech · test surface"
        title="STS"
        description={
          <span>
            Mic → <code className="font-mono text-[0.85em]">stt</code> → agent →{" "}
            <code className="font-mono text-[0.85em]">tts</code> → speaker. Half-duplex turns.
          </span>
        }
        actions={
          sessionKey ? (
            <Badge variant="outline" className="font-mono text-[11px]">
              {sessionKey}
            </Badge>
          ) : null
        }
      />

      <div className="grid gap-4">
        <Panel title="Turns" icon={<Phone className="h-3.5 w-3.5" />} bodyClassName="space-y-3">
          {turns.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No turns yet. Hit the mic below, speak, and stop — the reply comes back as audio + text.
            </p>
          )}
          {turns.map((t) => (
            <div
              key={t.id}
              className={cn(
                "flex flex-col gap-1.5 rounded-lg border p-3",
                t.role === "user" ? "border-primary/25 bg-primary/[0.04]" : "border-border",
              )}
            >
              <div className="flex items-center gap-2 font-mono text-[10px] tracking-[0.2em] text-muted-foreground uppercase">
                {t.role === "user" ? "You" : "STS"}
                {t.timingMs && (
                  <span className="ml-auto tracking-normal normal-case">
                    stt {t.timingMs.stt}ms · agent {t.timingMs.agent}ms · tts {t.timingMs.tts}ms
                  </span>
                )}
              </div>
              {t.error ? (
                <p className="text-sm text-destructive">{t.error}</p>
              ) : (
                <>
                  {t.text && <p className="text-sm whitespace-pre-wrap">{t.text}</p>}
                  {t.userAudioUrl && <audio controls src={t.userAudioUrl} className="w-full max-w-sm" />}
                  {t.replyAudioUrl && !muted && (
                    <audio controls autoPlay src={t.replyAudioUrl} className="w-full max-w-sm" />
                  )}
                </>
              )}
            </div>
          ))}
        </Panel>

        <Panel title="Input" icon={<Waves className="h-3.5 w-3.5" />} className="flex flex-wrap items-center gap-3">
          {!recording ? (
            <Button onClick={startRecording} disabled={busy} className="gap-2">
              <Mic className="h-4 w-4" /> Record
            </Button>
          ) : (
            <>
              <Button onClick={stopRecording} variant="destructive" className="gap-2">
                <Square className="h-4 w-4" /> Stop · {elapsed}s
              </Button>
              <Badge className="animate-pulse bg-red-500/20 text-red-500">REC</Badge>
            </>
          )}
          {busy && (
            <span className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> STT → agent → TTS…
            </span>
          )}
          <Button variant="ghost" size="sm" onClick={() => setMuted((m) => !m)}>
            {muted ? "Sound: off" : "Sound: on"}
          </Button>
        </Panel>
      </div>
    </div>
  );
}

function pathBase(p: string) {
  return p.slice(p.lastIndexOf("/") + 1);
}
