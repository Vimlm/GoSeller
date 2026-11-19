# GoSeller — development conventions

## Language
- **All code is written in English**: identifiers (variables, functions, classes), file names, comments, commit messages.
- **Program data stays in pt-BR**: chrome.storage keys (`abas`, `nomes`, `respostas`…), backup format, server routes, DB tables/columns and their values. Do not rename them (no migration needed); new ones may follow the existing pt-BR naming.
- **User-facing text stays in Portuguese (pt-BR)**: UI labels, messages, dialogs, store listing — the product is sold in Brazil.
- Conversation with the owner is in Portuguese; planning docs for the owner (`ROADMAP.md`, `LOJA.md`, `server/LEIAME.md`) may stay in Portuguese.
- Code was translated to English on 2026-11-19. Object property names that belong to persisted data or to the extension⇄page/server protocol (e.g. `c.nome`, `o.valor`, `{ erro, dados }`, rpc names like `salvarContato`) intentionally stay in Portuguese.

## Git
- Remote: GitHub (private). Commit every change (one commit per fix/feature) and push right after.
- Tag releases with the manifest version (`v0.8.3`).
- Never commit `dist/`, zips, `.env` or other secrets.

## Build
- `./build.sh` — obfuscated zip for manual install (the owner runs it).
- `./build-store.sh` — readable zip for the Chrome Web Store (no obfuscation allowed by the store).
