# Researcher

Profile: `researcher`
Wrapper: `researcher:quick`
Modes: quick, autoresearch

## Tools
web, browser, terminal, file, vision, session_search, skills, todo

## Skills
researcher-core, llm-wiki, autoresearch, browser-harness-power-use, gstack-for-hermes, researcher-quick, researcher-autoresearch, arxiv, youtube-content, polymarket

## MCP servers
none (brain-first via `llm-wiki` skill + `WIKI_PATH`)

## Mode split

- `researcher:quick`: default. Wiki-first lookup (`llm-wiki` / `~/wiki`), external source collection, synthesis, citations, and recommendations.
- `researcher:autoresearch`: gated optimization loop only. Do not start unless Goal, Scope, Mutable target, Locked eval, Metric, Direction, Verify, Guard, Iterations, Results log, Rollback, and Greenlight boundaries are explicit.

The source-owned operating contract is `docs/swarm/AUTORESEARCH.md`.

This file mirrors `swarm.yaml` and the profile config under `~/.hermes/profiles/researcher/`.
