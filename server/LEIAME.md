# Servidor do GoSeller (Kanban + sequências automáticas)

Roda na VPS em `/opt/vendaflow` (docker compose, rede `coolify`):

- `vf-evolution` (Evolution API v2.3.7) + `vf-evo-db` (Postgres): conexão WhatsApp de cada vendedor ("aparelho conectado"). **Não fica exposta na internet.**
- `vendaflow-api` (este `app.py`, Python sem dependências, SQLite em `/opt/vendaflow/dados`): API para a extensão + motor que envia as sequências.
- Rota pública: `https://api.goseller.app.br` (Traefik: `/data/coolify/proxy/dynamic/vendaflow.yaml`). A rota antiga `https://agents.coolmeia.tech/vendaflow` continua ativa para quem ainda está na 0.8.3 — remover quando todos estiverem na 0.8.4+.
- Segredos em `/opt/vendaflow/.env` (EVO_KEY, ADMIN_KEY, WEBHOOK_SECRET).

Contas de vendedores (na VPS):

    /opt/vendaflow/criar-conta.sh "Nome"   # mostra a chave de acesso (vf_...)
    /opt/vendaflow/listar-contas.sh

Atualizar o servidor: copiar `app.py` para `/opt/vendaflow/api/` e `docker compose up -d --build vendaflow-api`.
