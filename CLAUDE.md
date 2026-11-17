@AGENTS.md

## Claude-specific notes
- AGENTS.md (imported above) is the single source of truth. Put shared rules there, not here.
- Environment: WSL2 Linux, Node 24, npm. Docker must come from Docker Desktop with WSL integration enabled.
- Don't spawn sub-agents or read the whole `docs/` folder. The user wants token-lean sessions.
