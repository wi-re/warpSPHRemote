# Remote companion connections

**Parked as of 2026-10-18.** Direct HTTPS is implemented but is not the recommended
next setup step. Keep using the working localhost/SSH-forwarding workflow. The
implementation is retained and incidental starts remain local-only. This report
preserves optional setup details for later; see [current priorities](ROADMAP.md).

The viewer can connect directly to an explicitly started HTTPS listener on the
simulation host. The existing localhost endpoint and SSH forwarding remain
available. A single daemon manages both endpoints and the same simulations;
there is still one active live-viewer lease, shared across local/remote clients.

## Direct IP or hostname over HTTPS

Start this in the simulation environment on the remote system, after stopping
any daemon already using the same runtime directory:

```bash
warpsph-companion --python /path/to/warp/bin/python \
  --remote-host 10.8.0.12 \
  --tls-cert /path/to/server-chain.pem \
  --tls-key /path/to/server-key.pem
```

Replace `10.8.0.12` with the host's reachable VPN/LAN interface IP. The defaults
are local HTTP `127.0.0.1:8766` and remote HTTPS `10.8.0.12:8767`.
`--port` changes the loopback port; `--remote-port` changes the HTTPS port.
The certificate must be trusted by the browser and contain that IP in its
Subject Alternative Name. For a DNS certificate or an explicit wildcard bind:

```bash
warpsph-companion --remote-host 0.0.0.0 \
  --remote-name simulation.example.org \
  --tls-cert /path/to/server-chain.pem --tls-key /path/to/server-key.pem
```

`--remote-name` is the exact allowed HTTP Host name, without scheme/port/path.
It is required for wildcard binds, can be repeated for certificate-covered
aliases, and defaults to the bind IP for a specific interface. IPv6 is supported,
for example `--remote-host fd00::12` and viewer address `https://[fd00::12]:8767`.
DNS and IP aliases must also match the certificate; Host allowlisting alone
does not establish certificate trust.

The foreground command prints a **Remote viewer** address and **Remote pairing
token**, separately from the persistent local pairing token. In the hosted viewer:

1. Open **Connect daemon**, select **Remote host · HTTPS**.
2. Enter `https://10.8.0.12:8767` (or the certificate-covered hostname).
3. Enter the **remote** pairing token and connect.

Retrieve it again without starting anything:

```bash
warpsph-companion --show-remote-token
```

The remote token grants the authenticated manager operations: list/view runs,
inspect their configuration, pause/resume/stop, and launch the installed,
allowlisted case presets. It is cryptographically random and replaced on every
explicit daemon restart. `--show-token` continues to return the persistent local
credential for localhost/SSH. Neither token is accepted on the other listener.
A saved remote token must be replaced after restart; local saved pairing keeps
working. The remote token and producer credential live only in the OS-user-private
runtime descriptor (0700 directory, 0600 file), never in a public endpoint.

Simulation/desktop-launcher incidental starts can only start loopback HTTP.
Remote flags combined with `--incidental` are rejected before opening sockets.
A running local-only singleton is never silently upgraded to network listening:
stop and explicitly restart it with the remote flags. The implementation does
not modify firewall rules, VPN routes, router forwarding or certificate trust.
Allow the remote port through the host's firewall for the intended clients.

## Certificate setup

An existing organization/private-CA or public-CA certificate is the simplest
option. Its SAN must cover the exact URL host. A private IP normally needs a
private CA trusted by each client. A bare self-signed server certificate that the
browser does not trust will fail before pairing. The viewer cannot bypass this.

For a disposable private-CA setup, use a fresh private directory and retain the
CA private key securely. The following example issues for **one IP**; replace
`10.8.0.12` before running it. Only `ca.crt` is installed as a trusted CA on the
client's OS/browser, using its normal administrator-managed trust process.
Do not install or distribute `ca.key` or `server.key` to viewer devices.

```bash
umask 077
mkdir warpsph-tls
cd warpsph-tls
openssl req -x509 -newkey rsa:3072 -nodes -days 365 \
  -subj '/CN=warpSPH private CA' -keyout ca.key -out ca.crt \
  -addext 'basicConstraints=critical,CA:TRUE' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign'
openssl req -new -newkey rsa:3072 -nodes \
  -subj '/CN=10.8.0.12' -keyout server.key -out server.csr
cat > server.ext <<'EOF'
subjectAltName=IP:10.8.0.12
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid
EOF
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -days 30 -out server.crt -extfile server.ext
```

