"""Ponte de impressão: uma instância, um consumidor, armazenamento SQLite."""
import asyncio
import base64
import hashlib
import hmac
import io
import json
import logging
import mimetypes
import secrets
import sqlite3
import subprocess
import time
import uuid
from contextlib import asynccontextmanager, contextmanager
from pathlib import Path

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pypdf import PdfReader

ROOT = Path(__file__).resolve().parent
WEB = ROOT / 'web'
MAX_BYTES = 20 * 1024 * 1024
SESSION_COOKIE = 'toffa_session'
SESSION_SECONDS = 7 * 86400
log = logging.getLogger("bridge")
# O registro do Windows pode mapear .js para text/plain; módulos ES exigem JavaScript.
mimetypes.add_type('text/javascript', '.js')


def hash_password(password, iterations=600_000):
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac('sha256', password.encode(), salt, iterations)
    return f'pbkdf2_sha256${iterations}${salt.hex()}${digest.hex()}'


def check_password(password, stored):
    try:
        scheme, iterations, salt, expected = stored.split('$')
        if scheme != 'pbkdf2_sha256':
            return False
        digest = hashlib.pbkdf2_hmac('sha256', password.encode(), bytes.fromhex(salt), int(iterations))
        return hmac.compare_digest(digest.hex(), expected)
    except (AttributeError, ValueError):
        return False


class Sessions:
    """Cookie assinado com HMAC; trocar session_secret invalida todas as sessões."""

    def __init__(self, secret):
        self.key = secret.encode()

    def issue(self):
        payload = base64.urlsafe_b64encode(json.dumps({'exp': int(time.time()) + SESSION_SECONDS}).encode()).decode()
        return payload + '.' + hmac.new(self.key, payload.encode(), 'sha256').hexdigest()

    def valid(self, value):
        payload, _, signature = (value or '').partition('.')
        if not hmac.compare_digest(hmac.new(self.key, payload.encode(), 'sha256').hexdigest(), signature):
            return False
        try:
            return json.loads(base64.urlsafe_b64decode(payload))['exp'] > time.time()
        except (ValueError, KeyError, TypeError):
            return False


class Store:
    def __init__(self, path):
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("""CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY, key TEXT UNIQUE, digest TEXT, pdf BLOB,
                status TEXT, created REAL, updated REAL, detail TEXT)""")

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def recover(self):
        with self.connect() as db:
            db.execute("UPDATE jobs SET status='uncertain', detail='Serviço interrompido durante envio; confira a impressora antes de reenviar.' WHERE status='dispatching'")

    def create(self, key, pdf):
        digest = hashlib.sha256(pdf).hexdigest()
        now = time.time()
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT id,digest FROM jobs WHERE key=?", (key,)).fetchone()
            if row:
                if row['digest'] != digest:
                    raise HTTPException(409, 'Chave já usada para outro arquivo')
                return row['id']
            count = db.execute("SELECT COUNT(*) FROM jobs WHERE pdf IS NOT NULL").fetchone()[0]
            if count >= 100:
                raise HTTPException(503, 'Armazenamento da fila cheio')
            job_id = str(uuid.uuid4())
            db.execute("INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?)", (job_id,key,digest,pdf,'awaiting_confirmation',now,now,None))
            return job_id

    def recent(self, limit=20):
        with self.connect() as db:
            rows = db.execute("SELECT id,status,created,updated,detail FROM jobs ORDER BY created DESC LIMIT ?", (limit,)).fetchall()
        return [dict(row) for row in rows]

    def get(self, job_id):
        with self.connect() as db:
            row = db.execute("SELECT id,status,created,updated,detail FROM jobs WHERE id=?", (job_id,)).fetchone()
        if row is None:
            raise HTTPException(404, 'Pedido não encontrado')
        return dict(row)

    def confirm(self, job_id):
        with self.connect() as db:
            db.execute("UPDATE jobs SET status='queued',updated=? WHERE id=? AND status='awaiting_confirmation'", (time.time(),job_id))
        return self.get(job_id)

    def claim(self):
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute("SELECT id,pdf FROM jobs WHERE status='queued' ORDER BY created LIMIT 1").fetchone()
            if row:
                db.execute("UPDATE jobs SET status='dispatching',updated=? WHERE id=?", (time.time(),row['id']))
            return row

    def finish(self, job_id, status, detail=None):
        with self.connect() as db:
            db.execute('UPDATE jobs SET status=?,detail=?,updated=?,pdf=NULL WHERE id=?', (status,detail,time.time(),job_id))

    def expire(self):
        with self.connect() as db:
            db.execute("UPDATE jobs SET pdf=NULL,status='expired' WHERE status='awaiting_confirmation' AND created<?", (time.time()-86400,))
            db.execute("DELETE FROM jobs WHERE updated<? AND status NOT IN ('queued','dispatching')", (time.time()-30*86400,))


