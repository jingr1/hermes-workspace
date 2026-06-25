# Autoresearch demo — orchestrator dispatch

## Flow

1. **Orchestrator** validates contract and greenlight:
   ```bash
   orchestrator:autoresearch-dispatch chat -q "$(cat autoresearch-demo/contract.yaml)"
   ```
2. **Orchestrator** dispatches executor per `executor:` field:
   ```bash
   architect:autoresearch chat -q "Execute autoresearch contract at hermes-workspace/autoresearch-demo/contract.yaml"
   ```
   For code targets use `developer:autoresearch` instead.

## One-shot pilot (executor only, contract pre-approved)

```bash
cd /home/ramon.jing/hermes-workspace
architect:autoresearch chat -q "Run autoresearch per autoresearch-demo/contract.yaml. Log to autoresearch-results/demo-pilot.tsv."
```

## Expected

- Baseline metric from `eval.sh`, then up to 2 iterations on `routing_hint.md`
- TSV rows in `autoresearch-results/demo-pilot.tsv`
