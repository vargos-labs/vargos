"use client";

import { useId, type CSSProperties } from "react";
import { cn } from "@/lib/utils";

export function VoiceOrb({ active, paused, level, status }: { active: boolean; paused: boolean; level: number; status: string }) {
  const id = useId().replace(/:/g, "");
  return <div className={cn("voice-orb-stage", active && "is-active", paused && "is-paused", status === "Thinking" || status === "Working" ? "is-working" : "")} style={{ "--voice-level": level } as CSSProperties} aria-hidden="true">
    <div className="voice-orb-halo" />
    <svg className="voice-orb-orbit" viewBox="0 0 360 360" fill="none">
      <circle cx="180" cy="180" r="164" stroke="currentColor" opacity=".12" />
      <circle cx="180" cy="180" r="153" stroke="currentColor" opacity=".35" strokeDasharray="2 15" />
      <path d="M180 16a164 164 0 0 1 164 164M180 344A164 164 0 0 1 16 180" stroke="currentColor" strokeWidth="2" opacity=".55" />
      <circle cx="180" cy="16" r="3" fill="currentColor" />
      <circle cx="180" cy="344" r="3" fill="currentColor" />
    </svg>
    <div className="voice-orb-body">
      <svg viewBox="0 0 280 280" className="size-full" fill="none">
        <defs>
          <radialGradient id={`${id}-sphere`} cx=".35" cy=".25" r=".85">
            <stop stopColor="currentColor" stopOpacity=".45" />
            <stop offset=".48" stopColor="currentColor" stopOpacity=".07" />
            <stop offset="1" stopColor="currentColor" stopOpacity=".28" />
          </radialGradient>
          <radialGradient id={`${id}-core`}>
            <stop stopColor="currentColor" stopOpacity=".85" />
            <stop offset=".3" stopColor="currentColor" stopOpacity=".3" />
            <stop offset="1" stopColor="currentColor" stopOpacity="0" />
          </radialGradient>
          <clipPath id={`${id}-clip`}><circle cx="140" cy="140" r="132" /></clipPath>
        </defs>
        <circle cx="140" cy="140" r="132" fill={`url(#${id}-sphere)`} stroke="currentColor" strokeOpacity=".5" />
        <g clipPath={`url(#${id}-clip)`} stroke="currentColor" strokeWidth=".6" className="voice-orb-grid">
          {[28, 57, 86, 114].map(r => <ellipse key={`v${r}`} cx="140" cy="140" rx={r} ry="132" opacity=".38" />)}
          {[38, 76, 112, 140, 168, 204, 242].map(y => <ellipse key={`h${y}`} cx="140" cy={y} rx={Math.sqrt(132 ** 2 - (y-140) ** 2)} ry="18" opacity=".35" />)}
          <ellipse cx="140" cy="140" rx="132" ry="45" transform="rotate(-35 140 140)" strokeWidth="1.2" opacity=".6" />
          <ellipse cx="140" cy="140" rx="132" ry="75" transform="rotate(40 140 140)" opacity=".25" />
        </g>
        <circle cx="140" cy="140" r="76" fill={`url(#${id}-core)`} className="voice-orb-core" />
        <circle cx="140" cy="140" r="3" fill="currentColor" />
      </svg>
    </div>
    <span className="voice-orb-cross voice-orb-cross-left" />
    <span className="voice-orb-cross voice-orb-cross-right" />
  </div>;
}
