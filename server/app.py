# GoSeller — Kanban server with automatic remarketing.
#
# The extension (in WhatsApp Web) reports when a lead enters/leaves a tab. If the tab has an
# automation, the server sends the message sequence through the Evolution API (the seller's
# WhatsApp connected as a "linked device"), even with the computer off.
# If the lead replies, the sequence stops (and the lead may move to another tab).
#
# Python standard library only (no dependencies). Database: SQLite in /dados.
import base64
import json
import os
import random
import re
import secrets
import sqlite3
import threading
import time
import traceback
import unicodedata
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

EVO_URL = os.environ.get('EVO_URL', 'http://vf-evolution:8080')
EVO_KEY = os.environ.get('EVO_KEY', '')
ADMIN_KEY = os.environ.get('ADMIN_KEY', '')
WEBHOOK_SECRET = os.environ.get('WEBHOOK_SECRET', '')
SELF_URL = os.environ.get('MEU_URL', 'http://vendaflow-api:8080')  # how Evolution reaches this server
PREFIX = os.environ.get('PREFIXO', '/vendaflow')
CONTACT_EMAIL = os.environ.get('EMAIL_CONTATO', 'contato@goseller.app.br')
DATA_DIR = os.environ.get('DADOS', '/dados')
TZ = timezone(timedelta(hours=-3))  # Brasília (no daylight saving time)
MAX_MEDIA = 16 * 1024 * 1024
MAX_REPORT_FILE = 30 * 1024 * 1024  # print/video attached to a problem report
MAX_REPORT_JSON = 200 * 1024
REPORTS_PER_HOUR = 10  # per IP, the report route is public

DEFAULT_CONFIG = {
    'nomeVendedor': '',
    'horaInicio': '08:00',
    'horaFim': '19:00',
    'dias': [1, 2, 3, 4, 5, 6],  # 0 = Sunday
    'limiteDia': 80,
    'intervaloMin': 60,  # seconds between sends (so it doesn't look like a bot)
    'intervaloMax': 180,
    'simularDigitacao': True,
    'palavrasSair': ['sair', 'parar', 'pare', 'stop', 'descadastrar', 'nao quero mais', 'não quero mais', 'remover'],
}

os.makedirs(os.path.join(DATA_DIR, 'midias'), exist_ok=True)
os.makedirs(os.path.join(DATA_DIR, 'relatos'), exist_ok=True)
db = sqlite3.connect(os.path.join(DATA_DIR, 'vendaflow.db'), check_same_thread=False, isolation_level=None)
db.row_factory = sqlite3.Row
db.execute('PRAGMA journal_mode=WAL')
lock = threading.RLock()

db.executescript('''
CREATE TABLE IF NOT EXISTS contas (
  id TEXT PRIMARY KEY, nome TEXT, chave TEXT UNIQUE, instancia TEXT,
  estado TEXT DEFAULT 'desconectado', numero TEXT DEFAULT '', qr TEXT DEFAULT '', qr_em INTEGER DEFAULT 0,
  config TEXT DEFAULT '{}', proximo_envio INTEGER DEFAULT 0, criado INTEGER, visto INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS automacoes (
  conta TEXT, aba_id TEXT, nome TEXT, ativa INTEGER DEFAULT 1, passos TEXT DEFAULT '[]',
  ao_responder TEXT DEFAULT '{}', ao_terminar TEXT DEFAULT '{}', atualizado INTEGER,
  PRIMARY KEY (conta, aba_id));
CREATE TABLE IF NOT EXISTS inscricoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, conta TEXT, aba_id TEXT, numero TEXT, ids TEXT DEFAULT '[]', nome TEXT DEFAULT '',
  estado TEXT, passo INTEGER DEFAULT 0, proximo_em INTEGER, entrou_em INTEGER, atualizado INTEGER,
  erro TEXT DEFAULT '', tentativas INTEGER DEFAULT 0, respondeu_em INTEGER DEFAULT 0,
  mover_para TEXT DEFAULT '', mover_ok INTEGER DEFAULT 1, historico TEXT DEFAULT '[]',
  UNIQUE (conta, aba_id, numero));
CREATE INDEX IF NOT EXISTS ix_insc_fila ON inscricoes (conta, estado, proximo_em);
CREATE TABLE IF NOT EXISTS envios_dia (conta TEXT, data TEXT, n INTEGER, PRIMARY KEY (conta, data));
CREATE TABLE IF NOT EXISTS naoperturbe (conta TEXT, numero TEXT, texto TEXT, em INTEGER, PRIMARY KEY (conta, numero));
CREATE TABLE IF NOT EXISTS midias (conta TEXT, id TEXT, mime TEXT, nome TEXT, tamanho INTEGER, PRIMARY KEY (conta, id));
CREATE TABLE IF NOT EXISTS relatos (
  id TEXT PRIMARY KEY, conta TEXT DEFAULT '', vendedor TEXT DEFAULT '', descricao TEXT DEFAULT '',
  info TEXT DEFAULT '{}', erros TEXT DEFAULT '[]', anexo_nome TEXT DEFAULT '', anexo_mime TEXT DEFAULT '',
  anexo_tamanho INTEGER DEFAULT 0, anexo_ok INTEGER DEFAULT 0, anexo_token TEXT DEFAULT '', ip TEXT DEFAULT '', criado INTEGER);
''')


def now_ms():
    return int(time.time() * 1000)


def log(*a):
    print(datetime.now(TZ).strftime('%d/%m %H:%M:%S'), *a, flush=True)


def q(sql, args=(), one=False):
    with lock:
        cur = db.execute(sql, args)
        rows = cur.fetchall()
    rows = [dict(r) for r in rows]
    return (rows[0] if rows else None) if one else rows


def ex(sql, args=()):
    with lock:
        return db.execute(sql, args)


