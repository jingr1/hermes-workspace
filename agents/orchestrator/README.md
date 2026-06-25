# Orchestrator

Profile: `orchestrator`
Wrapper: `orchestrator:plan`
Modes: plan, autoresearch-dispatch

## Tools
todo, kanban, delegation, terminal, file, session_search, cronjob, skills, clarify, web

## Skills
orchestrator-core, gstack-for-hermes, llm-wiki, kanban-orchestrator, subagent-driven-development, writing-plans, workspace-dispatch, autoresearch, autoresearch-plan, autoresearch-orchestrate

## MCP servers
none (brain-first via `llm-wiki` skill + `WIKI_PATH`)

## Plugins
none

## Autoresearch dispatch

- `orchestrator:plan` — default mission routing and greenlight
- `orchestrator:autoresearch-dispatch` — validate contract, greenlight, dispatch `architect:autoresearch` or `developer:autoresearch`

Contract spec: `docs/swarm/AUTORESEARCH.md`. Install wrappers: `bash scripts/sync-autoresearch-skills.sh`

This file mirrors `swarm.yaml` and the profile config under `~/.hermes/profiles/orchestrator/`.
