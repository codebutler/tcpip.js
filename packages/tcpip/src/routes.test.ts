import { describe, expect, test } from 'vitest';
import { RouteTable } from './routes.js';
import type { NetworkInterface } from './types.js';

function tun(label: string) {
  return { type: 'tun', label } as unknown as NetworkInterface;
}

describe('RouteTable', () => {
  test('uses longest-prefix match and treats /0 as an ordinary route', () => {
    const routes = new RouteTable();
    const fallback = tun('fallback');
    const overlay = tun('overlay');
    const local = tun('local');
    routes.add({ destination: '::/0', via: fallback });
    routes.add({ destination: 'fdcb:a000::/20', via: overlay });
    routes.add({ destination: 'fdcb:a234:5678:9abc::/64', via: local });

    expect(routes.lookup('2001:db8::1')?.via).toBe(fallback);
    expect(routes.lookup('fdcb:afff::1')?.via).toBe(overlay);
    expect(routes.lookup('fdcb:a234:5678:9abc::2')?.via).toBe(local);
  });

  test('supports IPv4 and IPv6 independently', () => {
    const routes = new RouteTable();
    const v4 = tun('v4');
    const v6 = tun('v6');
    routes.add({ destination: '0.0.0.0/0', via: v4 });
    routes.add({ destination: '::/0', via: v6 });

    expect(routes.lookup('192.0.2.1')?.via).toBe(v4);
    expect(routes.lookup('2001:db8::1')?.via).toBe(v6);
  });

  test('uses lower metric for equal prefixes', () => {
    const routes = new RouteTable();
    const slow = tun('slow');
    const fast = tun('fast');
    routes.add({ destination: '10.0.0.0/8', via: slow, metric: 100 });
    routes.add({ destination: '10.0.0.0/8', via: fast, metric: 10 });
    expect(routes.lookup('10.2.3.4')?.via).toBe(fast);
  });

  test('rejects an exact duplicate route', () => {
    const routes = new RouteTable();
    const first = tun('first');
    routes.add({ destination: '10.0.0.0/8', via: first, metric: 10 });
    expect(() =>
      routes.add({ destination: '10.0.0.0/8', via: first, metric: 10 })
    ).toThrow(/already exists/);
  });

  test('requires a canonical network and validates prefix and metric', () => {
    const routes = new RouteTable();
    expect(() =>
      routes.add({ destination: '10.1.0.1/16', via: tun('x') })
    ).toThrow(/host bits/);
    expect(() =>
      routes.add({ destination: '2001:db8::/129', via: tun('x') })
    ).toThrow(/prefix/);
    expect(() =>
      routes.add({ destination: '::/0', via: tun('x'), metric: -1 })
    ).toThrow(/metric/);
  });

  test('route handles and interface removal cannot remove replacement routes', () => {
    const routes = new RouteTable();
    const first = tun('first');
    const second = tun('second');
    const stale = routes.add({ destination: '::/0', via: first });
    stale.dispose();
    routes.add({ destination: '::/0', via: second });
    stale.dispose();
    expect(routes.lookup('2001:db8::1')?.via).toBe(second);
    routes.removeInterface(second);
    expect(routes.lookup('2001:db8::1')).toBeNull();
  });
});
