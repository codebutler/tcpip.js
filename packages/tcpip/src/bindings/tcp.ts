import type { DnsClient } from '@tcpip/dns';
import { fromReadable } from '@tcpip/transport';
import { formatAddress, parseAddress } from '../ip.js';
import { LwipError } from '../lwip/errors.js';
import { NetworkError } from '../network-error.js';
import type { RouteTable } from '../routes.js';
import type {
  IpEndpoint,
  TcpConnection,
  TcpConnectionOptions,
  TcpListener,
  TcpListenerOptions,
} from '../types.js';
import { EventMap, Hooks, nextMicrotask } from '../util.js';
import { Bindings } from './base.js';
import type { Pointer } from './types.js';

type TcpListenerHandle = Pointer;
type TcpConnectionHandle = Pointer;

// biome-ignore lint/complexity/noBannedTypes: intentionally empty hook type
type TcpListenerOuterHooks = {};

type TcpListenerInnerHooks = {
  dispose(): void;
  accept(connection: TcpConnection): void;
};

type TcpConnectionOuterHooks = {
  send(data: Uint8Array): Promise<void>;
  updateReceiveBuffer(length: number): void;
  close(): Promise<void>;
  closeWrite(): Promise<void>;
};

type TcpConnectionInnerHooks = {
  dispose(error: Error): void;
  receive(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
};

const tcpListenerHooks = new Hooks<
  TcpListener,
  TcpListenerOuterHooks,
  TcpListenerInnerHooks
>();

const tcpConnectionHooks = new Hooks<
  TcpConnection,
  TcpConnectionOuterHooks,
  TcpConnectionInnerHooks
>();

export const MAX_SEGMENT_SIZE = 1448; // effective data per segment: TCP_MSS (1460) - timestamp option (12)
export const MAX_WINDOW_SIZE = MAX_SEGMENT_SIZE * 4; // This must match TCP_WND in lwipopts.h
export const SEND_BUFFER_SIZE = MAX_SEGMENT_SIZE * 4; // This must match TCP_SND_BUF in lwipopts.h
export const READABLE_HIGH_WATER_MARK = MAX_SEGMENT_SIZE;

export type TcpImports = {
  accept_tcp_connection(
    listenerHandle: TcpListenerHandle,
    connectionHandle: TcpConnectionHandle
  ): Promise<void>;
  connected_tcp_connection(handle: TcpConnectionHandle): Promise<void>;
  closed_tcp_connection(handle: TcpConnectionHandle): Promise<void>;
  receive_tcp_chunk(
    handle: TcpConnectionHandle,
    chunkPtr: number,
    length: number
  ): Promise<void>;
  sent_tcp_chunk(handle: TcpConnectionHandle, length: number): void;
};

export type TcpExports = {
  create_tcp_listener(
    family: number,
    host: Pointer | null,
    port: number
  ): TcpListenerHandle;
  create_tcp_connection(
    family: number,
    host: Pointer,
    port: number
  ): TcpConnectionHandle;
  close_tcp_connection(handle: TcpConnectionHandle): number;
  shutdown_tcp_connection_write(handle: TcpConnectionHandle): number;
  send_tcp_chunk(
    handle: TcpConnectionHandle,
    chunk: number,
    length: number
  ): number;
  update_tcp_receive_buffer(handle: TcpConnectionHandle, length: number): void;
  get_tcp_local_address_family(handle: TcpConnectionHandle): 4 | 6;
  get_tcp_local_address(handle: TcpConnectionHandle): Pointer;
  get_tcp_local_port(handle: TcpConnectionHandle): number;
  get_tcp_remote_address_family(handle: TcpConnectionHandle): 4 | 6;
  get_tcp_remote_address(handle: TcpConnectionHandle): Pointer;
  get_tcp_remote_port(handle: TcpConnectionHandle): number;
};

type AckWaiter = { resolve(length: number): void; reject(error: Error): void };
type AckWaiters = Map<TcpConnectionHandle, Set<AckWaiter>>;

export class TcpBindings extends Bindings<TcpImports, TcpExports> {
  #tcpListeners = new Map<TcpListenerHandle, TcpListener>();
  #tcpConnections = new Map<TcpConnectionHandle, TcpConnection>();
  #tcpConnectEvents = new EventMap<TcpConnectionHandle, TcpConnection>();
  #tcpAcks: AckWaiters = new Map();
  #tcpCloseAcks: AckWaiters = new Map();
  #dnsClient: DnsClient;
  #routes: RouteTable;

  async #resolveHost(host: string) {
    try {
      return parseAddress(host);
    } catch {
      const ip = await this.#dnsClient.lookup(host);
      return parseAddress(ip);
    }
  }

  constructor(dnsClient: DnsClient, routes: RouteTable) {
    super();
    this.#dnsClient = dnsClient;
    this.#routes = routes;
  }

  override dispose(error?: Error) {
    super.dispose(error);
    this.#tcpConnectEvents.rejectAll(this.disposedError!);
    for (const map of [this.#tcpAcks, this.#tcpCloseAcks]) {
      for (const waiters of map.values()) {
        for (const waiter of waiters) waiter.reject(this.disposedError!);
      }
      map.clear();
    }
    for (const listener of this.#tcpListeners.values()) {
      tcpListenerHooks.getInner(listener).dispose();
    }
    for (const connection of this.#tcpConnections.values()) {
      tcpConnectionHooks.getInner(connection).dispose(this.disposedError!);
    }
    this.#tcpListeners.clear();
    this.#tcpConnections.clear();
  }

  #waitForAck(map: AckWaiters, handle: TcpConnectionHandle) {
    this.assertActive();
    return new Promise<number>((resolve, reject) => {
      const waiters = map.get(handle) ?? new Set();
      waiters.add({ resolve, reject });
      map.set(handle, waiters);
    });
  }

  async #closeConnection(handle: TcpConnectionHandle) {
    while (true) {
      const result = this.exports.close_tcp_connection(handle);

      if (result === LwipError.ERR_OK) {
        return;
      }

      if (result !== LwipError.ERR_MEM) {
        throw new Error(`failed to close tcp connection: ${result}`);
      }

      await this.#waitForAck(this.#tcpCloseAcks, handle);
    }
  }

  async #closeConnectionWrite(handle: TcpConnectionHandle) {
    while (true) {
      const result = this.exports.shutdown_tcp_connection_write(handle);

      if (result === LwipError.ERR_OK) {
        return;
      }

      if (result !== LwipError.ERR_MEM) {
        throw new Error(`failed to shutdown tcp write side: ${result}`);
      }

      await this.#waitForAck(this.#tcpCloseAcks, handle);
    }
  }

  imports = {
    accept_tcp_connection: async (
      listenerHandle: TcpListenerHandle,
      connectionHandle: TcpConnectionHandle
    ) => {
      const listener = this.#tcpListeners.get(listenerHandle);

      if (!listener) {
        console.error('new tcp connection to unknown listener');
        return;
      }

      const connection = new VirtualTcpConnection(
        this.#getEndpoint(connectionHandle, 'local'),
        this.#getEndpoint(connectionHandle, 'remote')
      );

      tcpConnectionHooks.setOuter(connection, {
        send: async (data) => {
          using pointer = this.copyToMemory(data);
          const dataPtr = Number(pointer);

          let bytesQueued = this.exports.send_tcp_chunk(
            connectionHandle,
            dataPtr,
            data.length
          );

          // If the entire data was not queued, send the remaining
          // chunks as space becomes available
          while (bytesQueued < data.length) {
            await this.#waitForAck(this.#tcpAcks, connectionHandle);
            const bytesRemaining = data.length - bytesQueued;

            bytesQueued += this.exports.send_tcp_chunk(
              connectionHandle,
              dataPtr + bytesQueued,
              bytesRemaining
            );
          }
        },
        updateReceiveBuffer: (length: number) => {
          this.exports.update_tcp_receive_buffer(connectionHandle, length);
        },
        close: async () => {
          await this.#closeConnection(connectionHandle);
        },
        closeWrite: async () => {
          await this.#closeConnectionWrite(connectionHandle);
        },
      });

      this.#tcpConnections.set(connectionHandle, connection);

      // Wait for synchronous lwIP operations to complete to prevent reentrancy issues.
      // The handle is registered first so early peer data is not dropped.
      await nextMicrotask();
      if (
        this.disposedError ||
        this.#tcpListeners.get(listenerHandle) !== listener
      )
        return;

      tcpListenerHooks.getInner(listener).accept(connection);
    },
    connected_tcp_connection: async (handle: TcpConnectionHandle) => {
      const connection = new VirtualTcpConnection(
        this.#getEndpoint(handle, 'local'),
        this.#getEndpoint(handle, 'remote')
      );

      tcpConnectionHooks.setOuter(connection, {
        send: async (data) => {
          using pointer = this.copyToMemory(data);
          const dataPtr = Number(pointer);

          let bytesQueued = this.exports.send_tcp_chunk(
            handle,
            dataPtr,
            data.length
          );

          // If the entire data was not queued, send the remaining
          // chunks as space becomes available
          while (bytesQueued < data.length) {
            await this.#waitForAck(this.#tcpAcks, handle);
            const bytesRemaining = data.length - bytesQueued;

            bytesQueued += this.exports.send_tcp_chunk(
              handle,
              dataPtr + bytesQueued,
              bytesRemaining
            );
          }
        },
        updateReceiveBuffer: (length: number) => {
          this.exports.update_tcp_receive_buffer(handle, length);
        },
        close: async () => {
          await this.#closeConnection(handle);
        },
        closeWrite: async () => {
          await this.#closeConnectionWrite(handle);
        },
      });

      this.#tcpConnections.set(handle, connection);

      // Wait for synchronous lwIP operations to complete to prevent reentrancy issues.
      // The handle is registered first so early peer data is not dropped.
      await nextMicrotask();
      if (this.disposedError) return;

      this.#tcpConnectEvents.set(handle, connection);
    },
    closed_tcp_connection: async (handle: TcpConnectionHandle) => {
      const connection = this.#tcpConnections.get(handle);

      if (!connection) {
        console.error('received close on unknown tcp connection');
        return;
      }

      await tcpConnectionHooks.getInner(connection).close();
    },
    receive_tcp_chunk: async (
      handle: TcpConnectionHandle,
      chunkPtr: number,
      length: number
    ) => {
      const chunk = this.copyFromMemory(chunkPtr, length);
      const connection = this.#tcpConnections.get(handle);

      if (!connection) {
        console.error('received chunk on unknown tcp connection');
        return;
      }

      // Wait for synchronous lwIP operations to complete to prevent reentrancy issues
      await nextMicrotask();
      if (this.disposedError || this.#tcpConnections.get(handle) !== connection)
        return;

      tcpConnectionHooks.getInner(connection).receive(new Uint8Array(chunk));
    },
    sent_tcp_chunk: (handle: TcpConnectionHandle, length: number) => {
      for (const map of [this.#tcpAcks, this.#tcpCloseAcks]) {
        const waiters = map.get(handle);
        map.delete(handle);
        for (const waiter of waiters ?? []) waiter.resolve(length);
      }
    },
  };

  async listen(options: TcpListenerOptions) {
    this.assertActive();
    const host = options.host ? await this.#resolveHost(options.host) : null;
    this.assertActive();
    using hostPtr = host ? this.copyToMemory(host.bytes) : null;

    const handle = this.exports.create_tcp_listener(
      host?.family ?? 0,
      hostPtr,
      options.port
    );

    if (Number(handle) === 0) throw new Error('failed to create tcp listener');

    const tcpListener = new VirtualTcpListener();

    tcpListenerHooks.setOuter(tcpListener, {});

    this.#tcpListeners.set(handle, tcpListener);

    return tcpListener;
  }

  async connect(options: TcpConnectionOptions) {
    this.assertActive();
    const host = await this.#resolveHost(options.host);
    this.assertActive();
    const address = formatAddress(host.family, host.bytes);
    if (!this.#routes.lookup(address)) {
      throw new NetworkError('ENETUNREACH', `no route to ${address}`);
    }
    using hostPtr = this.copyToMemory(host.bytes);

    const handle = this.exports.create_tcp_connection(
      host.family,
      hostPtr,
      options.port
    );

    if (Number(handle) === 0) {
      throw new NetworkError('ENETUNREACH', `no route to ${address}`);
    }

    const tcpConnection = await this.#tcpConnectEvents.wait(handle);
    this.assertActive();

    if (!tcpConnection) {
      throw new Error('tcp failed to connect');
    }

    return tcpConnection;
  }

  #getEndpoint(
    handle: TcpConnectionHandle,
    side: 'local' | 'remote'
  ): IpEndpoint {
    const family =
      side === 'local'
        ? this.exports.get_tcp_local_address_family(handle)
        : this.exports.get_tcp_remote_address_family(handle);
    const addressPtr =
      side === 'local'
        ? this.exports.get_tcp_local_address(handle)
        : this.exports.get_tcp_remote_address(handle);
    const port =
      side === 'local'
        ? this.exports.get_tcp_local_port(handle)
        : this.exports.get_tcp_remote_port(handle);
    return {
      address: formatAddress(
        family,
        this.copyFromMemory(addressPtr, family === 4 ? 4 : 16)
      ),
      port,
    };
  }
}

