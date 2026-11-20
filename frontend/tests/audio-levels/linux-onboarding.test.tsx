import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';

Object.assign(globalThis, { React, window: { location: { reload: () => {} } } });
const devices = [
  { name: 'alsa_input.pinned', device_type: 'Input', label: 'USB mic' },
  { name: 'alsa_input.default', device_type: 'Input', label: 'Internal mic', is_default: true },
  { name: 'alsa_output.default', device_type: 'Output', label: 'Speakers', is_default: true },
];
let prefs: Record<string, unknown>;
const writes: unknown[] = [];
const starts: unknown[] = [];
const completeOnboarding = mock(async () => {});
mock.module('@tauri-apps/api/core', () => ({
  invoke: async (command: string, args?: { preferences?: unknown; deviceNames?: unknown }) => {
    switch (command) {
      case 'get_audio_devices': return devices;
      case 'get_recording_preferences': return prefs;
      case 'start_audio_level_monitoring': starts.push(args?.deviceNames); return;
      case 'stop_audio_level_monitoring': return;
      case 'set_recording_preferences': writes.push(args?.preferences); return;
      default: throw new Error(`Unexpected command ${command}`);
    }
  },
}));
mock.module('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
mock.module('@/hooks/usePlatform', () => ({ usePlatform: () => 'linux' }));
mock.module('@/contexts/OnboardingContext', () => ({
  useOnboarding: () => ({ goPrevious: () => {}, completeOnboarding }),
}));
mock.module('@/components/onboarding/OnboardingContainer', () => ({
  OnboardingContainer: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
function SelectStub(props: { value: string; onValueChange: (value: string) => void; children: React.ReactNode }) {
  return <>{props.children}</>;
}
function Content({ children }: { children: React.ReactNode }) { return <>{children}</>; }
mock.module('@/components/ui/select', () => ({
  Select: SelectStub, SelectContent: Content, SelectItem: Content, SelectTrigger: Content, SelectValue: () => null,
}));
const { AudioTestStep } = await import('../../src/components/onboarding/steps/AudioTestStep');
let view: ReactTestRenderer | undefined;
beforeEach(() => {
  prefs = { preferred_mic_device: null, preferred_system_device: null, save_folder: '/existing', mic_gain: 1.5 };
  writes.length = starts.length = 0;
  completeOnboarding.mockClear();
});
afterEach(async () => {
  await act(async () => view?.unmount());
  view = undefined;
});
async function mount() { await act(async () => { view = create(<AudioTestStep />); }); }
async function finish() {
  const buttons = view!.root.findAllByType('button');
  await act(async () => { buttons.at(-1)!.props.onClick(); });
}

test('Linux previews desktop defaults without writing preferences when no choice was changed', async () => {
  await mount();
  expect(starts).toEqual([['default (input)', 'default (output)']]);
  await finish();
  expect(writes).toEqual([]);
  expect(completeOnboarding).toHaveBeenCalledTimes(1);
});

test('Linux preserves a missing output preference and saves only the changed mic choice', async () => {
  prefs.preferred_mic_device = 'alsa_input.pinned (input)';
  prefs.preferred_system_device = 'unplugged (output)';
  await mount();
  expect(starts).toEqual([['alsa_input.pinned (input)']]);
  const [mic] = view!.root.findAllByType(SelectStub);
  await act(async () => mic.props.onValueChange('default (input)'));
  expect(starts.at(-1)).toEqual(['default (input)']);
  expect(writes).toEqual([]);
  await finish();
  expect(writes).toEqual([{ ...prefs, preferred_mic_device: null }]);
});