Pass `server.crt` / `server.key` to the daemon after the client trusts `ca.crt`.
Use `DNS:simulation.example.org` for a hostname SAN, or comma-separated SAN entries
for multiple intended names. Certificate renewal currently requires restarting
the daemon (which also replaces its remote token). Trust-store installation and
certificate lifecycle automation are outside the companion.

## SSH forwarding

For a host with SSH already working, the original method needs no extra daemon
listener or browser certificate:

```bash
# Simulation host, normal daemon:
warpsph-companion --python /path/to/warp/bin/python
# Browser device:
ssh -N -L 8766:127.0.0.1:8766 user@simulation-host
```

In the viewer choose **This device / SSH tunnel**, use
`http://127.0.0.1:8766`, and supply the simulation host's **local** token from
`warpsph-companion --show-token`.

## Transport and browser behavior

- The local HTTP server always binds IPv4 loopback. Simulation adapters use only
  this endpoint and a distinct producer token; the remote TLS listener rejects
  `/producer/*`, including preflights, even with a valid producer credential.
- Remote TLS uses Python's server SSL context, TLS 1.2 minimum and HTTP/1.1.
  Each handshake runs in its connection worker so an abandoned handshake does
  not block the accept loop. At most 32 remote connections are serviced at once;
  handshakes time out after 10 seconds. Exact Host and Origin allowlists remain enforced;
  add another trusted viewer origin with CLI `--origin https://viewer.example`.
  Forwarded Host headers are not trusted automatically.
- The browser rejects non-loopback HTTP endpoints before sending any token.
  HTTPS solves the HTTPS-page/plaintext-remote mixed-content problem. Browser
  local-network permission may still apply to a LAN/VPN address; it is not
  bypassed. Literal private IPs carry a local-address-space hint; DNS/public
  targets let the browser classify their actual address space.
- Large live/static/history particle downloads have no fixed total-duration
  deadline. They remain abortable by Pause updates, detach or connection loss.
  Control calls keep their deadlines (10 seconds; initial pairing 60 seconds).
  TLS response writes use 64 KiB chunks and a 30-second per-write stall deadline,
  allowing a steadily progressing large frame to take longer than 30 seconds.
  Simulations retain normal one-snapshot backpressure or explicit video ACK gates.
- Connection errors distinguish plaintext-address rejection from reachability,
  certificate trust/name, firewall, origin and browser permission possibilities.
  Fetch does not expose the precise TLS failure to JavaScript. Check the browser
  console and certificate/route independently when diagnosis is necessary.

This release adds explicit TLS listening, not a reverse-proxy trust mode,
automatic public exposure, multi-user accounts, WebRTC or NAT traversal. The
host must already be reachable through the chosen LAN/VPN/public route.

Primary references: [Python SSL](https://docs.python.org/3/library/ssl.html),
[Chrome local network access](https://developer.chrome.com/blog/local-network-access).

## Verification

```bash
PYTHONPATH=python python -m pytest tests/test_networking.py -q
npm test
npm run build
```

The networking tests generate a disposable CA and signed server certificate in
pytest's temporary directory. HTTPS clients verify that CA and the URL hostname;
verification is never disabled. They cover IPv4/IPv6 listeners, token separation,
producer rejection, CORS/Host validation, an abandoned TLS handshake concurrent
with a working client, live/static packet transfer, pause/resume and ACK, and real
CLI shutdown/restart with remote-token replacement and stable local pairing.
IPv6 skips only when the platform cannot bind IPv6 loopback. OpenSSL is required
for these certificate fixtures. No certificate is installed in the system trust
store, and no test binds a real external interface.

The browser check exercised remote setup, plaintext rejection before pairing,
and the original localhost live connection. A real cross-machine browser/VPN
session requires the user's route and browser-trusted host certificate; the test
CA was trusted only by fixture HTTPS clients. Generated UI screenshots/logs and
test reports live outside Git in
`warpSPHDevelopment/remote/networking-20261018/`.
