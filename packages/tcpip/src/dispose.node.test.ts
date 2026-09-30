import { setImmediate } from 'node:timers/promises';
import { createDns } from '@tcpip/dns';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createDhcp } from '../../dhcp/src/index.js';
import { NetworkInterfaceBindings } from './bindings/network-interface.js';
import { TcpBindings } from './bindings/tcp.js';
import * as files from './fetch-file.js';
import { VirtualNetworkStack, createStack } from './stack.js';
import type { NetworkStack } from './types.js';

const stacks: NetworkStack[] = [];
const unhandled: unknown[] = [];
const observe = (error: unknown) => unhandled.push(error);
const settled = <T>(operation: Promise<T>) =>
  operation.then(
    (value) => ({ value, error: undefined }),
    (error) => ({ value: undefined, error })
  );
const down = { code: 'ENETDOWN' };
async function stack() {
  const value = await createStack();
  stacks.push(value);
  return value;
}
async function pair(value: NetworkStack) {
  const listener = await value.tcp.listen({ host: '127.0.0.1', port: 2080 });
  const accepting = listener[Symbol.asyncIterator]().next();
  const client = await value.tcp.connect({ host: '127.0.0.1', port: 2080 });
  const server = (await accepting).value!;
  return { client, server, listener };
}
beforeEach(() => {
  unhandled.length = 0;
  process.on('unhandledRejection', observe);
});
afterEach(async () => {
  await Promise.all(stacks.splice(0).map((value) => value.dispose()));
  await setImmediate();
  process.off('unhandledRejection', observe);
  vi.restoreAllMocks();
  expect(unhandled).toEqual([]);
});

test('dispose clears its exact timer immediately and shares an idempotent completion', async () => {
  const start = vi.spyOn(globalThis, 'setInterval');
  const clear = vi.spyOn(globalThis, 'clearInterval');
  const value = await stack();
  const timer = start.mock.results.find(
    (result) => result.type === 'return'
  )!.value;
  const pending = value.dispose();
  expect(clear).toHaveBeenCalledWith(timer);
  expect(value.dispose()).toBe(pending);
  await pending;
  expect([...value.interfaces]).toEqual([]);
  expect(value.routes.list()).toEqual([]);
  expect(clear).toHaveBeenCalledTimes(1);
});

test('new work and retained interface handles fail after disposal; a new stack still works', async () => {
  const value = await stack();
  const [oldInterface] = [...value.interfaces];
  await value.dispose();
  for (const operation of [
    value.tcp.connect({ host: '127.0.0.1', port: 2080 }),
    value.tcp.listen({ port: 2080 }),
    value.udp.open(),
    value.ping.createSession({ host: '127.0.0.1' }),
    value.interfaces.createLoopback({ ip: '127.0.0.1/8' }),
  ])
    await expect(operation).rejects.toMatchObject(down);
  expect(() => oldInterface!.mtu).toThrow();
  expect(() =>
    value.routes.add({ destination: '127.0.0.0/8', via: oldInterface! })
  ).toThrow();
  const fresh = await stack();
  const socket = await fresh.udp.open();
  await socket.close();
});

test('pending TCP accept and UDP reads finish without orphan rejections', async () => {
  const value = await stack();
  const listener = await value.tcp.listen({ port: 2080 });
  const iterator = listener[Symbol.asyncIterator]();
  const accepted = iterator.next();
  const udp = await value.udp.open();
  const reader = udp.readable.getReader();
  const received = reader.read();
  await value.dispose();
  expect(await accepted).toEqual({ value: undefined, done: true });
  expect(await received).toEqual({ value: undefined, done: true });
  expect(await iterator.next()).toEqual({ value: undefined, done: true });
  reader.releaseLock();
  await udp.close();
  await udp.close();
});

test('pending TCP connect rejects promptly without waiting for peer/timeouts', async () => {
  const value = await stack();
  const connecting = settled(
    value.tcp.connect({ host: '127.0.0.2', port: 2080 })
  );
  await setImmediate();
  await value.dispose();
  expect((await connecting).error).toMatchObject(down);
});

test('blocked TCP write and active reads reject on disposal', async () => {
  const value = await stack();
  const { client, server } = await pair(value);
  const reader = client.readable.getReader();
  const reading = settled(reader.read());
  const writer = client.writable.getWriter();
  let finished = false;
  const writing = settled(writer.write(new Uint8Array(1_000_000))).then(
    (result) => {
      finished = true;
      return result;
    }
  );
  await setImmediate();
  expect(finished).toBe(false);
  await value.dispose();
  expect((await writing).error).toMatchObject(down);
  expect((await reading).error).toMatchObject(down);
  await client.close();
  await server.close();
  writer.releaseLock();
  reader.releaseLock();
});

test('pending graceful close and half-close ACK retries reject, without waiting on stopped packet processing', async () => {
  const register = TcpBindings.prototype.register;
  vi.spyOn(TcpBindings.prototype, 'register').mockImplementation(function (
    this: TcpBindings,
    exports
  ) {
    register.call(this, {
      ...exports,
      close_tcp_connection: () => -1,
      shutdown_tcp_connection_write: () => -1,
    });
  });
  const value = await stack();
  const { client, server } = await pair(value);
  const writer = client.writable.getWriter();
  const halfClose = settled(writer.close());
  const closing = settled(client.close());
  await setImmediate();
  await value.dispose();
  expect((await halfClose).error).toMatchObject(down);
  expect((await closing).error).toMatchObject(down);
  await server.close();
  writer.releaseLock();
});

