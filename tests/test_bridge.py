import io
import time
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from pypdf import PdfWriter

from bridge import Store, create_app


def pdf(width=100):
    output = io.BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=width, height=150)
    writer.write(output)
    return output.getvalue()


def test_auth_validation_confirmation_and_idempotency(tmp_path):
    config = dict(token='x'*48, printer='LABEL', sumatra_path=__file__, printing_enabled=True)
    sent = []
    def sender(*args):
        sent.append(args[2])
        return 'submitted', 'fake'
    with TestClient(create_app(config, tmp_path, sender)) as client:
        assert client.get('/health').status_code == 401
        client.headers['Authorization'] = 'Bearer ' + config['token']
        headers = {'Idempotency-Key':'one', 'Content-Type':'application/pdf'}
        assert client.post('/v1/jobs', content=b'bad', headers=headers).status_code == 422
        response = client.post('/v1/jobs', content=pdf(), headers=headers)
        assert response.status_code == 201
        job = response.json()
        assert job['status'] == 'awaiting_confirmation'
        assert sent == []
        assert client.post('/v1/jobs', content=pdf(), headers=headers).json()['id'] == job['id']
        assert client.post('/v1/jobs', content=pdf(200), headers=headers).status_code == 409
        url = '/v1/jobs/' + job['id']
        assert client.post(url+'/confirm').status_code == 200
        assert client.post(url+'/confirm').status_code == 200
        for _ in range(40):
            if client.get(url).json()['status'] == 'submitted':
                break
            time.sleep(.1)
        assert client.get(url).json()['status'] == 'submitted'
        client.post(url+'/confirm')
        assert len(sent) == 1


def test_recovery_cancel_and_concurrent_keys(tmp_path):
    store = Store(tmp_path/'jobs.db')
    with ThreadPoolExecutor(8) as pool:
        ids = list(pool.map(lambda _: store.create('same', pdf()), range(8)))
    assert len(set(ids)) == 1
    store.confirm(ids[0])
    assert store.claim()['id'] == ids[0]
    assert store.claim() is None
    Store(tmp_path/'jobs.db').recover()
    assert store.get(ids[0])['status'] == 'uncertain'
    store.confirm(ids[0])
    assert store.claim() is None


def test_disabled_and_cancel(tmp_path):
    config = dict(token='x'*48, printer='LABEL', sumatra_path='missing', printing_enabled=False)
    with TestClient(create_app(config, tmp_path)) as client:
        client.headers['Authorization'] = 'Bearer ' + config['token']
        job = client.post('/v1/jobs', content=pdf(), headers={'Idempotency-Key':'a','Content-Type':'application/pdf'}).json()
        url = '/v1/jobs/'+job['id']
        assert client.post(url+'/confirm').status_code == 503
        assert client.delete(url).json()['status'] == 'cancelled'
        assert client.get('/v1/jobs/missing').status_code == 404
