import type { RouteTable } from '../routes.js';
import type { NetworkInterface } from '../types.js';
import { Bindings } from './base.js';
import type { Pointer } from './types.js';

export type RouteImports = {
  route_ip4(source: Pointer, destination: Pointer): number;
  route_ip6(source: Pointer, destination: Pointer): number;
};

export type RouteExports = Record<never, never>;

export class RouteBindings extends Bindings<RouteImports, RouteExports> {
  #routes: RouteTable;
  #getHandle: (netInterface: NetworkInterface) => number;

  constructor(
    routes: RouteTable,
    getHandle: (netInterface: NetworkInterface) => number
  ) {
    super();
    this.#routes = routes;
    this.#getHandle = getHandle;
  }

  imports = {
    route_ip4: (_source: Pointer, destination: Pointer) =>
      this.#lookup(4, destination, 4),
    route_ip6: (_source: Pointer, destination: Pointer) =>
      this.#lookup(6, destination, 16),
  };

  #lookup(family: 4 | 6, destination: Pointer, length: number) {
    const address = this.viewFromMemory(destination, length);
    const netInterface = this.#routes.lookupBytes(family, address);
    return netInterface ? this.#getHandle(netInterface) : 0;
  }
}
