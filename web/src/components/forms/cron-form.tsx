"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { CronTask } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Field, FieldRow } from "@/components/hud/field";

const SCHEDULE_PRESETS: Array<{ label: string; expr: string }> = [
  { label: "every 30m", expr: "*/30 * * * *" },
  { label: "hourly", expr: "0 * * * *" },
  { label: "every 3h", expr: "0 */3 * * *" },
  { label: "daily 09:00", expr: "0 9 * * *" },
  { label: "weekdays 09:00", expr: "0 9 * * 1-5" },
  { label: "Mondays 09:00", expr: "0 9 * * 1" },
];

export function CronForm({
  open,
  onOpenChange,
  job,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** null → create; a job → edit */
  job: CronTask | null;
  onSaved: () => void;
}) {
  const editing = !!job?.id;
  const [name, setName] = useState("");
  const [schedule, setSchedule] = useState("");
  const [task, setTask] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [model, setModel] = useState("");
  const [notify, setNotify] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(job?.name ?? "");
    setSchedule(job?.schedule ?? "0 9 * * *");
    setTask(job?.task ?? "");
    setEnabled(job?.enabled ?? true);
    setModel(job?.model ?? "");
    setNotify((job?.notify ?? []).join(", "));
  }, [open, job]);

  const submit = async () => {
    if (!name.trim() || !schedule.trim() || !task.trim()) {
      toast.error("Name, schedule and prompt are all required.");
      return;
    }
    const notifyArr = notify
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    setBusy(true);
    const res = editing
      ? await api.rpc("cron.update", {
          id: job!.id,
          name: name.trim(),
          schedule: schedule.trim(),
          task,
          enabled,
          ...(model.trim() ? { model: model.trim() } : { model: undefined }),
          notify: notifyArr,
        })
      : await api.rpc("cron.add", {
          name: name.trim(),
          schedule: schedule.trim(),
          task,
          ...(model.trim() ? { model: model.trim() } : {}),
          notify: notifyArr,
        });
    setBusy(false);

    if (res.ok) {
      toast.success(editing ? `Updated "${name}".` : `Created "${name}".`);
      onOpenChange(false);
      onSaved();
    } else {
      toast.error(res.error ?? "Save failed");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={editing ? `Edit cron · ${job?.name}` : "New cron job"}
        description="Frontmatter drives the schedule; the prompt is what the agent runs."
        className="max-w-xl"
      >
        <div className="space-y-4">
          <Field label="Name" htmlFor="cron-name">
            <Input
              id="cron-name"
              placeholder="daily-standup"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>

          <Field
            label="Schedule (cron)"
            htmlFor="cron-sched"
            hint="Standard 5-field cron. Times are the daemon's local timezone."
          >
            <Input
              id="cron-sched"
              className="font-mono"
              placeholder="0 9 * * *"
              value={schedule}
              onChange={(e) => setSchedule(e.target.value)}
            />
            <div className="flex flex-wrap gap-1.5 pt-1">
              {SCHEDULE_PRESETS.map((p) => (
                <button
                  key={p.expr}
                  type="button"
                  onClick={() => setSchedule(p.expr)}
                  className="rounded-md border border-border/70 px-2 py-0.5 font-mono text-[10.5px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
                >
                  {p.label}
                </button>
              ))}
            </div>
          </Field>

          <Field
            label="Prompt"
            htmlFor="cron-task"
            hint="Supports ${WORKSPACE_DIR}, ${DATA_DIR}, ${CURRENT_DATE}, … interpolation."
          >
            <Textarea
              id="cron-task"
              rows={7}
              className="font-mono text-[12.5px]"
              placeholder="Check the GPU nodes and post a summary to the ops channel."
              value={task}
              onChange={(e) => setTask(e.target.value)}
            />
          </Field>

          <Field
            label="Model"
            htmlFor="cron-model"
            hint='Optional override as "provider:modelId" (e.g. deepseek:deepseek-v4-flash). Blank → agent default.'
          >
            <Input
              id="cron-model"
              className="font-mono text-xs"
              placeholder="local:vllm:qwen3.8-27b-uncensored"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            />
          </Field>

          <Field
            label="Notify"
            htmlFor="cron-notify"
            hint="Comma-separated session keys, e.g. telegram-ops:123, whatsapp-me:456"
          >
            <Input
              id="cron-notify"
              className="font-mono text-xs"
              placeholder="telegram-ops:7789463749"
              value={notify}
              onChange={(e) => setNotify(e.target.value)}
            />
          </Field>

          {editing && (
            <FieldRow label="Enabled" hint="Disabled jobs stay defined but don't fire.">
              <Switch checked={enabled} onCheckedChange={setEnabled} />
            </FieldRow>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} disabled={busy}>
            {busy ? "Saving…" : editing ? "Save changes" : "Create job"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
