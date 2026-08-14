#ifndef TCPIP_IP_ADDRESS_H
#define TCPIP_IP_ADDRESS_H

#include <string.h>

#include "lwip/err.h"
#include "lwip/ip_addr.h"

#define TCPIP_AF_IPV4 4
#define TCPIP_AF_IPV6 6

static inline err_t tcpip_ip_addr_from_bytes(uint8_t family,
                                              const uint8_t *bytes,
                                              ip_addr_t *address) {
  if (!bytes || !address) return ERR_ARG;
  if (family == TCPIP_AF_IPV4) {
    IP_ADDR4(address, bytes[0], bytes[1], bytes[2], bytes[3]);
    return ERR_OK;
  }
#if LWIP_IPV6
  if (family == TCPIP_AF_IPV6) {
    ip_addr_set_zero_ip6(address);
    memcpy(ip_2_ip6(address)->addr, bytes, 16);
    return ERR_OK;
  }
#endif
  return ERR_VAL;
}

static inline uint8_t tcpip_ip_addr_family(const ip_addr_t *address) {
  if (IP_IS_ANY_TYPE_VAL(*address)) return TCPIP_AF_IPV4;
  return IP_IS_V6(address) ? TCPIP_AF_IPV6 : TCPIP_AF_IPV4;
}

static inline const uint8_t *tcpip_ip_addr_bytes(const ip_addr_t *address) {
#if LWIP_IPV6
  if (IP_IS_V6(address)) return (const uint8_t *)ip_2_ip6(address)->addr;
#endif
  return (const uint8_t *)&ip_2_ip4(address)->addr;
}

#endif