def dispatch(config, pdf, job_id, directory):
    path = directory / (job_id + '.pdf')
    try:
        path.write_bytes(pdf)
        result = subprocess.run([
            config['sumatra_path'], '-print-to', config['printer'],
            '-print-settings', config.get('print_settings', 'noscale'),
            '-silent', str(path)
        ], timeout=120, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        if result.returncode != 0:
            return 'uncertain', f'Motor retornou {result.returncode}; confira a fila do Windows antes de reenviar.'
        return 'submitted', 'Enviado ao Windows; não confirma saída física da etiqueta.'
    except (subprocess.TimeoutExpired, OSError):
        log.exception('Falha no envio do pedido %s', job_id)
        return 'uncertain', 'Falha no envio; confira a fila do Windows antes de reenviar.'
    finally:
        path.unlink(missing_ok=True)


def create_app(config, data_dir=None, sender=dispatch):
    if len(config.get('token', '')) < 32:
        raise ValueError('Configure um token aleatório com pelo menos 32 caracteres')
    directory = data_dir or ROOT / 'data'
    store = Store(directory / 'jobs.sqlite3')

    async def consume():
        while True:
            store.expire()
            row = store.claim() if config.get('printing_enabled') else None
            if row:
                status, detail = await asyncio.to_thread(sender, config, row['pdf'], row['id'], directory)
                store.finish(row['id'], status, detail)
            else:
                await asyncio.sleep(1)

    @asynccontextmanager
    async def lifespan(app):
        store.recover()
        task = asyncio.create_task(consume())
        # A falha do consumidor derruba o processo para recuperação pelo serviço.
        def failed(t):
            if not t.cancelled() and t.exception():
                import os
                log.critical('Consumidor parou', exc_info=t.exception())
                os._exit(1)
        task.add_done_callback(failed)
        yield
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    sessions = Sessions(config.get('session_secret') or hmac.new(config['token'].encode(), b'site-session', 'sha256').hexdigest())
    failures = {}

    async def authorize(request: Request):
        supplied = request.headers.get('authorization', '')
        if supplied and secrets.compare_digest(supplied.encode(), ('Bearer ' + config['token']).encode()):
            return
        if sessions.valid(request.cookies.get(SESSION_COOKIE)):
            # Cabeçalho próprio força preflight CORS, que não é permitido: bloqueia CSRF.
            if request.method in ('GET', 'HEAD') or request.headers.get('x-toffa') == '1':
                return
            raise HTTPException(403, 'Requisição sem cabeçalho do site')
        raise HTTPException(401, 'Não autorizado')

    app = FastAPI(title='Toffa Print Bridge', lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.store = store
    api = APIRouter(dependencies=[Depends(authorize)])

    @app.middleware('http')
    async def headers(request: Request, call_next):
        response = await call_next(request)
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['Referrer-Policy'] = 'no-referrer'
        response.headers['X-Frame-Options'] = 'DENY'
        response.headers['Content-Security-Policy'] = (
            "default-src 'self'; script-src 'self'; worker-src 'self'; img-src 'self' data: blob:; "
            "style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
        response.headers.setdefault('Cache-Control', 'no-store')
        return response

    @app.get('/', include_in_schema=False)
    def index():
        return FileResponse(WEB / 'index.html', headers={'Cache-Control': 'no-cache'})

    if WEB.is_dir():
        app.mount('/static', StaticFiles(directory=WEB), name='static')

    @app.post('/auth/login')
    async def login(request: Request, response: Response):
        stored = config.get('site_password_hash')
        if not stored:
            raise HTTPException(503, 'Senha do site não configurada; execute setup.py --senha no Windows')
        client = request.headers.get('cf-connecting-ip') or (request.client.host if request.client else '?')
        now = time.time()
        recent = [t for t in failures.get(client, []) if t > now - 900]
        if len(recent) >= 10:
            raise HTTPException(429, 'Muitas tentativas; aguarde 15 minutos')
        try:
            password = str((await request.json()).get('password', ''))[:256]
        except (ValueError, AttributeError):
            raise HTTPException(400, 'Envie {"password": "..."}')
        if not await asyncio.to_thread(check_password, password, stored):
            if len(failures) > 1000:
                failures.clear()
            failures[client] = recent + [now]
            raise HTTPException(401, 'Senha incorreta')
        failures.pop(client, None)
        local = request.url.hostname in ('127.0.0.1', 'localhost')
        response.set_cookie(SESSION_COOKIE, sessions.issue(), max_age=SESSION_SECONDS, httponly=True,
                            secure=not local, samesite='strict', path='/')
        return {'ok': True}

    @app.post('/auth/logout')
    def logout(response: Response):
        response.delete_cookie(SESSION_COOKIE, path='/')
        return {'ok': True}

    @api.get('/health')
    def health():
        return {'status':'ok', 'printer':config['printer'], 'printing_enabled':config.get('printing_enabled',False), 'engine_available':Path(config['sumatra_path']).is_file(),
                'label_width_mm':config.get('label_width_mm', 100), 'label_height_mm':config.get('label_height_mm', 150)}

    @api.get('/v1/jobs')
    def recent():
        return store.recent()

    @api.post('/v1/jobs', status_code=201)
    async def upload(request: Request):
        key = request.headers.get('idempotency-key', '')
        if not 1 <= len(key) <= 128:
            raise HTTPException(400, 'Idempotency-Key obrigatório (1–128 caracteres)')
        if request.headers.get('content-type', '').split(';')[0] != 'application/pdf':
            raise HTTPException(415, 'Envie application/pdf')
        body = bytearray()
        async for chunk in request.stream():
            if len(body) + len(chunk) > MAX_BYTES:
                raise HTTPException(413, 'Limite: 20 MB')
            body.extend(chunk)
        try:
            if not body.startswith(b'%PDF-'):
                raise ValueError()
            reader = await asyncio.to_thread(PdfReader, io.BytesIO(body))
            if reader.is_encrypted or not 1 <= len(reader.pages) <= 500:
                raise ValueError()
        except Exception:
            raise HTTPException(422, 'PDF inválido, criptografado ou fora do limite de 1–500 páginas')
        job_id = store.create(key, bytes(body))
        return store.get(job_id)

    @api.get('/v1/jobs/{job_id}')
    def status(job_id: str):
        return store.get(job_id)

    @api.post('/v1/jobs/{job_id}/confirm')
    def confirm(job_id: str):
        if not config.get('printing_enabled') or not Path(config['sumatra_path']).is_file():
            raise HTTPException(503, 'Impressão ainda não habilitada/configurada')
        return store.confirm(job_id)

    @api.delete('/v1/jobs/{job_id}')
    def cancel(job_id: str):
        with store.connect() as db:
            db.execute("UPDATE jobs SET status='cancelled',pdf=NULL,updated=? WHERE id=? AND status IN ('awaiting_confirmation','queued')", (time.time(),job_id))
        return store.get(job_id)

    app.include_router(api)
    return app


if __name__ == '__main__':
    import uvicorn
    config = json.loads((ROOT / 'config.json').read_text(encoding='utf-8-sig'))
    uvicorn.run(create_app(config), host='127.0.0.1', port=17891, access_log=False, limit_concurrency=8, timeout_keep_alive=5)
