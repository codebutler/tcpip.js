import {
  compressIPv6,
  parseIPv4Address,
  parseIPv6Address,
  serializeIPv4Address,
  serializeIPv6Address,
} from '@tcpip/wire';

export type AddressFamily = 4 | 6;

export type ParsedAddress = {
  family: AddressFamily;
  bytes: Uint8Array;
};

export type ParsedCidr = ParsedAddress & {
  prefixLength: number;
  canonical: string;
};

export type ParsedInterfaceCidr = ParsedCidr & {
  networkBytes: Uint8Array;
  network: string;
};

export function parseAddress(address: string): ParsedAddress {
  try {
    return { family: 4, bytes: serializeIPv4Address(address) };
  } catch {
    return { family: 6, bytes: serializeIPv6Address(address) };
  }
}

export function formatAddress(family: AddressFamily, bytes: Uint8Array) {
  if (family === 4) return parseIPv4Address(bytes);
  return compressIPv6(parseIPv6Address(bytes));
}

export function parseCidr(cidr: string): ParsedCidr {
  const parsed = parseInterfaceCidr(cidr);
  if (!equalBytes(parsed.networkBytes, parsed.bytes)) {
    throw new Error(`CIDR has non-zero host bits: ${cidr}`);
  }
  return parsed;
}

export function parseInterfaceCidr(cidr: string): ParsedInterfaceCidr {
  const slash = cidr.lastIndexOf('/');
  if (slash <= 0 || slash === cidr.length - 1) {
    throw new Error(`invalid CIDR: ${cidr}`);
  }

  const address = parseAddress(cidr.slice(0, slash));
  const rawPrefix = cidr.slice(slash + 1);
  if (!/^\d+$/.test(rawPrefix)) throw new Error(`invalid CIDR prefix: ${cidr}`);

  const prefixLength = Number(rawPrefix);
  const max = address.bytes.length * 8;
  if (prefixLength < 0 || prefixLength > max) {
    throw new Error(`invalid CIDR prefix: ${cidr}`);
  }

  const networkBytes = maskAddress(address.bytes, prefixLength);

  return {
    family: address.family,
    bytes: address.bytes,
    prefixLength,
    canonical: `${formatAddress(address.family, address.bytes)}/${prefixLength}`,
    networkBytes,
    network: `${formatAddress(address.family, networkBytes)}/${prefixLength}`,
  };
}

export function maskAddress(bytes: Uint8Array, prefixLength: number) {
  const masked = new Uint8Array(bytes);
  const wholeBytes = Math.floor(prefixLength / 8);
  const partialBits = prefixLength % 8;

  if (partialBits > 0 && wholeBytes < masked.length) {
    masked[wholeBytes] =
      masked[wholeBytes]! & ((0xff << (8 - partialBits)) & 0xff);
  }
  for (
    let index = wholeBytes + (partialBits > 0 ? 1 : 0);
    index < masked.length;
    index++
  ) {
    masked[index] = 0;
  }
  return masked;
}

export function prefixMatches(
  address: Uint8Array,
  network: Uint8Array,
  prefixLength: number
) {
  if (address.length !== network.length) return false;
  const wholeBytes = Math.floor(prefixLength / 8);
  const partialBits = prefixLength % 8;

  for (let index = 0; index < wholeBytes; index++) {
    if (address[index] !== network[index]) return false;
  }
  if (partialBits === 0) return true;

  const mask = (0xff << (8 - partialBits)) & 0xff;
  return (address[wholeBytes]! & mask) === (network[wholeBytes]! & mask);
}

function equalBytes(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false;
  return left.every((byte, index) => byte === right[index]);
}
