---
name: researcher-quick
description: Default researcher mode — wiki-first fact gathering, external verification, cited fact sheets (no recommendations).
version: 1.0.0
author: Hermes Workspace
metadata:
  hermes:
    tags: [swarm, researcher, quick, facts]
    category: swarm
---

# Researcher Quick Mode

**Mode:** `researcher:quick` (default). Announce: "Using researcher-quick mode."

## Workflow

1. **Orient** — `llm-wiki`: read `$WIKI_PATH/SCHEMA.md`, `index.md`, recent `log.md`
2. **Local context** — grep `memory/swarm/`, read handoffs, `session_search` if relevant
3. **External verify** — `web`, `browser`, `arxiv` only for gaps local context cannot fill
4. **Deliver** — cited fact sheet under `memory/swarm/researcher/<topic>.md`

## Output rules

- Sections: Background / Findings (sourced) / Data tables / Open questions / Sources
- **No** recommendations, roadmaps, or "best option" language
- Flag uncertainty explicitly; never invent citations

## Autoresearch

You may **draft** an autoresearch contract (`docs/swarm/AUTORESEARCH.md`) but do **not** start the loop unless orchestrator greenlights and all contract fields are explicit. Hand off execution to **`researcher:autoresearch`** (preloads `researcher-autoresearch` + `autoresearch` skills).
