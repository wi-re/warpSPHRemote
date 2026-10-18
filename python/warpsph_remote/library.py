"""Small persistent run/measurement library. Never stores particle snapshots or secrets."""
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import stat
import time

TERMINAL = ('completed','stopped','failed','interrupted')
PERSIST = ('id','name','startedAt','updatedAt','status','pid','step','time','dt','particles','dimension','scheme',
           'createdBy','message','launch','recording','configuration','performance','resources','capabilities','pause','measurements','diagnosticProbes','recordedProbeDefinitions','libraryWarning','pipeline','storageEstimate')

class RunLibrary:
    def __init__(self, runtime):
        from .daemon import runtime_dir
        configured=os.environ.get('WARPSPH_REMOTE_DATA')
        if configured:
            self.root=Path(configured).expanduser().resolve()
        elif runtime == runtime_dir():
            state=Path(os.environ.get('XDG_STATE_HOME',Path.home()/'.local/state'))
            key=hashlib.sha256(str(runtime).encode()).hexdigest()[:16]
            self.root=state/'warpsph-remote'/'libraries'/key
        else:
            self.root=runtime.parent/(runtime.name+'-library') # Private custom runtimes stay isolated, including tests.
        self.root.mkdir(parents=True,exist_ok=True,mode=0o700)
        st=self.root.lstat()
        if not stat.S_ISDIR(st.st_mode) or st.st_uid!=os.getuid() or st.st_mode & 0o077:
            raise ValueError('Run library directory must be owned by this user and mode 0700.')
        self.path=self.root/'runs.sqlite3'
        with self.connect() as db:
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, body TEXT NOT NULL)')
            db.execute('CREATE TABLE IF NOT EXISTS samples (seq INTEGER PRIMARY KEY, run TEXT NOT NULL, wall REAL NOT NULL, body TEXT NOT NULL, token TEXT UNIQUE)')
            db.execute('CREATE INDEX IF NOT EXISTS sample_run ON samples(run,seq)')
        os.chmod(self.path,0o600)
        self.last={}
        self.saved={}

    @contextmanager
    def connect(self):
        db=sqlite3.connect(self.path,timeout=5)
        try:
            with db: yield db
        finally: db.close()

    def load(self):
        with self.connect() as db:
            rows=[json.loads(r[0]) for r in db.execute('SELECT body FROM runs ORDER BY rowid')]
        for r in rows:
            if r.get('status') not in TERMINAL:
                r.update(status='interrupted',message='Daemon restarted; waiting for the producer to re-register.')
            r.update(registered=False,sequence=0,lease=None,leaseAt=0,snapshot=None,static=None,metadata=None,capture=False,recovered=True)
        return rows

    def save(self,run):
        now=time.monotonic()
        signature=(run.get('status'),bool(run.get('configuration')),bool(run.get('recording')),json.dumps(run.get('diagnosticProbes',[])),run.get('libraryWarning'))
        previous=self.saved.get(run['id'])
        if previous and now-previous[0]<1 and signature==previous[1]: return
        self.saved[run['id']]=(now,signature)
        body={k:run[k] for k in PERSIST if k in run}
        with self.connect() as db:
            db.execute('INSERT OR REPLACE INTO runs(id,body) VALUES(?,?)',(run['id'],json.dumps(body,allow_nan=False)))

    def sample(self,run,data):
        # Status is sent at 20ms while attached; persist at most once/second,
        # unless a physical sample or lifecycle transition needs preserving.
        now=time.time(); previous=self.last.get(run['id'],(0,None,None))
        physical=data.get('physical')
        identity=None if not physical else (physical.get('step'),physical.get('time'))
        terminal=run.get('status') in TERMINAL
        if now-previous[0]<1 and identity==previous[2] and previous[1]==run.get('status'): return
        row={k:run[k] for k in ('step','time','dt','status','performance','resources','pipeline','storageEstimate') if k in run}
        if physical: row['physical']=physical
        row['wallTime']=now;row['elapsedSeconds']=max(0,now-run['startedAt'])
        self.last[run['id']]=(now,run.get('status'),identity)
        with self.connect() as db:
            db.execute('INSERT INTO samples(run,wall,body) VALUES(?,?,?)',(run['id'],now,json.dumps(row,allow_nan=False)))

    def physical_samples(self,run,rows):
        now=time.time()
        with self.connect() as db:
            db.executemany('INSERT OR IGNORE INTO samples(run,wall,body,token) VALUES(?,?,?,?)',
                [(run['id'],now,json.dumps(dict(wallTime=row.get('wallTime',now),elapsedSeconds=max(0,row.get('wallTime',now)-run['startedAt']),
                    step=row['step'],time=row['time'],status='sampled',physical=row),allow_nan=False),run['id']+':'+str(row.get('wallTime'))+':'+str(row['step'])+':'+str(row['time'])) for row in rows])

    def samples(self,key,after=0,limit=2000):
        if type(after) is not int or after<0 or not 1<=limit<=2000: raise ValueError('Invalid measurement page.')
        with self.connect() as db:
            rows=[dict(sequence=seq,**json.loads(body)) for seq,body in db.execute('SELECT seq,body FROM samples WHERE run=? AND seq>? ORDER BY seq LIMIT ?', (key,after,limit))]
        return dict(samples=rows,next=rows[-1]['sequence'] if rows else after,more=len(rows)==limit)

    def forget(self,key):
        # Forget metadata/history only. Never delete logs or exported particle files.
        with self.connect() as db:
            db.execute('DELETE FROM samples WHERE run=?',(key,));db.execute('DELETE FROM runs WHERE id=?',(key,))

    def recording_bytes(self,run):
        recording=run.get('recording')
        if not recording: return 0
        p=Path(recording['path'])
        try:
            if not p.exists(): return None
            return p.stat().st_size if p.is_file() else sum(f.stat().st_size for f in p.glob('*.h5') if f.is_file())
        except OSError: return None
