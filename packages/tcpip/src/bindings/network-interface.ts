import { formatAddress, parseInterfaceCidr } from '../ip.js';
import type { RouteTable } from '../routes.js';
import type {
  InterfaceConfiguration,
  IpCidr,
  NetworkInterface,
  RouteHandle,
} from '../types.js';
import { Bindings } from './base.js';
import type { Pointer } from './types.js';

export type NetworkInterfaceExports = {
  get_interface_mtu(handle: number): number;
  set_interface_mtu(handle: number, mtu: number): number;
  set_interface_ip4_address(
    handle: number,
    address: Pointer,
    prefixLength: number
  ): number;
  clear_interface_ip4_address(handle: number): void;
  add_interface_ip6_address(handle: number, address: Pointer): number;
  remove_interface_ip6_address(handle: number, address: Pointer): number;
};

type AddressState = {
  cidr: IpCidr;
  family: 4 | 6;
  bytes: Uint8Array;
  connectedNetwork: IpCidr;
};

type ConnectedRouteState = {
  handle: RouteHandle;
  references: number;
};

type InterfaceState = {
  bindings: NetworkInterfaceBindings;
  handle: number;
  netInterface: NetworkInterface;
  addresses: Map<IpCidr, AddressState>;
  connectedRoutes: Map<IpCidr, ConnectedRouteState>;
  detached: boolean;
};

const states = new WeakMap<InterfaceConfiguration, InterfaceState>();

export abstract class VirtualNetworkInterface
  implements InterfaceConfiguration
{
  get addresses(): readonly IpCidr[] {
    return [...getState(this).addresses.keys()];
  }

  get mtu(): number {
    const state = getAttachedState(this);
    return state.bindings.exports.get_interface_mtu(state.handle);
  }

  addAddress(cidr: IpCidr): Promise<void> {
    return getAttachedState(this).bindings.addAddress(this, cidr);
  }

  removeAddress(cidr: IpCidr): Promise<void> {
    return getAttachedState(this).bindings.removeAddress(this, cidr);
  }

  setMtu(mtu: number): Promise<void> {
    return getAttachedState(this).bindings.setMtu(this, mtu);
  }
}

export class NetworkInterfaceBindings extends Bindings<
  Record<never, never>,
  NetworkInterfaceExports
> {
  readonly imports = {};
  #routes: RouteTable;

  constructor(routes: RouteTable) {
    super();
    this.#routes = routes;
  }

  attach(
    netInterface: NetworkInterface,
    handle: number,
    initialAddresses: readonly IpCidr[] = []
  ) {
    if (states.has(netInterface)) {
      throw new Error('network interface is already attached');
    }
    const state: InterfaceState = {
      bindings: this,
      handle,
      netInterface,
      addresses: new Map(),
      connectedRoutes: new Map(),
      detached: false,
    };
    states.set(netInterface, state);

    for (const cidr of initialAddresses) {
      const parsed = parseInterfaceCidr(cidr);
      const canonical = parsed.canonical;
      state.addresses.set(canonical, {
        cidr: canonical,
        family: parsed.family,
        bytes: parsed.bytes,
        connectedNetwork: parsed.network,
      });
      this.#acquireConnectedRoute(state, parsed.network);
    }
  }

  detach(netInterface: NetworkInterface) {
    const state = getState(netInterface);
    if (state.detached) return;
    state.detached = true;
    for (const route of state.connectedRoutes.values()) {
      route.handle.dispose();
    }
    state.connectedRoutes.clear();
    state.addresses.clear();
  }

  async addAddress(netInterface: InterfaceConfiguration, cidr: IpCidr) {
    const state = getAttachedState(netInterface);
    const parsed = parseInterfaceCidr(cidr);
    if (state.addresses.has(parsed.canonical)) return;
    if (
      parsed.family === 4 &&
      [...state.addresses.values()].some((address) => address.family === 4)
    ) {
      throw new Error('an IPv4 address is already configured');
    }
    if (parsed.family === 6 && netInterface.mtu < 1280) {
      throw new Error('IPv6 interfaces require an MTU of at least 1280');
    }

    using addressPtr = this.copyToMemory(parsed.bytes);
    const result =
      parsed.family === 4
        ? this.exports.set_interface_ip4_address(
            state.handle,
            addressPtr,
            parsed.prefixLength
          )
        : this.exports.add_interface_ip6_address(state.handle, addressPtr);
    if (result !== 0) {
      throw new Error(`failed to add interface address: ${result}`);
    }

    try {
      this.#acquireConnectedRoute(state, parsed.network);
      state.addresses.set(parsed.canonical, {
        cidr: parsed.canonical,
        family: parsed.family,
        bytes: parsed.bytes,
        connectedNetwork: parsed.network,
      });
    } catch (error) {
      this.#removeAddressFromWasm(state, parsed.family, parsed.bytes);
      throw error;
    }
  }

  async removeAddress(netInterface: InterfaceConfiguration, cidr: IpCidr) {
    const state = getAttachedState(netInterface);
    const parsed = parseInterfaceCidr(cidr);
    const address = state.addresses.get(parsed.canonical);
    if (!address) return;

    this.#removeAddressFromWasm(state, address.family, address.bytes);
    this.#releaseConnectedRoute(state, address.connectedNetwork);
    state.addresses.delete(parsed.canonical);
  }

  async setMtu(netInterface: InterfaceConfiguration, mtu: number) {
    const state = getAttachedState(netInterface);
    if (!Number.isSafeInteger(mtu) || mtu < 68 || mtu > 65_535) {
      throw new Error('interface MTU must be an integer from 68 through 65535');
    }
    if (
      mtu < 1280 &&
      [...state.addresses.values()].some((address) => address.family === 6)
    ) {
      throw new Error('IPv6 interfaces require an MTU of at least 1280');
    }
    const result = this.exports.set_interface_mtu(state.handle, mtu);
    if (result !== 0) {
      throw new Error(`failed to set interface MTU: ${result}`);
    }
  }

  #removeAddressFromWasm(
    state: InterfaceState,
    family: 4 | 6,
    bytes: Uint8Array
  ) {
    if (family === 4) {
      this.exports.clear_interface_ip4_address(state.handle);
      return;
    }
    using addressPtr = this.copyToMemory(bytes);
    const result = this.exports.remove_interface_ip6_address(
      state.handle,
      addressPtr
    );
    if (result !== 0) {
      throw new Error(
        `failed to remove interface address ${formatAddress(family, bytes)}: ${result}`
      );
    }
  }

  #acquireConnectedRoute(state: InterfaceState, network: IpCidr) {
    const installed = state.connectedRoutes.get(network);
    if (installed) {
      installed.references++;
      return;
    }
    state.connectedRoutes.set(network, {
      handle: this.#routes.add({
        destination: network,
        via: state.netInterface,
        source: 'connected',
      }),
      references: 1,
    });
  }

  #releaseConnectedRoute(state: InterfaceState, network: IpCidr) {
    const installed = state.connectedRoutes.get(network);
    if (!installed) return;
    installed.references--;
    if (installed.references > 0) return;
    installed.handle.dispose();
    state.connectedRoutes.delete(network);
  }
}

function getState(netInterface: InterfaceConfiguration) {
  const state = states.get(netInterface);
  if (!state) throw new Error('network interface is not attached');
  return state;
}

function getAttachedState(netInterface: InterfaceConfiguration) {
  const state = getState(netInterface);
  if (state.detached) throw new Error('network interface has been removed');
  return state;
}
