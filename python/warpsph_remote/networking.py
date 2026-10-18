"""Explicit TLS viewer listener; producer traffic always uses loopback HTTP."""
from dataclasses import dataclass
import ipaddress
from pathlib import Path
import re
import socket
import ssl
import threading
from http.server import ThreadingHTTPServer


def hostname(value):
    if not isinstance(value,str) or not value or value!=value.strip() or any(c in value for c in '/\\@?#% \t\r\n'):
        raise ValueError('Use a bare IP address or DNS hostname, without a URL, path or credentials.')
    value=value.removeprefix('[').removesuffix(']')
    try:return str(ipaddress.ip_address(value))
    except ValueError:pass
    if ':' in value or re.fullmatch(r'[0-9.]+',value):
        raise ValueError('Invalid IP address.')
    value=value.rstrip('.').encode('idna').decode('ascii').lower()
    if len(value)>253 or any(not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?',part) for part in value.split('.')):
        raise ValueError('Invalid DNS hostname.')
    return value


def authority(name,port):
    return f'[{name}]:{port}' if ':' in name else f'{name}:{port}'


@dataclass(frozen=True)
class RemoteOptions:
    host:str
    port:int
    cert:Path
    key:Path
    names:tuple[str,...]=()

    def validated(self):
        try:address=ipaddress.ip_address(self.host)
        except ValueError:raise ValueError('--remote-host must be an IPv4 or IPv6 bind address.') from None
        if type(self.port) is not int or not 0<=self.port<=65535:
            raise ValueError('Remote port must be between 1 and 65535.')
        names=tuple(dict.fromkeys(hostname(v) for v in self.names))
        if not names:
            if address.is_unspecified:
                raise ValueError('A wildcard bind needs --remote-name with the IP or DNS name used by viewers.')
            names=(str(address),)
        if any(ipaddress.ip_address(v).is_unspecified for v in names if re.fullmatch(r'[0-9.:]+',v)):
            raise ValueError('A viewer hostname cannot be a wildcard address.')
        return RemoteOptions(str(address),self.port,Path(self.cert),Path(self.key),names)

    def context(self):
        context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version=ssl.TLSVersion.TLSv1_2
        context.set_alpn_protocols(['http/1.1'])
        context.load_cert_chain(str(self.cert),str(self.key))
        return context


class TLSViewerServer(ThreadingHTTPServer):
    daemon_threads=True
    def __init__(self,address,handler,context):
        self.context=context
        self.connections=threading.BoundedSemaphore(32)
        if ':' in address[0]:self.address_family=socket.AF_INET6
        super().__init__(address,handler)

    def process_request(self,request,client_address):
        if not self.connections.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:super().process_request(request,client_address)
        except BaseException:
            self.connections.release()
            raise

    def process_request_thread(self,request,client_address):
        # Handshake in this connection's worker, never in the accept loop.
        wrapped=None
        try:
            request.settimeout(10)
            wrapped=self.context.wrap_socket(request,server_side=True)
            wrapped.settimeout(30)
            self.finish_request(wrapped,client_address)
        except (OSError,ValueError):
            pass  # Failed/abandoned handshakes must not log secrets or stall peers.
        except Exception:
            self.handle_error(request,client_address)
        finally:
            try:self.shutdown_request(wrapped or request)
            finally:self.connections.release()
