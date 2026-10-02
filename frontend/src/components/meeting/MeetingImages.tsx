'use client';

import { useCallback, useEffect, useState, type ClipboardEvent, type ReactNode } from 'react';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { Camera, ImagePlus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { MEETING_IMAGES_CHANGED, type MeetingImage } from '@/lib/meeting-images';

function stamp(seconds: number): string {
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

async function screenImage(): Promise<Blob> {
  if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('Screen capture is unavailable in this WebView. Paste a screenshot instead.');
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  const video = document.createElement('video');
  video.srcObject = stream;
  try {
    await video.play();
    if (!video.videoWidth) await new Promise<void>((resolve) => { video.onloadedmetadata = () => resolve(); });
    const scale = Math.min(1, 1920 / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.86));
    if (!blob) throw new Error('Could not encode the screenshot');
    return blob;
  } finally {
    stream.getTracks().forEach((track) => track.stop());
    video.srcObject = null;
  }
}

/** Meeting-local image strip. Paste is scoped to notes, never the whole app. */
export function MeetingImages({ meetingId, live = false, currentTime = 0, onSeek, children }: {
  meetingId?: string;
  live?: boolean;
  currentTime?: number;
  onSeek?: (seconds: number) => void;
  children: ReactNode;
}) {
  const [images, setImages] = useState<MeetingImage[]>([]);
  const [isMac, setIsMac] = useState(false);
  useEffect(() => setIsMac(/Macintosh|Mac OS X/.test(navigator.userAgent)), []);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<MeetingImage | null>(null);
  const refresh = useCallback(async () => {
    try {
      setImages(await invoke<MeetingImage[]>('list_meeting_images', { meetingId, live }));
    } catch (error) {
      // A recording folder is not available until native capture starts.
      if (!live) console.error('Could not list meeting images', error);
    }
  }, [meetingId, live]);
  useEffect(() => { void refresh(); }, [refresh]);

  const add = async (blob: Blob) => {
    if (busy) return;
    setBusy(true);
    try {
      const audioTime = live
        ? (await invoke<{ active_duration?: number; is_recording?: boolean }>('get_recording_state')).active_duration
        : currentTime;
      if (audioTime === undefined || !Number.isFinite(audioTime)) throw new Error('Recording time is unavailable');
      const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
      const image = await invoke<MeetingImage>('save_meeting_image', { meetingId, live, audioTime, bytes });
      setImages((current) => [...current, image].sort((a, b) => a.audioTime - b.audioTime));
      if (!live) window.dispatchEvent(new Event(MEETING_IMAGES_CHANGED));
      toast.success(`Image saved at ${stamp(image.audioTime)}`);
    } catch (error) {
      toast.error(`Could not save image: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const image = Array.from(event.clipboardData.items).find((item) => item.type.startsWith('image/'))?.getAsFile();
    if (!image) return;
    event.preventDefault();
    event.stopPropagation();
    void add(image);
  };

  const remove = async (image: MeetingImage) => {
    try {
      await invoke('delete_meeting_image', { meetingId, live, imageId: image.id });
      setImages((current) => current.filter((item) => item.id !== image.id));
      if (!live) window.dispatchEvent(new Event(MEETING_IMAGES_CHANGED));
      setSelected(null);
      toast.success('Image removed');
    } catch (error) {
      toast.error(`Could not remove image: ${String(error)}`);
    }
  };

  return (
    <div onPasteCapture={onPaste}>
      {children}
      <div className="mt-4 border-t border-af-border pt-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-semibold text-af-text">Images at meeting moments</h3>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void screenImage().then(add).catch((error) => toast.error(String(error)))}>
            <Camera className="h-3.5 w-3.5" /> Capture screenshot
          </Button>
        </div>
        <p className="mt-1 text-[11px] text-af-text-4">Paste an image in the notes, or capture a window. It is saved at the current recording or playback time.{isMac ? ' In the macOS picker, hover over a window and choose Share This Window.' : ''}</p>
        {images.length > 0 ? (
          <div className="mt-3 flex gap-2 overflow-x-auto pb-2">
            {images.map((image) => (
              <div key={image.id} className="w-32 shrink-0 overflow-hidden rounded-lg border border-af-border bg-af-panel-2">
                <button type="button" className="block w-full" onClick={() => setSelected(image)} aria-label={`Open image at ${stamp(image.audioTime)}`}>
                  <img src={convertFileSrc(image.path)} alt={`Meeting image at ${stamp(image.audioTime)}`} className="h-20 w-full object-cover" />
                </button>
                <button type="button" className="flex w-full items-center gap-1 px-2 py-1 text-left text-[11px] text-af-accent hover:underline" onClick={() => onSeek?.(image.audioTime)} disabled={!onSeek}>
                  <ImagePlus className="h-3 w-3" /> {stamp(image.audioTime)}
                </button>
              </div>
            ))}
          </div>
        ) : null}
      </div>
      <Dialog open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}>
        <DialogContent className="max-w-4xl">
          <DialogHeader><DialogTitle>Meeting image · {selected ? stamp(selected.audioTime) : ''}</DialogTitle></DialogHeader>
          {selected && <img src={convertFileSrc(selected.path)} alt={`Meeting image at ${stamp(selected.audioTime)}`} className="max-h-[70vh] w-full object-contain" />}
          <div className="flex justify-end gap-2">
            {selected && onSeek && <Button variant="secondary" onClick={() => { onSeek(selected.audioTime); setSelected(null); }}>Play from here</Button>}
            {selected && <Button variant="ghost" onClick={() => void remove(selected)}><Trash2 /> Remove image</Button>}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
