#include "ipv6_helpers.h"

#include <string.h>

#include "lwip/inet_chksum.h"
#include "lwip/ip.h"
#include "lwip/ip6.h"
#include "lwip/mld6.h"
#include "lwip/prot/icmp6.h"
#include "lwip/prot/ip6.h"
#include "lwip/prot/nd6.h"
#include "lwip/timeouts.h"

static struct netif *ra_netif = NULL;

/* RFC 4861-ish: a few quick initial RAs, then a long interval. */
#define RA_INITIAL_COUNT 3
#define RA_INITIAL_MS 2000
#define RA_NORMAL_MS 600000
#define ND6_HOPLIM 255
#define RA_CUR_HOP_LIMIT 64
#define RA_ROUTER_LIFETIME_S 1800

static u8_t ra_initial_left = 0;

struct ra_prefix_config {
  ip6_addr_t prefix;
  u32_t valid_lifetime;
  u32_t preferred_lifetime;
  u8_t initial_only;
};

static struct ra_prefix_config ra_prefixes[TCPIP_RA_MAX_PREFIXES];
static u8_t ra_prefix_count = 0;

static void ra_send(struct netif *netif) {
  struct pbuf *p;
  struct ra_header *ra;
  struct lladdr_option *ll;
  struct prefix_option *pi;
  const ip6_addr_t *src;
  ip6_addr_t dest;
  u16_t ll_opt_len;
  u16_t total_length;
  u8_t advertised_count = 0;
  u8_t i;

  if (!netif || !netif_is_up(netif) || !netif_is_link_up(netif)) return;
  if (!ip6_addr_isvalid(netif_ip6_addr_state(netif, 0))) return;

  src = netif_ip6_addr(netif, 0);
  ip6_addr_set_allnodes_linklocal(&dest);
  ip6_addr_assign_zone(&dest, IP6_MULTICAST, netif);

  for (i = 0; i < ra_prefix_count; i++) {
    if (!ra_prefixes[i].initial_only || ra_initial_left > 0) {
      advertised_count++;
    }
  }
  if (advertised_count == 0) return;

  ll_opt_len = (u16_t)(((netif->hwaddr_len + 2) + 7) >> 3);
  total_length =
      (u16_t)(sizeof(struct ra_header) + (ll_opt_len << 3) +
              advertised_count * sizeof(struct prefix_option));
  p = pbuf_alloc(PBUF_IP, total_length, PBUF_RAM);
  if (!p) return;

  memset(p->payload, 0, total_length);
  ra = (struct ra_header *)p->payload;
  ra->type = ICMP6_TYPE_RA;
  ra->code = 0;
  ra->chksum = 0;
  ra->current_hop_limit = RA_CUR_HOP_LIMIT;
  ra->flags = 0;
  ra->router_lifetime = lwip_htons(RA_ROUTER_LIFETIME_S);

  ll = (struct lladdr_option *)((u8_t *)p->payload + sizeof(struct ra_header));
  ll->type = ND6_OPTION_TYPE_SOURCE_LLADDR;
  ll->length = (u8_t)ll_opt_len;
  MEMCPY(ll->addr, netif->hwaddr, netif->hwaddr_len);

  pi = (struct prefix_option *)((u8_t *)ll + (ll_opt_len << 3));
  for (i = 0; i < ra_prefix_count; i++) {
    if (ra_prefixes[i].initial_only && ra_initial_left == 0) continue;
    pi->type = ND6_OPTION_TYPE_PREFIX_INFO;
    pi->length = 4;
    pi->prefix_length = 64;
    pi->flags = ND6_PREFIX_FLAG_ON_LINK | ND6_PREFIX_FLAG_AUTONOMOUS;
    pi->valid_lifetime = lwip_htonl(ra_prefixes[i].valid_lifetime);
    pi->preferred_lifetime = lwip_htonl(ra_prefixes[i].preferred_lifetime);
    ip6_addr_copy_to_packed(pi->prefix, ra_prefixes[i].prefix);
    pi++;
  }

#if CHECKSUM_GEN_ICMP6
  IF__NETIF_CHECKSUM_ENABLED(netif, NETIF_CHECKSUM_GEN_ICMP6) {
    ra->chksum = ip6_chksum_pseudo(p, IP6_NEXTH_ICMP6, p->len, src, &dest);
  }
#endif

  (void)ip6_output_if(p, src, &dest, ND6_HOPLIM, 0, IP6_NEXTH_ICMP6, netif);
  pbuf_free(p);
}