# ---------------------------------------------------------------------------
# Numbers: the comparison key ignores the 9th digit of Brazilian mobiles
# (WhatsApp sometimes uses 5511 9xxxx-xxxx and sometimes 5511 xxxx-xxxx).
# ---------------------------------------------------------------------------
def digits(s):
    return re.sub(r'\D', '', str(s or '').split('@')[0].split(':')[0])


def number_key(s):
    d = digits(s)
    if d.startswith('55') and len(d) == 13 and d[4] == '9':
        d = d[:4] + d[5:]
    return d


# ---------------------------------------------------------------------------
# Text: same rules as the extension ({Oi|Olá}, {primeiro_nome}, {saudacao}...)
# ---------------------------------------------------------------------------
def strip_accents(s):
    return ''.join(c for c in unicodedata.normalize('NFD', s or '') if unicodedata.category(c) != 'Mn')


def first_name(name):
    parts = [p for p in (name or '').split() if any(ch.isalpha() for ch in p)]
    p = re.sub(r"[^\w'-]|\d|_", '', parts[0]) if parts else ''
    letters = ''.join(ch for ch in p if ch.isalpha())
    if letters and (letters == letters.upper() or letters == letters.lower()):
        p = p[:1].upper() + p[1:].lower()
    return p


def build_text(template, name='', seller=''):
    t = str(template or '')
    for _ in range(10):
        if not re.search(r'\{[^{}]*\|[^{}]*\}', t):
            break
        t = re.sub(r'\{([^{}]*\|[^{}]*)\}', lambda m: random.choice(m.group(1).split('|')), t)
    h = datetime.now(TZ)
    variables = {
        'nome': (name or '').strip(),
        'primeiro_nome': first_name(name),
        'saudacao': 'Bom dia' if h.hour < 12 else 'Boa tarde' if h.hour < 18 else 'Boa noite',
        'vendedor': seller or '',
        'data': h.strftime('%d/%m/%Y'),
    }
    t = re.sub(r'\{(\w+)\}', lambda m: variables.get(m.group(1), m.group(0)), t)
    t = re.sub(r'[ \t]+([,!?.])', r'\1', t)
    t = re.sub(r'[ \t]{2,}', ' ', t)
    return re.sub(r'^[ \t]+|[ \t]+$', '', t, flags=re.M)


def asked_to_leave(text, words):
    t = strip_accents(str(text or '').lower())
    t = re.sub(r'\s+', ' ', re.sub(r'[^\w\s]', ' ', t)).strip()
    if not t or len(t.split(' ')) > 3:
        return False
    padded = ' ' + t + ' '
    for p in words:
        w = re.sub(r'\s+', ' ', re.sub(r'[^\w\s]', ' ', strip_accents(p.lower()))).strip()
        if w and (' ' + w + ' ') in padded:
            return True
    return False


def config_for(account):
    c = dict(DEFAULT_CONFIG)
    try:
        c.update(json.loads(account.get('config') or '{}'))
    except Exception:
        pass
    return c


def within_hours(cfg, d=None):
    d = d or datetime.now(TZ)
    weekday_ = (d.weekday() + 1) % 7  # Python: Monday=0 -> extension: Sunday=0
    if weekday_ not in cfg['dias']:
        return False
    m = d.hour * 60 + d.minute
    start = [int(x) for x in cfg['horaInicio'].split(':')]
    end = [int(x) for x in cfg['horaFim'].split(':')]
    return start[0] * 60 + start[1] <= m < end[0] * 60 + end[1]


def today():
    return datetime.now(TZ).strftime('%Y-%m-%d')


def sent_today(account_id):
    r = q('SELECT n FROM envios_dia WHERE conta=? AND data=?', (account_id, today()), one=True)
    return r['n'] if r else 0


def delay_ms(stage):
    e = (stage or {}).get('espera') or {}
    n = float(e.get('n') or 0)
    factor = {'min': 60, 'h': 3600, 'd': 86400}.get(e.get('unidade'), 60)
    return int(n * factor * 1000)


