"""Cria config.json. Use `setup.py --senha` para definir/alterar a senha do site."""
import getpass
import json
import secrets
import sys
from pathlib import Path

from bridge import hash_password

root = Path(__file__).resolve().parent
path = root / 'config.json'
if not path.exists():
    config = json.loads((root / 'config.example.json').read_text())
    config['token'] = secrets.token_urlsafe(48)
    config['sumatra_path'] = str(root / 'tools' / 'SumatraPDF.exe')
    print('Configuração criada; token salvo apenas em config.json.')
else:
    config = json.loads(path.read_text(encoding='utf-8-sig'))
    print('Configuração existente preservada.')
config.setdefault('session_secret', secrets.token_urlsafe(48))

if '--senha' in sys.argv:
    password = getpass.getpass('Nova senha do site (mínimo 10 caracteres): ')
    if len(password) < 10 or password != getpass.getpass('Repita a senha: '):
        sys.exit('Senha curta ou diferente; nada foi alterado.')
    config['site_password_hash'] = hash_password(password)
    # Novo segredo de sessão: quem estava logado precisa entrar de novo.
    config['session_secret'] = secrets.token_urlsafe(48)
    print('Senha do site atualizada. Reinicie o serviço ToffaPrintBridge.')
elif not config.get('site_password_hash'):
    print('Defina a senha do site com: python setup.py --senha')

path.write_text(json.dumps(config, indent=2), encoding='utf-8')