static void ra_timer(void *arg) {
  struct netif *netif = (struct netif *)arg;
  u32_t next_ms;
  if (netif != ra_netif) return;
  ra_send(netif);
  if (ra_initial_left > 0) {
    ra_initial_left--;
    next_ms = ra_initial_left > 0 ? RA_INITIAL_MS : RA_NORMAL_MS;
  } else {
    next_ms = RA_NORMAL_MS;
  }
  sys_timeout(next_ms, ra_timer, netif);
}

static void ra_stop(struct netif *netif) {
  ip6_addr_t allrouters;
  if (!netif || ra_netif != netif) return;
  sys_untimeout(ra_timer, netif);
  ip6_addr_set_allrouters_linklocal(&allrouters);
  ip6_addr_assign_zone(&allrouters, IP6_MULTICAST, netif);
  (void)mld6_leavegroup_netif(netif, &allrouters);
  ra_netif = NULL;
  ra_initial_left = 0;
  ra_prefix_count = 0;
  memset(ra_prefixes, 0, sizeof(ra_prefixes));
}

err_t tcpip_ra_set(struct netif *netif, const uint8_t *prefixes,
                   const uint32_t *valid_lifetimes,
                   const uint32_t *preferred_lifetimes,
                   const uint8_t *initial_only, uint8_t prefix_count) {
  ip6_addr_t allrouters;
  u8_t i;
  if (!netif) return ERR_ARG;
  if (!prefixes || prefix_count == 0) {
    ra_stop(netif);
    return ERR_OK;
  }
  if (!valid_lifetimes || !preferred_lifetimes || !initial_only ||
      prefix_count > TCPIP_RA_MAX_PREFIXES) {
    return ERR_ARG;
  }

  if (ra_netif && ra_netif != netif) ra_stop(ra_netif);
  for (i = 0; i < prefix_count; i++) {
    if (preferred_lifetimes[i] > valid_lifetimes[i]) return ERR_ARG;
    memcpy(ra_prefixes[i].prefix.addr, prefixes + ((size_t)i * 16), 16);
    ra_prefixes[i].valid_lifetime = valid_lifetimes[i];
    ra_prefixes[i].preferred_lifetime = preferred_lifetimes[i];
    ra_prefixes[i].initial_only = initial_only[i] ? 1 : 0;
  }
  ra_prefix_count = prefix_count;
  ra_netif = netif;

  if (ip6_addr_islinklocal(netif_ip6_addr(netif, 0))) {
    netif_ip6_addr_set_state(netif, 0, IP6_ADDR_PREFERRED);
  }

  ip6_addr_set_allrouters_linklocal(&allrouters);
  ip6_addr_assign_zone(&allrouters, IP6_MULTICAST, netif);
  (void)mld6_joingroup_netif(netif, &allrouters);

  ra_initial_left = RA_INITIAL_COUNT;
  ra_send(netif);
  ra_initial_left = RA_INITIAL_COUNT - 1;
  sys_untimeout(ra_timer, netif);
  sys_timeout(RA_INITIAL_MS, ra_timer, netif);
  return ERR_OK;
}

int tcpip_ip6_input_hook(struct pbuf *p, struct netif *inp) {
  struct ip6_hdr *ip6hdr;
  struct icmp6_hdr *icmp6;
  if (!ra_netif || inp != ra_netif || !p ||
      p->len < (u16_t)(IP6_HLEN + sizeof(struct icmp6_hdr))) {
    return 0;
  }
  ip6hdr = (struct ip6_hdr *)p->payload;
  if (IP6H_NEXTH(ip6hdr) != IP6_NEXTH_ICMP6) return 0;
  icmp6 = (struct icmp6_hdr *)((u8_t *)p->payload + IP6_HLEN);
  if (icmp6->type != ICMP6_TYPE_RS) return 0;
  ra_send(ra_netif);
  return 0;
}
