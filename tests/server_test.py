"""Starts server/app.py locally (temporary data folder, fake Evolution) and checks its routes.
Usage: python3 tests/server_test.py
"""
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT_URL = 'http://127.0.0.1:8080'
results = []


def call(method, path, body=None, headers=None, raw=None):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(PORT_URL + path, data=data, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            content = r.read()
            return r.status, (json.loads(content) if r.headers.get('Content-Type', '').startswith('application/json') else content)
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b'{}')


def test(name, fn):
    try:
        fn()
        results.append(True)
        print('  ✓', name)
    except AssertionError as e:
        results.append(False)
        print('  ✗', name, '\n     ', e)


ADMIN = {'X-Admin-Key': 'adm'}


def t_health():
    st, r = call('GET', '/saude')
    assert st == 200 and r['ok'], r


def t_report_without_key():
    st, r = call('POST', '/relatos', {'descricao': 'A campanha parou', 'vendedor': 'Ana', 'erros': ['erro 1', 'erro 2'], 'info': {'versao': '0.8.3'}})
    assert st == 200 and len(r['id']) == 6 and r['anexoToken'] is None, r
    st, d = call('GET', '/admin/relatos/' + r['id'], headers=ADMIN)
    assert st == 200 and d['descricao'] == 'A campanha parou' and d['erros'] == ['erro 1', 'erro 2'] and d['info']['versao'] == '0.8.3', d
    assert 'anexo_token' not in d, 'token must not leak'


def t_report_with_attachment():
    img = b'\x89PNG fake image bytes' * 100
    st, r = call('POST', '/relatos', {'descricao': 'com print', 'anexo': {'nome': 'tela.png', 'mime': 'image/png', 'tamanho': len(img)}})
    assert st == 200 and r['anexoToken'], r
    st, _ = call('PUT', f"/relatos/{r['id']}/anexo", raw=img, headers={'X-Anexo-Token': 'wrong'})
    assert st == 403, 'wrong token must be refused'
    st, ok = call('PUT', f"/relatos/{r['id']}/anexo", raw=img, headers={'X-Anexo-Token': r['anexoToken'], 'Content-Type': 'image/png'})
    assert st == 200, ok
    st, again = call('PUT', f"/relatos/{r['id']}/anexo", raw=img, headers={'X-Anexo-Token': r['anexoToken']})
    assert st == 403, 'token is single-use'
    st, content = call('GET', f"/admin/relatos/{r['id']}/anexo", headers=ADMIN)
    assert st == 200 and content == img, 'attachment downloaded intact'


def t_rejects_bad_attachment():
    st, r = call('POST', '/relatos', {'descricao': 'x', 'anexo': {'nome': 'a.exe', 'mime': 'application/x-msdownload', 'tamanho': 10}})
    assert st == 400, r
    st, r = call('POST', '/relatos', {'descricao': 'x', 'anexo': {'nome': 'a.mp4', 'mime': 'video/mp4', 'tamanho': 31 * 1024 * 1024}})
    assert st == 400, r


def t_admin_needs_key():
    st, _ = call('GET', '/admin/relatos')
    assert st == 403
    st, rows = call('GET', '/admin/relatos', headers=ADMIN)
    assert st == 200 and len(rows) >= 2, rows


def t_rate_limit():
    codes = [call('POST', '/relatos', {'descricao': f'spam {i}'})[0] for i in range(12)]
    assert 429 in codes, codes


def t_report_with_key_links_account():
    st, acc = call('POST', '/admin/contas', {'nome': 'Vendedor'}, headers=ADMIN)
    st, r = call('POST', '/relatos', {'descricao': 'com chave'}, headers={'Authorization': 'Bearer ' + acc['chave'], 'X-Forwarded-For': '10.0.0.9'})
    assert st == 200, r
    st, d = call('GET', '/admin/relatos/' + r['id'], headers=ADMIN)
    assert d['conta'] == acc['id'], d


if __name__ == '__main__':
    data = tempfile.mkdtemp()
    env = dict(os.environ, DADOS=data, ADMIN_KEY='adm', EVO_URL='http://127.0.0.1:9', WEBHOOK_SECRET='wh')
    proc = subprocess.Popen([sys.executable, os.path.join(ROOT, 'server', 'app.py')], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    try:
        for _ in range(50):
            try:
                call('GET', '/saude')
                break
            except Exception:
                time.sleep(0.1)
        for name, fn in [('health', t_health), ('report without key', t_report_without_key), ('report with attachment', t_report_with_attachment),
                         ('rejects bad attachment', t_rejects_bad_attachment), ('admin needs key', t_admin_needs_key),
                         ('report with key links account', t_report_with_key_links_account), ('rate limit per IP', t_rate_limit)]:
            test(name, fn)
    finally:
        proc.terminate()
    print(f'\n{sum(results)} passed, {results.count(False)} failed')
    sys.exit(0 if all(results) else 1)
