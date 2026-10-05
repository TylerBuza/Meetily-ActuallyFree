export async function screenImage(): Promise<Blob> {
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
