import { parseAddress, parseCidr, prefixMatches } from './ip.js';
import type {
  NetworkInterface,
  RouteHandle,
  RouteSnapshot,
  RouteSpec,
  Routes,
} from './types.js';

type InstalledRoute = RouteSnapshot & {
  bytes: Uint8Array;
  order: number;
};

export class RouteTable implements Routes {
  #routes: InstalledRoute[] = [];
  #nextOrder = 1;
  #validateInterface: (netInterface: NetworkInterface) => void;

  constructor(
    validateInterface: (netInterface: NetworkInterface) => void = () => {}
  ) {
    this.#validateInterface = validateInterface;
  }

  add(spec: RouteSpec): RouteHandle {
    this.#validateInterface(spec.via);
    const parsed = parseCidr(spec.destination);
    const metric = spec.metric ?? 0;
    if (!Number.isSafeInteger(metric) || metric < 0) {
      throw new Error('route metric must be a non-negative safe integer');
    }

    if (
      this.#routes.some(
        (route) =>
          route.family === parsed.family &&
          route.destination === parsed.canonical &&
          route.metric === metric &&
          route.via === spec.via
      )
    ) {
      throw new Error(
        `route already exists: ${parsed.canonical} metric ${metric}`
      );
    }

    const route: InstalledRoute = {
      family: parsed.family,
      destination: parsed.canonical,
      prefixLength: parsed.prefixLength,
      via: spec.via,
      metric,
      source: spec.source ?? 'static',
      bytes: parsed.bytes,
      order: this.#nextOrder++,
    };
    this.#routes.push(route);

    let installed = true;
    return {
      dispose: () => {
        if (!installed) return;
        installed = false;
        this.#routes = this.#routes.filter((candidate) => candidate !== route);
      },
    };
  }

  list(): readonly RouteSnapshot[] {
    return this.#routes
      .slice()
      .sort(compareRoutes)
      .map(({ bytes: _bytes, order: _order, ...route }) => ({ ...route }));
  }

  lookup(address: string): RouteSnapshot | null {
    const parsed = parseAddress(address);
    const match = this.#routes
      .filter(
        (route) =>
          route.family === parsed.family &&
          prefixMatches(parsed.bytes, route.bytes, route.prefixLength)
      )
      .sort(compareRoutes)[0];
    if (!match) return null;
    const { bytes: _bytes, order: _order, ...snapshot } = match;
    return { ...snapshot };
  }

  lookupBytes(family: 4 | 6, address: Uint8Array): NetworkInterface | null {
    const match = this.#routes
      .filter(
        (route) =>
          route.family === family &&
          prefixMatches(address, route.bytes, route.prefixLength)
      )
      .sort(compareRoutes)[0];
    return match?.via ?? null;
  }

  removeInterface(netInterface: NetworkInterface) {
    this.#routes = this.#routes.filter((route) => route.via !== netInterface);
  }
}

function compareRoutes(left: InstalledRoute, right: InstalledRoute) {
  return (
    right.prefixLength - left.prefixLength ||
    left.metric - right.metric ||
    left.order - right.order
  );
}
