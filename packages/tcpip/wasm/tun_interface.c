#include <stdlib.h>
#include <string.h>

#include "lwip/netif.h"
#include "macros.h"
#include "ipv6_helpers.h"

extern void register_tun_interface(struct netif *netif);
extern void receive_packet(struct netif *netif, const uint8_t *packet, uint16_t length);

err_t tun_interface_output(struct netif *netif, struct pbuf *p, const ip4_addr_t *ipaddr) {
  LWIP_UNUSED_ARG(ipaddr);
  receive_packet(netif, (uint8_t *)p->payload, p->tot_len);
  return 0;
}

#if LWIP_IPV6
err_t tun_interface_output_ip6(struct netif *netif, struct pbuf *p, const ip6_addr_t *ipaddr) {
  LWIP_UNUSED_ARG(ipaddr);
  receive_packet(netif, (uint8_t *)p->payload, p->tot_len);
  return 0;
}
#endif

static err_t tun_interface_init(struct netif *netif) {
  // Setup callback for outgoing IP packets (raw IP, no ethernet)
  netif->output = tun_interface_output;
#if LWIP_IPV6
  netif->output_ip6 = tun_interface_output_ip6;
#endif
  netif->mtu = 1500;
#if LWIP_IPV6 && LWIP_ND6_ALLOW_RA_UPDATES
  netif->mtu6 = 1500;
#endif

  return ERR_OK;
}

EXPORT("create_tun_interface")
struct netif *create_tun_interface(const uint8_t ip4[4], const uint8_t netmask[4]) {
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

  register_tun_interface(netif);

  netif_add(netif, ip4_addr, netmask_addr, NULL, NULL, tun_interface_init, netif_input);
  netif_set_link_up(netif);
  netif_set_up(netif);
  return netif;
}

EXPORT("remove_tun_interface")
void remove_tun_interface(struct netif *netif) {
  netif_remove(netif);
  free(netif);
}

EXPORT("send_tun_interface")
void send_tun_interface(struct netif *netif, const uint8_t *packet, uint16_t length) {
  // pc#714: allocate at the LINK layer (reserving headroom for an Ethernet
  // header) and COPY the packet in — do NOT use a headroom-less PBUF_REF. A
  // raw-IP packet the TUN receives may be FORWARDED out an Ethernet netif (the
  // bridge, on the guest internet-return path), where ethernet_output must
  // prepend a 14-byte header via pbuf_add_header. That prepend fails on a
  // PBUF_REF (its payload points at external memory with no room in front), so
  // only the FIRST forwarded packet — the one routed through etharp's
  // pending-ARP queue, which copies into a headroom'd pbuf — was delivered;
  // every subsequent forward (ARP already resolved → direct send) was silently
  // dropped. A LINK-layer PBUF_RAM copy carries the 14-byte headroom the
  // prepend needs. (Tap-sourced frames don't hit this: stripping their inbound
  // Ethernet header already leaves 14 bytes of headroom for a re-prepend.)
  struct pbuf *p = pbuf_alloc(PBUF_LINK, length, PBUF_RAM);
  if (p != NULL) {
    if (pbuf_take(p, packet, length) != ERR_OK || netif->input(p, netif) != ERR_OK) {
      pbuf_free(p);
    }
  }
}
