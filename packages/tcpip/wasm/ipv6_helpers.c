#include "ipv6_helpers.h"

#include <string.h>

#include "macros.h"
#include "lwip/ip.h"
#include "lwip/ip6.h"
#include "lwip/inet_chksum.h"
#include "lwip/mld6.h"
#include "lwip/timeouts.h"
#include "lwip/prot/icmp6.h"
#include "lwip/prot/ip6.h"
#include "lwip/prot/nd6.h"

/* Active LAN /64 prefix, stored as ip6_addr_t words (network byte order in
 * wasm memory). Defaults to the legacy compile-time prefix so behavior is
 * unchanged when JS never calls pc_set_lan6_prefix. Read at interface-create
 * time (pc_assign_ula) and snapshotted by pc_ra_start — so a call takes
 * effect for bridges created AFTER it, never retroactively. */
u32_t pc_lan6_words[4] = {PC_ULA_WORD0, PC_ULA_WORD1, PC_ULA_WORD2, 0};

/* JS seam: set the keyed LAN /64 before create_bridge_interface. The four
 * u32s must already be in ip6_addr word order (see ipv6_helpers.h). */
EXPORT("pc_set_lan6_prefix")
void pc_set_lan6_prefix(u32_t w0, u32_t w1, u32_t w2, u32_t w3) {
  pc_lan6_words[0] = w0;
  pc_lan6_words[1] = w1;
  pc_lan6_words[2] = w2;
  pc_lan6_words[3] = w3;
}

/* Only the explicitly configured LAN bridge advertises Router Advertisements. */
static struct netif *pc_ra_netif = NULL;

/* RFC 4861-ish: a few quick initial RAs, then a long interval. */
#define PC_RA_INITIAL_COUNT 3
#define PC_RA_INITIAL_MS 2000
#define PC_RA_NORMAL_MS 600000
#define PC_ND6_HOPLIM 255
#define PC_RA_CUR_HOP_LIMIT 64
#define PC_RA_ROUTER_LIFETIME_S 1800
#define PC_RA_PREFIX_VALID_S 86400
#define PC_RA_PREFIX_PREF_S 14400

static u8_t pc_ra_initial_left = 0;
/* Snapshot of pc_lan6_words taken by pc_ra_start, so a mid-flight
 * pc_set_lan6_prefix only affects the NEXT bridge, not the live advertiser. */
static u32_t pc_ra_words[4] = {0, 0, 0, 0};
/* When the snapshotted prefix differs from the legacy compile-time one, the
 * initial RA burst (only) also carries a lifetime-0 Prefix Info for the
 * legacy prefix so guests that SLAAC'd on it renumber immediately. */
static u8_t pc_ra_deprecate_legacy = 0;

void pc_assign_ula(struct netif *netif, u8_t host_id) {
  s8_t idx = -1;
  ip6_addr_t addr6;
  IP6_ADDR(&addr6, pc_lan6_words[0], pc_lan6_words[1], pc_lan6_words[2],
           PP_HTONL((u32_t)host_id));
  netif_add_ip6_address(netif, &addr6, &idx);
  if (idx >= 0) {
    netif_ip6_addr_set_state(netif, idx, IP6_ADDR_PREFERRED);
  }
}

