"""Private per-user, per-system localhost pairing credential (not a producer key)."""

import fcntl
import hashlib
import os
from pathlib import Path
import re
import secrets
import socket
import stat


def system_scope():
    """Shared home directories must not silently share a machine's credential."""
    try:
        identity = Path('/etc/machine-id').read_text().strip()
    except OSError:
        identity = ''
    identity = identity or socket.gethostname()
    return hashlib.sha256(identity.encode()).hexdigest()[:24]


def token_directory():
    state = Path(os.environ.get('XDG_STATE_HOME') or Path.home() / '.local/state')
    if not state.is_absolute():
        raise ValueError('XDG_STATE_HOME must be an absolute path.')
    namespace = state / 'warpsph-remote'
    namespace.mkdir(parents=True, exist_ok=True, mode=0o700)
    root = namespace / system_scope()
    for directory in (namespace, root):
        if directory == root:
            directory.mkdir(exist_ok=True, mode=0o700)
        st = directory.lstat()
        if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid() or st.st_mode & 0o077:
            raise ValueError('Pairing token directory must be owned by this user and mode 0700.')
    return root


def _private_file(fd):
    st = os.fstat(fd)
    if (not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid()
            or st.st_mode & 0o077 or st.st_nlink != 1):
        raise ValueError('Pairing credential files must be private regular files owned by this user.')


def _valid_token(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_-]{40,128}', value):
        raise ValueError('Invalid stored pairing token; restore or remove the private token file.')
    return value


def persistent_token(*, rotate=False, initial=None):
    root = token_directory()
    lock = os.open(root / 'pairing.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        _private_file(lock)
        fcntl.flock(lock, fcntl.LOCK_EX)
        path = root / 'pairing-token'
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        except FileNotFoundError:
            existing = None
        else:
            with os.fdopen(fd, 'r') as stored:
                _private_file(stored.fileno())
                if os.fstat(stored.fileno()).st_size > 256:
                    raise ValueError('Invalid stored pairing token file size.')
                existing = _valid_token(stored.read(256).strip())
        if existing and not rotate:
            return existing
        token = _valid_token(initial) if initial and not rotate else secrets.token_urlsafe(32)
        temporary = root / ('.pairing-' + secrets.token_hex(12))
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            with os.fdopen(fd, 'w') as output:
                output.write(token + '\n')
                output.flush()
                os.fsync(output.fileno())
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)
        return token
    finally:
        os.close(lock)
