# Conexão Cloudflare — 16/10/2026

DNS `print.toffa.com.br` criado no túnel existente
`5f458d5a-a65a-4c45-9576-292ec8f71032`.

Rota adicionada em `C:\Users\marlo\.cloudflared\fazenda.yml` para
`http://127.0.0.1:17891`. Validação do cloudflared passou e a URL corresponde
à regra correta. As quatro rotas anteriores foram preservadas.

Backup: `C:\Users\marlo\.cloudflared\fazenda.yml.bak-print-20261016-120745`.

Reinício administrativo executado pelo usuário. Os serviços Cloudflared e
ToffaPrintBridge estão rodando. Teste HTTPS externo passou: `/health` retorna
401 sem token e 200 com token, com `status=ok` e `engine_available=true`.

O DNS público da Cloudflare já resolve o hostname. O resolvedor local ainda
retornava host desconhecido no momento do teste; usamos `curl --resolve` com o
IP obtido via DNS público, preservando hostname, SNI e validação do certificado.
Não foram alterados DNS do Windows nem arquivo hosts.

Teste físico posterior: uma etiqueta de 100 × 150 mm enviada diretamente pelo
SumatraPDF à LABEL, com retorno zero, aprovada pelo usuário. A impressão pela
API foi posteriormente habilitada com `noscale,1x` e o serviço reiniciado.

Teste completo via HTTPS/Cloudflare: pedido
`1298834f-727d-4a63-8ee4-0d80b3bd4c8e`, recebido em
`awaiting_confirmation`, confirmado para `queued`, finalizado em `submitted`.
Foi enviada uma única etiqueta. O usuário confirmou a saída física correta deste
segundo teste, executado sob a conta do serviço Windows. Fluxo completo aprovado.
