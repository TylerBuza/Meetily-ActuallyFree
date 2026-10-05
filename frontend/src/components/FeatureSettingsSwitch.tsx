'use client';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Switch } from '@/components/ui/switch';
import { useLabs } from '@/hooks/useLabs';
import { setLabsFeature, syncLabsFromBackend, type LabsFeature } from '@/lib/labs-features';

/** Keeps existing preference keys so moving a setting preserves saved choices. */
export function FeatureSettingsSwitch({ feature, title, description }: { feature: LabsFeature; title: string; description: string }) {
  const { labs } = useLabs();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (feature === 'voiceProfiles') void syncLabsFromBackend().catch(console.error);
  }, [feature]);
  const change = async (value: boolean) => {
    setBusy(true);
    try { await setLabsFeature(feature, value); }
    catch (error) { toast.error(`Could not update ${title}`, { description: String(error) }); }
    finally { setBusy(false); }
  };
  return <div className="flex items-start gap-4 rounded-2xl border border-af-border bg-af-panel-2/40 p-5">
    <div className="min-w-0 flex-1"><h3 className="text-sm font-semibold text-af-text">{title}</h3><p className="mt-1 text-[13px] text-af-text-3">{description}</p></div>
    <Switch aria-label={title} checked={labs[feature]} disabled={busy} onCheckedChange={value => void change(value)} />
  </div>;
}
