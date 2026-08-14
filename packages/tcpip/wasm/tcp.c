#include "lwip/tcp.h"

#include <stdio.h>

#include "lwip/err.h"
#include "ip_address.h"
#include "macros.h"

extern void accept_tcp_connection(struct tcp_pcb *listener, struct tcp_pcb *pcb);
extern void connected_tcp_connection(struct tcp_pcb *conn);
extern void closed_tcp_connection(struct tcp_pcb *conn);
extern void receive_tcp_chunk(struct tcp_pcb *conn, const uint8_t *chunk, uint16_t length);
extern void sent_tcp_chunk(struct tcp_pcb *conn, uint16_t length);

EXPORT("update_tcp_receive_buffer")
void update_tcp_receive_buffer(struct tcp_pcb *conn, uint16_t length) {
  tcp_recved(conn, length);
}

EXPORT("send_tcp_chunk")
uint16_t send_tcp_chunk(struct tcp_pcb *conn, uint8_t *chunk, uint16_t length) {
  uint16_t available_space = tcp_sndbuf(conn);

  if (available_space == 0) {
    return 0;
  }

  uint16_t bytes_to_send = length < available_space ? length : available_space;

  err_t result = tcp_write(conn, chunk, bytes_to_send, TCP_WRITE_FLAG_COPY);
  if (result != ERR_OK) {
    return 0;
  }

  // Force sending chunks immediately
  err_t out_result = tcp_output(conn);
  if (out_result != ERR_OK) {
    return 0;
  }

  return bytes_to_send;
}

EXPORT("close_tcp_connection")
err_t close_tcp_connection(struct tcp_pcb *conn) {
  return tcp_close(conn);
}

EXPORT("shutdown_tcp_connection_write")
err_t shutdown_tcp_connection_write(struct tcp_pcb *conn) {
  return tcp_shutdown(conn, 0, 1);
}

// Callback for when data is received
err_t recv_tcp_callback(void *arg, struct tcp_pcb *conn, struct pbuf *p, err_t err) {
  // TODO: review this logic (should we half-close?)
  if (p == NULL) {
    closed_tcp_connection(conn);
    return ERR_OK;
  }

  receive_tcp_chunk(conn, p->payload, p->len);
  pbuf_free(p);

  return ERR_OK;
}

// Callback for when sent data is acknowledged and new buffer space is available
err_t sent_callback(void *arg, struct tcp_pcb *conn, uint16_t len) {
  sent_tcp_chunk(conn, len);
  return ERR_OK;
}

// Callback for when a new connection is accepted
err_t accept_callback(void *arg, struct tcp_pcb *conn, err_t err) {
  struct tcp_pcb *listener = arg;

  accept_tcp_connection(listener, conn);

  // Set a receive callback to handle incoming data
  tcp_recv(conn, recv_tcp_callback);

  // Set a sent callback to handle outgoing data acknowledgements
  tcp_sent(conn, sent_callback);

  return ERR_OK;
}

EXPORT("create_tcp_listener")
struct tcp_pcb *create_tcp_listener(uint8_t family, const uint8_t *host, int port) {
  ip_addr_t bind_address;
  struct tcp_pcb *listener = tcp_new_ip_type(
      host ? (family == TCPIP_AF_IPV6 ? IPADDR_TYPE_V6 : IPADDR_TYPE_V4)
           : IPADDR_TYPE_ANY);

  if (listener == NULL) {
    return NULL;
  }

  err_t err;
  if (host) {
    err = tcpip_ip_addr_from_bytes(family, host, &bind_address);
    if (err == ERR_OK) err = tcp_bind(listener, &bind_address, port);
  } else {
    err = tcp_bind(listener, IP_ANY_TYPE, port);
  }
  if (err != ERR_OK) {
    tcp_close(listener);
    return NULL;
  }

  listener = tcp_listen(listener);
  if (listener == NULL) {
    return NULL;
  }

  // Store the listener's handle for access in the callback
  tcp_arg(listener, listener);
  tcp_accept(listener, accept_callback);

  return listener;
}

err_t connected_callback(void *arg, struct tcp_pcb *conn, err_t err) {
  connected_tcp_connection(conn);

  // Set a receive callback to handle incoming data
  tcp_recv(conn, recv_tcp_callback);

  // Set a sent callback to handle outgoing data acknowledgements
  tcp_sent(conn, sent_callback);

  return ERR_OK;
}

EXPORT("create_tcp_connection")
struct tcp_pcb *create_tcp_connection(uint8_t family, const uint8_t *host, int port) {
  struct tcp_pcb *conn = tcp_new_ip_type(
      family == TCPIP_AF_IPV6 ? IPADDR_TYPE_V6 : IPADDR_TYPE_V4);

  if (conn == NULL) {
    return NULL;
  }

  ip_addr_t ipaddr;
  if (tcpip_ip_addr_from_bytes(family, host, &ipaddr) != ERR_OK) {
    tcp_close(conn);
    return NULL;
  }

  err_t err = tcp_connect(conn, &ipaddr, port, connected_callback);

  if (err != ERR_OK) {
    tcp_close(conn);
    return NULL;
  }

  return conn;
}

EXPORT("get_tcp_local_address_family")
uint8_t get_tcp_local_address_family(struct tcp_pcb *conn) {
  return tcpip_ip_addr_family(&conn->local_ip);
}

EXPORT("get_tcp_local_address")
const uint8_t *get_tcp_local_address(struct tcp_pcb *conn) {
  return tcpip_ip_addr_bytes(&conn->local_ip);
}

EXPORT("get_tcp_local_port")
uint16_t get_tcp_local_port(struct tcp_pcb *conn) {
  return conn->local_port;
}

EXPORT("get_tcp_remote_address_family")
uint8_t get_tcp_remote_address_family(struct tcp_pcb *conn) {
  return tcpip_ip_addr_family(&conn->remote_ip);
}

EXPORT("get_tcp_remote_address")
const uint8_t *get_tcp_remote_address(struct tcp_pcb *conn) {
  return tcpip_ip_addr_bytes(&conn->remote_ip);
}

EXPORT("get_tcp_remote_port")
uint16_t get_tcp_remote_port(struct tcp_pcb *conn) {
  return conn->remote_port;
}
