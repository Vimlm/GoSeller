# GoSeller — servidor do Kanban com remarketing automático.
#
# A extensão (no WhatsApp Web) avisa quando um lead entra/sai de uma aba. Se a aba tem
# automação, o servidor envia a sequência de mensagens pela Evolution API (o WhatsApp do
# vendedor conectado como "aparelho conectado"), mesmo com o computador desligado.
# Se o lead responde, a sequência para (e o lead pode ir para outra aba).
#
# Só biblioteca padrão do Python (sem dependências). Banco: SQLite em /dados.
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
MEU_URL = os.environ.get('MEU_URL', 'http://vendaflow-api:8080')  # como a Evolution chega aqui
PREFIXO = os.environ.get('PREFIXO', '/vendaflow')
EMAIL_CONTATO = os.environ.get('EMAIL_CONTATO', 'contato@goseller.app.br')
DADOS = os.environ.get('DADOS', '/dados')
FUSO = timezone(timedelta(hours=-3))  # Brasília (sem horário de verão)
MAX_MIDIA = 16 * 1024 * 1024

CONFIG_PADRAO = {
    'nomeVendedor': '',
    'horaInicio': '08:00',
    'horaFim': '19:00',
    'dias': [1, 2, 3, 4, 5, 6],  # 0 = domingo
    'limiteDia': 80,
    'intervaloMin': 60,  # segundos entre um envio e outro (para não parecer robô)
    'intervaloMax': 180,
    'simularDigitacao': True,
    'palavrasSair': ['sair', 'parar', 'pare', 'stop', 'descadastrar', 'nao quero mais', 'não quero mais', 'remover'],
}

