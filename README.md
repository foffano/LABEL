# Toffa Print Bridge — primeira etapa

Ponte Windows para a impressora **LABEL (USB002)**. API local em
`http://127.0.0.1:17891`. O domínio informado é `toffa.com.br`.

## Estado desta entrega

- API, fila SQLite, autenticação e confirmação implementadas e testadas.
- Configuração local e ambiente Python criados.
- Serviço Windows preparado via WinSW, com início automático, reinício após falhas e logs rotativos.
- Serviço instalado, rodando e publicado em `https://print.toffa.com.br` pelo túnel existente.
- API externa validada: 401 sem token e 200 com token.
- Teste físico direto no Windows aprovado pelo usuário, em 100 × 150 mm.
- Impressão pela API habilitada, com tamanho real e uma cópia por página.
- Teste completo pela Cloudflare aprovado pelo usuário: etiqueta impressa corretamente sob a conta do serviço Windows.
- Site e otimização de PDFs são a próxima etapa. Nenhuma transformação é aplicada ainda.

## Instalar e executar

Ambiente de desenvolvimento, se for recriar:

```powershell
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.lock.txt
.venv\Scripts\python setup.py
.venv\Scripts\python bridge.py
```

O token fica em `config.json`, ignorado pelo Git e protegido por ACL nesta máquina.
Nunca coloque esse token no JavaScript público do site. O backend do site deve
autenticar o usuário e fazer as chamadas à ponte usando um secret.

Instalar como serviço: abra PowerShell **como administrador** e execute:

```powershell
cd C:\pc-print-nuvem
powershell -ExecutionPolicy Bypass -File .\scripts\install-service.ps1
```

O instalador requer `tools/ToffaPrintBridge.exe` (WinSW 2.12.0) e
`tools/ToffaPrintBridge.xml` (cópia de `service.xml`), preparados nesta entrega.
O serviço usa LocalSystem: verificar acesso à LABEL e preferências de papel nessa
conta antes do teste físico. O Windows precisa continuar ligado, conectado e sem
suspender para atender 24h. Não alteramos as configurações de energia do PC.

Para parar/remover, no PowerShell administrativo:

```powershell
.\tools\ToffaPrintBridge.exe stop
.\tools\ToffaPrintBridge.exe uninstall
```

Dados ficam em `data/`; logs do serviço em `logs/`. Não execute mais de uma instância.

## Conectar ao túnel existente

O serviço Cloudflared existente usa
`C:\Users\marlo\.cloudflared\fazenda.yml` e também atende outros sistemas.
A rota **print.toffa.com.br** já foi adicionada e validada nesta máquina.
Os passos abaixo documentam a configuração realizada; não é necessário repeti-los.

1. Faça backup desse YAML e adicione, antes da regra final `http_status:404`:

```yaml
  - hostname: print.toffa.com.br
    service: http://127.0.0.1:17891
```

2. Valide e cadastre o DNS com a conta que administra `toffa.com.br`:

```powershell
cloudflared tunnel --config C:\Users\marlo\.cloudflared\fazenda.yml ingress validate
cloudflared tunnel route dns 5f458d5a-a65a-4c45-9576-292ec8f71032 print.toffa.com.br
```

3. Com a ponte instalada, reinicie `Cloudflared` em PowerShell administrativo.
Isso reconecta brevemente todas as rotas existentes. Verifique também fazenda,
native, eco e mcp-fazenda após o reinício.
4. Valide que `/health` externo sem token retorna 401 e com token retorna 200.
Recomenda-se também Cloudflare Access com política Service Auth para o backend.
Não configure cache para as rotas desta API.

Rollback: restaure o backup do YAML, reinicie Cloudflared e remova somente o DNS
`print.toffa.com.br` criado nesta etapa.

## Contrato para integrar o site

Todas as chamadas exigem `Authorization: Bearer <token>`.

| Método | Rota | Função |
|---|---|---|
| GET | `/health` | Saúde e configuração do motor |
| POST | `/v1/jobs` | Corpo binário PDF, `Content-Type: application/pdf`, `Idempotency-Key` única |
| GET | `/v1/jobs/{id}` | Consultar estado |
| POST | `/v1/jobs/{id}/confirm` | Confirmar impressão |
| DELETE | `/v1/jobs/{id}` | Cancelar se ainda não começou o envio |

O site processa o PDF, mostra a prévia e pergunta se deseja imprimir. Só após o
clique de confirmação chama `/confirm`. Repetir a mesma chave e conteúdo retorna
o mesmo pedido. Outra tentativa intencional deve usar outra chave.

Estados: `awaiting_confirmation`, `queued`, `dispatching`, `submitted`,
`uncertain`, `cancelled`, `expired`. `submitted` significa que o motor retornou
sucesso no envio ao Windows; não garante que o papel saiu. `uncertain` exige
conferência manual; nunca há reenvio automático nesse caso.

Limites iniciais: PDF de 20 MB, 1–500 páginas, sem senha, até 100 arquivos
armazenados. PDFs aguardando confirmação expiram em 24h. Conteúdo é descartado
após envio/cancelamento; histórico e chaves expiram após 30 dias. SQLite pode
reutilizar espaço liberado; isto não é uma promessa de apagamento seguro.

## Impressão

Motor: `tools/SumatraPDF.exe`, configuração `noscale` para preservar medidas.
Etiqueta confirmada: **100 mm de largura × 150 mm de altura**, orientação retrato.
Os campos `label_width_mm` e `label_height_mm` registram o formato para a futura
etapa de otimização; ainda não transformam nem validam as dimensões do PDF.
O PDF final deverá ter páginas de 100 × 150 mm, impressas em tamanho real.
Defina também o papel no driver LABEL como 100 × 150 mm. Depois de validar as
dimensões e o acesso da conta do serviço, altere `printing_enabled` para `true`
em `config.json` e reinicie a ponte. Faça um teste de uma etiqueta antes de lotes.
O motor pode falhar ou imprimir parcialmente; confira fisicamente antes de reenviar.

## Testes

```powershell
.venv\Scripts\python -m pytest -q
```

Os testes usam um motor simulado: não consomem etiquetas. Cobrem autenticação,
PDF inválido, confirmação, cancelamento, impressão desabilitada, chaves
concorrentes e recuperação de envio interrompido. O teste físico direto pelo
Windows e a saúde externa do túnel passaram. O teste de impressão pela API chegou
a `submitted` e o usuário confirmou a saída física correta da etiqueta.

## Referências

- [Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/get-started/)
- [SumatraPDF: argumentos de impressão](https://www.sumatrapdfreader.org/docs/Command-line-arguments)
- [WinSW 2.12.0](https://github.com/winsw/winsw/releases/tag/v2.12.0)
