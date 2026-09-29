import React from 'react';
import { act, create } from 'react-test-renderer';
import { expect, mock, spyOn, test } from 'bun:test';

const listeners = new Set<(event: { payload: any }) => void>();
mock.module('@tauri-apps/api/event', () => ({
  listen: async (_name: string, listener: (event: { payload: any }) => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
}));
const { LiveAudioVisualizer } = await import('../../src/components/LiveAudioVisualizer');

test('live system advice expires without callbacks, prioritizes limiting and clears on pause', async () => {
  let now = 0;
  const clock = spyOn(performance, 'now').mockImplementation(() => now);
  let view: ReturnType<typeof create> | undefined;
  const emit = (source: string, rms: number, peak: number, limiter_hit = false) => {
    for (const listener of listeners) listener({ payload: { source, rms, peak, limiter_hit } });
  };
  try {
    await act(async () => { view = create(<LiveAudioVisualizer active source="system" />); });
    const status = () => view!.root.findAllByProps({ role: 'status' }).map(node => node.children.join('')).join('');
    act(() => {
      for (now = 0; now <= 5000; now += 40) emit('mic', 0.002, 0.008);
    });
    expect(status()).toBe('');
    act(() => {
      for (now = 0; now <= 5000; now += 40) emit('system', 0.002, 0.008);
    });
    expect(status()).toBe('Low audio');
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1100)); });
    expect(status()).toBe('');
    act(() => {
      for (now = 6000; now <= 6840; now += 40) emit('system', 0.5, 0.9, true);
      for (now = 7000; now <= 12000; now += 40) emit('system', 0.002, 0.008);
    });
    expect(status()).toBe('Too loud');
    await act(async () => { view!.update(<LiveAudioVisualizer active={false} source="system" />); });
    expect(status()).toBe('');
    expect(listeners.size).toBe(0);
  } finally {
    if (view) act(() => view!.unmount());
    clock.mockRestore();
  }
});
