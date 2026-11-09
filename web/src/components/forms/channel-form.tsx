"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { ChannelConfig } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Field, FieldRow } from "@/components/hud/field";

const TYPES = ["telegram", "whatsapp"];

export function ChannelForm({
  open,
  onOpenChange,
  channel,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** null → register new; a config → edit */
  channel: ChannelConfig | null;
  onSaved: () => void;
}) {
  const editing = !!channel;
  const [id, setId] = useState("");
  const [type, setType] = useState("telegram");
  const [enabled, setEnabled] = useState(true);
  const [sentryMode, setSentryMode] = useState(false);
  const [botToken, setBotToken] = useState("");
  const [model, setModel] = useState("");
  const [allowFrom, setAllowFrom] = useState("");
  const [cwd, setCwd] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setId(String(channel?.id ?? ""));
    setType(String(channel?.type ?? "telegram"));
    setEnabled(channel?.enabled ?? true);
    setSentryMode(channel?.sentryMode ?? false);
    setBotToken(String((channel?.botToken as string) ?? ""));
    setModel(String((channel?.model as string) ?? ""));
    setAllowFrom(((channel?.allowFrom as string[]) ?? []).join(", "));
    setCwd(String((channel?.cwd as string) ?? ""));
  }, [open, channel]);

  const submit = async () => {
    if (!id.trim() || !type.trim()) {
      toast.error("ID and type are required.");
      return;
    }
    const allow = allowFrom.split(",").map((s) => s.trim()).filter(Boolean);
    setBusy(true);

    let res;
    if (editing) {
      // Read-modify-write the whole config so nothing else is disturbed.
      try {
        const cfg = await api.config();
        const list = (cfg.channels as ChannelConfig[]) ?? [];
        const next = list.map((c) =>
          c.id === channel!.id
            ? {
                ...c,
                type,
                enabled,
                sentryMode,
                ...(model.trim() ? { model: model.trim() } : { model: undefined }),
                ...(allow.length ? { allowFrom: allow } : { allowFrom: undefined }),
                ...(cwd.trim() ? { cwd: cwd.trim() } : { cwd: undefined }),
                ...(botToken.trim() ? { botToken: botToken.trim() } : {}),
              }
            : c,
        );
        res = await api.saveConfig({ ...cfg, channels: next });
      } catch (e) {
        res = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    } else {
      res = await api.rpc("channel.register", {
        id: id.trim(),
        type: type.trim(),
        enabled,
        sentryMode,
        ...(botToken.trim() ? { botToken: botToken.trim() } : {}),
        ...(model.trim() ? { model: model.trim() } : {}),
        ...(allow.length ? { allowFrom: allow } : {}),
        ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
      });
    }
    setBusy(false);

    if (res.ok) {
      if (!editing && type === "whatsapp") {
        toast.success(`Registered "${id}". Click "Pair" in the table to scan the QR.`, {
          duration: 7000,
        });
      } else {
        toast.success(editing ? `Updated "${id}".` : `Registered "${id}" — restart the channel to apply.`);
      }
      onOpenChange(false);
      onSaved();
    } else {
      toast.error(res.error ?? "Save failed");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={editing ? `Edit channel · ${channel?.id}` : "Register channel"}
        description="Persists to ~/.vargos/config.json. Restart the channel (or daemon) to apply."
      >
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Channel ID" htmlFor="ch-id" hint={editing ? "Immutable" : "e.g. telegram-ops"}>
              <Input
                id="ch-id"
                value={id}
                disabled={editing}
                onChange={(e) => setId(e.target.value)}
              />
            </Field>
            <Field label="Type" htmlFor="ch-type">
              <select
                id="ch-type"
                value={type}
                onChange={(e) => setType(e.target.value)}
                className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
              >
                {[...new Set([type, ...TYPES])].map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          {type === "telegram" && (
            <Field
              label="Bot token"
              htmlFor="ch-token"
              hint={editing ? "Leave blank to keep the current token." : "From @BotFather"}
            >
              <Input
                id="ch-token"
                type="password"
                className="font-mono text-xs"
                placeholder="123456:AA…"
                value={botToken}
                onChange={(e) => setBotToken(e.target.value)}
              />
            </Field>
          )}

          {type === "whatsapp" && !editing && (
            <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 text-[12px] leading-relaxed text-muted-foreground">
              After registering, use <span className="font-medium text-foreground">Pair</span> in the
              channel row to scan the WhatsApp QR right here — the channel comes online
              automatically once linked.
            </div>
          )}

          <Field
            label="Allow from"
            htmlFor="ch-allow"
            hint="Comma-separated user/chat IDs allowed to talk to the agent. Empty = allow all."
          >
            <Input
              id="ch-allow"
              className="font-mono text-xs"
              placeholder="7789463749, 61423222658"
              value={allowFrom}
              onChange={(e) => setAllowFrom(e.target.value)}
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Model override" htmlFor="ch-model" hint="Optional. provider:model">
              <Input
                id="ch-model"
                className="font-mono text-xs"
                placeholder="anthropic:claude-sonnet-4"
                value={model}
                onChange={(e) => setModel(e.target.value)}
              />
            </Field>
            <Field label="Working dir" htmlFor="ch-cwd" hint="Optional. Agent cwd for this channel.">
              <Input
                id="ch-cwd"
                className="font-mono text-xs"
                placeholder="/home/choz/apps/vargos"
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
              />
            </Field>
          </div>

          <FieldRow label="Sentry mode" hint="Save messages that do not trigger the agent, including attachments. Off by default.">
            <Switch checked={sentryMode} onCheckedChange={setSentryMode} />
          </FieldRow>

          <FieldRow label="Enabled" hint="Disabled channels stay in config but don't connect.">
            <Switch checked={enabled} onCheckedChange={setEnabled} />
          </FieldRow>
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} disabled={busy}>
            {busy ? "Saving…" : editing ? "Save changes" : "Register"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
