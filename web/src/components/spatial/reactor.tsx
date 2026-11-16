"use client";

import { useEffect, useRef } from "react";
import styles from "./reactor.module.css";

type SpatialReactorProps = {
  inputLevel: number;
  outputLevel: number;
  active: boolean;
  paused: boolean;
  contextPercent?: number;
};

const TAU = Math.PI * 2;
const clamp = (value: number) =>
  Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));

/** A decorative instrument: speech amplitude is measured; context is drawn only when supplied. */
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

    function circle(
      radius: number,
      color: string,
      width = 1,
      start = 0,
      end = TAU,
    ) {
      ctx!.beginPath();
      ctx!.arc(0, 0, radius, start, end);
      ctx!.strokeStyle = color;
      ctx!.lineWidth = width;
      ctx!.stroke();
    }

    function draw(delta: number) {
      const { active, paused, inputLevel, outputLevel, contextPercent } =
        latest.current;
      const target =
        active && !paused ? Math.max(clamp(inputLevel), clamp(outputLevel)) : 0;
      amplitude = reduced
        ? target
        : amplitude + (target - amplitude) * Math.min(1, delta / 100);
      if (!reduced) elapsed += delta / 1000;
      const t = elapsed;
      const r = size * 0.36;
      const speaking = outputLevel > inputLevel && target > 0.025;
      ctx!.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx!.clearRect(0, 0, size, size);
      ctx!.translate(size / 2, size / 2);
      ctx!.globalAlpha = paused ? 0.55 : 1;

      const halo = ctx!.createRadialGradient(0, 0, r * 0.1, 0, 0, r * 1.35);
      halo.addColorStop(0, `rgba(109,228,255,${0.1 + amplitude * 0.15})`);
      halo.addColorStop(0.55, `rgba(18,136,210,${0.09 + amplitude * 0.14})`);
      halo.addColorStop(1, "rgba(5,50,90,0)");
      ctx!.fillStyle = halo;
      ctx!.fillRect(-size / 2, -size / 2, size, size);

      // Fixed divisions make the moving layers legible against the instrument.
      for (let i = 0; i < 120; i++) {
        const a = (i / 120) * TAU;
        const major = i % 10 === 0;
        ctx!.beginPath();
        ctx!.moveTo(Math.cos(a) * r * 1.18, Math.sin(a) * r * 1.18);
        ctx!.lineTo(
          Math.cos(a) * r * (major ? 1.23 : 1.2),
          Math.sin(a) * r * (major ? 1.23 : 1.2),
        );
        ctx!.strokeStyle = major
          ? "rgba(169,232,255,.6)"
          : "rgba(95,182,220,.2)";
        ctx!.lineWidth = major ? 1 : 0.6;
        ctx!.stroke();
      }
      circle(r * 1.12, "rgba(120,210,250,.14)");
      circle(r * 1.04, "rgba(129,219,255,.2)");
      const turn = reduced ? 0 : t * 0.065;
      for (let i = 0; i < 3; i++) {
        const a = (i * TAU) / 3 + turn;
        circle(r * 1.07, "rgba(152,229,255,.7)", 1.6, a, a + 0.65);
        circle(r * 0.95, "rgba(63,186,246,.28)", 4, -a, -a + 1.1);
      }
      circle(r * 0.91, "rgba(114,214,251,.17)", 0.8);
      circle(
        r * 1.12,
        "rgba(255,184,86,.85)",
        2,
        -Math.PI * 0.13,
        Math.PI * 0.025,
      );

      // A finite context arc represents actual supplied usage, never a decorative percentage.
      if (contextPercent !== undefined && Number.isFinite(contextPercent)) {
        circle(r * 1.29, "rgba(134,208,238,.1)", 2);
        const usage = clamp(contextPercent / 100);
        circle(
          r * 1.29,
          usage > 0.85 ? "#ffc27d" : "#9beaff",
          2,
          -Math.PI / 2,
          -Math.PI / 2 + usage * TAU,
        );
      }

      // Rotating spherical points: rear points are dimmer, front points emit measured audio.
      const globe = r * (0.72 + amplitude * 0.09);
      const rotation = reduced ? 0.3 : t * 0.12;
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
        const wave = reduced
          ? 0
          : Math.sin(p.latitude * 5 - t * 3) * amplitude * 0.035;
        const scale = globe * (1 + wave);
        const alpha = 0.08 + depth * (0.5 + amplitude * 0.35);
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
