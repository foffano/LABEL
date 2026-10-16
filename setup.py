import json
import secrets
from pathlib import Path

root = Path(__file__).resolve().parent
path = root / 'config.json'
if not path.exists():
    config = json.loads((root / 'config.example.json').read_text())
    config['token'] = secrets.token_urlsafe(48)
    config['sumatra_path'] = str(root / 'tools' / 'SumatraPDF.exe')
    path.write_text(json.dumps(config, indent=2), encoding='utf-8')
    print('Configuração criada; token salvo apenas em config.json.')
else:
    print('Configuração existente preservada.')
