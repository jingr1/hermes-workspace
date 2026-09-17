package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	agentdaemon "agorax.local/agent-daemon/packages/agent/daemon"
	activity "agorax.local/agent-daemon/packages/agent/daemon/activity"
	hostadapter "agorax.local/agent-daemon/packages/agent/daemon/hostadapter"
	agenthost "agorax.local/agent-daemon/packages/agent/host"
	storesqlite "agorax.local/agent-daemon/packages/agent/store-sqlite"
	canonical "agorax.local/agent-daemon/packages/agent/store-sqlite/canonical"
	"golang.org/x/net/websocket"
	_ "modernc.org/sqlite"
)

const defaultPort = 8788

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	db, err := sql.Open("sqlite", agentDBPath())
	if err != nil {
		return fmt.Errorf("open Agorax agent database: %w", err)
	}
	defer db.Close()
	db.SetMaxOpenConns(4)
	db.SetMaxIdleConns(4)
	if _, err := db.ExecContext(ctx, `PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000;`); err != nil {
		return fmt.Errorf("configure Agorax SQLite: %w", err)
	}
	if _, err := db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at_unix_ms INTEGER NOT NULL, updated_at_unix_ms INTEGER NOT NULL)`); err != nil {
		return fmt.Errorf("create Agorax workspace registry: %w", err)
	}
	store := storesqlite.New(db, storesqlite.Options{})
	if err := store.Migrate(ctx); err != nil {
		return fmt.Errorf("migrate Agorax agent database: %w", err)
	}
	workspaceStore := &agenthost.SQLiteWorkspaceStore{
		StoreForWorkspace: func(string) *storesqlite.Store { return store },
	}
	hub := newEventHub()
	localReporter := &localDurableReporter{adapter: activity.NewSessionActivityReporterAdapter(&localCanonicalReporter{store: store, hub: hub})}
	runtime, err := agentdaemon.NewRuntime(agentdaemon.Config{
		Reporter: localReporter,
		HostMetadata: agentdaemon.HostMetadata{
			ClientInfo:       agentdaemon.ClientInfo{Name: "agorax", Title: "Agorax", Version: "0.1.0"},
			WorkspaceEnvName: "AGORAX_WORKSPACE_ID", OpenClawSessionKeyPrefix: "agent:main:agorax-",
		},
		ProcessTransport: agentdaemon.NewLocalProcessTransport(),
	})
	if err != nil {
		return fmt.Errorf("create Agorax agent runtime with reporter: %w", err)
	}
	defer runtime.Close()
	hostRuntime := &hostadapter.RuntimeController{Backend: runtime.Controller()}
	host := agenthost.New(agenthost.Config{
		CanonicalStore: workspaceStore, TurnSubmissions: store,
		EffectiveHistory: store, SessionManagement: workspaceStore,
		RuntimeOperations: store, Runtime: hostRuntime,
		HistoryRuntime: hostRuntime, GoalRuntime: hostRuntime,
		OperationOwner: "agorax-agentd", EditRetryDisabled: true,
	})

	server := &http.Server{
		Addr:              listenAddress(),
		Handler:           routes(runtime, host, db, hub),
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdownCtx)
	}()

	err = server.ListenAndServe()
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func listenAddress() string {
	port := defaultPort
	if value, err := strconv.Atoi(os.Getenv("AGORAX_MANAGED_AGENT_PORT")); err == nil && value > 0 && value < 65536 {
		port = value
	}
	return fmt.Sprintf("127.0.0.1:%d", port)
}

func agentDBPath() string {
	if value := os.Getenv("AGORAX_AGENT_DB_PATH"); value != "" {
		return value
	}
	return "agorax-agent.db"
}

func routes(runtime *agentdaemon.Runtime, host *agenthost.Host, db *sql.DB, hub *eventHub) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(response http.ResponseWriter, _ *http.Request) {
		writeJSON(response, http.StatusOK, map[string]any{
			"ok":      true,
			"runtime": "agorax-managed-agent",
		})
	})
	mux.HandleFunc("GET /v1/agent-targets", func(response http.ResponseWriter, _ *http.Request) {
		writeJSON(response, http.StatusOK, map[string]any{
			"agents": []any{
				map[string]any{"id": "local:claude-code", "enabled": true},
				map[string]any{"id": "local:codex", "enabled": true},
				map[string]any{"id": "local:cursor", "enabled": true},
				map[string]any{"id": "local:opencode", "enabled": true},
				map[string]any{"id": "extension:kimi-code", "enabled": true},
			},
			"runtimeReady": runtime != nil,
		})
	})
	mux.Handle("GET /v1/events/ws", websocket.Handler(func(connection *websocket.Conn) {
		defer connection.Close()
		channel, unsubscribe := hub.subscribe()
		defer unsubscribe()
		for payload := range channel {
			if _, err := connection.Write(payload); err != nil {
				return
			}
		}
	}))
	mux.HandleFunc("POST /v1/workspaces/{workspaceID}/agent-sessions", func(response http.ResponseWriter, request *http.Request) {
		workspaceID := request.PathValue("workspaceID")
		now := time.Now().UnixMilli()
		if _, err := db.ExecContext(request.Context(), `INSERT INTO workspaces (id, name, created_at_unix_ms, updated_at_unix_ms) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET updated_at_unix_ms=excluded.updated_at_unix_ms`, workspaceID, workspaceID, now, now); err != nil {
			writeJSON(response, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		var input struct {
			AgentSessionID string          `json:"agentSessionId"`
			AgentTargetID  string          `json:"agentTargetId"`
			Provider       string          `json:"provider"`
			ClientSubmitID string          `json:"clientSubmitId"`
			Content        json.RawMessage `json:"content"`
			InitialContent json.RawMessage `json:"initialContent"`
			CWD            string          `json:"cwd"`
			Model          string          `json:"model"`
		}
		if err := json.NewDecoder(request.Body).Decode(&input); err != nil {
			writeJSON(response, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		content := promptText(input.Content)
		if len(content) == 0 {
			content = promptText(input.InitialContent)
		}
		provider := input.Provider
		if provider == "" {
			provider = providerFromTarget(input.AgentTargetID)
		}
		result, err := host.CreateSession(request.Context(), workspaceID, agenthost.CreateSessionInput{
			AgentSessionID: input.AgentSessionID, AgentTargetID: input.AgentTargetID,
			Provider: provider, ClientSubmitID: input.ClientSubmitID,
			InitialContent: content,
			Cwd:            stringPointer(input.CWD), Model: stringPointer(input.Model),
		})
		if err != nil {
			writeJSON(response, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(response, http.StatusCreated, result)
	})
	mux.HandleFunc("POST /v1/workspaces/{workspaceID}/agent-sessions/{agentSessionID}/input", func(response http.ResponseWriter, request *http.Request) {
		var input struct {
			ClientSubmitID string          `json:"clientSubmitId"`
			Content        json.RawMessage `json:"content"`
		}
		if err := json.NewDecoder(request.Body).Decode(&input); err != nil {
			writeJSON(response, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		result, err := host.SendInput(request.Context(), agenthost.SessionRef{WorkspaceID: request.PathValue("workspaceID"), AgentSessionID: request.PathValue("agentSessionID")}, agenthost.SendInput{
			ClientSubmitID: input.ClientSubmitID,
			Content:        promptText(input.Content),
		})
		if err != nil {
			writeJSON(response, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(response, http.StatusOK, result)
	})
	mux.HandleFunc("POST /v1/workspaces/{workspaceID}/agent-sessions/{agentSessionID}/turns/{turnID}/cancel", func(response http.ResponseWriter, request *http.Request) {
		result, err := host.CancelTurn(request.Context(), agenthost.CancelTurnInput{WorkspaceID: request.PathValue("workspaceID"), AgentSessionID: request.PathValue("agentSessionID"), TurnID: request.PathValue("turnID"), Reason: "user_requested"})
		if err != nil {
			writeJSON(response, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(response, http.StatusOK, result)
	})
	mux.HandleFunc("GET /v1/workspaces/{workspaceID}/agent-sessions/{agentSessionID}/interactions", func(response http.ResponseWriter, request *http.Request) {
		workspaceID, agentSessionID := request.PathValue("workspaceID"), request.PathValue("agentSessionID")
		snapshot, err := host.GetSessionInteractionSnapshot(request.Context(), agenthost.SessionRef{WorkspaceID: workspaceID, AgentSessionID: agentSessionID})
		if err != nil {
			writeJSON(response, http.StatusNotFound, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(response, http.StatusOK, map[string]any{"workspaceId": workspaceID, "agentSessionId": agentSessionID, "interactions": snapshot.Interactions})
	})
	mux.HandleFunc("GET /v1/workspaces/{workspaceID}/agent-sessions/{agentSessionID}/activity", func(response http.ResponseWriter, request *http.Request) {
		workspaceID, agentSessionID := request.PathValue("workspaceID"), request.PathValue("agentSessionID")
		ref := agenthost.SessionRef{WorkspaceID: workspaceID, AgentSessionID: agentSessionID}
		session, err := host.GetSession(request.Context(), ref)
		if err != nil {
			writeJSON(response, http.StatusNotFound, map[string]string{"error": err.Error()})
			return
		}
		turns, err := host.ListCanonicalSessionTurns(request.Context(), ref)
		if err != nil {
			writeJSON(response, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		messages, _, err := host.ListSessionMessages(request.Context(), ref, agenthost.SessionMessageQuery{Limit: 500, Order: storesqlite.MessageOrderAsc})
		if err != nil {
			writeJSON(response, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		interactions, err := host.GetSessionInteractionSnapshot(request.Context(), ref)
		if err != nil {
			writeJSON(response, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(response, http.StatusOK, map[string]any{
			"workspaceId":  workspaceID,
			"session":      session.Canonical,
			"turns":        turns,
			"messages":     messages.Messages,
			"interactions": interactions.Interactions,
		})
	})
	mux.HandleFunc("POST /v1/workspaces/{workspaceID}/agent-sessions/{agentSessionID}/turns/{turnID}/interactions/{requestID}/response", func(response http.ResponseWriter, request *http.Request) {
		var input struct {
			Action   string         `json:"action"`
			OptionID string         `json:"optionId"`
			Payload  map[string]any `json:"payload"`
		}
		if err := json.NewDecoder(request.Body).Decode(&input); err != nil {
			writeJSON(response, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		workspaceID, agentSessionID, turnID, requestID := request.PathValue("workspaceID"), request.PathValue("agentSessionID"), request.PathValue("turnID"), request.PathValue("requestID")
		result, err := host.SubmitInteractive(request.Context(), agenthost.InteractionRef{WorkspaceID: workspaceID, AgentSessionID: agentSessionID, TurnID: turnID, RequestID: requestID}, agenthost.SubmitInteractiveInput{Action: stringPointer(input.Action), OptionID: stringPointer(input.OptionID), Payload: input.Payload})
		if err != nil {
			writeJSON(response, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		interaction, found, err := host.GetInteraction(request.Context(), agenthost.SessionRef{WorkspaceID: workspaceID, AgentSessionID: agentSessionID}, turnID, requestID)
		if err != nil {
			writeJSON(response, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		if found && hub != nil {
			hub.publish(map[string]any{"topic": "agent.activity.updated", "payload": map[string]any{
				"workspaceId": workspaceID, "agentSessionId": agentSessionID, "eventType": "interaction_update",
				"data": map[string]any{"agentSessionId": agentSessionID, "interaction": interaction},
			}})
		}
		writeJSON(response, http.StatusOK, result)
	})
	return mux
}

func promptText(raw json.RawMessage) []agenthost.PromptContentBlock {
	if len(raw) == 0 {
		return nil
	}
	var text string
	if json.Unmarshal(raw, &text) == nil && text != "" {
		return []agenthost.PromptContentBlock{{Type: "text", Text: text}}
	}
	var blocks []agenthost.PromptContentBlock
	if json.Unmarshal(raw, &blocks) == nil {
		return blocks
	}
	return nil
}

func providerFromTarget(target string) string {
	switch target {
	case "local:claude-code":
		return "claude-code"
	case "local:codex":
		return "codex"
	case "local:cursor":
		return "cursor"
	case "local:opencode":
		return "opencode"
	case "extension:kimi-code":
		return "kimi-code"
	default:
		return target
	}
}

type localDurableReporter struct {
	adapter *activity.SessionActivityReporterAdapter
}

func (r *localDurableReporter) Report(ctx context.Context, input activity.ReportActivityInput) error {
	return r.adapter.Report(ctx, input)
}
func (r *localDurableReporter) ReportSubmitProvenance(ctx context.Context, input activity.ReportActivityInput) error {
	return r.adapter.Report(ctx, input)
}

type localCanonicalReporter struct {
	store *storesqlite.Store
	hub   *eventHub
}

func (r *localCanonicalReporter) ReportSessionState(ctx context.Context, input canonical.ReportSessionStateInput) (canonical.ReportSessionStateReply, error) {
	s := input.State
	report := storesqlite.ActivityStateReport{Session: storesqlite.SessionStateReport{
		WorkspaceID: input.WorkspaceID, AgentSessionID: input.AgentSessionID, Kind: s.Kind,
		RootAgentSessionID: s.RootAgentSessionID, RootTurnID: s.RootTurnID,
		ParentAgentSessionID: s.ParentAgentSessionID, ParentTurnID: s.ParentTurnID,
		ParentToolCallID: s.ParentToolCallID, AgentTargetID: s.AgentTargetID,
		Provider: s.Provider, ProviderSessionID: s.ProviderSessionID, Model: s.Model,
		Settings: s.Settings, Capabilities: s.Capabilities, RuntimeContext: s.RuntimeContext,
		RuntimeContextPatch: s.RuntimeContextPatch, Cwd: s.CWD, Title: s.Title,
		Status: s.LifecycleStatus, CurrentPhase: s.CurrentPhase, LastError: s.LastError,
		OccurredAtUnixMS: s.OccurredAtUnixMS,
	}}
	if s.InteractionTransition != nil {
		report.Interaction = interactionUpsert(input.WorkspaceID, input.AgentSessionID, s.InteractionTransition, s.OccurredAtUnixMS)
	}
	if s.Turn != nil {
		report.Turn = &storesqlite.TurnTransition{
			WorkspaceID: input.WorkspaceID, AgentSessionID: input.AgentSessionID,
			TurnID: s.Turn.TurnID, Phase: s.Turn.Phase, Outcome: s.Turn.Outcome,
			ErrorCode: s.Turn.ErrorCode, ErrorMessage: s.Turn.ErrorMessage,
			Origin: s.Turn.Origin, FileChanges: s.Turn.FileChanges,
			SourceGoalOperationID: s.Turn.SourceGoalOperationID, SourceGoalRevision: s.Turn.SourceGoalRevision,
			SourceGoalRepairEpoch: s.Turn.SourceGoalRepairEpoch, StartedAtUnixMS: s.Turn.StartedAtUnixMS,
			SettledAtUnixMS: s.Turn.CompletedAtUnixMS, OccurredAtUnixMS: s.OccurredAtUnixMS,
		}
	}
	result, err := r.store.ReportActivityState(ctx, report)
	if err != nil {
		return canonical.ReportSessionStateReply{}, err
	}
	if r.hub != nil && s.Turn != nil {
		r.hub.publish(map[string]any{"topic": "agent.activity.updated", "payload": map[string]any{
			"workspaceId": input.WorkspaceID, "agentSessionId": input.AgentSessionID, "eventType": "turn_update",
			"data": map[string]any{"workspaceId": input.WorkspaceID, "agentSessionId": input.AgentSessionID, "eventType": "turn_update", "occurredAtUnixMs": s.OccurredAtUnixMS, "activeTurnId": s.Turn.ActiveTurnID, "turn": s.Turn},
		}})
	}
	if r.hub != nil && result.InteractionResult == storesqlite.InteractionTransitionApplied {
		r.publishInteraction(input.WorkspaceID, input.AgentSessionID, result.Interaction)
	}
	return canonical.ReportSessionStateReply{Accepted: result.State.Accepted, StateApplied: result.State.StateApplied, LastEventAtUnixMS: result.State.LastEventUnixMS}, nil
}

func (r *localCanonicalReporter) ReportSessionMessages(ctx context.Context, input canonical.ReportSessionMessagesInput) (canonical.ReportSessionMessagesReply, error) {
	updates := make([]storesqlite.MessageUpdate, 0, len(input.Updates))
	for _, message := range input.Updates {
		updates = append(updates, storesqlite.MessageUpdate{MessageID: message.MessageID, TurnID: message.TurnID, Role: message.Role, Kind: message.Kind, Status: message.Status, ContentDelta: message.ContentDelta, Payload: message.Payload, OccurredAtUnixMS: message.OccurredAtUnixMS, StartedAtUnixMS: message.StartedAtUnixMS, CompletedAtUnixMS: message.CompletedAtUnixMS})
	}
	result, err := r.store.ReportSessionMessages(ctx, storesqlite.SessionMessageReport{WorkspaceID: input.WorkspaceID, AgentSessionID: input.AgentSessionID, Provider: input.Source.Provider, Messages: updates})
	if err != nil {
		return canonical.ReportSessionMessagesReply{}, err
	}
	if r.hub != nil {
		for _, message := range input.Updates {
			text, _ := message.Payload["text"].(string)
			if text == "" {
				continue
			}
			r.hub.publish(map[string]any{"topic": "agent.activity.updated", "payload": map[string]any{
				"workspaceId": input.WorkspaceID, "agentSessionId": input.AgentSessionID, "eventType": "message_delta",
				"data": map[string]any{"workspaceId": input.WorkspaceID, "agentSessionId": input.AgentSessionID, "eventType": "message_delta", "messageId": message.MessageID, "turnId": message.TurnID, "role": message.Role, "kind": message.Kind, "occurredAtUnixMs": message.OccurredAtUnixMS, "content": map[string]any{"operation": "append_text", "text": text}},
			}})
		}
	}
	return canonical.ReportSessionMessagesReply{AcceptedCount: result.AcceptedCount, LatestVersion: result.LatestVersion}, nil
}

type localActivityReporter struct {
	store *storesqlite.Store
	hub   *eventHub
}

func (r *localActivityReporter) Report(ctx context.Context, input activity.ReportActivityInput) error {
	for _, patch := range input.StatePatches {
		session := storesqlite.SessionStateReport{
			WorkspaceID: input.WorkspaceID, AgentSessionID: patch.AgentSessionID,
			Kind: patch.Kind, RootAgentSessionID: patch.RootAgentSessionID, RootTurnID: patch.RootTurnID,
			ParentAgentSessionID: patch.ParentAgentSessionID, ParentTurnID: patch.ParentTurnID,
			ParentToolCallID: patch.ParentToolCallID, AgentTargetID: patch.AgentTargetID,
			Provider: patch.Provider, ProviderSessionID: patch.ProviderSessionID, Model: patch.Model,
			Settings: patch.Settings, RuntimeContext: patch.RuntimeContext, Cwd: patch.CWD,
			Title: patch.Title, Status: patch.LifecycleStatus, CurrentPhase: patch.CurrentPhase,
			LastError: patch.LastError, OccurredAtUnixMS: patch.OccurredAtUnixMS,
		}
		state := storesqlite.ActivityStateReport{Session: session}
		if patch.Turn != nil {
			state.Turn = &storesqlite.TurnTransition{
				WorkspaceID: input.WorkspaceID, AgentSessionID: patch.AgentSessionID,
				TurnID: patch.Turn.TurnID, Phase: patch.Turn.Phase, Outcome: patch.Turn.Outcome,
				Origin: patch.Turn.Origin, ErrorCode: patch.Turn.ErrorCode, ErrorMessage: patch.Turn.ErrorMessage,
				FileChanges: patch.Turn.FileChanges, FinalAssistantMessageID: patch.Turn.FinalAssistantMessageID,
				SourceGoalOperationID: patch.Turn.SourceGoalOperationID, SourceGoalRevision: patch.Turn.SourceGoalRevision,
				SourceGoalRepairEpoch: patch.Turn.SourceGoalRepairEpoch, StartedAtUnixMS: patch.Turn.StartedAtUnixMS,
				SettledAtUnixMS: patch.Turn.CompletedAtUnixMS, OccurredAtUnixMS: patch.OccurredAtUnixMS,
			}
		}
		if patch.InteractionTransition != nil {
			state.Interaction = interactionUpsert(input.WorkspaceID, patch.AgentSessionID, patch.InteractionTransition, patch.OccurredAtUnixMS)
		}
		result, err := r.store.ReportActivityState(ctx, state)
		if err != nil {
			return err
		}
		if r.hub != nil && patch.Turn != nil {
			r.hub.publish(map[string]any{"topic": "agent.activity.updated", "payload": map[string]any{
				"workspaceId": input.WorkspaceID, "agentSessionId": patch.AgentSessionID,
				"eventType": "turn_update", "data": map[string]any{
					"workspaceId": input.WorkspaceID, "agentSessionId": patch.AgentSessionID,
					"eventType": "turn_update", "occurredAtUnixMs": patch.OccurredAtUnixMS,
					"activeTurnId": patch.Turn.ActiveTurnID, "turn": patch.Turn,
				},
			}})
		}
		if r.hub != nil && result.InteractionResult == storesqlite.InteractionTransitionApplied {
			r.hub.publish(map[string]any{"topic": "agent.activity.updated", "payload": map[string]any{
				"workspaceId": input.WorkspaceID, "agentSessionId": patch.AgentSessionID, "eventType": "interaction_update",
				"data": map[string]any{"agentSessionId": patch.AgentSessionID, "interaction": result.Interaction},
			}})
		}
	}
	for _, message := range input.MessageUpdates {
		if r.hub == nil {
			continue
		}
		text, _ := message.Payload["text"].(string)
		if text == "" {
			continue
		}
		r.hub.publish(map[string]any{"topic": "agent.activity.updated", "payload": map[string]any{
			"workspaceId": input.WorkspaceID, "agentSessionId": message.AgentSessionID,
			"eventType": "message_delta", "data": map[string]any{
				"workspaceId": input.WorkspaceID, "agentSessionId": message.AgentSessionID,
				"eventType": "message_delta", "messageId": message.MessageID, "turnId": message.TurnID,
				"role": message.Role, "kind": message.Kind, "occurredAtUnixMs": message.OccurredAtUnixMS,
				"content": map[string]any{"operation": "append_text", "text": text},
			},
		}})
	}
	return nil
}
func (r *localActivityReporter) ReportSubmitProvenance(ctx context.Context, input activity.ReportActivityInput) error {
	return r.Report(ctx, input)
}

func interactionUpsert(workspaceID, agentSessionID string, transition *canonical.WorkspaceAgentInteractionTransition, occurredAtUnixMS int64) *storesqlite.InteractionUpsert {
	if transition == nil {
		return nil
	}
	return &storesqlite.InteractionUpsert{
		WorkspaceID: workspaceID, AgentSessionID: agentSessionID,
		RequestID: transition.RequestID, TurnID: transition.TurnID,
		Kind: transition.Kind, Status: transition.Status, ToolName: transition.ToolName,
		Input: transition.Input, Metadata: transition.Metadata, OccurredAtUnixMS: occurredAtUnixMS,
	}
}

func (r *localCanonicalReporter) publishInteraction(workspaceID, agentSessionID string, interaction storesqlite.Interaction) {
	r.hub.publish(map[string]any{"topic": "agent.activity.updated", "payload": map[string]any{
		"workspaceId": workspaceID, "agentSessionId": agentSessionID, "eventType": "interaction_update",
		"data": map[string]any{"agentSessionId": agentSessionID, "interaction": interaction},
	}})
}

func stringPointer(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}
