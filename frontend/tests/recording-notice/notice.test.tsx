import React from 'react';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';

let disk = false;
let cached = false;
let readFails = false;
let saveFails = false;
const save = mock(async () => { if (saveFails) throw new Error('disk unavailable'); disk = cached; });
const set = mock(async (_key: string, value: boolean) => { cached = value; });
mock.module('@tauri-apps/plugin-store', () => ({ load: async () => ({
  get: async () => { if (readFails) throw new Error('read unavailable'); return cached; }, set, save,
}) }));
mock.module('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: any) => open ? <div>{children}</div> : null,
  DialogContent: ({ children }: any) => <div>{children}</div>,
  DialogHeader: ({ children }: any) => <div>{children}</div>,
  DialogTitle: ({ children }: any) => <h2>{children}</h2>,
  DialogDescription: ({ children }: any) => <p>{children}</p>,
}));
mock.module('@/components/ui/checkbox', () => ({ Checkbox: (props: any) => <input {...props} type="checkbox" /> }));
const { RecordingNotice } = await import('../../src/components/RecordingNotice');
const acknowledged = mock(() => {});
let root: ReactTestRenderer;
const boot = async () => {
  cached = disk;
  await act(async () => { root = create(<RecordingNotice onAcknowledged={acknowledged} />); });
};
const click = async () => { await act(async () => root.root.findByType('button').props.onClick()); };
const remember = async () => { await act(async () => root.root.findByType('input').props.onCheckedChange(true)); };
beforeEach(() => { disk = false; cached = false; readFails = false; saveFails = false; save.mockClear(); set.mockClear(); acknowledged.mockClear(); });
afterEach(async () => { await act(async () => root?.unmount()); });

test('dismissal lasts for the shell session but the notice returns on next launch', async () => {
  await boot();
  expect(root.root.findByType('input').props.checked).toBe(false);
  await click();
  expect(acknowledged).toHaveBeenCalledTimes(1);
  expect(save).not.toHaveBeenCalled();
  await act(async () => root.update(<RecordingNotice onAcknowledged={acknowledged} />));
  expect(root.toJSON()).toBeNull();
  await act(async () => root.unmount());
  await boot();
  expect(root.root.findByType('button').children).toEqual(['I understand']);
});

test('permanent acknowledgement is saved and suppresses the next launch notice', async () => {
  await boot();
  await remember();
  expect(save).not.toHaveBeenCalled();
  await click();
  expect(disk).toBe(true);
  await act(async () => root.unmount());
  await boot();
  expect(root.toJSON()).toBeNull();
  expect(acknowledged).toHaveBeenCalledTimes(2);
});

test('a failed permanent save stays visible and allows session-only dismissal', async () => {
  await boot();
  await remember();
  saveFails = true;
  await click();
  expect(root.root.findByProps({ role: 'alert' })).toBeDefined();
  expect(acknowledged).not.toHaveBeenCalled();
  expect(cached).toBe(false);
  expect(disk).toBe(false);
  await act(async () => root.root.findByType('input').props.onCheckedChange(false));
  await click();
  expect(acknowledged).toHaveBeenCalledTimes(1);
});

test('an unreadable preference still shows a dismissible notice', async () => {
  readFails = true;
  await boot();
  await click();
  expect(acknowledged).toHaveBeenCalledTimes(1);
});
