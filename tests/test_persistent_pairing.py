import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor

import pytest
from warpsph_remote.pairing_token import persistent_token, token_directory
from warpsph_remote.daemon import descriptor, ensure_daemon, pairing_command


@pytest.fixture(autouse=True)
def private_state(tmp_path, monkeypatch):
    monkeypatch.setenv('XDG_STATE_HOME', str(tmp_path / 'state'))


def test_pairing_is_stable_private_and_independent_of_runtime(tmp_path):
    with ThreadPoolExecutor(max_workers=8) as pool:
        tokens = list(pool.map(lambda _: persistent_token(), range(16)))
    assert len(set(tokens)) == 1 and len(tokens[0]) >= 40
    root = token_directory()
    assert stat.S_IMODE(root.stat().st_mode) == 0o700
    assert stat.S_IMODE((root / 'pairing-token').stat().st_mode) == 0o600
    assert pairing_command(tmp_path / 'runtime-one') == tokens[0]
    assert pairing_command(tmp_path / 'runtime-two') == tokens[0]
    rotated = pairing_command(tmp_path / 'runtime-one', rotate=True)
    assert rotated != tokens[0] and persistent_token() == rotated


def test_shared_state_directory_is_scoped_to_system(monkeypatch):
    import warpsph_remote.pairing_token as module
    monkeypatch.setattr(module, 'system_scope', lambda: 'machine-one')
    first = persistent_token()
    monkeypatch.setattr(module, 'system_scope', lambda: 'machine-two')
    assert persistent_token() != first
    monkeypatch.setattr(module, 'system_scope', lambda: 'machine-one')
    assert persistent_token() == first


@pytest.mark.parametrize('entry', ['pairing-token', 'pairing.lock'])
def test_insecure_or_symlinked_files_are_rejected(tmp_path, entry):
    root = token_directory()
    target = tmp_path / 'elsewhere'
    target.write_text('not-a-credential')
    (root / entry).symlink_to(target)
    with pytest.raises((ValueError, OSError)):
        persistent_token()
    (root / entry).unlink()
    (root / entry).write_text('a' * 43)
    (root / entry).chmod(0o644)
    with pytest.raises(ValueError, match='private'):
        persistent_token()


def test_invalid_existing_token_is_not_silently_replaced():
    root = token_directory()
    token = root / 'pairing-token'
    token.write_text('bad')
    token.chmod(0o600)
    with pytest.raises(ValueError, match='Invalid stored'):
        persistent_token()
    assert token.read_text() == 'bad'


def test_initial_active_token_can_be_preserved_but_never_overwrites_existing():
    first, other = 'a' * 43, 'b' * 43
    assert persistent_token(initial=first) == first
    assert persistent_token(initial=other) == first


def stop(root):
    info = descriptor(root)
    os.kill(info['pid'], signal.SIGTERM)
    until = time.monotonic() + 10
    while (root / 'daemon.json').exists() and time.monotonic() < until:
        time.sleep(.05)
    assert not (root / 'daemon.json').exists()
    try:
        os.waitpid(info['pid'], os.WNOHANG)
    except ChildProcessError:
        pass


def test_implicit_restart_preserves_viewer_token_and_rotates_producer_key(tmp_path):
    root = tmp_path / 'runtime'
    try:
        first = ensure_daemon(root, port=0)
        assert pairing_command(root) == first['token']
        with pytest.raises(ValueError, match='Stop this daemon'):
            pairing_command(root, rotate=True)
        assert persistent_token() == first['token']
        stop(root)
        # The runtime directory and descriptor are disposable; persistent state is separate.
        for path in root.iterdir():
            path.unlink()
        root.rmdir()
        second = ensure_daemon(root, port=0)
        assert first['token'] == second['token']
        assert first['producerToken'] != second['producerToken']
        assert 'Pairing token:' not in (root / 'daemon.log').read_text()
        stop(root)
        cli = subprocess.run([sys.executable, '-m', 'warpsph_remote.daemon',
                              '--runtime', str(root), '--show-token'],
                             capture_output=True, text=True, check=True)
        assert cli.stdout.strip() == first['token']
        assert not (root / 'daemon.json').exists()
        rotated = subprocess.run([sys.executable, '-m', 'warpsph_remote.daemon',
                                  '--runtime', str(root), '--rotate-token'],
                                 capture_output=True, text=True, check=True).stdout.strip()
        assert rotated != first['token'] and rotated == persistent_token()
        third = ensure_daemon(root, port=0)
        assert third['token'] == rotated
    finally:
        if (root / 'daemon.json').exists():
            stop(root)


def test_upgrade_preserves_active_legacy_token(tmp_path):
    import fcntl
    from warpsph_remote.daemon import runtime_dir
    root = runtime_dir(tmp_path / 'legacy')
    active_token = 'c' * 43
    (root / 'daemon.json').write_text(json.dumps({'token': active_token}))
    (root / 'daemon.json').chmod(0o600)
    with open(root / 'daemon.lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        assert pairing_command(root) == active_token
        assert persistent_token() == active_token
        with pytest.raises(ValueError, match='Stop this daemon'):
            pairing_command(root, rotate=True)
    assert pairing_command(root) == active_token


def test_insecure_directory_and_oversized_token_fail_closed():
    root = token_directory()
    root.chmod(0o755)
    with pytest.raises(ValueError, match='directory'):
        persistent_token()
    root.chmod(0o700)
    token = root / 'pairing-token'
    token.write_text('d' * 43 + ' ' * 300)
    token.chmod(0o600)
    with pytest.raises(ValueError, match='size'):
        persistent_token()


def test_relative_state_path_cannot_write_credentials_into_a_checkout(monkeypatch):
    monkeypatch.setenv('XDG_STATE_HOME', 'relative-state')
    with pytest.raises(ValueError, match='absolute'):
        persistent_token()


@pytest.mark.parametrize('entry', ['pairing-token', 'pairing.lock'])
def test_hard_linked_credential_files_are_rejected(tmp_path, entry):
    root = token_directory()
    target = tmp_path / 'linked'
    target.write_text('e' * 43)
    target.chmod(0o600)
    os.link(target, root / entry)
    with pytest.raises(ValueError, match='private'):
        persistent_token()
