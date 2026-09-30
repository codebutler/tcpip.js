#include "lwip/udp.h"

#include <stdbool.h>
#include <stdio.h>

#include "lwip/err.h"
#include "lwip/netif.h"
#include "ip_address.h"
#include "macros.h"

extern void receive_udp_datagram(struct udp_pcb *socket,
                                 uint8_t remote_family, const uint8_t *remote_addr, uint16_t remote_port,
                                 uint8_t local_family, const uint8_t *local_addr, uint16_t local_port,
                                 const uint8_t *datagram, uint16_t length);

EXPORT("send_udp_datagram")
err_t send_udp_datagram(struct udp_pcb *socket, uint8_t family, const uint8_t *addr, uint16_t port, uint8_t *datagram, uint16_t length) {
  ip_addr_t ipaddr;
  err_t parsed = tcpip_ip_addr_from_bytes(family, addr, &ipaddr);
  if (parsed != ERR_OK) return parsed;

  err_t code = ERR_OK;

  // If the destination IP is the limited broadcast address (255.255.255.255),
  // send on all interfaces that are up, support ARP, and have the broadcast flag set
  if (IP_IS_V4(&ipaddr) && ip_addr_get_ip4_u32(&ipaddr) == PP_HTONL(IPADDR_BROADCAST)) {
    struct netif *netif;

    NETIF_FOREACH(netif) {
      if (netif_is_up(netif) && netif_is_flag_set(netif, NETIF_FLAG_ETHARP) && netif_is_flag_set(netif, NETIF_FLAG_BROADCAST)) {
        struct pbuf *p = pbuf_alloc(PBUF_TRANSPORT, length, PBUF_RAM);
        if (p == NULL) {
          return ERR_MEM;
        }
        pbuf_take(p, datagram, length);
        udp_sendto_if(socket, p, IP_ADDR_BROADCAST, port, netif);
        pbuf_free(p);
      }
    }

    return ERR_OK;
  }
  // Otherwise, send to the specified IP address using lwIP's automatic routing
  else {
    struct pbuf *p = pbuf_alloc(PBUF_TRANSPORT, length, PBUF_RAM);
    if (p == NULL) {
      return ERR_MEM;
    }
    pbuf_take(p, datagram, length);
    code = udp_sendto(socket, p, &ipaddr, port);
    pbuf_free(p);
    return code;
  }
}

EXPORT("close_udp_socket")
void close_udp_socket(struct udp_pcb *socket) {
  udp_remove(socket);
}

// Callback for when data is received
void recv_udp_callback(void *arg, struct udp_pcb *socket, struct pbuf *p, const ip_addr_t *addr, uint16_t port) {
  const ip_addr_t *local_addr;
  if (p == NULL) {
    return;
  }
  local_addr = ip_addr_isany(&socket->local_ip) ? ip_current_dest_addr() : &socket->local_ip;
  receive_udp_datagram(socket, tcpip_ip_addr_family(addr),
                       tcpip_ip_addr_bytes(addr), port,
                       tcpip_ip_addr_family(local_addr),
                       tcpip_ip_addr_bytes(local_addr), socket->local_port,
                       p->payload, p->len);
  pbuf_free(p);
}

EXPORT("open_udp_socket")
struct udp_pcb *open_udp_socket(uint8_t family, const uint8_t *host, int port) {
  struct udp_pcb *socket = udp_new_ip_type(host ?
      (family == TCPIP_AF_IPV6 ? IPADDR_TYPE_V6 : IPADDR_TYPE_V4) :
      IPADDR_TYPE_ANY);

  if (socket == NULL) {
    return NULL;
  }

  ip_set_option(socket, SOF_BROADCAST);

  ip_addr_t ipaddr;
  if (host != NULL) {
    if (tcpip_ip_addr_from_bytes(family, host, &ipaddr) != ERR_OK) {
      udp_remove(socket);
      return NULL;
    }
  } else {
    ip_addr_set_ipaddr(&ipaddr, IP_ANY_TYPE);
  }

  err_t err;
  err = udp_bind(socket, &ipaddr, port);
  if (err != ERR_OK) {
    udp_remove(socket);
    return NULL;
  }

  udp_recv(socket, recv_udp_callback, NULL);
  return socket;
}

EXPORT("get_udp_local_address_family")
uint8_t get_udp_local_address_family(struct udp_pcb *socket) {
  return tcpip_ip_addr_family(&socket->local_ip);
}

EXPORT("get_udp_local_address")
const uint8_t *get_udp_local_address(struct udp_pcb *socket) {
  return tcpip_ip_addr_bytes(&socket->local_ip);
}

EXPORT("get_udp_local_port")
uint16_t get_udp_local_port(struct udp_pcb *socket) {
  return socket->local_port;
}
