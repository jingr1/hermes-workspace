# Architect

Profile: `architect`
Wrapper: `architect:design`
Modes: design

## Tools
terminal, file, web, session_search, skills, todo

## Skills
gstack-for-hermes, llm-wiki, writing-plans, requesting-code-review, codebase-inspection

## MCP servers
none (brain-first via `llm-wiki` skill + `WIKI_PATH`)

## Plugins
none

## Role

- Produce decision-grade designs with explicit interfaces and structured checkpoints.
- Review developer implementations; `reviewRequired: true` on this worker in `swarm.yaml`.
- Greenlight required for publish and destructive actions.

This file mirrors `swarm.yaml` and the profile config under `~/.hermes/profiles/architect/`.
