"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import {
  Gauge,
  MessagesSquare,
  Radio,
  Timer,
  Boxes,
  Plug,
  Bot,
  Database,
  Menu,
  X,
  Activity,
} from "lucide-react";
import { useVargosSocket } from "@/lib/use-vargos-socket";
import { ThemeToggle } from "@/components/theme-toggle";
import { Reactor } from "@/components/hud/reactor";
import { StatusDot } from "@/components/hud/status-dot";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "Dashboard", icon: Gauge },
  { href: "/sessions", label: "Sessions", icon: MessagesSquare },
  { href: "/channels", label: "Channels", icon: Radio },
  { href: "/cron", label: "Cron", icon: Timer },
  { href: "/models", label: "Models", icon: Boxes },
  { href: "/mcp", label: "MCP", icon: Plug },
  { href: "/agents", label: "Agents", icon: Bot },
  { href: "/memory", label: "Memory", icon: Database },
] as const;

function useClock() {
  const [now, setNow] = useState<string | null>(null);
  useEffect(() => {
    const tick = () =>
      setNow(
        new Date().toLocaleTimeString("en-GB", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }),
      );
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav className="space-y-0.5 p-2">
      {NAV.map((item) => {
        const active =
          item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            className={cn(
              "group relative flex items-center gap-3 rounded-md px-3 py-2 text-[13.5px] font-medium text-muted-foreground transition-all hover:bg-primary/[0.06] hover:text-foreground",
              active &&
                "bg-gradient-to-r from-primary/[0.14] to-transparent text-foreground",
            )}
          >
            <span
              className={cn(
                "absolute inset-y-1.5 left-0 w-[2px] rounded-full bg-primary transition-all",
                active
                  ? "opacity-100 shadow-[0_0_8px_var(--hud-glow)]"
                  : "opacity-0 group-hover:opacity-50",
              )}
            />
            <Icon
              className={cn(
                "size-4 shrink-0 transition-colors",
                active ? "text-primary" : "text-muted-foreground group-hover:text-foreground",
              )}
            />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

function SidebarInner({
  connected,
  url,
  onNavigate,
}: {
  connected: boolean;
  url: string | null;
  onNavigate?: () => void;
}) {
  return (
    <>
      <div className="flex h-14 items-center gap-2.5 border-b border-border/70 px-4">
        <Reactor size={22} />
        <span className="font-heading text-[16px] font-bold tracking-[0.14em] text-glow-soft">
          VARGOS
        </span>
        <span className="ml-auto font-mono text-[9.5px] tracking-[0.24em] text-muted-foreground/80 uppercase">
          console
        </span>
      </div>
      <NavList onNavigate={onNavigate} />
      <div className="absolute inset-x-0 bottom-0 space-y-2 border-t border-border/70 p-3">
        <div className="flex items-center gap-2 font-mono text-[11px] tracking-wide text-muted-foreground uppercase">
          <StatusDot tone={connected ? "online" : "offline"} pulse={connected} />
          {connected ? `link · ${url?.replace(/^wss?:\/\//, "") ?? "ws"}` : "ws offline"}
        </div>
        <div className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground/70">
          <Activity className="size-3" />
          {connected ? "streaming live state" : "filesystem-only"}
        </div>
      </div>
    </>
  );
}

/** Sidebar + header wrapper for every page. */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { connected, url } = useVargosSocket();
  const clock = useClock();
  const [mobileOpen, setMobileOpen] = useState(false);

  const section =
    NAV.find((n) => (n.href === "/" ? pathname === "/" : pathname.startsWith(n.href)))
      ?.label ?? "Console";

  return (
    <div className="flex min-h-screen">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-56 border-r border-border/70 hud-surface md:block">
        <SidebarInner connected={connected} url={url} />
      </aside>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div
            className="absolute inset-0 bg-background/70 backdrop-blur-sm"
            onClick={() => setMobileOpen(false)}
          />
          <aside className="absolute inset-y-0 left-0 w-64 border-r border-border/70 bg-card/95 backdrop-blur-md">
            <button
              className="absolute right-3 top-4 text-muted-foreground hover:text-foreground"
              onClick={() => setMobileOpen(false)}
              aria-label="Close navigation"
            >
              <X className="size-4" />
            </button>
            <SidebarInner connected={connected} url={url} onNavigate={() => setMobileOpen(false)} />
          </aside>
        </div>
      )}

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col md:ml-56">
        <header className="hud-scanline sticky top-0 z-10 flex h-14 items-center justify-between gap-3 border-b border-border/70 hud-surface px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <button
              className="text-muted-foreground hover:text-foreground md:hidden"
              onClick={() => setMobileOpen(true)}
              aria-label="Open navigation"
            >
              <Menu className="size-5" />
            </button>
            <div className="flex items-center gap-2 font-mono text-[12px] tracking-[0.18em] uppercase">
              <span className="text-muted-foreground/70">VRG</span>
              <span className="text-primary/60">/</span>
              <span className="font-medium text-foreground text-glow-soft">{section}</span>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden font-mono text-[12px] tabular-nums text-muted-foreground sm:block">
              {clock ?? "--:--:--"}
            </span>
            <span className="hidden items-center gap-1.5 font-mono text-[11px] tracking-wide text-muted-foreground uppercase sm:flex">
              <StatusDot tone={connected ? "online" : "offline"} pulse={connected} />
              {connected ? "live" : "offline"}
            </span>
            <ThemeToggle />
          </div>
        </header>
        <main key={pathname} className="hud-rise flex-1 p-4 sm:p-6 lg:p-8">
          {children}
        </main>
      </div>
    </div>
  );
}
