#ifndef PC_IPV6_HELPERS_H
#define PC_IPV6_HELPERS_H

#include "lwip/netif.h"
#include "lwip/ip6_addr.h"
#include "lwip/pbuf.h"

/* Fixed ULA prefix fdcb:0000:0000:0002::/64 — mirrors the IPv4 10.0.2.0/24 LAN.
 * Host id is taken from the IPv4 last octet so 10.0.2.1 → ::1, 10.0.2.2 → ::2.
 * Word layout is hextet pairs: word0=fdcb:0000, word1=0000:0002, word2=0, word3=host. */
#define PC_ULA_WORD0 PP_HTONL(0xfdcb0000)
#define PC_ULA_WORD1 PP_HTONL(0x00000002)
#define PC_ULA_WORD2 PP_HTONL(0x00000000)

/* Active LAN /64 prefix words (ip6_addr_t word layout — network byte order in
 * memory, i.e. the value PP_HTONL(<big-endian hextet pair>) would produce).
 * Defaults to the legacy compile-time prefix above; JS overrides it via the
 * `pc_set_lan6_prefix` export BEFORE creating interfaces. word3 of the /64
 * prefix is host bits and is ignored by pc_assign_ula (the host id goes there). */
extern u32_t pc_lan6_words[4];
void pc_set_lan6_prefix(u32_t w0, u32_t w1, u32_t w2, u32_t w3);

void pc_assign_ula(struct netif *netif, u8_t host_id);
/* Router Advertisement sender on the LAN bridge (SLAAC + default route). */
void pc_ra_start(struct netif *netif);
void pc_ra_stop(struct netif *netif);
void pc_ra_disable(void);
/** LWIP_HOOK_IP6_INPUT — return 0 to continue processing. */
int pc_ip6_input_hook(struct pbuf *p, struct netif *inp);

#endif /* PC_IPV6_HELPERS_H */
