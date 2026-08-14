#include <stdlib.h>
#include <string.h>

#include "lwip/netif.h"
#include "macros.h"
#include "netif/bridgeif.h"
#include "ipv6_helpers.h"

EXPORT("create_bridge_interface")
struct netif *create_bridge_interface(const uint8_t mac_address[6], const uint8_t ip4[4], const uint8_t netmask[4], struct netif *ports[], uint8_t ports_num) {
  struct netif *netif = (struct netif *)malloc(sizeof(struct netif));

  if (!netif) {
    return NULL;
  }

  ip4_addr_t *ip4_addr = NULL;
  ip4_addr_t *netmask_addr = NULL;

  if (ip4) {
    ip4_addr = malloc(sizeof(ip4_addr_t));
    IP4_ADDR(ip4_addr, ip4[0], ip4[1], ip4[2], ip4[3]);
  }

  if (netmask) {
    netmask_addr = malloc(sizeof(ip4_addr_t));
    IP4_ADDR(netmask_addr, netmask[0], netmask[1], netmask[2], netmask[3]);
  }

  bridgeif_initdata_t bridge_init = BRIDGEIF_INITDATA2(
      ports_num,
      1024,
      16,
      mac_address[0],
      mac_address[1],
      mac_address[2],
      mac_address[3],
      mac_address[4],
      mac_address[5]);

  netif_add(netif,
            ip4_addr,
            netmask_addr,
            NULL,
            &bridge_init,
            bridgeif_init,
            netif_input);

  netif_set_link_up(netif);
  netif_set_up(netif);
#if LWIP_IPV6
  netif_create_ip6_linklocal_address(netif, 1);
  if (ip4) {
    pc_assign_ula(netif, ip4[3]);
  }
#endif

  for (uint8_t i = 0; i < ports_num; i++) {
    bridgeif_add_port(netif, ports[i]);
  }

#if LWIP_IPV6
  /* Advertise fdcb:0:0:2::/64 + default route so guests can SLAAC. */
  pc_ra_start(netif);
#endif

  return netif;
}

EXPORT("remove_bridge_interface")
void remove_bridge_interface(struct netif *netif) {
  // pc#433: cancel the bridge FDB's aging sys_timeout and free its private
  // state before removing the netif. Without this, netif_remove() leaks the
  // bridge's MEMP_SYS_TIMEOUT slot (the pool has room for exactly one bridge),
  // so the first sys_timeout() after a remove — e.g. TCP arming a timer on an
  // inbound SYN — traps the wasm ("pool MEMP_SYS_TIMEOUT is empty").
#if LWIP_IPV6
  pc_ra_stop(netif);
#endif
  bridgeif_deinit(netif);
  netif_remove(netif);
  free(netif);
}