static void pc_ra_send(struct netif *netif) {
  struct pbuf *p;
  struct ra_header *ra;
  struct lladdr_option *ll;
  struct prefix_option *pi;
  const ip6_addr_t *src;
  ip6_addr_t dest;
  ip6_addr_t prefix;
  u16_t ll_opt_len;
  u16_t tot;
  /* Deprecate the legacy prefix during the initial burst only: the immediate
   * RA + burst RAs run with pc_ra_initial_left > 0; steady-state RAs don't. */
  u8_t include_legacy = (u8_t)(pc_ra_deprecate_legacy && pc_ra_initial_left > 0);

  if (!netif || !netif_is_up(netif) || !netif_is_link_up(netif)) return;
  if (!ip6_addr_isvalid(netif_ip6_addr_state(netif, 0))) return;

  src = netif_ip6_addr(netif, 0); /* link-local — RFC 4861 §4.2 */
  ip6_addr_set_allnodes_linklocal(&dest);
  ip6_addr_assign_zone(&dest, IP6_MULTICAST, netif);

  ll_opt_len = (u16_t)(((netif->hwaddr_len + 2) + 7) >> 3);
  tot = (u16_t)(sizeof(struct ra_header) + (ll_opt_len << 3) + sizeof(struct prefix_option));
  if (include_legacy) tot = (u16_t)(tot + sizeof(struct prefix_option));
  p = pbuf_alloc(PBUF_IP, tot, PBUF_RAM);
  if (!p) return;

  memset(p->payload, 0, tot);
  ra = (struct ra_header *)p->payload;
  ra->type = ICMP6_TYPE_RA;
  ra->code = 0;
  ra->chksum = 0;
  ra->current_hop_limit = PC_RA_CUR_HOP_LIMIT;
  ra->flags = 0; /* M=0 O=0 — SLAAC only, no DHCPv6 */
  ra->router_lifetime = lwip_htons(PC_RA_ROUTER_LIFETIME_S);
  ra->reachable_time = 0;
  ra->retrans_timer = 0;

  ll = (struct lladdr_option *)((u8_t *)p->payload + sizeof(struct ra_header));
  ll->type = ND6_OPTION_TYPE_SOURCE_LLADDR;
  ll->length = (u8_t)ll_opt_len;
  MEMCPY(ll->addr, netif->hwaddr, netif->hwaddr_len);

  pi = (struct prefix_option *)((u8_t *)ll + (ll_opt_len << 3));
  pi->type = ND6_OPTION_TYPE_PREFIX_INFO;
  pi->length = 4; /* 32 bytes */
  pi->prefix_length = 64;
  pi->flags = ND6_PREFIX_FLAG_ON_LINK | ND6_PREFIX_FLAG_AUTONOMOUS;
  pi->valid_lifetime = lwip_htonl(PC_RA_PREFIX_VALID_S);
  pi->preferred_lifetime = lwip_htonl(PC_RA_PREFIX_PREF_S);
  IP6_ADDR(&prefix, pc_ra_words[0], pc_ra_words[1], pc_ra_words[2], 0);
  ip6_addr_copy_to_packed(pi->prefix, prefix);

  if (include_legacy) {
    /* Second Prefix Info: the legacy /64 with preferred+valid lifetime 0 —
     * RFC 4862 §5.5.3: guests drop their legacy-prefix addresses now instead
     * of aging them out. Memory is already zeroed, so lifetimes stay 0. */
    pi = (struct prefix_option *)((u8_t *)pi + sizeof(struct prefix_option));
    pi->type = ND6_OPTION_TYPE_PREFIX_INFO;
    pi->length = 4;
    pi->prefix_length = 64;
    pi->flags = ND6_PREFIX_FLAG_ON_LINK | ND6_PREFIX_FLAG_AUTONOMOUS;
    IP6_ADDR(&prefix, PC_ULA_WORD0, PC_ULA_WORD1, PC_ULA_WORD2, 0);
    ip6_addr_copy_to_packed(pi->prefix, prefix);
  }

#if CHECKSUM_GEN_ICMP6
  IF__NETIF_CHECKSUM_ENABLED(netif, NETIF_CHECKSUM_GEN_ICMP6) {
    ra->chksum = ip6_chksum_pseudo(p, IP6_NEXTH_ICMP6, p->len, src, &dest);
  }
#endif

  (void)ip6_output_if(p, src, &dest, PC_ND6_HOPLIM, 0, IP6_NEXTH_ICMP6, netif);
  pbuf_free(p);
}

static void pc_ra_timer(void *arg) {
  struct netif *netif = (struct netif *)arg;
  u32_t next_ms;
  if (netif != pc_ra_netif) return;
  pc_ra_send(netif);
  if (pc_ra_initial_left > 0) {
    pc_ra_initial_left--;
    next_ms = pc_ra_initial_left > 0 ? PC_RA_INITIAL_MS : PC_RA_NORMAL_MS;
  } else {
    next_ms = PC_RA_NORMAL_MS;
  }
  sys_timeout(next_ms, pc_ra_timer, netif);
}

