"use client"

import { useEffect, useState } from "react"
import { Switch } from "./ui/switch"
import { Badge } from "./ui/badge"
import { invoke } from "@tauri-apps/api/core"
import { Radar, Workflow } from "lucide-react"
import { toast } from "sonner"
import { useLabs } from "@/hooks/useLabs"
import { setLabsFeature } from "@/lib/labs-features"

interface MeetingDetectionSettings {
  enabled: boolean;
  interval_secs: number;
  meeting_apps: string[];
  ignored_apps: string[];
  notify: boolean;
}

/**
 * Meeting Detection settings panel. Watches running processes for meeting apps
 * (Zoom / Teams / Slack / Webex / Discord / …) and prompts to start recording.
 * Fully on-device. Persisted install-locally via Rust.
 */
export function MeetingDetectionSettings() {
  const [md, setMd] = useState<MeetingDetectionSettings | null>(null);
  const [ignoredInput, setIgnoredInput] = useState('');
  const { labs } = useLabs();
  const [automationBusy, setAutomationBusy] = useState(false);

  useEffect(() => {
    invoke<MeetingDetectionSettings>('get_meeting_detection_settings')
      .then((s) => {
        setMd(s);
        setIgnoredInput((s.ignored_apps || []).join(', '));
      })
      .catch((e) => console.error('Failed to load meeting detection settings:', e));
  }, []);

  const saveMd = async (next: MeetingDetectionSettings) => {
    setMd(next);
    try {
      await invoke('set_meeting_detection_settings', { settings: next });
      // Automation acts on detection's events; without detection it is off too.
      if (!next.enabled && labs.meetingAutomation) await setLabsFeature('meetingAutomation', false);
    } catch (e) {
      console.error('Failed to save meeting detection settings:', e);
    }
  };

  // Labs: turning automation on also turns detection on.
  const setAutomation = async (value: boolean) => {
    setAutomationBusy(true);
    try {
      await setLabsFeature('meetingAutomation', value);
      if (value && md && !md.enabled) setMd({ ...md, enabled: true });
    } catch (error) {
      toast.error('Could not change meeting automation', { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setAutomationBusy(false);
    }
  };

  if (!md) {
    return <div className="max-w-2xl mx-auto p-6 text-af-text-3">Loading…</div>;
  }

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-af-border bg-af-panel-2/40 p-5">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-[15px] font-semibold text-af-text mb-2 flex items-center gap-2">
              <Radar className="w-5 h-5 text-af-accent" />
              Meeting Detection
            </h3>
            <p className="text-sm text-af-text-2">
              Watch for meeting apps (Zoom, Teams, Slack, Webex, Discord…) and prompt you to start
              recording when one starts. Runs entirely on-device — no network, no telemetry.
            </p>
          </div>
          <Switch checked={md.enabled} onCheckedChange={(v) => saveMd({ ...md, enabled: v })} />
        </div>

        {md.enabled && (
          <div className="mt-5 space-y-4">
            <div className="flex items-center justify-between gap-4">
              <label className="text-sm text-af-text-2">Check every</label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={3}
                  max={3600}
                  value={md.interval_secs}
                  onChange={(e) => setMd({ ...md, interval_secs: Number(e.target.value) || 15 })}
                  onBlur={() => saveMd({ ...md, interval_secs: Math.min(3600, Math.max(3, md.interval_secs || 15)) })}
                  className="w-20 rounded-lg border border-af-border px-2 py-1 text-sm focus:border-af-accent/40 focus:outline-none"
                />
                <span className="text-sm text-af-text-3">seconds</span>
              </div>
            </div>

            <div className="flex items-center justify-between gap-4">
              <label className="text-sm text-af-text-2">Also send a system notification</label>
              <Switch checked={md.notify} onCheckedChange={(v) => saveMd({ ...md, notify: v })} />
            </div>

            <div>
              <label className="text-sm text-af-text-2 block mb-1">
                Ignore these apps (comma-separated)
              </label>
              <input
                type="text"
                value={ignoredInput}
                onChange={(e) => setIgnoredInput(e.target.value)}
                onBlur={() =>
                  saveMd({
                    ...md,
                    ignored_apps: ignoredInput
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
                placeholder="e.g. obs64, teamviewer"
                className="w-full rounded-lg border border-af-border px-3 py-2 text-sm focus:border-af-accent/40 focus:outline-none"
              />
              <p className="text-xs text-af-text-3 mt-1">
                Watched apps: {md.meeting_apps.join(', ')}
              </p>
            </div>
          </div>
        )}
      </div>

      <div className="flex items-start gap-4 rounded-2xl border border-af-border bg-af-panel-2/40 p-5">
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-af-accent/[0.12] text-af-accent">
          <Workflow className="h-[18px] w-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="flex items-center gap-2 text-[15px] font-semibold text-af-text">
            Start and stop recordings automatically
            <Badge variant="accent" size="xs">Labs</Badge>
          </h3>
          <p className="mt-0.5 text-[13px] leading-relaxed text-af-text-3">
            Instead of prompting, record a detected call once it uses your microphone or camera, and stop and save when it
            ends. Recordings you start yourself are never stopped.
          </p>
        </div>
        <Switch
          checked={labs.meetingAutomation}
          disabled={automationBusy}
          onCheckedChange={(value) => void setAutomation(value)}
          aria-label="Start and stop recordings automatically"
          className="mt-1 shrink-0"
        />
      </div>
    </div>
  );
}
