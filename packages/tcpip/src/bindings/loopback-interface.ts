import {
  type IPv4Address,
  parseIPv4Address,
  serializeIPv4Cidr,
} from '@tcpip/wire';
import type { LoopbackInterface, LoopbackInterfaceOptions } from '../types.js';
import { Hooks } from '../util.js';
import { Bindings } from './base.js';
import { VirtualNetworkInterface } from './network-interface.js';
import type { Pointer } from './types.js';

type LoopbackInterfaceHandle = Pointer;

type LoopbackInterfaceOuterHooks = {
  handle: LoopbackInterfaceHandle;
  getIPv4Address(): IPv4Address | undefined;
  getIPv4Netmask(): IPv4Address | undefined;
};

// biome-ignore lint/complexity/noBannedTypes: intentionally empty hook type
type LoopbackInterfaceInnerHooks = {};

export const loopbackInterfaceHooks = new Hooks<
  LoopbackInterface,
  LoopbackInterfaceOuterHooks,
  LoopbackInterfaceInnerHooks
>();

export type LoopbackImports = {
  register_loopback_interface(handle: LoopbackInterfaceHandle): void;
};

export type LoopbackExports = {
  create_loopback_interface(
    ipAddress: Pointer,
    netmask: Pointer
  ): LoopbackInterfaceHandle;
  remove_loopback_interface(handle: LoopbackInterfaceHandle): void;
};

export class LoopbackBindings extends Bindings<
  LoopbackImports,
  LoopbackExports
> {
  interfaces = new Map<LoopbackInterfaceHandle, LoopbackInterface>();

  imports = {
    register_loopback_interface: (handle: LoopbackInterfaceHandle) => {
      const loopbackInterface = new VirtualLoopbackInterface();

      loopbackInterfaceHooks.setOuter(loopbackInterface, {
        handle,
        getIPv4Address: () => {
          const ipPtr = this.exports.get_interface_ip4_address(handle);

          if (ipPtr === 0) {
            return;
          }

          const ipBytes = this.viewFromMemory(ipPtr, 4);
          return parseIPv4Address(ipBytes);
        },
        getIPv4Netmask: () => {
          const netmaskPtr = this.exports.get_interface_ip4_netmask(handle);

          if (netmaskPtr === 0) {
            return;
          }

          const netmaskBytes = this.viewFromMemory(netmaskPtr, 4);
          return parseIPv4Address(netmaskBytes);
        },
      });

      this.interfaces.set(handle, loopbackInterface);
    },
  };

  async create(options: LoopbackInterfaceOptions) {
    const { ipAddress, netmask } = options.ip
      ? serializeIPv4Cidr(options.ip)
      : {};

    using ipAddressPtr = ipAddress ? this.copyToMemory(ipAddress) : undefined;
    using netmaskPtr = netmask ? this.copyToMemory(netmask) : undefined;

    const handle = this.exports.create_loopback_interface(
      ipAddressPtr ?? 0,
      netmaskPtr ?? 0
    );

    const loopbackInterface = this.interfaces.get(handle);

    if (!loopbackInterface) {
      throw new Error('loopback interface failed to register');
    }

    return loopbackInterface;
  }

  async remove(loopbackInterface: LoopbackInterface) {
    for (const [handle, loopback] of this.interfaces.entries()) {
      if (loopback === loopbackInterface) {
        this.exports.remove_loopback_interface(handle);
        this.interfaces.delete(handle);
        return;
      }
    }
  }
}

export class VirtualLoopbackInterface
  extends VirtualNetworkInterface
  implements LoopbackInterface
{
  readonly type = 'loopback';
  get ip(): IPv4Address | undefined {
    return loopbackInterfaceHooks.getOuter(this).getIPv4Address();
  }
  get netmask(): IPv4Address | undefined {
    return loopbackInterfaceHooks.getOuter(this).getIPv4Netmask();
  }
}
