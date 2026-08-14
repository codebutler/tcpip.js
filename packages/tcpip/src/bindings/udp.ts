import type { DnsClient } from '@tcpip/dns';
import { fromReadable } from '@tcpip/transport';
import { formatAddress, parseAddress } from '../ip.js';
import { LwipError } from '../lwip/errors.js';
import { NetworkError } from '../network-error.js';
import type { RouteTable } from '../routes.js';
import type {
  IpEndpoint,
  UdpDatagram,
  UdpSocket,
  UdpSocketOptions,
} from '../types.js';
import { EventMap, Hooks, nextMicrotask } from '../util.js';
import { Bindings } from './base.js';
import type { Pointer } from './types.js';

type UdpSocketHandle = Pointer;

type UdpSocketOuterHooks = {
  send(datagram: UdpDatagram): Promise<void>;
  close(): Promise<void>;
};

type UdpSocketInnerHooks = {
  receive(datagram: UdpDatagram): Promise<void>;
};

const udpSocketHooks = new Hooks<
  UdpSocket,
  UdpSocketOuterHooks,
  UdpSocketInnerHooks
>();

export type UdpImports = {
  receive_udp_datagram(
    handle: UdpSocketHandle,
    family: 4 | 6,
    ip: number,
    port: number,
    localFamily: 4 | 6,
    localIp: number,
    localPort: number,
    datagramPtr: number,
    length: number
  ): Promise<void>;
};

export type UdpExports = {
  open_udp_socket(
    family: number,
    host: Pointer | null,
    port: number
  ): UdpSocketHandle;
  close_udp_socket(handle: UdpSocketHandle): void;
  send_udp_datagram(
    handle: UdpSocketHandle,
    family: 4 | 6,
    ip: Pointer | null,
    port: number,
    datagram: Pointer,
    length: number
  ): number;
  get_udp_local_address_family(handle: UdpSocketHandle): 4 | 6;
  get_udp_local_address(handle: UdpSocketHandle): Pointer;
  get_udp_local_port(handle: UdpSocketHandle): number;
};

export class UdpBindings extends Bindings<UdpImports, UdpExports> {
  #udpSockets = new EventMap<UdpSocketHandle, UdpSocket>();
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

  imports = {
    receive_udp_datagram: async (
      handle: UdpSocketHandle,
      family: 4 | 6,
      hostPtr: number,
      port: number,
      localFamily: 4 | 6,
      localHostPtr: number,
      localPort: number,
      datagramPtr: number,
      length: number
    ) => {
      const host = this.copyFromMemory(hostPtr, family === 4 ? 4 : 16);
      const localHost = this.copyFromMemory(
        localHostPtr,
        localFamily === 4 ? 4 : 16
      );
      const datagram = this.copyFromMemory(datagramPtr, length);
      const socket = this.#udpSockets.get(handle);

      if (!socket) {
        console.error('received datagram on unknown udp socket');
        return;
      }

      // Wait for synchronous lwIP operations to complete to prevent reentrancy issues
      await nextMicrotask();

      udpSocketHooks.getInner(socket).receive({
        host: formatAddress(family, host),
        port,
        local: {
          address: formatAddress(localFamily, localHost),
          port: localPort,
        },
        data: datagram,
      });
    },
  };

  async open(options: UdpSocketOptions) {
    const host = options.host ? await this.#resolveHost(options.host) : null;
    using hostPtr = host ? this.copyToMemory(host.bytes) : null;

    const handle = this.exports.open_udp_socket(
      host?.family ?? 0,
      hostPtr,
      options.port ?? 0
    );

    if (Number(handle) === 0) {
      throw new Error('failed to open udp socket');
    }

    const family = this.exports.get_udp_local_address_family(handle);
    const localAddressPtr = this.exports.get_udp_local_address(handle);
    const udpSocket = new VirtualUdpSocket({
      address: formatAddress(
        family,
        this.copyFromMemory(localAddressPtr, family === 4 ? 4 : 16)
      ),
      port: this.exports.get_udp_local_port(handle),
    });

    udpSocketHooks.setOuter(udpSocket, {
      send: async (datagram: UdpDatagram) => {
        const host = await this.#resolveHost(datagram.host);
        const address = formatAddress(host.family, host.bytes);
        const route = this.#routes.lookup(address);
        const isLimitedBroadcast = address === '255.255.255.255';
        if (!route && !isLimitedBroadcast) {
          throw new NetworkError('ENETUNREACH', `no route to ${address}`);
        }
        if (
          host.family === 6 &&
          route &&
          datagram.data.length + 48 > route.via.mtu
        ) {
          throw new NetworkError(
            'EMSGSIZE',
            `UDP datagram exceeds interface MTU ${route.via.mtu}`
          );
        }
        using hostPtr = this.copyToMemory(host.bytes);
        using datagramPtr = this.copyToMemory(datagram.data);

        const result = this.exports.send_udp_datagram(
          handle,
          host.family,
          hostPtr,
          datagram.port,
          datagramPtr,
          datagram.data.length
        );

        if (result !== LwipError.ERR_OK) {
          if (result === LwipError.ERR_RTE) {
            throw new NetworkError('ENETUNREACH', `no route to ${address}`);
          }
          throw new Error(`failed to send udp datagram: ${result}`);
        }
      },
      close: async () => {
        this.exports.close_udp_socket(handle);
        this.#udpSockets.delete(handle);
      },
    });

    this.#udpSockets.set(handle, udpSocket);

    return udpSocket;
  }
}

export class VirtualUdpSocket implements UdpSocket, AsyncIterable<UdpDatagram> {
  #readableController?: ReadableStreamDefaultController<UdpDatagram>;
  #writableController?: WritableStreamDefaultController;

  readable: ReadableStream<UdpDatagram>;
  writable: WritableStream<UdpDatagram>;
  readonly local: IpEndpoint;

  constructor(local: IpEndpoint) {
    this.local = local;
    udpSocketHooks.setInner(this, {
      receive: async (datagram: UdpDatagram) => {
        if (!this.#readableController) {
          throw new Error('readable controller not initialized');
        }
        this.#readableController.enqueue(datagram);
      },
    });

    this.readable = new ReadableStream({
      start: (controller) => {
        this.#readableController = controller;
      },
    });

    this.writable = new WritableStream({
      start: (controller) => {
        this.#writableController = controller;
      },
      write: async (datagram) => {
        await udpSocketHooks.getOuter(this).send(datagram);
      },
    });
  }

  async close() {
    await udpSocketHooks.getOuter(this).close();
    this.#readableController?.error(new Error('udp socket closed'));
    this.#writableController?.error(new Error('udp socket closed'));
  }

  [Symbol.asyncIterator](): AsyncIterator<UdpDatagram> {
    if (this.readable.locked) {
      throw new Error('readable stream already locked');
    }
    return fromReadable(this.readable);
  }
}
