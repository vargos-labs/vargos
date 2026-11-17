"use client";

import { useEffect, useRef } from "react";
import styles from "./reactor.module.css";

type SpatialReactorProps = {
  inputLevel: number;
  outputLevel: number;
  active: boolean;
  paused: boolean;
  quiet?: boolean;
  focused?: boolean;
  muted?: boolean;
  status?: string;
};

const TAU = Math.PI * 2;
const clamp = (value: number) =>
  Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));

/** Speech amplitude drives the globe; the surrounding orbits are decorative. */
export function SpatialReactor(props: SpatialReactorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  }, [props]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    let reduced = media.matches;
    let frame = 0;
    let lastDraw = 0;
    let elapsed = 0;
    let size = 0;
    let ratio = 1;
    let amplitude = 0;
    let orbitTilt = 0.48;

    function draw(delta: number) {
      const {
        active,
        paused,
        inputLevel,
        outputLevel,
        quiet,
        focused,
        muted,
        status,
      } = latest.current;
      const still = reduced || quiet;
      const processing = status === "Thinking" || status === "Connecting";
      const target =
        active && !paused ? Math.max(clamp(inputLevel), clamp(outputLevel)) : 0;
      amplitude = still
        ? target
        : amplitude + (target - amplitude) * Math.min(1, delta / 100);
      if (!still) elapsed += delta / 1000;
      const t = elapsed;
      const r = size * 0.36;
      const speaking = outputLevel > inputLevel && target > 0.025;
      ctx!.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx!.clearRect(0, 0, size, size);
      ctx!.translate(size / 2, size / 2);
      ctx!.globalAlpha = paused || muted ? 0.45 : active ? 1 : 0.65;

      const halo = ctx!.createRadialGradient(0, 0, r * 0.1, 0, 0, r * 1.35);
      halo.addColorStop(0, `rgba(109,228,255,${0.1 + amplitude * 0.15})`);
      halo.addColorStop(0.55, `rgba(18,136,210,${0.09 + amplitude * 0.14})`);
      halo.addColorStop(1, "rgba(5,50,90,0)");
      ctx!.fillStyle = halo;
      ctx!.fillRect(-size / 2, -size / 2, size, size);

      // Project a tilted orbit into screen space. Draw its far half before the
      // membrane and its near half after, so depth has a stable visual reference.
      const turn = t * 0.18;
      // Restore the reactor rim as a stable frame around the dimensional orbits.
      // These evenly spaced marks are a bezel, not a context usage gauge.
      for (let i = 0; i < 60; i++) {
        const a = (i / 60) * TAU;
        const major = i % 5 === 0;
        ctx!.beginPath();
        ctx!.moveTo(Math.cos(a) * r * 1.28, Math.sin(a) * r * 1.28);
        ctx!.lineTo(
          Math.cos(a) * r * (major ? 1.34 : 1.31),
          Math.sin(a) * r * (major ? 1.34 : 1.31),
        );
        ctx!.strokeStyle = major
          ? "rgba(169,232,255,.6)"
          : "rgba(95,182,220,.26)";
        ctx!.lineWidth = 1;
        ctx!.stroke();
      }
      for (let i = 0; i < 3; i++) {
        const start = (i / 3) * TAU + turn;
        ctx!.beginPath();
        ctx!.arc(0, 0, r * 0.91, start, start + 0.55);
        ctx!.strokeStyle = "rgba(152,229,255,.6)";
        ctx!.lineWidth = 1.5;
        ctx!.stroke();
      }
      function orbit(
        front: boolean,
        tilt: number,
        rotation: number,
        radius: number,
      ) {
        const count = 160;
        for (let i = 0; i < count; i++) {
          const a = (i / count) * TAU;
          if (Math.sin(a) >= 0 !== front) continue;
          ctx!.save();
          ctx!.rotate(rotation);
          ctx!.beginPath();
          ctx!.ellipse(
            0,
            0,
            radius,
            radius * tilt,
            0,
            a,
            a + TAU / count + 0.002,
          );
          ctx!.strokeStyle = `rgba(112,205,241,${front ? 0.6 : 0.2})`;
          ctx!.lineWidth = 1.4;
          ctx!.stroke();
          ctx!.restore();
        }
      }
      orbitTilt +=
        ((focused ? 0.86 : 0.48) - orbitTilt) *
        (still ? 1 : Math.min(1, delta / 180));
      const tilt = orbitTilt;
      orbit(false, tilt, -0.35, r * 1.22);
      orbit(false, tilt - 0.16, 0.95, r * 1.08);
      const membrane = ctx!.createRadialGradient(
        -r * 0.22,
        -r * 0.3,
        0,
        0,
        0,
        r * 0.76,
      );
      membrane.addColorStop(0, "rgba(99,202,239,.08)");
      membrane.addColorStop(0.72, "rgba(12,58,85,.12)");
      membrane.addColorStop(1, "rgba(6,26,43,.24)");
      ctx!.fillStyle = membrane;
      ctx!.beginPath();
      ctx!.arc(0, 0, r * 0.76, 0, TAU);
      ctx!.fill();
      // Fixed transparent globe: perspective separates the visible front and rear surfaces.
      const globe = r * (0.72 + amplitude * 0.09);
      const rotation = 0.3;
      const points: Array<{
        x: number;
        y: number;
        z: number;
        latitude: number;
      }> = [];
      for (let row = 1; row < 24; row++) {
        const latitude = (row / 24) * Math.PI;
        for (let col = 0; col < 44; col++) {
          const longitude = (col / 44) * TAU + rotation;
          const x = Math.sin(latitude) * Math.cos(longitude);
          const y = Math.cos(latitude);
          const z = Math.sin(latitude) * Math.sin(longitude);
          points.push({ x, y: y * 0.96 + z * 0.12, z, latitude });
        }
      }
      points.sort((a, b) => a.z - b.z);
      for (const p of points) {
        const depth = (p.z + 1) / 2;
        const wave = still
          ? 0
          : Math.sin(p.latitude * 5 + (speaking ? -1 : 1) * t * 3) *
            amplitude *
            0.035;
        const scale = globe * (1 + wave) * (1 + p.z * 0.08);
        const alpha = 0.22 + depth * (0.36 + amplitude * 0.35);
        ctx!.fillStyle = `rgba(${speaking ? "195,240,255" : "110,218,255"},${alpha})`;
        ctx!.beginPath();
        ctx!.arc(
          p.x * scale,
          p.y * scale,
          0.35 + depth * 0.8 + amplitude * 0.7,
          0,
          TAU,
        );
        ctx!.fill();
      }
      for (let i = 0; i < 5; i++) {
        ctx!.save();
        ctx!.rotate(-0.2 + i * 0.09);
        ctx!.beginPath();
        ctx!.ellipse(0, 0, globe, globe * (0.15 + i * 0.13), 0, 0, TAU);
        ctx!.strokeStyle = `rgba(135,221,255,${0.045 + amplitude * 0.06})`;
        ctx!.lineWidth = 0.6;
        ctx!.stroke();
        ctx!.restore();
      }
      const core = ctx!.createRadialGradient(0, 0, 0, 0, 0, globe * 0.65);
      core.addColorStop(0, `rgba(211,250,255,${0.23 + amplitude * 0.4})`);
      core.addColorStop(0.15, `rgba(80,202,255,${0.14 + amplitude * 0.3})`);
      core.addColorStop(1, "rgba(10,110,215,0)");
      ctx!.fillStyle = core;
      ctx!.fillRect(-globe, -globe, globe * 2, globe * 2);
      orbit(true, tilt, -0.35, r * 1.22);
      orbit(true, tilt - 0.16, 0.95, r * 1.08);
      // Persistent amber accent; processing changes emphasis, never visibility.
      {
        ctx!.save();
        ctx!.rotate(0.95);
        ctx!.beginPath();
        ctx!.ellipse(
          0,
          0,
          r * 1.08,
          r * 1.08 * (tilt - 0.16),
          0,
          turn,
          turn + 0.65,
        );
        ctx!.strokeStyle = "#ffc27d";
        ctx!.lineWidth = processing && !paused ? 3 : 2;
        ctx!.stroke();
        ctx!.restore();
      }
      ctx!.globalAlpha = 1;
    }

    function tick(now: number) {
      frame = 0;
      if (document.hidden) return;
      const interval = reduced ? 120 : 1000 / 30;
      if (now - lastDraw >= interval) {
        draw(Math.min(150, lastDraw ? now - lastDraw : interval));
        lastDraw = now;
      }
      frame = requestAnimationFrame(tick);
    }
    function start() {
      cancelAnimationFrame(frame);
      lastDraw = 0;
      if (!document.hidden) frame = requestAnimationFrame(tick);
    }
    function resize() {
      const bounds = canvas!.getBoundingClientRect();
      size = Math.min(bounds.width, bounds.height);
      ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas!.width = Math.round(size * ratio);
      canvas!.height = Math.round(size * ratio);
      start();
    }
    function motion() {
      reduced = media.matches;
      start();
    }
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    document.addEventListener("visibilitychange", start);
    media.addEventListener("change", motion);
    resize();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener("visibilitychange", start);
      media.removeEventListener("change", motion);
    };
  }, []);

  return (
    <canvas ref={canvasRef} className={styles.reactor} aria-hidden="true" />
  );
}
