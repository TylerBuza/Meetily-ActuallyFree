import { describe, expect, test } from 'bun:test';
import {
  deviceDisplayName,
  deviceLabel,
  selectedDevice,
  deviceSelectValue,
  toDeviceOptionValue,
  UNAVAILABLE_DEVICE_VALUE,
} from '../../src/lib/audio-devices';

test('Linux labels stay separate from identity and ambiguous legacy names require reselect', () => {
  const devices = [
    { name: 'source.a', device_type: 'Input' as const, label: 'USB 1', legacy_name: 'USB' },
    { name: 'source.b', device_type: 'Input' as const, label: 'USB 2', legacy_name: 'USB' },
  ];
  expect(deviceLabel(devices[1])).toBe('USB 2');
  expect(toDeviceOptionValue(devices[1])).toBe('source.b (input)');
  expect(selectedDevice('source.b (input)', devices)).toBe(devices[1]);
  expect(selectedDevice('USB (input)', devices)).toBeUndefined();
  expect(selectedDevice('USB (input)', [devices[1]])).toBe(devices[1]);
  expect(selectedDevice(null, devices)).toBeUndefined();
});

describe('toDeviceOptionValue', () => {
  test('matches the string persisted in preferences', () => {
    expect(toDeviceOptionValue({ name: 'USB Audio Headphones (System Audio)', device_type: 'Output' }))
      .toBe('USB Audio Headphones (System Audio) (output)');
  });

  test('lowercases the device type', () => {
    expect(toDeviceOptionValue({ name: 'Built-in Mic', device_type: 'Input' }))
      .toBe('Built-in Mic (input)');
  });
});

describe('deviceSelectValue', () => {
  const available = ['Built-in Mic (input)', 'JBL Tune 770NC (input)'];

  test('keeps a saved device that is still available', () => {
    expect(deviceSelectValue('JBL Tune 770NC (input)', available)).toBe('JBL Tune 770NC (input)');
  });

  test('uses a distinct saved-device item so selecting Default can clear the preference', () => {
    // The disconnected-Bluetooth case: previously left the picker blank.
    expect(deviceSelectValue('Disconnected Headset (input)', available)).toBe(UNAVAILABLE_DEVICE_VALUE);
    expect(UNAVAILABLE_DEVICE_VALUE).not.toBe('default');
  });

  test('returns the default sentinel when nothing is saved', () => {
    expect(deviceSelectValue(null, available)).toBe('default');
  });

  test('falls back while the device list is still empty', () => {
    expect(deviceSelectValue('JBL Tune 770NC (input)', [])).toBe(UNAVAILABLE_DEVICE_VALUE);
  });

  test('does not match on a partial name', () => {
    expect(deviceSelectValue('JBL Tune 770NC', available)).toBe(UNAVAILABLE_DEVICE_VALUE);
  });

  test('restores a reconnected device without changing the saved preference', () => {
    const saved = 'JBL Tune 770NC (input)';
    expect(deviceSelectValue(saved, [])).toBe(UNAVAILABLE_DEVICE_VALUE);
    expect(deviceSelectValue(saved, available)).toBe(saved);
    expect(deviceSelectValue(null, available)).toBe('default');
  });
});

describe('deviceDisplayName', () => {
  test('strips the output suffix', () => {
    expect(deviceDisplayName('JBL Tune 770NC (System Audio) (output)'))
      .toBe('JBL Tune 770NC (System Audio)');
  });

  test('strips the input suffix', () => {
    expect(deviceDisplayName('Built-in Mic (input)')).toBe('Built-in Mic');
  });

  test('leaves a name with no suffix alone', () => {
    expect(deviceDisplayName('Built-in Mic')).toBe('Built-in Mic');
  });

  test('only strips a trailing suffix, not one mid-name', () => {
    expect(deviceDisplayName('Mic (input) Dock (output)')).toBe('Mic (input) Dock');
  });
});