# ---------------------------------------------------------------------------
# Evolution API
# ---------------------------------------------------------------------------
def evo(method_, req_path, body=None, timeout=60):
    payload = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(EVO_URL + req_path, data=payload, method=method_,
                                 headers={'apikey': EVO_KEY, 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            txt = r.read().decode() or '{}'
            return r.status, json.loads(txt)
    except urllib.error.HTTPError as e:
        txt = e.read().decode(errors='replace')
        try:
            return e.code, json.loads(txt)
        except Exception:
            return e.code, {'erro': txt[:300]}
    except Exception as e:
        return 0, {'erro': str(e)}


def create_instance(account):
    body = {
        'instanceName': account['instancia'],
        'integration': 'WHATSAPP-BAILEYS',
        'qrcode': True,
        'groupsIgnore': True,
        'alwaysOnline': False,  # don't stay "online" all the time (the phone keeps getting notifications)
        'readMessages': False,
        'readStatus': False,
        'syncFullHistory': False,
        'rejectCall': False,
        'webhook': {
            'url': f'{SELF_URL}/webhook/evolution/{WEBHOOK_SECRET}',
            'byEvents': False,
            'base64': False,
            'events': ['MESSAGES_UPSERT', 'CONNECTION_UPDATE', 'QRCODE_UPDATED'],
        },
    }
    return evo('POST', '/instance/create', body)


def evolution_state(account):
    st, r = evo('GET', '/instance/connectionState/' + account['instancia'], timeout=15)
    if st == 404:
        return 'inexistente'
    if st != 200:
        return None
    return ((r.get('instance') or {}).get('state')) or None


def update_number(account):
    st, r = evo('GET', '/instance/fetchInstances?instanceName=' + account['instancia'], timeout=15)
    if st == 200 and isinstance(r, list) and r:
        owner = digits(r[0].get('ownerJid') or '')
        if owner:
            ex('UPDATE contas SET numero=? WHERE id=?', (owner, account['id']))
            return owner
    return ''


def evo_error(r):
    if isinstance(r, dict):
        resp = r.get('response') or {}
        msg = resp.get('message') if isinstance(resp, dict) else None
        if isinstance(msg, list) and msg and isinstance(msg[0], dict) and msg[0].get('exists') is False:
            return 'Número sem WhatsApp', True
        if isinstance(msg, list):
            return '; '.join(str(m) for m in msg)[:200], False
        return str(r.get('erro') or r.get('error') or r)[:200], False
    return str(r)[:200], False


def send_step(account, cfg, number, step, name):
    instance = account['instancia']
    if step.get('tipo') == 'texto':
        text = build_text(step.get('texto'), name, cfg.get('nomeVendedor'))
        if not text.strip():
            return
        delay = min(1200 + len(text) * 35, 7000) if cfg.get('simularDigitacao') else 0
        st, r = evo('POST', '/message/sendText/' + instance, {'number': number, 'text': text, 'delay': delay}, timeout=60)
    else:
        m = q('SELECT * FROM midias WHERE conta=? AND id=?', (account['id'], step.get('midiaId')), one=True)
        if not m:
            raise SendError('Arquivo não está no servidor (abra a automação na extensão e salve de novo)', False)
        with open(os.path.join(DATA_DIR, 'midias', account['id'] + '_' + re.sub(r'\W', '', m['id'])), 'rb') as f:
            b64 = base64.b64encode(f.read()).decode()
        tipo = step.get('tipoMidia')
        if tipo == 'audio':
            delay = 3000 if cfg.get('simularDigitacao') else 0
            st, r = evo('POST', '/message/sendWhatsAppAudio/' + instance, {'number': number, 'audio': b64, 'delay': delay}, timeout=180)
        else:
            body = {
                'number': number,
                'mediatype': tipo if tipo in ('image', 'video') else 'document',
                'mimetype': m['mime'] or 'application/octet-stream',
                'media': b64,
                'fileName': step.get('nomeArquivo') or m['nome'] or 'arquivo',
                'caption': build_text(step.get('legenda') or '', name, cfg.get('nomeVendedor')),
            }
            st, r = evo('POST', '/message/sendMedia/' + instance, body, timeout=180)
    if st not in (200, 201):
        msg, permanent = evo_error(r)
        raise SendError(msg or f'Erro {st}', permanent)


class SendError(Exception):
    def __init__(self, msg, permanent):
        super().__init__(msg)
        self.permanent = permanent


# ---------------------------------------------------------------------------
# Engine: every few seconds, checks who is due to receive a message
# ---------------------------------------------------------------------------
def pick_template(stage, tab_sub, account_id, stage_i):
    variations = [v for v in (stage.get('variacoes') or []) if v]
    if len(variations) <= 1:
        return 1, (variations[0] if variations else [])
    # Balanced: random pick among the least-used templates in this stage
    uses = [0] * len(variations)
    for r in q('SELECT historico FROM inscricoes WHERE conta=? AND aba_id=?', (account_id, tab_sub)):
        for h in json.loads(r['historico'] or '[]'):
            if h.get('passo') == stage_i and 1 <= (h.get('modelo') or 0) <= len(uses):
                uses[h['modelo'] - 1] += 1
    smallest = min(uses)
    candidates = [k for k, u in enumerate(uses) if u <= smallest + 1]
    k = random.choice(candidates)
    return k + 1, variations[k]


def move_lead(sub, target_tab, reason):
    """Flags the lead for the extension to move to another tab and subscribes it to the new tab's automation."""
    if not target_tab or target_tab == sub['aba_id']:
        return
    ex('UPDATE inscricoes SET mover_para=?, mover_ok=0 WHERE id=?', (target_tab, sub['id']))
    enter(sub['conta'], target_tab, sub['numero'], json.loads(sub['ids'] or '[]'), sub['nome'], now_ms())
    log('mover', sub['conta'], sub['numero'], sub['aba_id'], '->', target_tab, reason)


def engine_step():
    now_ms_ = now_ms()
    for account in q("SELECT * FROM contas WHERE estado='open' AND proximo_envio<=?", (now_ms_,)):
        cfg = config_for(account)
        if not within_hours(cfg) or sent_today(account['id']) >= int(cfg['limiteDia']):
            continue
        sub = q('''SELECT i.* FROM inscricoes i JOIN automacoes a ON a.conta=i.conta AND a.aba_id=i.aba_id AND a.ativa=1
                    WHERE i.conta=? AND i.estado='ativo' AND i.proximo_em<=? ORDER BY i.proximo_em LIMIT 1''', (account['id'], now_ms_), one=True)
        if not sub:
            continue
        process(account, cfg, sub)
        ex('UPDATE contas SET proximo_envio=? WHERE id=?',
           (now_ms() + int(random.uniform(cfg['intervaloMin'], cfg['intervaloMax']) * 1000), account['id']))


def process(account, cfg, sub):
    auto = q('SELECT * FROM automacoes WHERE conta=? AND aba_id=?', (account['id'], sub['aba_id']), one=True)
    stages = json.loads(auto['passos'] or '[]')
    i = sub['passo']
    if i >= len(stages):
        ex("UPDATE inscricoes SET estado='concluido', atualizado=? WHERE id=?", (now_ms(), sub['id']))
        return
    if q('SELECT 1 FROM naoperturbe WHERE conta=? AND numero=?', (account['id'], number_key(sub['numero'])), one=True):
        ex("UPDATE inscricoes SET estado='descadastrou', erro='Pediu para não receber', atualizado=? WHERE id=?", (now_ms(), sub['id']))
        return
    template, steps = pick_template(stages[i], sub['aba_id'], account['id'], i)
    try:
        for j, step_ in enumerate(steps):
            if j > 0:
                time.sleep(min(float(step_.get('espera', 2) or 0), 60))
            send_step(account, cfg, sub['numero'], step_, sub['nome'])
    except SendError as e:
        attempts = sub['tentativas'] + 1
        if e.permanent or attempts >= 3:
            ex("UPDATE inscricoes SET estado='falhou', erro=?, tentativas=?, atualizado=? WHERE id=?", (str(e), attempts, now_ms(), sub['id']))
        else:  # retry in 15 min
            ex('UPDATE inscricoes SET erro=?, tentativas=?, proximo_em=?, atualizado=? WHERE id=?',
               (str(e), attempts, now_ms() + 15 * 60000, now_ms(), sub['id']))
        log('falha', account['id'], sub['numero'], 'passo', i + 1, e)
        return
    history = json.loads(sub['historico'] or '[]') + [{'passo': i, 'modelo': template, 'em': now_ms()}]
    ex('INSERT INTO envios_dia (conta, data, n) VALUES (?, ?, 1) ON CONFLICT(conta, data) DO UPDATE SET n=n+1', (account['id'], today()))
    next_i = i + 1
    if next_i >= len(stages):
        ex("UPDATE inscricoes SET estado='concluido', passo=?, historico=?, erro='', tentativas=0, atualizado=? WHERE id=?",
           (next_i, json.dumps(history), now_ms(), sub['id']))
        target_tab = json.loads(auto['ao_terminar'] or '{}').get('moverPara')
        if target_tab:
            move_lead(dict(sub, historico=json.dumps(history)), target_tab, 'terminou')
    else:
        ex("UPDATE inscricoes SET passo=?, proximo_em=?, historico=?, erro='', tentativas=0, atualizado=? WHERE id=?",
           (next_i, now_ms() + delay_ms(stages[next_i]), json.dumps(history), now_ms(), sub['id']))
    log('enviado', account['id'], sub['numero'], 'aba', sub['aba_id'], 'passo', i + 1, 'modelo', template)


def engine_loop():
    while True:
        try:
            engine_step()
        except Exception:
            traceback.print_exc()
        time.sleep(10)


def connections_loop():
    """Periodically checks whether each account's WhatsApp is still connected."""
    while True:
        try:
            for account in q("SELECT * FROM contas WHERE instancia IS NOT NULL AND estado!='desconectado'"):
                e = evolution_state(account)
                if e and e != account['estado']:
                    ex('UPDATE contas SET estado=? WHERE id=?', ('desconectado' if e == 'inexistente' else e, account['id']))
                    if e == 'open':
                        update_number(account)
        except Exception:
            traceback.print_exc()
        time.sleep(120)


# ---------------------------------------------------------------------------
# Subscriptions (lead enters/leaves a tab)
# ---------------------------------------------------------------------------
def enter(account_id, tab_id, number, ids, name, entered_at):
    number = digits(number)
    if not number:
        return 'sem_numero'
    auto = q('SELECT * FROM automacoes WHERE conta=? AND aba_id=?', (account_id, tab_id), one=True)
    if not auto:
        return 'sem_automacao'
    stages = json.loads(auto['passos'] or '[]')
    if not stages:
        return 'sem_automacao'
    now_ms_ = now_ms()
    current = q('SELECT * FROM inscricoes WHERE conta=? AND aba_id=? AND numero=?', (account_id, tab_id, number), one=True)
    state = 'ativo' if auto['ativa'] else 'pausado'
    if current:
        ex('UPDATE inscricoes SET ids=?, nome=? WHERE id=?', (json.dumps(ids or []), name or current['nome'], current['id']))
        if current['estado'] in ('ativo', 'pausado'):
            return 'ja_estava'
        if current['estado'] == 'descadastrou':
            return 'descadastrou'
        if (entered_at or 0) <= (current['atualizado'] or 0):
            # "Undo" right after taking it out of the tab: continue where it stopped
            if current['estado'] == 'saiu' and now_ms_ - (current['atualizado'] or 0) < 5 * 60000 and current['passo'] < len(stages):
                ex('UPDATE inscricoes SET estado=?, atualizado=? WHERE id=?', (state, now_ms_, current['id']))
                return 'retomou'
            return 'antigo'
        # Came back to the tab after the last change: restart the sequence
        ex('''UPDATE inscricoes SET estado=?, passo=0, proximo_em=?, entrou_em=?, atualizado=?, erro='', tentativas=0,
              respondeu_em=0, mover_para='', mover_ok=1 WHERE id=?''', (state, now_ms_ + delay_ms(stages[0]), now_ms_, now_ms_, current['id']))
        return 'recomecou'
    ex('''INSERT INTO inscricoes (conta, aba_id, numero, ids, nome, estado, passo, proximo_em, entrou_em, atualizado)
          VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)''', (account_id, tab_id, number, json.dumps(ids or []), name or '', state,
                                                     now_ms_ + delay_ms(stages[0]), now_ms_, now_ms_))
    return 'entrou'


def leave(account_id, tab_id, number):
    number = digits(number)
    ex("UPDATE inscricoes SET estado='saiu', atualizado=? WHERE conta=? AND aba_id=? AND numero=? AND estado IN ('ativo','pausado')",
       (now_ms(), account_id, tab_id, number))


def reply_received(account, number_keys, text):
    cfg = config_for(account)
    now_ms_ = now_ms()
    if text and asked_to_leave(text, cfg['palavrasSair']):
        for k in number_keys:
            if k.isdigit() and len(k) >= 10:
                ex('INSERT OR REPLACE INTO naoperturbe (conta, numero, texto, em) VALUES (?, ?, ?, ?)', (account['id'], k, text[:60], now_ms_))
    for sub in q("SELECT * FROM inscricoes WHERE conta=? AND estado IN ('ativo','pausado','concluido')", (account['id'],)):
        my_keys = {number_key(sub['numero'])} | {number_key(x) for x in json.loads(sub['ids'] or '[]')}
        if not my_keys & number_keys:
            continue
        if sub['estado'] == 'concluido' and now_ms_ - (sub['atualizado'] or 0) > 30 * 86400000:
            continue
        ex("UPDATE inscricoes SET estado='respondeu', respondeu_em=?, atualizado=? WHERE id=?", (now_ms_, now_ms_, sub['id']))
        log('respondeu', account['id'], sub['numero'], 'aba', sub['aba_id'])
        auto = q('SELECT ao_responder FROM automacoes WHERE conta=? AND aba_id=?', (account['id'], sub['aba_id']), one=True)
        target_tab = json.loads((auto or {}).get('ao_responder') or '{}').get('moverPara')
        if target_tab:
            move_lead(sub, target_tab, 'respondeu')


def handle_webhook(body):
    instance = body.get('instance')
    event = (body.get('event') or '').lower().replace('_', '.')
    account = q('SELECT * FROM contas WHERE instancia=?', (instance,), one=True)
    if not account:
        return
    payload = body.get('data') or {}
    if event == 'connection.update':
        st = payload.get('state')
        if st:
            ex('UPDATE contas SET estado=? WHERE id=?', (st, account['id']))
            if st == 'open':
                ex("UPDATE contas SET qr='' WHERE id=?", (account['id'],))
                threading.Thread(target=update_number, args=(account,), daemon=True).start()
            log('conexão', account['id'], st)
    elif event == 'qrcode.updated':
        b64 = ((payload.get('qrcode') or {}).get('base64')) or ''
        if b64:
            ex('UPDATE contas SET qr=?, qr_em=?, estado=? WHERE id=?', (b64, now_ms(), 'connecting', account['id']))
    elif event == 'messages.upsert':
        msgs = payload if isinstance(payload, list) else [payload]
        for m in msgs:
            key = m.get('key') or {}
            jid = key.get('remoteJid') or ''
            if key.get('fromMe') or jid.endswith('@g.us') or 'broadcast' in jid:
                continue
            ts = m.get('messageTimestamp') or 0
            try:
                ts = int(ts)
            except Exception:
                ts = 0
            if ts and time.time() - ts > 600:  # old message (history sync)
                continue
            number_keys = {number_key(x) for x in (jid, key.get('remoteJidAlt'), key.get('senderPn'), key.get('participantAlt')) if x}
            number_keys.discard('')
            msg = m.get('message') or {}
            text = msg.get('conversation') or (msg.get('extendedTextMessage') or {}).get('text') or ''
            reply_received(account, number_keys, text)


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------
def public_sub(r):
    return {
        'abaId': r['aba_id'], 'numero': r['numero'], 'nome': r['nome'], 'estado': r['estado'], 'passo': r['passo'],
        'proximoEm': r['proximo_em'], 'entrouEm': r['entrou_em'], 'atualizado': r['atualizado'], 'erro': r['erro'],
        'respondeuEm': r['respondeu_em'], 'moverPara': r['mover_para'] if not r['mover_ok'] else '', 'ids': json.loads(r['ids'] or '[]'),
        'enviados': len(json.loads(r['historico'] or '[]')),
    }


def account_info(account):
    cfg = config_for(account)
    qr = account['qr'] if account['estado'] != 'open' and now_ms() - (account['qr_em'] or 0) < 60000 else ''
    return {
        'nome': account['nome'], 'whatsapp': {'estado': account['estado'], 'numero': account['numero'], 'qr': qr},
        'config': cfg, 'enviosHoje': sent_today(account['id']),
        'dentroDoHorario': within_hours(cfg),
    }


PRIVACY_PAGE = """<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>GoSeller – Política de Privacidade</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:760px;margin:0 auto;padding:24px 16px;color:#1f2937;background:#fff}h1{font-size:26px}h2{font-size:19px;margin-top:28px}</style></head><body>
<h1>Política de Privacidade – GoSeller</h1>
<p>Última atualização: 18 de novembro de 2026.</p>
<p>O GoSeller é uma extensão para o Google Chrome que ajuda equipes de vendas a organizar o atendimento no WhatsApp Web: respostas rápidas, abas de contatos, campanhas, quadro Kanban e mensagens automáticas.</p>
<h2>1. Dados guardados no seu navegador</h2>
<p>Respostas rápidas, abas, anotações, nomes de contatos, campanhas e configurações ficam guardados <b>somente no seu computador</b> (armazenamento local do Chrome). Esses dados não são enviados a nós, exceto nos casos do item 2.</p>
<h2>2. Dados enviados ao servidor do GoSeller</h2>
<p>Somente se você ativar o <b>Kanban automático / mensagens automáticas</b> e informar sua chave de acesso, o GoSeller envia ao nosso servidor: o número de telefone e o nome dos contatos colocados nas colunas com sequência automática, as mensagens e arquivos dessas sequências e a etapa de cada contato. Para enviar essas mensagens, o seu número de WhatsApp é conectado ao servidor como "aparelho conectado" (lendo o QR code); o servidor recebe apenas os avisos necessários para saber se o contato respondeu.</p>
<h2>3. Para que usamos</h2>
<p>Exclusivamente para executar as funções que você configurou (enviar as mensagens programadas e mover os contatos de etapa). Não vendemos, não alugamos e não compartilhamos esses dados com terceiros, e não os usamos para publicidade.</p>
<h2>4. Segurança e prazo</h2>
<p>A comunicação com o servidor é criptografada (HTTPS). Os dados de uma conta são apagados em até 30 dias após o cancelamento ou mediante pedido.</p>
<h2>5. Seus direitos (LGPD)</h2>
<p>Você pode pedir acesso, correção ou exclusão dos seus dados a qualquer momento pelo contato abaixo. Desconectar o número e apagar a chave de acesso nas Configurações interrompe qualquer envio de dados ao servidor.</p>
<h2>6. Contato</h2>
<p>E-mail: <a href="mailto:""" + CONTACT_EMAIL + """">""" + CONTACT_EMAIL + """</a></p>
</body></html>"""


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *a):
        pass

    def respond(self, status, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Authorization, Content-Type')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
        self.end_headers()
        self.wfile.write(body)

    def respond_html(self, status, text):
        body = text.encode()
        self.send_response(status)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.respond(204, {})

    def respond_file(self, path, mime):
        size = os.path.getsize(path)
        self.send_response(200)
        self.send_header('Content-Type', mime or 'application/octet-stream')
        self.send_header('Content-Length', str(size))
        self.end_headers()
        with open(path, 'rb') as f:
            while chunk := f.read(65536):
                self.wfile.write(chunk)

    def client_ip(self):
        fwd = self.headers.get('X-Forwarded-For') or ''
        return fwd.split(',')[0].strip() or self.client_address[0]

    # ---- Problem reports ("Relatar problema"): public, works without a server key ----
    def create_report(self):
        n = int(self.headers.get('Content-Length') or 0)
        if n > MAX_REPORT_JSON:
            raise ValueError('Relato grande demais')
        ip = self.client_ip()
        hour_ago = now_ms() - 3600 * 1000
        if q('SELECT COUNT(*) n FROM relatos WHERE ip=? AND criado>?', (ip, hour_ago), one=True)['n'] >= REPORTS_PER_HOUR:
            return self.respond(429, {'erro': 'Muitos relatos em pouco tempo. Tente de novo mais tarde.'})
        body = json.loads(self.rfile.read(n) or b'{}') if n else {}
        account = self.account()
        errors = [str(x)[:1000] for x in (body.get('erros') or [])[:50]]
        info = body.get('info') if isinstance(body.get('info'), dict) else {}
        attachment = body.get('anexo') if isinstance(body.get('anexo'), dict) else None
        name, mime, size, token = '', '', 0, ''
        if attachment:
            mime = str(attachment.get('mime') or '')
            size = int(attachment.get('tamanho') or 0)
            if not re.match(r'^(image|video)/[\w.+-]+$', mime):
                raise ValueError('O anexo precisa ser uma imagem ou um vídeo')
            if not 0 < size <= MAX_REPORT_FILE:
                raise ValueError('Anexo grande demais (máx. 30 MB)')
            name = str(attachment.get('nome') or '')[:120]
            token = secrets.token_urlsafe(16)
        for _ in range(5):
            rid = secrets.token_hex(3).upper()
            if not q('SELECT 1 FROM relatos WHERE id=?', (rid,), one=True):
                break
        ex('''INSERT INTO relatos (id, conta, vendedor, descricao, info, erros, anexo_nome, anexo_mime, anexo_tamanho, anexo_token, ip, criado)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
           (rid, account['id'] if account else '', str(body.get('vendedor') or '')[:80], str(body.get('descricao') or '')[:4000],
            json.dumps(info, ensure_ascii=False)[:20000], json.dumps(errors, ensure_ascii=False), name, mime, size, token, ip, now_ms()))
        log('relato', rid, account['id'] if account else '-', ip)
        return self.respond(200, {'id': rid, 'anexoToken': token or None})

    def upload_report_file(self, rid):
        r = q('SELECT * FROM relatos WHERE id=?', (rid,), one=True)
        token = self.headers.get('X-Anexo-Token') or ''
        if not r or not r['anexo_token'] or not secrets.compare_digest(token, r['anexo_token']):
            return self.respond(403, {'erro': 'Sem permissão'})
        n = int(self.headers.get('Content-Length') or 0)
        if not 0 < n <= min(r['anexo_tamanho'], MAX_REPORT_FILE):
            raise ValueError('Tamanho do anexo inválido')
        path = os.path.join(DATA_DIR, 'relatos', rid)
        left = n
        with open(path, 'wb') as f:  # streamed to disk (the container has little memory)
            while left > 0:
                chunk = self.rfile.read(min(65536, left))
                if not chunk:
                    break
                f.write(chunk)
                left -= len(chunk)
        if left:
            os.remove(path)
            raise ValueError('Envio do anexo interrompido')
        ex("UPDATE relatos SET anexo_ok=1, anexo_tamanho=?, anexo_token='' WHERE id=?", (n, rid))
        return self.respond(200, {'ok': True})

    def body(self):
        n = int(self.headers.get('Content-Length') or 0)
        if n > MAX_MEDIA * 1.4 + 100000:
            raise ValueError('Arquivo grande demais (máx. 16 MB)')
        return json.loads(self.rfile.read(n) or b'{}') if n else {}

    def account(self):
        auth = self.headers.get('Authorization') or ''
        api_key = auth[7:].strip() if auth.startswith('Bearer ') else ''
        if not api_key:
            return None
        c = q('SELECT * FROM contas WHERE chave=?', (api_key,), one=True)
        if c:
            ex('UPDATE contas SET visto=? WHERE id=?', (now_ms(), c['id']))
        return c

    def do_GET(self):
        self.route_request('GET')

    def do_POST(self):
        self.route_request('POST')

    def do_PUT(self):
        self.route_request('PUT')

    def do_DELETE(self):
        self.route_request('DELETE')

    def route_request(self, method_):
        req_path = self.path.split('?')[0]
        if req_path.startswith(PREFIX):
            req_path = req_path[len(PREFIX):] or '/'
        try:
            if req_path in ('/privacidade', '/privacidade/') and method_ == 'GET':
                return self.respond_html(200, PRIVACY_PAGE)
            if req_path in ('/', '/saude'):
                return self.respond(200, {'ok': True, 'servico': 'vendaflow'})
            if req_path == '/webhook/evolution/' + WEBHOOK_SECRET and method_ == 'POST':
                handle_webhook(self.body())
                return self.respond(200, {'ok': True})
            if req_path == '/relatos' and method_ == 'POST':
                return self.create_report()
            m = re.match(r'^/relatos/([0-9A-F]{6})/anexo$', req_path)
            if m and method_ == 'PUT':
                return self.upload_report_file(m.group(1))
            if req_path.startswith('/admin/'):
                if not ADMIN_KEY or not secrets.compare_digest(self.headers.get('X-Admin-Key') or '', ADMIN_KEY):
                    return self.respond(403, {'erro': 'Sem permissão'})
                return self.admin(method_, req_path, self.body() if method_ != 'GET' else {})
            if req_path.startswith('/api/'):
                account = self.account()
                if not account:
                    return self.respond(401, {'erro': 'Chave de acesso inválida'})
                return self.api(account, method_, req_path[4:], self.body() if method_ in ('POST', 'PUT') else {})
            return self.respond(404, {'erro': 'Não encontrado'})
        except ValueError as e:
            return self.respond(400, {'erro': str(e)})
        except Exception as e:
            traceback.print_exc()
            return self.respond(500, {'erro': str(e)})

    def admin(self, method_, req_path, body):
        if req_path == '/admin/relatos' and method_ == 'GET':
            rows = q('''SELECT id, conta, vendedor, substr(descricao, 1, 200) descricao, anexo_mime, anexo_ok, criado
                        FROM relatos ORDER BY criado DESC LIMIT 100''')
            return self.respond(200, rows)
        m = re.match(r'^/admin/relatos/([0-9A-F]{6})(/anexo)?$', req_path)
        if m and method_ == 'GET':
            r = q('SELECT * FROM relatos WHERE id=?', (m.group(1),), one=True)
            if not r:
                return self.respond(404, {'erro': 'Relato não encontrado'})
            if m.group(2):
                path = os.path.join(DATA_DIR, 'relatos', r['id'])
                if not r['anexo_ok'] or not os.path.exists(path):
                    return self.respond(404, {'erro': 'Sem anexo'})
                return self.respond_file(path, r['anexo_mime'])
            r.pop('anexo_token', None)
            r['info'] = json.loads(r['info'] or '{}')
            r['erros'] = json.loads(r['erros'] or '[]')
            return self.respond(200, r)
        if req_path == '/admin/contas' and method_ == 'POST':
            cid = secrets.token_hex(4)
            api_key = 'vf_' + secrets.token_urlsafe(24)
            ex('INSERT INTO contas (id, nome, chave, instancia, criado) VALUES (?, ?, ?, ?, ?)',
               (cid, body.get('nome') or 'Vendedor', api_key, 'vf_' + cid, now_ms()))
            return self.respond(200, {'id': cid, 'nome': body.get('nome'), 'chave': api_key})
        if req_path == '/admin/contas' and method_ == 'GET':
            rows = q('SELECT id, nome, estado, numero, criado, visto FROM contas')
            for r in rows:
                r['ativos'] = q("SELECT COUNT(*) n FROM inscricoes WHERE conta=? AND estado='ativo'", (r['id'],), one=True)['n']
                r['enviosHoje'] = sent_today(r['id'])
            return self.respond(200, rows)
        return self.respond(404, {'erro': 'Não encontrado'})

    def api(self, account, method_, route, body):
        cid = account['id']
        if route == '/eu' and method_ == 'GET':
            return self.respond(200, account_info(account))

        if route == '/config' and method_ == 'PUT':
            cfg = config_for(account)
            for k in DEFAULT_CONFIG:
                if k in body:
                    cfg[k] = body[k]
            cfg['intervaloMin'] = max(20, int(cfg['intervaloMin']))
            cfg['intervaloMax'] = max(cfg['intervaloMin'], int(cfg['intervaloMax']))
            cfg['limiteDia'] = max(1, min(500, int(cfg['limiteDia'])))
            ex('UPDATE contas SET config=? WHERE id=?', (json.dumps(cfg, ensure_ascii=False), cid))
            return self.respond(200, {'ok': True, 'config': cfg})

        # --- Server-side WhatsApp ---
        if route == '/whatsapp/conectar' and method_ == 'POST':
            e = evolution_state(account)
            if e == 'open':
                ex("UPDATE contas SET estado='open' WHERE id=?", (cid,))
                update_number(account)
                return self.respond(200, account_info(q('SELECT * FROM contas WHERE id=?', (cid,), one=True)))
            if e == 'inexistente':
                st, r = create_instance(account)
                if st not in (200, 201):
                    return self.respond(502, {'erro': 'Evolution: ' + evo_error(r)[0]})
                b64 = ((r.get('qrcode') or {}).get('base64')) or ''
            else:
                number = digits(body.get('numero'))
                st, r = evo('GET', '/instance/connect/' + account['instancia'] + (f'?number={number}' if number else ''))
                b64 = r.get('base64') or ''
                if r.get('pairingCode'):
                    ex('UPDATE contas SET estado=? WHERE id=?', ('connecting', cid))
                    return self.respond(200, dict(account_info(q('SELECT * FROM contas WHERE id=?', (cid,), one=True)), codigo=r['pairingCode']))
            ex('UPDATE contas SET estado=?, qr=?, qr_em=? WHERE id=?', ('connecting', b64, now_ms(), cid))
            return self.respond(200, account_info(q('SELECT * FROM contas WHERE id=?', (cid,), one=True)))

        if route == '/whatsapp/desconectar' and method_ == 'POST':
            evo('DELETE', '/instance/logout/' + account['instancia'])
            evo('DELETE', '/instance/delete/' + account['instancia'])
            ex("UPDATE contas SET estado='desconectado', numero='', qr='' WHERE id=?", (cid,))
            return self.respond(200, {'ok': True})

        # --- Media (automation files) ---
        if route == '/midias/faltando' and method_ == 'POST':
            ids = [str(x) for x in body.get('ids') or []]
            has = {r['id'] for r in q('SELECT id FROM midias WHERE conta=?', (cid,))}
            return self.respond(200, {'faltando': [x for x in ids if x not in has]})
        if route == '/midias' and method_ == 'POST':
            mid = re.sub(r'\W', '', str(body.get('id') or ''))
            m = re.match(r'^data:([^;,]*)(;base64)?,(.*)$', body.get('dataUrl') or '', re.S)
            if not mid or not m:
                raise ValueError('Arquivo inválido')
            payload = base64.b64decode(m.group(3)) if m.group(2) else m.group(3).encode()
            if len(payload) > MAX_MEDIA:
                raise ValueError('Arquivo grande demais (máx. 16 MB)')
            with open(os.path.join(DATA_DIR, 'midias', cid + '_' + mid), 'wb') as f:
                f.write(payload)
            ex('INSERT OR REPLACE INTO midias (conta, id, mime, nome, tamanho) VALUES (?, ?, ?, ?, ?)',
               (cid, mid, m.group(1) or 'application/octet-stream', body.get('nome') or '', len(payload)))
            return self.respond(200, {'ok': True})

        # --- Automations (one per tab) ---
        if route == '/automacoes' and method_ == 'GET':
            rows = q('SELECT * FROM automacoes WHERE conta=?', (cid,))
            return self.respond(200, [{'abaId': r['aba_id'], 'nome': r['nome'], 'ativa': bool(r['ativa']), 'passos': json.loads(r['passos']),
                                         'aoResponder': json.loads(r['ao_responder']), 'aoTerminar': json.loads(r['ao_terminar'])} for r in rows])
        m = re.match(r'^/automacoes/([\w-]+)$', route)
        if m and method_ == 'PUT':
            tab = m.group(1)
            stages = body.get('passos') or []
            if not isinstance(stages, list) or len(stages) > 15:
                raise ValueError('Passos inválidos')
            before = q('SELECT ativa FROM automacoes WHERE conta=? AND aba_id=?', (cid, tab), one=True)
            ativa = 1 if body.get('ativa', True) else 0
            ex('''INSERT INTO automacoes (conta, aba_id, nome, ativa, passos, ao_responder, ao_terminar, atualizado) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(conta, aba_id) DO UPDATE SET nome=excluded.nome, ativa=excluded.ativa, passos=excluded.passos,
                  ao_responder=excluded.ao_responder, ao_terminar=excluded.ao_terminar, atualizado=excluded.atualizado''',
               (cid, tab, body.get('nome') or '', ativa, json.dumps(stages, ensure_ascii=False),
                json.dumps(body.get('aoResponder') or {}), json.dumps(body.get('aoTerminar') or {}), now_ms()))
            if before and before['ativa'] != ativa:  # pause/resume leads in the middle of it
                src, dst = ('ativo', 'pausado') if not ativa else ('pausado', 'ativo')
                ex('UPDATE inscricoes SET estado=?, atualizado=? WHERE conta=? AND aba_id=? AND estado=?', (dst, now_ms(), cid, tab, src))
            return self.respond(200, {'ok': True})
        if m and method_ == 'DELETE':
            tab = m.group(1)
            ex('DELETE FROM automacoes WHERE conta=? AND aba_id=?', (cid, tab))
            ex("UPDATE inscricoes SET estado='saiu', atualizado=? WHERE conta=? AND aba_id=? AND estado IN ('ativo','pausado')", (now_ms(), cid, tab))
            return self.respond(200, {'ok': True})

        # --- Leads entering/leaving tabs ---
        if route == '/leads/mudancas' and method_ == 'POST':
            res = []
            for it in (body.get('entrar') or [])[:2000]:
                res.append(enter(cid, str(it.get('abaId')), it.get('numero'), it.get('ids'), it.get('nome'), it.get('em') or now_ms()))
            for it in (body.get('sair') or [])[:2000]:
                leave(cid, str(it.get('abaId')), it.get('numero'))
            return self.respond(200, {'ok': True, 'resultado': res})
        if route == '/leads/acao' and method_ == 'POST':  # pause/resume/restart a lead
            number, tab, action = digits(body.get('numero')), str(body.get('abaId')), body.get('acao')
            if action == 'agora':
                ex("UPDATE inscricoes SET proximo_em=?, atualizado=? WHERE conta=? AND aba_id=? AND numero=? AND estado='ativo'", (now_ms(), now_ms(), cid, tab, number))
            elif action == 'parar':
                ex("UPDATE inscricoes SET estado='saiu', atualizado=? WHERE conta=? AND aba_id=? AND numero=?", (now_ms(), cid, tab, number))
            elif action == 'recomecar':
                ex("DELETE FROM inscricoes WHERE conta=? AND aba_id=? AND numero=?", (cid, tab, number))
                enter(cid, tab, number, body.get('ids'), body.get('nome'), now_ms())
            return self.respond(200, {'ok': True})

        if route == '/sync' and method_ == 'GET':
            limit = now_ms() - 45 * 86400000
            rows = q("SELECT * FROM inscricoes WHERE conta=? AND (estado IN ('ativo','pausado') OR atualizado>? OR mover_ok=0)", (cid, limit))
            dnd = q('SELECT numero, texto, em FROM naoperturbe WHERE conta=?', (cid,))
            return self.respond(200, dict(account_info(account), inscricoes=[public_sub(r) for r in rows], naoPerturbe=dnd))
        if route == '/mover-ok' and method_ == 'POST':
            for it in body.get('itens') or []:
                ex('UPDATE inscricoes SET mover_ok=1 WHERE conta=? AND aba_id=? AND numero=?', (cid, str(it.get('abaId')), digits(it.get('numero'))))
            return self.respond(200, {'ok': True})

        return self.respond(404, {'erro': 'Não encontrado'})


if __name__ == '__main__':
    threading.Thread(target=engine_loop, daemon=True).start()
    threading.Thread(target=connections_loop, daemon=True).start()
    log('GoSeller servidor no ar na porta 8080')
    ThreadingHTTPServer(('0.0.0.0', 8080), Handler).serve_forever()