void pc_ra_start(struct netif *netif) {
  ip6_addr_t allrouters;
  if (!netif) return;
  if (pc_ra_netif && pc_ra_netif != netif) {
    pc_ra_stop(pc_ra_netif);
  }
  pc_ra_netif = netif;

  /* Virtual LAN — no real neighbors to DAD against. Promote the link-local out
   * of TENTATIVE so we can source RAs immediately (RFC 4861 requires fe80::). */
  if (ip6_addr_islinklocal(netif_ip6_addr(netif, 0))) {
    netif_ip6_addr_set_state(netif, 0, IP6_ADDR_PREFERRED);
  }

  /* Accept Router Solicitations destined to ff02::2. */
  ip6_addr_set_allrouters_linklocal(&allrouters);
  ip6_addr_assign_zone(&allrouters, IP6_MULTICAST, netif);
  (void)mld6_joingroup_netif(netif, &allrouters);

  /* Snapshot the active prefix for this advertiser's lifetime; flag legacy
   * deprecation when it differs from the compile-time legacy prefix. */
  pc_ra_words[0] = pc_lan6_words[0];
  pc_ra_words[1] = pc_lan6_words[1];
  pc_ra_words[2] = pc_lan6_words[2];
  pc_ra_words[3] = pc_lan6_words[3];
  pc_ra_deprecate_legacy =
      (u8_t)(pc_ra_words[0] != PC_ULA_WORD0 || pc_ra_words[1] != PC_ULA_WORD1 ||
             pc_ra_words[2] != PC_ULA_WORD2);

  /* Immediate RA, then the initial/periodic timer chain. Set the burst count
   * BEFORE the immediate send so it also carries the legacy deprecation. */
  pc_ra_initial_left = PC_RA_INITIAL_COUNT;
  pc_ra_send(netif);
  pc_ra_initial_left = PC_RA_INITIAL_COUNT - 1; /* already sent one */
  sys_untimeout(pc_ra_timer, netif);
  sys_timeout(PC_RA_INITIAL_MS, pc_ra_timer, netif);
}

void pc_ra_stop(struct netif *netif) {
  ip6_addr_t allrouters;
  if (!netif || pc_ra_netif != netif) return;
  sys_untimeout(pc_ra_timer, netif);
  ip6_addr_set_allrouters_linklocal(&allrouters);
  ip6_addr_assign_zone(&allrouters, IP6_MULTICAST, netif);
  (void)mld6_leavegroup_netif(netif, &allrouters);
  pc_ra_netif = NULL;
  pc_ra_initial_left = 0;
  pc_ra_deprecate_legacy = 0;
}

/* JS toggle (settings-network "Enable Router Advertisements"): stop whatever
 * bridge is currently advertising. Safe when RA was never started. */
EXPORT("pc_ra_disable")
void pc_ra_disable(void) {
  if (pc_ra_netif) pc_ra_stop(pc_ra_netif);
}

int pc_ip6_input_hook(struct pbuf *p, struct netif *inp) {
  struct ip6_hdr *ip6hdr;
  struct icmp6_hdr *icmp6;
  LWIP_UNUSED_ARG(inp);
  if (!pc_ra_netif || !p || p->len < (u16_t)(IP6_HLEN + sizeof(struct icmp6_hdr))) {
    return 0;
  }
  ip6hdr = (struct ip6_hdr *)p->payload;
  if (IP6H_NEXTH(ip6hdr) != IP6_NEXTH_ICMP6) return 0;
  icmp6 = (struct icmp6_hdr *)((u8_t *)p->payload + IP6_HLEN);
  if (icmp6->type != ICMP6_TYPE_RS) return 0;
  pc_ra_send(pc_ra_netif);
  return 0; /* don't eat — stack frees via the empty RS case */
}
