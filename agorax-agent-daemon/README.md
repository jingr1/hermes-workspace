# Agorax Agent Daemon Core

This directory is the in-repository migration boundary for the Agent Host and
managed runtime code previously maintained in the Tutti repository.

## Migrated core

- `packages/agent/host`: canonical Session/Turn/Interaction lifecycle
- `packages/agent/store-sqlite`: durable canonical state
- `packages/agent/store-sqlite/canonical`: shared identity and state contracts
- `packages/agent/activity-replication`: activity replication primitives
- `packages/agent/session-replay`: replay and provider history contracts
- `packages/connector/daemon/core`: connector runtime core
- `packages/events/stream-go`: event stream transport primitives
- Claude Code is intentionally excluded from the Go runtime migration. Agorax
	uses the existing TypeScript `claude -p --output-format stream-json` adapter
	for Claude Code, the same CLI boundary used by the other managed backends.

 The Go modules use the local vanity path `agorax.local/agent-daemon/...`.
 This is a logical module identity, not a GitHub or network endpoint. The
 workspace file maps it to the local `agorax-agent-daemon` directory, so the Go
 code is not coupled to the repository hosting URL.

## Remaining work

`packages/agent/daemon` is copied as source and points at the migrated local
dependencies. It still needs an Agorax daemon composition root and HTTP/event
wiring before it can be launched as part of the application.

The Claude SDK sidecar is not part of this migration. Do not install
`@anthropic-ai/claude-agent-sdk`; use the Agorax CLI adapter instead.

Until that work is complete, Agorax must not enable the embedded daemon in
production. The TypeScript Managed Agent transport remains a boundary probe and
contract test surface only.

## Validation

The intended validation command after Go is available is:

```bash
GOWORK=$PWD/go.work go test ./packages/agent/host/... ./packages/agent/store-sqlite/... ./packages/agent/activity-replication/...
```

The Go toolchain is installed in the development environment and the migrated
Go modules have been tested individually through the workspace.
