"use client"

import { useEffect, useState } from "react"
import { Switch } from "./ui/switch"
import { invoke } from "@tauri-apps/api/core"
import { Radar } from "lucide-react"

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
    } catch (e) {
      console.error('Failed to save meeting detection settings:', e);
    }
  };

  if (!md) {
    return <div className="max-w-2xl mx-auto p-6 text-gray-500">Loading…</div>;
  }

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-lg border border-gray-200 p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-gray-900 mb-2 flex items-center gap-2">
              <Radar className="w-5 h-5 text-blue-500" />
              Meeting Detection
            </h3>
            <p className="text-sm text-gray-600">
              Watch for meeting apps (Zoom, Teams, Slack, Webex, Discord…) and prompt you to start
              recording when one starts. Runs entirely on-device — no network, no telemetry.
            </p>
          </div>
          <Switch checked={md.enabled} onCheckedChange={(v) => saveMd({ ...md, enabled: v })} />
        </div>

        {md.enabled && (
          <div className="mt-5 space-y-4">
            <div className="flex items-center justify-between gap-4">
              <label className="text-sm text-gray-700">Check every</label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={3}
                  max={3600}
                  value={md.interval_secs}
                  onChange={(e) => setMd({ ...md, interval_secs: Number(e.target.value) || 15 })}
                  onBlur={() => saveMd({ ...md, interval_secs: Math.min(3600, Math.max(3, md.interval_secs || 15)) })}
                  className="w-20 rounded-lg border border-gray-200 px-2 py-1 text-sm focus:border-blue-400 focus:outline-none"
                />
                <span className="text-sm text-gray-500">seconds</span>
              </div>
            </div>

            <div className="flex items-center justify-between gap-4">
              <label className="text-sm text-gray-700">Also send a system notification</label>
              <Switch checked={md.notify} onCheckedChange={(v) => saveMd({ ...md, notify: v })} />
            </div>

            <div>
              <label className="text-sm text-gray-700 block mb-1">
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
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none"
              />
              <p className="text-xs text-gray-500 mt-1">
                Watched apps: {md.meeting_apps.join(', ')}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
