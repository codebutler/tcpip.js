import type { DnsClient } from '@tcpip/dns';
import { ICMP_ECHO_HEADER_LENGTH, IPV4_HEADER_LENGTH } from '@tcpip/wire';
import { formatAddress, parseAddress } from '../ip.js';
import { LwipError } from '../lwip/errors.js';
import { NetworkError } from '../network-error.js';
import type { RouteTable } from '../routes.js';
import type {
  PingProbeOptions,
  PingReply,
  PingSession,
  PingSessionOptions,
} from '../types.js';
import { Hooks, nextMicrotask } from '../util.js';
import { Bindings } from './base.js';
import type { Pointer } from './types.js';

type IcmpSocketHandle = Pointer;

type PingSessionOuterHooks = {
  send(sequenceNumber: number, options?: PingProbeOptions): Promise<PingReply>;
  close(): void;
};

// biome-ignore lint/complexity/noBannedTypes: intentionally empty hook type
type PingSessionInnerHooks = {};

const pingSessionHooks = new Hooks<
  PingSession,
  PingSessionOuterHooks,
  PingSessionInnerHooks
>();

type PendingPing = {
  host: string;
  identifier: number;
  sequenceNumber: number;
  payload: Uint8Array;
  startedAt: number;
  timeoutId: ReturnType<typeof setTimeout>;
  resolve(reply: PingReply): void;
  reject(error: Error): void;
};

export type IcmpImports = {
  receive_icmp_echo_reply(
    handle: IcmpSocketHandle,
    family: 4 | 6,
    hostPtr: number,
    identifier: number,
    sequenceNumber: number,
    payloadPtr: number,
    length: number
  ): number;
};

export type IcmpExports = {
  open_icmp_socket(family: 4 | 6): IcmpSocketHandle;
  close_icmp_socket(handle: IcmpSocketHandle): void;
  send_icmp_echo_request(
    handle: IcmpSocketHandle,
    family: 4 | 6,
    host: Pointer,
    identifier: number,
    sequenceNumber: number,
    payload: Pointer,
    length: number
  ): number;
};

const DEFAULT_TIMEOUT = 1000;
const DEFAULT_PAYLOAD = Uint8Array.from({ length: 56 }, (_, index) => index);
const MAX_IPV4_PACKET_LENGTH = 65535;
const MAX_ICMP_ECHO_PAYLOAD_LENGTH =
  MAX_IPV4_PACKET_LENGTH - IPV4_HEADER_LENGTH - ICMP_ECHO_HEADER_LENGTH;

export class IcmpBindings extends Bindings<IcmpImports, IcmpExports> {
  #dnsClient: DnsClient;
  #routes: RouteTable;
  #handles = new Map<4 | 6, IcmpSocketHandle>();
  #pendingPings = new Map<string, PendingPing>();

  constructor(dnsClient: DnsClient, routes: RouteTable) {
    super();
    this.#dnsClient = dnsClient;
    this.#routes = routes;
  }

  imports = {
    receive_icmp_echo_reply: (
      _handle: IcmpSocketHandle,
      family: 4 | 6,
      hostPtr: number,
      identifier: number,
      sequenceNumber: number,
      payloadPtr: number,
      length: number
    ) => {
      const host = formatAddress(
        family,
        this.copyFromMemory(hostPtr, family === 4 ? 4 : 16)
      );
      const payload = this.copyFromMemory(payloadPtr, length);
      const key = this.#getPendingKey(host, identifier, sequenceNumber);
      const pendingPing = this.#pendingPings.get(key);

      if (!pendingPing || !this.#payloadEquals(payload, pendingPing.payload)) {
        return 0;
      }

      this.#pendingPings.delete(key);
      clearTimeout(pendingPing.timeoutId);

      const reply = {
        host,
        identifier,
        sequenceNumber,
        payload,
        roundTripTime: Date.now() - pendingPing.startedAt,
      };

      nextMicrotask().then(() => pendingPing.resolve(reply));
      return 1;
    },
  };

