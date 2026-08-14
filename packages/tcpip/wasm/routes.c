#include "routes.h"

#include <stdint.h>

extern struct netif *route_ip4(const uint8_t *source, const uint8_t *destination);
extern struct netif *route_ip6(const uint8_t *source, const uint8_t *destination);

struct netif *tcpip_ip4_route(const ip4_addr_t *src, const ip4_addr_t *dest) {
  if (!dest) return NULL;
  return route_ip4(src ? (const uint8_t *)&src->addr : NULL,
                   (const uint8_t *)&dest->addr);
}

struct netif *tcpip_ip6_route(const ip6_addr_t *src, const ip6_addr_t *dest) {
  if (!dest) return NULL;
  return route_ip6(src ? (const uint8_t *)src->addr : NULL,
                   (const uint8_t *)dest->addr);
}