os.makedirs(os.path.join(DADOS, 'midias'), exist_ok=True)
db = sqlite3.connect(os.path.join(DADOS, 'vendaflow.db'), check_same_thread=False, isolation_level=None)
db.row_factory = sqlite3.Row
db.execute('PRAGMA journal_mode=WAL')
trava = threading.RLock()

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
''')


def agora_ms():
    return int(time.time() * 1000)


def log(*a):
    print(datetime.now(FUSO).strftime('%d/%m %H:%M:%S'), *a, flush=True)


def q(sql, args=(), um=False):
    with trava:
        cur = db.execute(sql, args)
        rows = cur.fetchall()
    rows = [dict(r) for r in rows]
    return (rows[0] if rows else None) if um else rows


def ex(sql, args=()):
    with trava:
        return db.execute(sql, args)


# ---------------------------------------------------------------------------
# Números: a chave de comparação ignora o 9º dígito dos celulares do Brasil
# (o WhatsApp às vezes usa 5511 9xxxx-xxxx e às vezes 5511 xxxx-xxxx).
# ---------------------------------------------------------------------------
def digitos(s):
    return re.sub(r'\D', '', str(s or '').split('@')[0].split(':')[0])


def chave_numero(s):
    d = digitos(s)
    if d.startswith('55') and len(d) == 13 and d[4] == '9':
        d = d[:4] + d[5:]
    return d


# ---------------------------------------------------------------------------
# Texto: mesmo jeito da extensão ({Oi|Olá}, {primeiro_nome}, {saudacao}...)
# ---------------------------------------------------------------------------
def sem_acento(s):
    return ''.join(c for c in unicodedata.normalize('NFD', s or '') if unicodedata.category(c) != 'Mn')


def primeiro_nome(nome):
    partes = [p for p in (nome or '').split() if any(ch.isalpha() for ch in p)]
    p = re.sub(r"[^\w'-]|\d|_", '', partes[0]) if partes else ''
    letras = ''.join(ch for ch in p if ch.isalpha())
    if letras and (letras == letras.upper() or letras == letras.lower()):
        p = p[:1].upper() + p[1:].lower()
    return p


def montar_texto(modelo, nome='', vendedor=''):
    t = str(modelo or '')
    for _ in range(10):
        if not re.search(r'\{[^{}]*\|[^{}]*\}', t):
            break
        t = re.sub(r'\{([^{}]*\|[^{}]*)\}', lambda m: random.choice(m.group(1).split('|')), t)
    h = datetime.now(FUSO)
    vars_ = {
        'nome': (nome or '').strip(),
        'primeiro_nome': primeiro_nome(nome),
        'saudacao': 'Bom dia' if h.hour < 12 else 'Boa tarde' if h.hour < 18 else 'Boa noite',
        'vendedor': vendedor or '',
        'data': h.strftime('%d/%m/%Y'),
    }
    t = re.sub(r'\{(\w+)\}', lambda m: vars_.get(m.group(1), m.group(0)), t)
    t = re.sub(r'[ \t]+([,!?.])', r'\1', t)
    t = re.sub(r'[ \t]{2,}', ' ', t)
    return re.sub(r'^[ \t]+|[ \t]+$', '', t, flags=re.M)


def pediu_para_sair(texto, palavras):
    t = sem_acento(str(texto or '').lower())
    t = re.sub(r'\s+', ' ', re.sub(r'[^\w\s]', ' ', t)).strip()
    if not t or len(t.split(' ')) > 3:
        return False
    com = ' ' + t + ' '
    for p in palavras:
        w = re.sub(r'\s+', ' ', re.sub(r'[^\w\s]', ' ', sem_acento(p.lower()))).strip()
        if w and (' ' + w + ' ') in com:
            return True
    return False


def config_de(conta):
    c = dict(CONFIG_PADRAO)
    try:
        c.update(json.loads(conta.get('config') or '{}'))
    except Exception:
        pass
    return c


def dentro_do_horario(cfg, d=None):
    d = d or datetime.now(FUSO)
    dia = (d.weekday() + 1) % 7  # Python: segunda=0 -> extensão: domingo=0
    if dia not in cfg['dias']:
        return False
    m = d.hour * 60 + d.minute
    ini = [int(x) for x in cfg['horaInicio'].split(':')]
    fim = [int(x) for x in cfg['horaFim'].split(':')]
    return ini[0] * 60 + ini[1] <= m < fim[0] * 60 + fim[1]


def hoje():
    return datetime.now(FUSO).strftime('%Y-%m-%d')


def envios_hoje(conta_id):
    r = q('SELECT n FROM envios_dia WHERE conta=? AND data=?', (conta_id, hoje()), um=True)
    return r['n'] if r else 0


def espera_ms(passo):
    e = (passo or {}).get('espera') or {}
    n = float(e.get('n') or 0)
    mult = {'min': 60, 'h': 3600, 'd': 86400}.get(e.get('unidade'), 60)
    return int(n * mult * 1000)


# ---------------------------------------------------------------------------
# Evolution API
# ---------------------------------------------------------------------------
def evo(metodo, caminho, corpo=None, timeout=60):
    dados = json.dumps(corpo).encode() if corpo is not None else None
    req = urllib.request.Request(EVO_URL + caminho, data=dados, method=metodo,
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


def criar_instancia(conta):
    corpo = {
        'instanceName': conta['instancia'],
        'integration': 'WHATSAPP-BAILEYS',
        'qrcode': True,
        'groupsIgnore': True,
        'alwaysOnline': False,  # não fica "online" o tempo todo (o celular continua recebendo notificações)
        'readMessages': False,
        'readStatus': False,
        'syncFullHistory': False,
        'rejectCall': False,
        'webhook': {
            'url': f'{MEU_URL}/webhook/evolution/{WEBHOOK_SECRET}',
            'byEvents': False,
            'base64': False,
            'events': ['MESSAGES_UPSERT', 'CONNECTION_UPDATE', 'QRCODE_UPDATED'],
        },
    }
    return evo('POST', '/instance/create', corpo)


def estado_evolution(conta):
    st, r = evo('GET', '/instance/connectionState/' + conta['instancia'], timeout=15)
    if st == 404:
        return 'inexistente'
    if st != 200:
        return None
    return ((r.get('instance') or {}).get('state')) or None


def atualizar_numero(conta):
    st, r = evo('GET', '/instance/fetchInstances?instanceName=' + conta['instancia'], timeout=15)
    if st == 200 and isinstance(r, list) and r:
        dono = digitos(r[0].get('ownerJid') or '')
        if dono:
            ex('UPDATE contas SET numero=? WHERE id=?', (dono, conta['id']))
            return dono
    return ''


def erro_evo(r):
    if isinstance(r, dict):
        resp = r.get('response') or {}
        msg = resp.get('message') if isinstance(resp, dict) else None
        if isinstance(msg, list) and msg and isinstance(msg[0], dict) and msg[0].get('exists') is False:
            return 'Número sem WhatsApp', True
        if isinstance(msg, list):
            return '; '.join(str(m) for m in msg)[:200], False
        return str(r.get('erro') or r.get('error') or r)[:200], False
    return str(r)[:200], False


def enviar_etapa(conta, cfg, numero, etapa, nome):
    inst = conta['instancia']
    if etapa.get('tipo') == 'texto':
        texto = montar_texto(etapa.get('texto'), nome, cfg.get('nomeVendedor'))
        if not texto.strip():
            return
        delay = min(1200 + len(texto) * 35, 7000) if cfg.get('simularDigitacao') else 0
        st, r = evo('POST', '/message/sendText/' + inst, {'number': numero, 'text': texto, 'delay': delay}, timeout=60)
    else:
        m = q('SELECT * FROM midias WHERE conta=? AND id=?', (conta['id'], etapa.get('midiaId')), um=True)
        if not m:
            raise ErroEnvio('Arquivo não está no servidor (abra a automação na extensão e salve de novo)', False)
        with open(os.path.join(DADOS, 'midias', conta['id'] + '_' + re.sub(r'\W', '', m['id'])), 'rb') as f:
            b64 = base64.b64encode(f.read()).decode()
        tipo = etapa.get('tipoMidia')
        if tipo == 'audio':
            delay = 3000 if cfg.get('simularDigitacao') else 0
            st, r = evo('POST', '/message/sendWhatsAppAudio/' + inst, {'number': numero, 'audio': b64, 'delay': delay}, timeout=180)
        else:
            corpo = {
                'number': numero,
                'mediatype': tipo if tipo in ('image', 'video') else 'document',
                'mimetype': m['mime'] or 'application/octet-stream',
                'media': b64,
                'fileName': etapa.get('nomeArquivo') or m['nome'] or 'arquivo',
                'caption': montar_texto(etapa.get('legenda') or '', nome, cfg.get('nomeVendedor')),
            }
            st, r = evo('POST', '/message/sendMedia/' + inst, corpo, timeout=180)
    if st not in (200, 201):
        msg, definitivo = erro_evo(r)
        raise ErroEnvio(msg or f'Erro {st}', definitivo)


class ErroEnvio(Exception):
    def __init__(self, msg, definitivo):
        super().__init__(msg)
        self.definitivo = definitivo


# ---------------------------------------------------------------------------
# Motor: a cada poucos segundos vê quem está na hora de receber
# ---------------------------------------------------------------------------
def escolher_modelo(passo, insc_aba, conta_id, passo_i):
    variacoes = [v for v in (passo.get('variacoes') or []) if v]
    if len(variacoes) <= 1:
        return 1, (variacoes[0] if variacoes else [])
    # Equilibrado: sorteia entre os modelos menos usados neste passo
    usos = [0] * len(variacoes)
    for r in q('SELECT historico FROM inscricoes WHERE conta=? AND aba_id=?', (conta_id, insc_aba)):
        for h in json.loads(r['historico'] or '[]'):
            if h.get('passo') == passo_i and 1 <= (h.get('modelo') or 0) <= len(usos):
                usos[h['modelo'] - 1] += 1
    menor = min(usos)
    cand = [k for k, u in enumerate(usos) if u <= menor + 1]
    k = random.choice(cand)
    return k + 1, variacoes[k]


def mover_lead(insc, destino, motivo):
    """Marca para a extensão mover o lead de aba e já inscreve na automação da aba nova."""
    if not destino or destino == insc['aba_id']:
        return
    ex('UPDATE inscricoes SET mover_para=?, mover_ok=0 WHERE id=?', (destino, insc['id']))
    entrar(insc['conta'], destino, insc['numero'], json.loads(insc['ids'] or '[]'), insc['nome'], agora_ms())
    log('mover', insc['conta'], insc['numero'], insc['aba_id'], '->', destino, motivo)


def passo_motor():
    agora = agora_ms()
    for conta in q("SELECT * FROM contas WHERE estado='open' AND proximo_envio<=?", (agora,)):
        cfg = config_de(conta)
        if not dentro_do_horario(cfg) or envios_hoje(conta['id']) >= int(cfg['limiteDia']):
            continue
        insc = q('''SELECT i.* FROM inscricoes i JOIN automacoes a ON a.conta=i.conta AND a.aba_id=i.aba_id AND a.ativa=1
                    WHERE i.conta=? AND i.estado='ativo' AND i.proximo_em<=? ORDER BY i.proximo_em LIMIT 1''', (conta['id'], agora), um=True)
        if not insc:
            continue
        processar(conta, cfg, insc)
        ex('UPDATE contas SET proximo_envio=? WHERE id=?',
           (agora_ms() + int(random.uniform(cfg['intervaloMin'], cfg['intervaloMax']) * 1000), conta['id']))


def processar(conta, cfg, insc):
    auto = q('SELECT * FROM automacoes WHERE conta=? AND aba_id=?', (conta['id'], insc['aba_id']), um=True)
    passos = json.loads(auto['passos'] or '[]')
    i = insc['passo']
    if i >= len(passos):
        ex("UPDATE inscricoes SET estado='concluido', atualizado=? WHERE id=?", (agora_ms(), insc['id']))
        return
    if q('SELECT 1 FROM naoperturbe WHERE conta=? AND numero=?', (conta['id'], chave_numero(insc['numero'])), um=True):
        ex("UPDATE inscricoes SET estado='descadastrou', erro='Pediu para não receber', atualizado=? WHERE id=?", (agora_ms(), insc['id']))
        return
    modelo, etapas = escolher_modelo(passos[i], insc['aba_id'], conta['id'], i)
    try:
        for j, et in enumerate(etapas):
            if j > 0:
                time.sleep(min(float(et.get('espera', 2) or 0), 60))
            enviar_etapa(conta, cfg, insc['numero'], et, insc['nome'])
    except ErroEnvio as e:
        tent = insc['tentativas'] + 1
        if e.definitivo or tent >= 3:
            ex("UPDATE inscricoes SET estado='falhou', erro=?, tentativas=?, atualizado=? WHERE id=?", (str(e), tent, agora_ms(), insc['id']))
        else:  # tenta de novo em 15 min
            ex('UPDATE inscricoes SET erro=?, tentativas=?, proximo_em=?, atualizado=? WHERE id=?',
               (str(e), tent, agora_ms() + 15 * 60000, agora_ms(), insc['id']))
        log('falha', conta['id'], insc['numero'], 'passo', i + 1, e)
        return
    hist = json.loads(insc['historico'] or '[]') + [{'passo': i, 'modelo': modelo, 'em': agora_ms()}]
    ex('INSERT INTO envios_dia (conta, data, n) VALUES (?, ?, 1) ON CONFLICT(conta, data) DO UPDATE SET n=n+1', (conta['id'], hoje()))
    prox = i + 1
    if prox >= len(passos):
        ex("UPDATE inscricoes SET estado='concluido', passo=?, historico=?, erro='', tentativas=0, atualizado=? WHERE id=?",
           (prox, json.dumps(hist), agora_ms(), insc['id']))
        destino = json.loads(auto['ao_terminar'] or '{}').get('moverPara')
        if destino:
            mover_lead(dict(insc, historico=json.dumps(hist)), destino, 'terminou')
    else:
        ex("UPDATE inscricoes SET passo=?, proximo_em=?, historico=?, erro='', tentativas=0, atualizado=? WHERE id=?",
           (prox, agora_ms() + espera_ms(passos[prox]), json.dumps(hist), agora_ms(), insc['id']))
    log('enviado', conta['id'], insc['numero'], 'aba', insc['aba_id'], 'passo', i + 1, 'modelo', modelo)


def laco_motor():
    while True:
        try:
            passo_motor()
        except Exception:
            traceback.print_exc()
        time.sleep(10)


def laco_conexoes():
    """Confere de tempos em tempos se o WhatsApp de cada conta continua conectado."""
    while True:
        try:
            for conta in q("SELECT * FROM contas WHERE instancia IS NOT NULL AND estado!='desconectado'"):
                e = estado_evolution(conta)
                if e and e != conta['estado']:
                    ex('UPDATE contas SET estado=? WHERE id=?', ('desconectado' if e == 'inexistente' else e, conta['id']))
                    if e == 'open':
                        atualizar_numero(conta)
        except Exception:
            traceback.print_exc()
        time.sleep(120)


# ---------------------------------------------------------------------------
# Inscrições (lead entra/sai de uma aba)
# ---------------------------------------------------------------------------
def entrar(conta_id, aba_id, numero, ids, nome, em):
    numero = digitos(numero)
    if not numero:
        return 'sem_numero'
    auto = q('SELECT * FROM automacoes WHERE conta=? AND aba_id=?', (conta_id, aba_id), um=True)
    if not auto:
        return 'sem_automacao'
    passos = json.loads(auto['passos'] or '[]')
    if not passos:
        return 'sem_automacao'
    agora = agora_ms()
    atual = q('SELECT * FROM inscricoes WHERE conta=? AND aba_id=? AND numero=?', (conta_id, aba_id, numero), um=True)
    estado = 'ativo' if auto['ativa'] else 'pausado'
    if atual:
        ex('UPDATE inscricoes SET ids=?, nome=? WHERE id=?', (json.dumps(ids or []), nome or atual['nome'], atual['id']))
        if atual['estado'] in ('ativo', 'pausado'):
            return 'ja_estava'
        if atual['estado'] == 'descadastrou':
            return 'descadastrou'
        if (em or 0) <= (atual['atualizado'] or 0):
            # "Desfazer" logo depois de tirar da aba: continua de onde parou
            if atual['estado'] == 'saiu' and agora - (atual['atualizado'] or 0) < 5 * 60000 and atual['passo'] < len(passos):
                ex('UPDATE inscricoes SET estado=?, atualizado=? WHERE id=?', (estado, agora, atual['id']))
                return 'retomou'
            return 'antigo'
        # Voltou para a aba depois da última mudança: recomeça a sequência
        ex('''UPDATE inscricoes SET estado=?, passo=0, proximo_em=?, entrou_em=?, atualizado=?, erro='', tentativas=0,
              respondeu_em=0, mover_para='', mover_ok=1 WHERE id=?''', (estado, agora + espera_ms(passos[0]), agora, agora, atual['id']))
        return 'recomecou'
    ex('''INSERT INTO inscricoes (conta, aba_id, numero, ids, nome, estado, passo, proximo_em, entrou_em, atualizado)
          VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)''', (conta_id, aba_id, numero, json.dumps(ids or []), nome or '', estado,
                                                     agora + espera_ms(passos[0]), agora, agora))
    return 'entrou'


def sair(conta_id, aba_id, numero):
    numero = digitos(numero)
    ex("UPDATE inscricoes SET estado='saiu', atualizado=? WHERE conta=? AND aba_id=? AND numero=? AND estado IN ('ativo','pausado')",
       (agora_ms(), conta_id, aba_id, numero))


def resposta_recebida(conta, chaves, texto):
    cfg = config_de(conta)
    agora = agora_ms()
    if texto and pediu_para_sair(texto, cfg['palavrasSair']):
        for k in chaves:
            if k.isdigit() and len(k) >= 10:
                ex('INSERT OR REPLACE INTO naoperturbe (conta, numero, texto, em) VALUES (?, ?, ?, ?)', (conta['id'], k, texto[:60], agora))
    for insc in q("SELECT * FROM inscricoes WHERE conta=? AND estado IN ('ativo','pausado','concluido')", (conta['id'],)):
        meus = {chave_numero(insc['numero'])} | {chave_numero(x) for x in json.loads(insc['ids'] or '[]')}
        if not meus & chaves:
            continue
        if insc['estado'] == 'concluido' and agora - (insc['atualizado'] or 0) > 30 * 86400000:
            continue
        ex("UPDATE inscricoes SET estado='respondeu', respondeu_em=?, atualizado=? WHERE id=?", (agora, agora, insc['id']))
        log('respondeu', conta['id'], insc['numero'], 'aba', insc['aba_id'])
        auto = q('SELECT ao_responder FROM automacoes WHERE conta=? AND aba_id=?', (conta['id'], insc['aba_id']), um=True)
        destino = json.loads((auto or {}).get('ao_responder') or '{}').get('moverPara')
        if destino:
            mover_lead(insc, destino, 'respondeu')


def tratar_webhook(corpo):
    inst = corpo.get('instance')
    evento = (corpo.get('event') or '').lower().replace('_', '.')
    conta = q('SELECT * FROM contas WHERE instancia=?', (inst,), um=True)
    if not conta:
        return
    dados = corpo.get('data') or {}
    if evento == 'connection.update':
        st = dados.get('state')
        if st:
            ex('UPDATE contas SET estado=? WHERE id=?', (st, conta['id']))
            if st == 'open':
                ex("UPDATE contas SET qr='' WHERE id=?", (conta['id'],))
                threading.Thread(target=atualizar_numero, args=(conta,), daemon=True).start()
            log('conexão', conta['id'], st)
    elif evento == 'qrcode.updated':
        b64 = ((dados.get('qrcode') or {}).get('base64')) or ''
        if b64:
            ex('UPDATE contas SET qr=?, qr_em=?, estado=? WHERE id=?', (b64, agora_ms(), 'connecting', conta['id']))
    elif evento == 'messages.upsert':
        msgs = dados if isinstance(dados, list) else [dados]
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
            if ts and time.time() - ts > 600:  # mensagem antiga (sincronização)
                continue
            chaves = {chave_numero(x) for x in (jid, key.get('remoteJidAlt'), key.get('senderPn'), key.get('participantAlt')) if x}
            chaves.discard('')
            msg = m.get('message') or {}
            texto = msg.get('conversation') or (msg.get('extendedTextMessage') or {}).get('text') or ''
            resposta_recebida(conta, chaves, texto)


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------
def insc_publica(r):
    return {
        'abaId': r['aba_id'], 'numero': r['numero'], 'nome': r['nome'], 'estado': r['estado'], 'passo': r['passo'],
        'proximoEm': r['proximo_em'], 'entrouEm': r['entrou_em'], 'atualizado': r['atualizado'], 'erro': r['erro'],
        'respondeuEm': r['respondeu_em'], 'moverPara': r['mover_para'] if not r['mover_ok'] else '', 'ids': json.loads(r['ids'] or '[]'),
        'enviados': len(json.loads(r['historico'] or '[]')),
    }


def info_conta(conta):
    cfg = config_de(conta)
    qr = conta['qr'] if conta['estado'] != 'open' and agora_ms() - (conta['qr_em'] or 0) < 60000 else ''
    return {
        'nome': conta['nome'], 'whatsapp': {'estado': conta['estado'], 'numero': conta['numero'], 'qr': qr},
        'config': cfg, 'enviosHoje': envios_hoje(conta['id']),
        'dentroDoHorario': dentro_do_horario(cfg),
    }


PAGINA_PRIVACIDADE = """<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
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
<p>E-mail: <a href="mailto:""" + EMAIL_CONTATO + """">""" + EMAIL_CONTATO + """</a></p>
</body></html>"""


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *a):
        pass

    def responder(self, status, obj):
        corpo = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(corpo)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Authorization, Content-Type')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
        self.end_headers()
        self.wfile.write(corpo)

    def responder_html(self, status, texto):
        corpo = texto.encode()
        self.send_response(status)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(corpo)))
        self.end_headers()
        self.wfile.write(corpo)

    def do_OPTIONS(self):
        self.responder(204, {})

    def corpo(self):
        n = int(self.headers.get('Content-Length') or 0)
        if n > MAX_MIDIA * 1.4 + 100000:
            raise ValueError('Arquivo grande demais (máx. 16 MB)')
        return json.loads(self.rfile.read(n) or b'{}') if n else {}

    def conta(self):
        aut = self.headers.get('Authorization') or ''
        chave = aut[7:].strip() if aut.startswith('Bearer ') else ''
        if not chave:
            return None
        c = q('SELECT * FROM contas WHERE chave=?', (chave,), um=True)
        if c:
            ex('UPDATE contas SET visto=? WHERE id=?', (agora_ms(), c['id']))
        return c

    def do_GET(self):
        self.rotear('GET')

    def do_POST(self):
        self.rotear('POST')

    def do_PUT(self):
        self.rotear('PUT')

    def do_DELETE(self):
        self.rotear('DELETE')

    def rotear(self, metodo):
        caminho = self.path.split('?')[0]
        if caminho.startswith(PREFIXO):
            caminho = caminho[len(PREFIXO):] or '/'
        try:
            if caminho in ('/privacidade', '/privacidade/') and metodo == 'GET':
                return self.responder_html(200, PAGINA_PRIVACIDADE)
            if caminho in ('/', '/saude'):
                return self.responder(200, {'ok': True, 'servico': 'vendaflow'})
            if caminho == '/webhook/evolution/' + WEBHOOK_SECRET and metodo == 'POST':
                tratar_webhook(self.corpo())
                return self.responder(200, {'ok': True})
            if caminho.startswith('/admin/'):
                if not ADMIN_KEY or not secrets.compare_digest(self.headers.get('X-Admin-Key') or '', ADMIN_KEY):
                    return self.responder(403, {'erro': 'Sem permissão'})
                return self.admin(metodo, caminho, self.corpo() if metodo != 'GET' else {})
            if caminho.startswith('/api/'):
                conta = self.conta()
                if not conta:
                    return self.responder(401, {'erro': 'Chave de acesso inválida'})
                return self.api(conta, metodo, caminho[4:], self.corpo() if metodo in ('POST', 'PUT') else {})
            return self.responder(404, {'erro': 'Não encontrado'})
        except ValueError as e:
            return self.responder(400, {'erro': str(e)})
        except Exception as e:
            traceback.print_exc()
            return self.responder(500, {'erro': str(e)})

    def admin(self, metodo, caminho, corpo):
        if caminho == '/admin/contas' and metodo == 'POST':
            cid = secrets.token_hex(4)
            chave = 'vf_' + secrets.token_urlsafe(24)
            ex('INSERT INTO contas (id, nome, chave, instancia, criado) VALUES (?, ?, ?, ?, ?)',
               (cid, corpo.get('nome') or 'Vendedor', chave, 'vf_' + cid, agora_ms()))
            return self.responder(200, {'id': cid, 'nome': corpo.get('nome'), 'chave': chave})
        if caminho == '/admin/contas' and metodo == 'GET':
            rows = q('SELECT id, nome, estado, numero, criado, visto FROM contas')
            for r in rows:
                r['ativos'] = q("SELECT COUNT(*) n FROM inscricoes WHERE conta=? AND estado='ativo'", (r['id'],), um=True)['n']
                r['enviosHoje'] = envios_hoje(r['id'])
            return self.responder(200, rows)
        return self.responder(404, {'erro': 'Não encontrado'})

    def api(self, conta, metodo, rota, corpo):
        cid = conta['id']
        if rota == '/eu' and metodo == 'GET':
            return self.responder(200, info_conta(conta))

        if rota == '/config' and metodo == 'PUT':
            cfg = config_de(conta)
            for k in CONFIG_PADRAO:
                if k in corpo:
                    cfg[k] = corpo[k]
            cfg['intervaloMin'] = max(20, int(cfg['intervaloMin']))
            cfg['intervaloMax'] = max(cfg['intervaloMin'], int(cfg['intervaloMax']))
            cfg['limiteDia'] = max(1, min(500, int(cfg['limiteDia'])))
            ex('UPDATE contas SET config=? WHERE id=?', (json.dumps(cfg, ensure_ascii=False), cid))
            return self.responder(200, {'ok': True, 'config': cfg})

        # --- WhatsApp do servidor ---
        if rota == '/whatsapp/conectar' and metodo == 'POST':
            e = estado_evolution(conta)
            if e == 'open':
                ex("UPDATE contas SET estado='open' WHERE id=?", (cid,))
                atualizar_numero(conta)
                return self.responder(200, info_conta(q('SELECT * FROM contas WHERE id=?', (cid,), um=True)))
            if e == 'inexistente':
                st, r = criar_instancia(conta)
                if st not in (200, 201):
                    return self.responder(502, {'erro': 'Evolution: ' + erro_evo(r)[0]})
                b64 = ((r.get('qrcode') or {}).get('base64')) or ''
            else:
                numero = digitos(corpo.get('numero'))
                st, r = evo('GET', '/instance/connect/' + conta['instancia'] + (f'?number={numero}' if numero else ''))
                b64 = r.get('base64') or ''
                if r.get('pairingCode'):
                    ex('UPDATE contas SET estado=? WHERE id=?', ('connecting', cid))
                    return self.responder(200, dict(info_conta(q('SELECT * FROM contas WHERE id=?', (cid,), um=True)), codigo=r['pairingCode']))
            ex('UPDATE contas SET estado=?, qr=?, qr_em=? WHERE id=?', ('connecting', b64, agora_ms(), cid))
            return self.responder(200, info_conta(q('SELECT * FROM contas WHERE id=?', (cid,), um=True)))

        if rota == '/whatsapp/desconectar' and metodo == 'POST':
            evo('DELETE', '/instance/logout/' + conta['instancia'])
            evo('DELETE', '/instance/delete/' + conta['instancia'])
            ex("UPDATE contas SET estado='desconectado', numero='', qr='' WHERE id=?", (cid,))
            return self.responder(200, {'ok': True})

        # --- Mídias (arquivos das automações) ---
        if rota == '/midias/faltando' and metodo == 'POST':
            ids = [str(x) for x in corpo.get('ids') or []]
            tem = {r['id'] for r in q('SELECT id FROM midias WHERE conta=?', (cid,))}
            return self.responder(200, {'faltando': [x for x in ids if x not in tem]})
        if rota == '/midias' and metodo == 'POST':
            mid = re.sub(r'\W', '', str(corpo.get('id') or ''))
            m = re.match(r'^data:([^;,]*)(;base64)?,(.*)$', corpo.get('dataUrl') or '', re.S)
            if not mid or not m:
                raise ValueError('Arquivo inválido')
            dados = base64.b64decode(m.group(3)) if m.group(2) else m.group(3).encode()
            if len(dados) > MAX_MIDIA:
                raise ValueError('Arquivo grande demais (máx. 16 MB)')
            with open(os.path.join(DADOS, 'midias', cid + '_' + mid), 'wb') as f:
                f.write(dados)
            ex('INSERT OR REPLACE INTO midias (conta, id, mime, nome, tamanho) VALUES (?, ?, ?, ?, ?)',
               (cid, mid, m.group(1) or 'application/octet-stream', corpo.get('nome') or '', len(dados)))
            return self.responder(200, {'ok': True})

        # --- Automações (uma por aba) ---
        if rota == '/automacoes' and metodo == 'GET':
            rows = q('SELECT * FROM automacoes WHERE conta=?', (cid,))
            return self.responder(200, [{'abaId': r['aba_id'], 'nome': r['nome'], 'ativa': bool(r['ativa']), 'passos': json.loads(r['passos']),
                                         'aoResponder': json.loads(r['ao_responder']), 'aoTerminar': json.loads(r['ao_terminar'])} for r in rows])
        m = re.match(r'^/automacoes/([\w-]+)$', rota)
        if m and metodo == 'PUT':
            aba = m.group(1)
            passos = corpo.get('passos') or []
            if not isinstance(passos, list) or len(passos) > 15:
                raise ValueError('Passos inválidos')
            antes = q('SELECT ativa FROM automacoes WHERE conta=? AND aba_id=?', (cid, aba), um=True)
            ativa = 1 if corpo.get('ativa', True) else 0
            ex('''INSERT INTO automacoes (conta, aba_id, nome, ativa, passos, ao_responder, ao_terminar, atualizado) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(conta, aba_id) DO UPDATE SET nome=excluded.nome, ativa=excluded.ativa, passos=excluded.passos,
                  ao_responder=excluded.ao_responder, ao_terminar=excluded.ao_terminar, atualizado=excluded.atualizado''',
               (cid, aba, corpo.get('nome') or '', ativa, json.dumps(passos, ensure_ascii=False),
                json.dumps(corpo.get('aoResponder') or {}), json.dumps(corpo.get('aoTerminar') or {}), agora_ms()))
            if antes and antes['ativa'] != ativa:  # pausar/retomar quem está no meio
                de, para = ('ativo', 'pausado') if not ativa else ('pausado', 'ativo')
                ex('UPDATE inscricoes SET estado=?, atualizado=? WHERE conta=? AND aba_id=? AND estado=?', (para, agora_ms(), cid, aba, de))
            return self.responder(200, {'ok': True})
        if m and metodo == 'DELETE':
            aba = m.group(1)
            ex('DELETE FROM automacoes WHERE conta=? AND aba_id=?', (cid, aba))
            ex("UPDATE inscricoes SET estado='saiu', atualizado=? WHERE conta=? AND aba_id=? AND estado IN ('ativo','pausado')", (agora_ms(), cid, aba))
            return self.responder(200, {'ok': True})

        # --- Leads entrando/saindo das abas ---
        if rota == '/leads/mudancas' and metodo == 'POST':
            res = []
            for it in (corpo.get('entrar') or [])[:2000]:
                res.append(entrar(cid, str(it.get('abaId')), it.get('numero'), it.get('ids'), it.get('nome'), it.get('em') or agora_ms()))
            for it in (corpo.get('sair') or [])[:2000]:
                sair(cid, str(it.get('abaId')), it.get('numero'))
            return self.responder(200, {'ok': True, 'resultado': res})
        if rota == '/leads/acao' and metodo == 'POST':  # pausar/retomar/recomeçar um lead
            numero, aba, acao = digitos(corpo.get('numero')), str(corpo.get('abaId')), corpo.get('acao')
            if acao == 'agora':
                ex("UPDATE inscricoes SET proximo_em=?, atualizado=? WHERE conta=? AND aba_id=? AND numero=? AND estado='ativo'", (agora_ms(), agora_ms(), cid, aba, numero))
            elif acao == 'parar':
                ex("UPDATE inscricoes SET estado='saiu', atualizado=? WHERE conta=? AND aba_id=? AND numero=?", (agora_ms(), cid, aba, numero))
            elif acao == 'recomecar':
                ex("DELETE FROM inscricoes WHERE conta=? AND aba_id=? AND numero=?", (cid, aba, numero))
                entrar(cid, aba, numero, corpo.get('ids'), corpo.get('nome'), agora_ms())
            return self.responder(200, {'ok': True})

        if rota == '/sync' and metodo == 'GET':
            limite = agora_ms() - 45 * 86400000
            rows = q("SELECT * FROM inscricoes WHERE conta=? AND (estado IN ('ativo','pausado') OR atualizado>? OR mover_ok=0)", (cid, limite))
            np_ = q('SELECT numero, texto, em FROM naoperturbe WHERE conta=?', (cid,))
            return self.responder(200, dict(info_conta(conta), inscricoes=[insc_publica(r) for r in rows], naoPerturbe=np_))
        if rota == '/mover-ok' and metodo == 'POST':
            for it in corpo.get('itens') or []:
                ex('UPDATE inscricoes SET mover_ok=1 WHERE conta=? AND aba_id=? AND numero=?', (cid, str(it.get('abaId')), digitos(it.get('numero'))))
            return self.responder(200, {'ok': True})

        return self.responder(404, {'erro': 'Não encontrado'})


if __name__ == '__main__':
    threading.Thread(target=laco_motor, daemon=True).start()
    threading.Thread(target=laco_conexoes, daemon=True).start()
    log('GoSeller servidor no ar na porta 8080')
    ThreadingHTTPServer(('0.0.0.0', 8080), Handler).serve_forever()