  async createPingSession(options: PingSessionOptions) {
    const resolvedHost = await this.#resolveHost(options.host);
    const host = formatAddress(resolvedHost.family, resolvedHost.bytes);
    if (!this.#routes.lookup(host)) {
      throw new NetworkError('ENETUNREACH', `no route to ${host}`);
    }
    const identifier = this.#createIdentifier();
    const defaultTimeout = options.timeout ?? DEFAULT_TIMEOUT;

    this.#getHandle(resolvedHost.family);

    const pingSession = new VirtualPingSession({
      host,
      identifier,
      timeout: defaultTimeout,
    });

    pingSessionHooks.setOuter(pingSession, {
      send: async (sequenceNumber, options = {}) => {
        const payload = options.payload ?? DEFAULT_PAYLOAD;
        const timeout = options.timeout ?? defaultTimeout;

        this.#validatePayload(payload);

        const key = this.#getPendingKey(host, identifier, sequenceNumber);
        if (this.#pendingPings.has(key)) {
          throw new Error(
            'icmp ping identifier and sequence number are in use'
          );
        }

        return await new Promise<PingReply>((resolve, reject) => {
          const timeoutId = setTimeout(() => {
            this.#pendingPings.delete(key);
            reject(new Error(`icmp ping timed out: ${host}`));
          }, timeout);

          this.#pendingPings.set(key, {
            host,
            identifier,
            sequenceNumber,
            payload,
            startedAt: Date.now(),
            timeoutId,
            resolve,
            reject,
          });

          try {
            using hostPtr = this.copyToMemory(resolvedHost.bytes);
            using payloadPtr = this.copyToMemory(payload);

            const result = this.exports.send_icmp_echo_request(
              this.#getHandle(resolvedHost.family),
              resolvedHost.family,
              hostPtr,
              identifier,
              sequenceNumber,
              payloadPtr,
              payload.length
            );

            if (result !== LwipError.ERR_OK) {
              throw new Error(`failed to send icmp echo request: ${result}`);
            }
          } catch (error) {
            clearTimeout(timeoutId);
            this.#pendingPings.delete(key);
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      },
      close: () => {
        for (const [key, pendingPing] of this.#pendingPings) {
          if (
            pendingPing.host === host &&
            pendingPing.identifier === identifier
          ) {
            clearTimeout(pendingPing.timeoutId);
            pendingPing.reject(new Error('icmp ping session closed'));
            this.#pendingPings.delete(key);
          }
        }
      },
    });

    pingSessionHooks.setInner(pingSession, {});

    return pingSession;
  }

  #getHandle(family: 4 | 6) {
    let handle = this.#handles.get(family);
    if (!handle) {
      handle = this.exports.open_icmp_socket(family);

      if (Number(handle) === 0) {
        throw new Error('failed to open icmp socket');
      }

      this.#handles.set(family, handle);
    }

    return handle;
  }

  async #resolveHost(host: string) {
    try {
      return parseAddress(host);
    } catch {
      return parseAddress(await this.#dnsClient.lookup(host));
    }
  }

  #createIdentifier() {
    const buffer = new Uint16Array(1);
    crypto.getRandomValues(buffer);
    return buffer[0]!;
  }

  #getPendingKey(host: string, identifier: number, sequenceNumber: number) {
    return `${host}:${identifier}:${sequenceNumber}`;
  }

  #validateUint16(value: number, name: string) {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
      throw new Error(`${name} must be an integer between 0 and 65535`);
    }
  }

  #validatePayload(payload: Uint8Array) {
    if (payload.length > MAX_ICMP_ECHO_PAYLOAD_LENGTH) {
      throw new Error('icmp echo payload exceeds maximum IPv4 packet size');
    }
  }

  #payloadEquals(a: Uint8Array, b: Uint8Array) {
    if (a.length !== b.length) {
      return false;
    }

    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        return false;
      }
    }

    return true;
  }
}

type VirtualPingSessionOptions = {
  host: string;
  identifier: number;
  timeout: number;
};

export class VirtualPingSession implements PingSession {
  #closed = false;
  #sequenceNumber = 0;

  readonly host: string;
  readonly identifier: number;
  readonly timeout: number;

  constructor(options: VirtualPingSessionOptions) {
    this.host = options.host;
    this.identifier = options.identifier;
    this.timeout = options.timeout;
  }

  async ping(options?: PingProbeOptions) {
    if (this.#closed) {
      throw new Error('icmp ping session closed');
    }

    return await pingSessionHooks
      .getOuter(this)
      .send(this.#nextSequenceNumber(), options);
  }

  async close() {
    if (this.#closed) {
      return;
    }

    this.#closed = true;
    pingSessionHooks.getOuter(this).close();
  }

  #nextSequenceNumber() {
    const sequenceNumber = this.#sequenceNumber;
    this.#sequenceNumber = (this.#sequenceNumber + 1) & 0xffff;
    return sequenceNumber;
  }
}
