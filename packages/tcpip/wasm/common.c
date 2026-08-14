#include <string.h>

#include "lwip/err.h"
#include "lwip/ip_addr.h"
#include "lwip/netif.h"
#include "ipv6_helpers.h"
#include "macros.h"

EXPORT("get_interface_mac_address")
uint8_t *get_interface_mac_address(struct netif *netif) {
  return (uint8_t *)&netif->hwaddr;
}

EXPORT("get_interface_ip4_address")
uint8_t *get_interface_ip4_address(struct netif *netif) {
  if (!IP_IS_V4(&netif->ip_addr)) {
    return NULL;
  }
  return (uint8_t *)&ip_2_ip4(&netif->ip_addr)->addr;
}

EXPORT("get_interface_ip4_netmask")
uint8_t *get_interface_ip4_netmask(struct netif *netif) {
  if (!IP_IS_V4(&netif->netmask)) {
    return NULL;
  }
  return (uint8_t *)&ip_2_ip4(&netif->netmask)->addr;
}

EXPORT("get_interface_mtu")
uint16_t get_interface_mtu(struct netif *netif) {
  return netif->mtu;
}

EXPORT("set_interface_mtu")
err_t set_interface_mtu(struct netif *netif, uint16_t mtu) {
  if (!netif || mtu == 0) return ERR_ARG;
  netif->mtu = mtu;
#if LWIP_IPV6 && LWIP_ND6_ALLOW_RA_UPDATES
  netif->mtu6 = mtu;
#endif
  return ERR_OK;
}

EXPORT("set_interface_router_advertisements")
err_t set_interface_router_advertisements(struct netif *netif,
                                          const uint8_t prefix[16]) {
#if LWIP_IPV6
  return tcpip_ra_set(netif, prefix);
#else
  LWIP_UNUSED_ARG(netif);
  LWIP_UNUSED_ARG(prefix);
  return ERR_IF;
#endif
}

EXPORT("set_interface_ip4_address")
err_t set_interface_ip4_address(struct netif *netif, const uint8_t address[4],
                                uint8_t prefix_length) {
  ip4_addr_t ip;
  ip4_addr_t netmask;
  uint8_t mask[4] = {0, 0, 0, 0};
  uint8_t remaining = prefix_length;
  uint8_t i;

  if (!netif || !address || prefix_length > 32) return ERR_ARG;
  for (i = 0; i < 4; i++) {
    if (remaining >= 8) {
      mask[i] = 0xff;
      remaining = (uint8_t)(remaining - 8);
    } else if (remaining > 0) {
      mask[i] = (uint8_t)(0xff << (8 - remaining));
      remaining = 0;
    }
  }
  IP4_ADDR(&ip, address[0], address[1], address[2], address[3]);
  IP4_ADDR(&netmask, mask[0], mask[1], mask[2], mask[3]);
  netif_set_addr(netif, &ip, &netmask, NULL);
  return ERR_OK;
}

EXPORT("clear_interface_ip4_address")
void clear_interface_ip4_address(struct netif *netif) {
  if (netif) netif_set_addr(netif, NULL, NULL, NULL);
}

#if LWIP_IPV6
EXPORT("add_interface_ip6_address")
err_t add_interface_ip6_address(struct netif *netif,
                                const uint8_t address[16]) {
  ip6_addr_t ip;
  s8_t index = -1;
  err_t result;
  if (!netif || !address) return ERR_ARG;
  memset(&ip, 0, sizeof(ip));
  memcpy(ip.addr, address, 16);
  result = netif_add_ip6_address(netif, &ip, &index);
  if (result == ERR_OK && index >= 0) {
    netif_ip6_addr_set_state(netif, index, IP6_ADDR_PREFERRED);
  }
  return result;
}

EXPORT("remove_interface_ip6_address")
err_t remove_interface_ip6_address(struct netif *netif,
                                   const uint8_t address[16]) {
  ip6_addr_t ip;
  s8_t index;
  if (!netif || !address) return ERR_ARG;
  memset(&ip, 0, sizeof(ip));
  memcpy(ip.addr, address, 16);
  index = netif_get_ip6_addr_match(netif, &ip);
  if (index < 0) return ERR_VAL;
  netif_ip6_addr_set_state(netif, index, IP6_ADDR_INVALID);
  ip_addr_set_zero_ip6(&netif->ip6_addr[index]);
  return ERR_OK;
}
#endif
