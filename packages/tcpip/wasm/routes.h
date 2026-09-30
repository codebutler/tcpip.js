#ifndef TCPIP_ROUTES_H
#define TCPIP_ROUTES_H

#include "lwip/ip4_addr.h"
#include "lwip/ip6_addr.h"
#include "lwip/netif.h"

struct netif *tcpip_ip4_route(const ip4_addr_t *src, const ip4_addr_t *dest);
struct netif *tcpip_ip6_route(const ip6_addr_t *src, const ip6_addr_t *dest);

#endif /* TCPIP_ROUTES_H */