test('disposal terminates DNS waits and prevents late TCP/UDP host resolution allocation', async () => {
  const value = await stack();
  const tcp = settled(
    value.tcp.connect({ host: 'pending.invalid', port: 2080 })
  );
  const udp = settled(value.udp.open({ host: 'pending.invalid' }));
  await setImmediate();
  await value.dispose();
  expect((await tcp).error).toMatchObject(down);
  expect((await udp).error).toMatchObject(down);
});

test('disposal terminates a UDP send blocked on DNS and is safe with a held writer', async () => {
  const value = await stack();
  const udp = await value.udp.open();
  const writer = udp.writable.getWriter();
  const writing = settled(
    writer.write({
      host: 'pending.invalid',
      port: 2080,
      data: new Uint8Array([1]),
    })
  );
  await setImmediate();
  await value.dispose();
  expect((await writing).error).toMatchObject(down);
  writer.releaseLock();
});

test('ping probe timers are cleared and held sessions reject new probes', async () => {
  const value = await stack();
  const ping = await value.ping.createSession({
    host: '127.0.0.2',
    timeout: 60_000,
  });
  const clear = vi.spyOn(globalThis, 'clearTimeout');
  const pending = settled(ping.ping());
  await value.dispose();
  expect((await pending).error).toMatchObject(down);
  expect(clear).toHaveBeenCalled();
  await expect(ping.ping()).rejects.toMatchObject(down);
  await ping.close();
});

test('actual DNS/DHCP server loops end without secondary unhandled rejection', async () => {
  const value = await stack();
  await (await createDns(value.udp)).serve({ request: async () => undefined });
  await (await createDhcp(value.udp)).serve({
    leaseRange: { start: '10.0.0.2', end: '10.0.0.10' },
    serverIdentifier: '10.0.0.1',
    netmask: '255.255.255.0',
    router: '10.0.0.1',
  });
  await value.dispose();
  await setImmediate();
  expect(unhandled).toEqual([]);
});

test('tap/tun readers finish and writers cannot reenter the disposed WASM instance', async () => {
  const value = await stack();
  for (const netInterface of [
    await value.interfaces.createTap(),
    await value.interfaces.createTun({ ip: '10.0.0.1/24' }),
  ]) {
    const reader = netInterface.readable.getReader();
    const pending = reader.read();
    const writer = netInterface.writable.getWriter();
    await value.dispose();
    expect(await pending).toEqual({ value: undefined, done: true });
    await expect(writer.write(new Uint8Array([0]))).rejects.toMatchObject(down);
    reader.releaseLock();
    writer.releaseLock();
  }
});

test('dispose during WASM load prevents late registration/timer and observes ready rejection', async () => {
  const fetch = files.fetchFile;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(files, 'fetchFile').mockImplementationOnce(async (...args) => {
    await gate;
    return fetch(...args);
  });
  const interval = vi.spyOn(globalThis, 'setInterval');
  const value = new VirtualNetworkStack();
  stacks.push(value);
  const ready = settled(value.ready);
  const disposed = value.dispose();
  let completed = false;
  void disposed.then(() => {
    completed = true;
  });
  await setImmediate();
  expect(completed).toBe(false);
  release();
  await disposed;
  expect((await ready).error).toMatchObject(down);
  expect(interval).not.toHaveBeenCalled();
});

test('dispose during default address setup releases partially attached interfaces', async () => {
  const add = NetworkInterfaceBindings.prototype.addAddress;
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const began = new Promise<void>((resolve) => {
    entered = resolve;
  });
  vi.spyOn(
    NetworkInterfaceBindings.prototype,
    'addAddress'
  ).mockImplementationOnce(async function (
    this: NetworkInterfaceBindings,
    ...args
  ) {
    entered();
    await gate;
    return add.apply(this, args);
  });
  const value = new VirtualNetworkStack();
  stacks.push(value);
  const ready = settled(value.ready);
  await began;
  const disposed = value.dispose();
  release();
  await disposed;
  expect((await ready).error).toBeInstanceOf(Error);
  expect([...value.interfaces]).toEqual([]);
});

test('work queued at the ready boundary cannot allocate after disposal', async () => {
  const value = await stack();
  const pending = [
    settled(value.tcp.listen({ port: 2080 })),
    settled(value.udp.open()),
    settled(value.interfaces.createTap()),
  ];
  await value.dispose();
  for (const operation of pending)
    expect((await operation).error).toMatchObject(down);
  expect([...value.interfaces]).toEqual([]);
});

test('already accepted queued connections are retired without a late accept delivery', async () => {
  const value = await stack();
  const listener = await value.tcp.listen({ host: '127.0.0.1', port: 2080 });
  const client = await value.tcp.connect({ host: '127.0.0.1', port: 2080 });
  await value.dispose();
  expect(await listener[Symbol.asyncIterator]().next()).toEqual({
    value: undefined,
    done: true,
  });
  await client.close();
});
