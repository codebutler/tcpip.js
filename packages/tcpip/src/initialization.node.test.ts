import { setImmediate } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { LoopbackBindings } from './bindings/loopback-interface.js';
import { NetworkInterfaceBindings } from './bindings/network-interface.js';
import * as files from './fetch-file.js';
import { createStack } from './stack.js';

const unhandled: unknown[] = [];
const intervals: ReturnType<typeof setInterval>[] = [];
const observeRejection = (error: unknown) => unhandled.push(error);
let intervalCalls = 0;

beforeEach(() => {
  unhandled.length = 0;
  intervalCalls = 0;
  process.on('unhandledRejection', observeRejection);
  const start = globalThis.setInterval;
  vi.spyOn(globalThis, 'setInterval').mockImplementation((...args) => {
    intervalCalls++;
    const interval = start(...args);
    intervals.push(interval);
    return interval;
  });
});
afterEach(() => {
  for (const interval of intervals.splice(0)) clearInterval(interval);
  process.off('unhandledRejection', observeRejection);
  vi.restoreAllMocks();
});

async function expectSingleFailure(
  operation: Promise<unknown>,
  error: unknown
) {
  await expect(operation).rejects.toBe(error);
  await setImmediate();
  expect(unhandled).toEqual([]);
  expect(intervalCalls).toBe(0);
}

describe('stack initialization has one readiness promise', () => {
  test('a loader rejection has no secondary unhandled promise or packet timer', async () => {
    const failure = new Error('file read failed');
    vi.spyOn(files, 'fetchFile').mockRejectedValueOnce(failure);
    await expectSingleFailure(createStack(), failure);
  });

  test('corrupt WASM rejects readiness without a secondary promise or timer', async () => {
    vi.spyOn(files, 'fetchFile').mockResolvedValueOnce(
      new Response(Uint8Array.of(1, 2, 3, 4), {
        headers: { 'Content-Type': 'application/wasm' },
      })
    );
    await expect(createStack()).rejects.toBeInstanceOf(
      WebAssembly.CompileError
    );
    await setImmediate();
    expect(unhandled).toEqual([]);
    expect(intervalCalls).toBe(0);
  });

  test('loopback creation rejection belongs to readiness', async () => {
    const failure = new Error('loopback creation failed');
    vi.spyOn(LoopbackBindings.prototype, 'create').mockRejectedValueOnce(
      failure
    );
    await expectSingleFailure(createStack(), failure);
  });

  test('default IPv6 address failure belongs to readiness', async () => {
    const failure = new Error('loopback IPv6 failed');
    vi.spyOn(
      NetworkInterfaceBindings.prototype,
      'addAddress'
    ).mockRejectedValueOnce(failure);
    await expectSingleFailure(createStack(), failure);
  });

  test('readiness waits for IPv6 completion before starting the packet timer', async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const began = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const add = NetworkInterfaceBindings.prototype.addAddress;
    vi.spyOn(
      NetworkInterfaceBindings.prototype,
      'addAddress'
    ).mockImplementationOnce(async function (
      this: NetworkInterfaceBindings,
      netInterface,
      cidr
    ) {
      entered();
      await gate;
      return add.call(this, netInterface, cidr);
    });
    let ready = false;
    const pending = createStack().then((stack) => {
      ready = true;
      return stack;
    });
    await began;
    await setImmediate();
    expect(ready).toBe(false);
    expect(intervalCalls).toBe(0);
    release();
    const stack = await pending;
    const [loopback] = [...stack.interfaces];
    expect(loopback?.addresses).toEqual(['127.0.0.1/8', '::1/128']);
    expect(stack.routes.lookup('127.0.0.1')?.via).toBe(loopback);
    expect(stack.routes.lookup('::1')?.via).toBe(loopback);
    expect(intervalCalls).toBe(1);
    expect(unhandled).toEqual([]);
  });

  test('explicit no-loopback readiness neither creates interfaces nor waits for loopback', async () => {
    const create = vi.spyOn(LoopbackBindings.prototype, 'create');
    const stack = await createStack({ initializeLoopback: false });
    expect([...stack.interfaces]).toEqual([]);
    expect(stack.routes.list()).toEqual([]);
    expect(create).not.toHaveBeenCalled();
    expect(intervalCalls).toBe(1);
    expect(unhandled).toEqual([]);
  });
});
