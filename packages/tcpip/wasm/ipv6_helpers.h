#ifndef TCPIP_IPV6_HELPERS_H
#define TCPIP_IPV6_HELPERS_H

#include "lwip/netif.h"
#include "lwip/ip6_addr.h"
#include "lwip/pbuf.h"

err_t tcpip_ra_set(struct netif *netif, const uint8_t prefix[16]);
/** LWIP_HOOK_IP6_INPUT — return 0 to continue processing. */
int tcpip_ip6_input_hook(struct pbuf *p, struct netif *inp);

#endif /* TCPIP_IPV6_HELPERS_H */
