"""Real verified TLS, independent listener credentials and local producer isolation."""
from functools import partial
import json
from pathlib import Path
import shutil
import socket
import ssl
import subprocess
import sys
import threading
from urllib.error import HTTPError, URLError
from urllib.request import HTTPSHandler,ProxyHandler,Request,build_opener
import pytest
from warpsph_remote.daemon import Handler,serve
from warpsph_remote.networking import RemoteOptions,TLSViewerServer,hostname
from warpsph_remote.protocol import validate_packet
from test_companion import api,arrays,wait_for
from test_buffering import publisher_for


@pytest.fixture(scope='module')
def certificates(tmp_path_factory):
    if not shutil.which('openssl'):pytest.skip('openssl is required for disposable TLS fixtures')
    root=tmp_path_factory.mktemp('remote-tls')
    def run(*args):subprocess.run(['openssl',*args],cwd=root,check=True,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
    run('req','-x509','-newkey','rsa:2048','-nodes','-subj','/CN=warpSPH test CA','-days','1','-keyout','ca.key','-out','ca.crt',
        '-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign,cRLSign')
    run('req','-new','-newkey','rsa:2048','-nodes','-subj','/CN=localhost','-keyout','server.key','-out','server.csr')
    (root/'extensions').write_text('subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid\n')
    run('x509','-req','-in','server.csr','-CA','ca.crt','-CAkey','ca.key','-CAcreateserial','-days','1','-out','server.crt','-extfile','extensions')
    return root


@pytest.fixture
def tls_api(api,certificates):
    m,local,endpoint=api
    options=RemoteOptions('127.0.0.1',0,certificates/'server.crt',certificates/'server.key',('localhost','127.0.0.1')).validated()
    m.remote_token='remote-only-test-token'
    server=TLSViewerServer(('127.0.0.1',0),partial(Handler,manager=m,remote=True,allowed_hosts=options.names),options.context())
    worker=threading.Thread(target=server.serve_forever,daemon=True);worker.start()
    context=ssl.create_default_context(cafile=str(certificates/'ca.crt'))
    opener=build_opener(ProxyHandler({}),HTTPSHandler(context=context))
    def call(path,data=None,token=None,headers=None,method=None):
        raw=None if data is None else json.dumps(data).encode()
        return opener.open(Request(f'https://localhost:{server.server_port}'+path,data=raw,method=method,headers={
            'Authorization':'Bearer '+(token or m.remote_token),'Content-Type':'application/json',**(headers or {})}),timeout=3)
    yield m,local,endpoint,server,context,call
    server.shutdown();server.server_close();worker.join(3)


def test_verified_tls_separate_tokens_origin_host_and_no_producer_access(tls_api):
    m,local,_,server,context,call=tls_api
    result=json.load(call('/v1/session',headers={'Origin':'https://fluids.dev'}))
    assert result['loopbackOnly'] is False and result['transport']=='https'
    assert json.load(local('/v1/session'))['loopbackOnly'] is True
    for token in (m.token,m.producer_token,'bad'):
        with pytest.raises(HTTPError) as error:call('/v1/session',token=token)
        assert error.value.code==401
    with pytest.raises(HTTPError) as error:local('/v1/session',token=m.remote_token)
    assert error.value.code==401
    for path,method,data in (('/producer/runs','POST',{'name':'bad'}),('/producer/runs','OPTIONS',None)):
        with pytest.raises(HTTPError) as error:call(path,data,token=m.producer_token,method=method)
        assert error.value.code==403
    for headers in ({'Origin':'https://evil.example'},{'Host':f'evil.example:{server.server_port}'},{'Host':'localhost:1'}):
        with pytest.raises(HTTPError) as error:call('/v1/session',headers=headers)
        assert error.value.code==403
    response=call('/v1/runs',method='OPTIONS',headers={'Origin':'https://fluids.dev','Access-Control-Request-Method':'POST'})
    assert response.status==204 and response.headers['Access-Control-Allow-Origin']=='https://fluids.dev'
    assert 'Authorization' in response.headers['Access-Control-Allow-Headers']
    with pytest.raises(URLError):
        build_opener(ProxyHandler({}),HTTPSHandler(context=ssl.create_default_context())).open(f'https://localhost:{server.server_port}/v1/session',timeout=3)


def test_stalled_tls_handshake_does_not_block_authenticated_clients(tls_api):
    _,_,_,server,_,call=tls_api
    with socket.create_connection(('127.0.0.1',server.server_port),timeout=3):
        assert json.load(call('/v1/session'))['version']==1


def test_remote_viewer_receives_local_producer_data_and_controls(tls_api):
    m,_,local_endpoint,_,_,call=tls_api
    p=publisher_for(m,local_endpoint)
    viewer={'X-Viewer-Id':'remote-viewer-aaaaaaaa'}
    try:
        call(f'/v1/runs/{p.id}/attach',{},headers=viewer).close()
        wait_for(lambda:p.wants_snapshot)
        assert p.snapshot(arrays(),step=0,time_value=0)
        wait_for(lambda:m.runs[p.id]['snapshot'] is not None)
        response=call(f'/v1/runs/{p.id}/snapshot',headers=viewer)
        sequence=int(response.headers['X-Snapshot-Sequence'])
        assert validate_packet(response.read())['arrays']['positions']
        assert validate_packet(call(f'/v1/runs/{p.id}/static',headers=viewer).read())['arrays']['UIDs']
        call(f'/v1/runs/{p.id}/pause',{},headers=viewer).close();wait_for(lambda:p.pausing.is_set())
        call(f'/v1/runs/{p.id}/resume',{},headers=viewer).close();wait_for(lambda:not p.pausing.is_set())
        call(f'/v1/runs/{p.id}/ack',{'sequence':sequence},headers=viewer).close()
        assert m.runs[p.id]['snapshot'] is None
    finally:p.close('stopped')


def test_remote_options_cannot_be_enabled_incidentally_or_without_tls(tmp_path,certificates):
    valid=RemoteOptions('127.0.0.1',0,certificates/'server.crt',certificates/'server.key')
    with pytest.raises(ValueError,match='Incidental'):
        serve(tmp_path/'incidental',incidental=True,remote=valid)
    assert not (tmp_path/'incidental').exists()
    with pytest.raises(OSError):serve(tmp_path/'missing',remote=RemoteOptions('127.0.0.1',0,tmp_path/'missing.crt',tmp_path/'missing.key'))
    assert not (tmp_path/'missing'/'daemon.json').exists()
    for host,names in [('0.0.0.0',()),('127.0.0.1',('0.0.0.0',)),('bad-host',('localhost',))]:
        with pytest.raises(ValueError):RemoteOptions(host,8767,valid.cert,valid.key,names).validated()
    for name in ('https://host','user@host','host/path','host:8767','host\r\nInjected:x','*.example'):
        with pytest.raises(ValueError):hostname(name)
    assert hostname('[::1]')=='::1'
    assert RemoteOptions('::1',8767,valid.cert,valid.key).validated().names==('::1',)
    result=subprocess.run([sys.executable,'-m','warpsph_remote.daemon','--incidental','--remote-host','127.0.0.1'],capture_output=True,text=True)
    assert result.returncode==2 and 'Incidental' in result.stderr


def test_explicit_remote_daemon_restart_keeps_local_pairing_and_rotates_remote(tmp_path,certificates):
    import os,time
    from warpsph_remote.daemon import descriptor,ensure_daemon
    root=tmp_path/'runtime';env={**os.environ,'XDG_STATE_HOME':str(tmp_path/'state')}
    def free_port():
        with socket.socket() as sock:sock.bind(('127.0.0.1',0));return sock.getsockname()[1]
    local_port,remote_port=free_port(),free_port()
    process=None
    def start():
        nonlocal process
        process=subprocess.Popen([sys.executable,'-m','warpsph_remote.daemon','--runtime',str(root),'--port',str(local_port),
            '--remote-host','127.0.0.1','--remote-port',str(remote_port),'--remote-name','localhost',
            '--tls-cert',str(certificates/'server.crt'),'--tls-key',str(certificates/'server.key')],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        deadline=time.monotonic()+10
        while time.monotonic()<deadline:
            assert process.poll() is None
            try:
                info=descriptor(root)
                if info['pid']==process.pid:return info
            except (OSError,ValueError,KeyError):pass
            time.sleep(.03)
        raise TimeoutError('Fixture daemon did not start.')
    def remote_call(info,token):
        opener=build_opener(ProxyHandler({}),HTTPSHandler(context=ssl.create_default_context(cafile=str(certificates/'ca.crt'))))
        # /v1/runs is lightweight; no simulator discovery is required for this check.
        return opener.open(Request(info['remote']['endpoint']+'/v1/runs',headers={'Authorization':'Bearer '+token}),timeout=3)
    try:
        first=start()
        assert json.load(remote_call(first,first['remote']['token']))['runs']==[]
        shown=subprocess.run([sys.executable,'-m','warpsph_remote.daemon','--runtime',str(root),'--show-remote-token'],env=env,capture_output=True,text=True,check=True)
        assert shown.stdout.strip()==first['remote']['token']
        # A second startup may neither reconfigure nor replace the active listener.
        duplicate=subprocess.run([sys.executable,'-m','warpsph_remote.daemon','--runtime',str(root),'--remote-host','127.0.0.1',
            '--tls-cert',str(certificates/'server.crt'),'--tls-key',str(certificates/'server.key')],env=env,capture_output=True,text=True)
        assert duplicate.returncode==2 and 'already running' in duplicate.stderr
        assert descriptor(root)==first
        process.terminate();process.wait(10)
        from warpsph_remote.daemon import remote_pairing_command
        with pytest.raises(ValueError,match='No active'):
            remote_pairing_command(root)
        second=start()
        assert first['token']==second['token']
        assert first['remote']['token']!=second['remote']['token']
        with pytest.raises(HTTPError) as error:remote_call(second,first['remote']['token'])
        assert error.value.code==401
        assert json.load(remote_call(second,second['remote']['token']))['runs']==[]
        assert second['endpoint'].startswith('http://127.0.0.1:')
    finally:
        if process and process.poll() is None:process.terminate();process.wait(10)


def test_ipv6_tls_viewer_listener(api,certificates):
    if not socket.has_ipv6:pytest.skip('IPv6 unavailable')
    m,_,_=api;m.remote_token='ipv6-remote-test-token'
    options=RemoteOptions('::1',0,certificates/'server.crt',certificates/'server.key').validated()
    try:server=TLSViewerServer(('::1',0),partial(Handler,manager=m,remote=True,allowed_hosts=options.names),options.context())
    except OSError:pytest.skip('IPv6 loopback unavailable')
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    try:
        opener=build_opener(ProxyHandler({}),HTTPSHandler(context=ssl.create_default_context(cafile=str(certificates/'ca.crt'))))
        response=opener.open(Request(f'https://[::1]:{server.server_port}/v1/runs',headers={'Authorization':'Bearer '+m.remote_token}),timeout=3)
        assert json.load(response)['runs']==[]
    finally:server.shutdown();server.server_close();thread.join(3)
