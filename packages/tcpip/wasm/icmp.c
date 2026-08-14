#include "lwip/inet_chksum.h"
#include "lwip/ip4.h"
#include "lwip/ip6.h"
#include "lwip/pbuf.h"
#include "lwip/prot/icmp.h"
#include "lwip/prot/icmp6.h"
#include "lwip/raw.h"

#include <stdlib.h>
#include <string.h>

#include "ip_address.h"
#include "macros.h"

extern uint8_t receive_icmp_echo_reply(struct raw_pcb *socket, uint8_t family, const uint8_t *addr, uint16_t identifier, uint16_t sequence_number, const uint8_t *payload, uint16_t length);

static uint8_t recv_icmp_callback(void *arg, struct raw_pcb *socket, struct pbuf *p, const ip_addr_t *addr) {
  LWIP_UNUSED_ARG(arg);

  uint8_t family = tcpip_ip_addr_family(addr);
  uint16_t ip_header_length;
  uint16_t echo_header_length;
  uint8_t echo_type;
  uint8_t echo_code;
  uint16_t echo_id;
  uint16_t echo_seqno;

  if (family == TCPIP_AF_IPV4) {
    struct ip_hdr iphdr;
    struct icmp_echo_hdr echo;
    if (p->tot_len < IP_HLEN + sizeof(echo)) return 0;
    pbuf_copy_partial(p, &iphdr, sizeof(iphdr), 0);
    ip_header_length = IPH_HL_BYTES(&iphdr);
    if (p->tot_len < ip_header_length + sizeof(echo)) return 0;
    pbuf_copy_partial(p, &echo, sizeof(echo), ip_header_length);
    echo_header_length = sizeof(echo);
    echo_type = echo.type;
    echo_code = echo.code;
    echo_id = echo.id;
    echo_seqno = echo.seqno;
    if (echo_type != ICMP_ER || echo_code != 0) return 0;
  } else {
    struct icmp6_echo_hdr echo;
    ip_header_length = IP6_HLEN;
    if (p->tot_len < ip_header_length + sizeof(echo)) return 0;
    pbuf_copy_partial(p, &echo, sizeof(echo), ip_header_length);
    echo_header_length = sizeof(echo);
    echo_type = echo.type;
    echo_code = echo.code;
    echo_id = echo.id;
    echo_seqno = echo.seqno;
    if (echo_type != ICMP6_TYPE_EREP || echo_code != 0) return 0;
  }

  uint16_t payload_length = p->tot_len - ip_header_length - echo_header_length;
  uint8_t *payload = NULL;

  if (payload_length > 0) {
    payload = malloc(payload_length);
    if (payload == NULL) {
      return 0;
    }

    pbuf_copy_partial(p, payload, payload_length, ip_header_length + echo_header_length);
  }

  uint8_t eaten = receive_icmp_echo_reply(
    socket,
    family,
    tcpip_ip_addr_bytes(addr),
    lwip_ntohs(echo_id),
    lwip_ntohs(echo_seqno),
    payload,
    payload_length
  );

  free(payload);

  if (eaten) {
    pbuf_free(p);
    return 1;
  }

  return 0;
}

EXPORT("open_icmp_socket")
struct raw_pcb *open_icmp_socket(uint8_t family) {
  struct raw_pcb *socket = raw_new_ip_type(
      family == TCPIP_AF_IPV6 ? IPADDR_TYPE_V6 : IPADDR_TYPE_V4,
      family == TCPIP_AF_IPV6 ? IP6_NEXTH_ICMP6 : IP_PROTO_ICMP);

  if (socket == NULL) {
    return NULL;
  }

  raw_recv(socket, recv_icmp_callback, NULL);
#if LWIP_IPV6
  if (family == TCPIP_AF_IPV6) {
    socket->chksum_reqd = 1;
    socket->chksum_offset = 2;
  }
#endif
  return socket;
}

EXPORT("close_icmp_socket")
void close_icmp_socket(struct raw_pcb *socket) {
  raw_remove(socket);
}

EXPORT("send_icmp_echo_request")
err_t send_icmp_echo_request(struct raw_pcb *socket, uint8_t family, const uint8_t *addr, uint16_t identifier, uint16_t sequence_number, uint8_t *payload, uint16_t length) {
  ip_addr_t ipaddr;
  err_t parsed = tcpip_ip_addr_from_bytes(family, addr, &ipaddr);
  if (parsed != ERR_OK) return parsed;

  uint16_t header_length = family == TCPIP_AF_IPV6 ?
      sizeof(struct icmp6_echo_hdr) : sizeof(struct icmp_echo_hdr);

  struct pbuf *p = pbuf_alloc(PBUF_IP, header_length + length, PBUF_RAM);
  if (p == NULL) {
    return ERR_MEM;
  }

  struct icmp_echo_hdr *echo = (struct icmp_echo_hdr *)p->payload;
  echo->type = family == TCPIP_AF_IPV6 ? ICMP6_TYPE_EREQ : ICMP_ECHO;
  echo->code = 0;
  echo->chksum = 0;
  echo->id = lwip_htons(identifier);
  echo->seqno = lwip_htons(sequence_number);

  if (length > 0) {
    uint8_t *echo_payload = ((uint8_t *)p->payload) + header_length;
    MEMCPY(echo_payload, payload, length);
  }

  if (family == TCPIP_AF_IPV4) {
    echo->chksum = inet_chksum(p->payload, p->len);
  }

  err_t code = raw_sendto(socket, p, &ipaddr);
  pbuf_free(p);
  return code;
}