export class VirtualTcpListener
  implements TcpListener, AsyncIterable<TcpConnection>
{
  #connections: TcpConnection[] = [];
  #notifyConnections = new Set<() => void>();
  #disposed = false;

  constructor() {
    tcpListenerHooks.setInner(this, {
      dispose: () => {
        this.#disposed = true;
        this.#connections = [];
        for (const notify of this.#notifyConnections) notify();
        this.#notifyConnections.clear();
      },
      accept: (connection: TcpConnection) => {
        if (this.#disposed) return;
        this.#connections.push(connection);
        for (const notify of this.#notifyConnections) notify();
        this.#notifyConnections.clear();
      },
    });
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<TcpConnection> {
    while (!this.#disposed) {
      if (this.#connections.length === 0) {
        await new Promise<void>((resolve) =>
          this.#notifyConnections.add(resolve)
        );
      }
      if (this.#disposed) return;
      while (this.#connections.length && !this.#disposed) {
        yield this.#connections.shift()!;
      }
    }
  }
}

export class VirtualTcpConnection
  implements TcpConnection, AsyncIterable<Uint8Array>
{
  #receiveBuffer: Uint8Array[] = [];
  #readableController?: ReadableStreamDefaultController<Uint8Array>;
  #writableController?: WritableStreamDefaultController;
  #remoteClosed = false;
  #readableClosed = false;
  #disposed = false;

  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  readonly local: IpEndpoint;
  readonly remote: IpEndpoint;

  constructor(local: IpEndpoint, remote: IpEndpoint) {
    this.local = local;
    this.remote = remote;
    tcpConnectionHooks.setInner(this, {
      dispose: (error) => {
        if (this.#disposed) return;
        this.#disposed = true;
        this.#receiveBuffer = [];
        this.#errorReadable(error);
        this.#writableController?.error(error);
      },
      receive: async (data: Uint8Array) => {
        if (this.#disposed) return;
        // We maintain our own receive buffer prior to enqueueing to the readable
        // stream so that we can send window updates as data is consumed
        this.#receiveBuffer.push(data);
        this.#enqueueBuffer();
      },
      close: async () => {
        await nextMicrotask();
        if (this.#disposed) return;
        this.#remoteClosed = true;
        this.#enqueueBuffer();
      },
    });

    this.readable = new ReadableStream(
      {
        start: (controller) => {
          this.#readableController = controller;
        },
        pull: () => {
          this.#enqueueBuffer();
        },
      },
      {
        highWaterMark: READABLE_HIGH_WATER_MARK,
        size: (chunk) => chunk.byteLength,
      }
    );

    this.writable = new WritableStream(
      {
        start: (controller) => {
          this.#writableController = controller;
        },
        write: async (chunk) => {
          await tcpConnectionHooks.getOuter(this).send(chunk);
        },
        close: async () => {
          await tcpConnectionHooks.getOuter(this).closeWrite();
        },
      },
      {
        // Send buffer capacity is managed by the TCP stack. Allow one queued
        // write so standard stream utilities like pipeTo() can start flowing.
        highWaterMark: 1,
      }
    );
  }

  #closeReadable() {
    if (this.#readableClosed) {
      return;
    }

    this.#readableClosed = true;
    try {
      this.#readableController?.close();
    } catch {}
  }

  #errorReadable(error: Error) {
    if (this.#readableClosed) {
      return;
    }

    this.#readableClosed = true;
    try {
      this.#readableController?.error(error);
    } catch {}
  }

  #enqueueBuffer() {
    if (this.#disposed) return;
    if (this.#remoteClosed && this.#receiveBuffer.length === 0) {
      this.#closeReadable();
      this.#writableController?.error(new Error('tcp connection closed'));
      return;
    }

    if (!(this.#readableController?.desiredSize! > 0)) {
      return;
    }

    let bytesEnqueued = 0;

    // Enqueue chunks until the desired size is reached.
    // Always enqueue at least one chunk (desiredSize is a soft limit per the
    // WHATWG Streams spec - chunks can push it negative).
    while (this.#receiveBuffer.length > 0) {
      const chunkLength = this.#receiveBuffer[0]!.length;

      if (
        bytesEnqueued > 0 &&
        bytesEnqueued + chunkLength > this.#readableController!.desiredSize!
      ) {
        break;
      }

      const chunk = this.#receiveBuffer.shift()!;
      this.#readableController!.enqueue(chunk);
      bytesEnqueued += chunk.length;
    }

    // Notify the TCP stack that we've consumed data to reopen the receive window
    if (bytesEnqueued > 0) {
      tcpConnectionHooks.getOuter(this).updateReceiveBuffer(bytesEnqueued);
    }

    if (this.#remoteClosed && this.#receiveBuffer.length === 0) {
      this.#closeReadable();
      this.#writableController?.error(new Error('tcp connection closed'));
    }
  }

  async close() {
    if (this.#disposed) return;
    await tcpConnectionHooks.getOuter(this).close();
    this.#errorReadable(new Error('tcp connection closed'));
    this.#writableController?.error(new Error('tcp connection closed'));
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    if (this.readable.locked) {
      throw new Error('readable stream already locked');
    }
    return fromReadable(this.readable);
  }
}
