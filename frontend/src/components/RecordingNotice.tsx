'use client';

import { useEffect, useState } from 'react';
import { load } from '@tauri-apps/plugin-store';
import { Mic } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

const STORE = 'recording-notice.json';
const ACKNOWLEDGED = 'permanentlyAcknowledged';
const options = { autoSave: false, defaults: { [ACKNOWLEDGED]: false } };

/** Mounted by the main shell after setup, not by individual routes or the minibar. */
export function RecordingNotice({ onAcknowledged }: { onAcknowledged: () => void }) {
  const [open, setOpen] = useState(false);
  const [remember, setRemember] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    void load(STORE, options).then(async store => {
      const acknowledged = await store.get<boolean>(ACKNOWLEDGED);
      if (disposed) return;
      if (acknowledged === true) onAcknowledged();
      else setOpen(true);
    }).catch(error => {
      console.error('Could not read recording notice preference:', error);
      if (!disposed) setOpen(true);
    });
    return () => { disposed = true; };
  }, [onAcknowledged]);

  const acknowledge = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      if (remember) {
        const store = await load(STORE, options);
        await store.set(ACKNOWLEDGED, true);
        try {
          await store.save();
        } catch (error) {
          // A failed disk save must not leave the cached store claiming success.
          await store.set(ACKNOWLEDGED, false);
          throw error;
        }
      }
      setOpen(false);
      onAcknowledged();
    } catch (error) {
      console.error('Could not save recording notice preference:', error);
      setError('Could not save your preference. Try again, or uncheck the option to continue for this session.');
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  return (
    <Dialog open={open}>
      <DialogContent showCloseButton={false} onEscapeKeyDown={event => event.preventDefault()} onInteractOutside={event => event.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Mic className="h-5 w-5 text-af-accent" /> Before you record</DialogTitle>
          <DialogDescription>Recording disclosure and consent</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm text-af-text-2">
          <p>Tell everyone involved that they are being recorded before you start, and obtain any consent required by applicable law.</p>
          <p>Recording laws vary by location and situation. You are responsible for following the laws and workplace policies that apply to you and the participants.</p>
          <p>Meetily does not notify participants or obtain their consent for you.</p>
        </div>
        <label className="flex items-start gap-2 text-xs text-af-text-2">
          <Checkbox aria-label="Permanently acknowledge — don’t show this notice again" checked={remember} disabled={saving} onCheckedChange={checked => setRemember(checked === true)} />
          <span>Permanently acknowledge — don’t show this notice again</span>
        </label>
        {error && <p role="alert" className="text-xs text-af-danger">{error}</p>}
        <Button aria-label="Acknowledge recording notice" onClick={acknowledge} disabled={saving}>{saving ? 'Saving…' : 'I understand'}</Button>
      </DialogContent>
    </Dialog>
  );
}
