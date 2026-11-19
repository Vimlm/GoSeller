# GoSeller — development conventions

## Language
- **All code is written in English**: identifiers (variables, functions, classes), file names, comments, commit messages, new server routes, DB tables/columns, storage keys.
- **User-facing text stays in Portuguese (pt-BR)**: UI labels, messages, dialogs, store listing — the product is sold in Brazil.
- Conversation with the owner is in Portuguese; planning docs for the owner (`ROADMAP.md`, `LOJA.md`, `servidor/LEIAME.md`) may stay in Portuguese.
- Legacy code is still in Portuguese and is being migrated (see ROADMAP "Fase 0"). When touching legacy code, new code is English; renaming persisted data (chrome.storage keys, backup format, server routes/columns) requires an automatic migration that still reads the old names.

## Git
- Remote: GitHub (private). Commit every change (one commit per fix/feature) and push right after.
- Tag releases with the manifest version (`v0.8.3`).
- Never commit `dist/`, zips, `.env` or other secrets.

## Build
- `./empacotar.sh` — obfuscated zip for manual install (the owner runs it).
- `./empacotar-loja.sh` — readable zip for the Chrome Web Store (no obfuscation allowed by the store).
