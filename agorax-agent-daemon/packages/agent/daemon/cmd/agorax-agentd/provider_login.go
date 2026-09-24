package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"time"

	"agorax.local/agent-daemon/packages/agent/daemon/providerregistry"
	"agorax.local/agent-daemon/packages/agent/daemon/providerstatus"
)

const (
	// providerLoginWatchTimeout bounds how long status reports loginInProgress
	// after the daemon launches an interactive login process.
	providerLoginWatchTimeout = 3 * time.Minute
	// providerLoginPollInterval is how often we re-probe auth while watching.
	providerLoginPollInterval = 5 * time.Second
)

type providerLoginResultDTO struct {
	Provider       string   `json:"provider"`
	Status         string   `json:"status"` // "started" | "already" | "in_progress"
	Mode           string   `json:"mode,omitempty"` // "terminal" | "detached" | "command"
	Command        []string `json:"command,omitempty"`
	DisplayCommand string   `json:"displayCommand,omitempty"`
}

func loginDescriptorDTO(status providerregistry.StatusDescriptor, binary string) (*providerLoginDTO, bool) {
	if len(status.LoginArgs) == 0 {
		return nil, false
	}
	commandName := strings.TrimSpace(binary)
	if commandName == "" && len(status.BinaryNames) > 0 {
		commandName = status.BinaryNames[0]
	}
	if commandName == "" {
		return nil, false
	}
	parts := append([]string{commandName}, status.LoginArgs...)
	return &providerLoginDTO{
		Supported:      true,
		DisplayCommand: strings.Join(parts, " "),
		Command:        parts,
	}, true
}

func (o *providerOps) acquireLogin(providerID string) bool {
	o.loginMu.Lock()
	defer o.loginMu.Unlock()
	if o.loggingIn[providerID] {
		return false
	}
	o.loggingIn[providerID] = true
	return true
}

func (o *providerOps) releaseLogin(providerID string) {
	o.loginMu.Lock()
	defer o.loginMu.Unlock()
	delete(o.loggingIn, providerID)
}

func (o *providerOps) isLoginInProgress(providerID string) bool {
	o.loginMu.Lock()
	defer o.loginMu.Unlock()
	return o.loggingIn[providerID]
}

// startProviderLogin launches the provider's interactive login CLI, or returns
// a command for the Agorax web terminal when preferWebTerminal is set / the
// host is headless. The handler returns immediately; a background watcher
// clears loginInProgress when auth becomes ready or the watch budget expires.
func (o *providerOps) startProviderLogin(ctx context.Context, providerID string, preferWebTerminal bool) (providerLoginResultDTO, int, error) {
	result := providerLoginResultDTO{Provider: providerID}
	descriptor, ok := findProviderTarget(providerID)
	if !ok {
		return result, http.StatusNotFound, fmt.Errorf("unknown provider %q", providerID)
	}
	if len(descriptor.Status.LoginArgs) == 0 {
		return result, http.StatusUnprocessableEntity, fmt.Errorf("interactive login is not supported for %q", providerID)
	}

	binary := o.resolveBinary(descriptor.Status.BinaryNames)
	if binary == "" {
		return result, http.StatusBadRequest, fmt.Errorf("%q is not installed", providerID)
	}

	// Already authenticated — no need to relaunch.
	if auth := o.probeAuthQuick(ctx, descriptor, binary); auth == providerstatus.AuthAuthenticated || auth == providerstatus.AuthConfigured {
		result.Status = "already"
		if login, ok := loginDescriptorDTO(descriptor.Status, binary); ok {
			result.DisplayCommand = login.DisplayCommand
			result.Command = login.Command
		}
		return result, http.StatusOK, nil
	}

	if !o.acquireLogin(providerID) {
		result.Status = "in_progress"
		return result, http.StatusConflict, fmt.Errorf("a login for %q is already in progress", providerID)
	}

	direct := append([]string{binary}, descriptor.Status.LoginArgs...)
	// Browser / remote Agorax clients open the built-in web PTY themselves.
	if preferWebTerminal || !loginPrefersTerminalEmulator(o.environ()) {
		result.Status = "started"
		result.Mode = "command"
		result.Command = direct
		result.DisplayCommand = strings.Join(direct, " ")
		go o.watchProviderLogin(providerID, descriptor)
		return result, http.StatusOK, nil
	}

	mode, command, err := o.launchInteractiveLogin(binary, descriptor.Status.LoginArgs)
	if err != nil {
		o.releaseLogin(providerID)
		return result, http.StatusInternalServerError, err
	}
	result.Status = "started"
	result.Mode = mode
	result.Command = command
	result.DisplayCommand = strings.Join(command, " ")

	go o.watchProviderLogin(providerID, descriptor)
	return result, http.StatusOK, nil
}

func (o *providerOps) probeAuthQuick(ctx context.Context, descriptor providerregistry.ProviderDescriptor, binary string) providerstatus.AuthStatus {
	status := descriptor.Status
	if len(status.AuthStatusCommand) == 0 {
		return providerstatus.AuthUnknown
	}
	timeout := time.Duration(status.AuthStatusCommandTimeoutSeconds) * time.Second
	if timeout <= 0 || timeout > providerAuthTimeoutMax {
		timeout = providerAuthTimeoutMax
	}
	output, err := o.runProviderCommand(ctx, timeout, binary, status.AuthStatusCommand...)
	if err != nil {
		return providerstatus.AuthUnknown
	}
	auth, ok := providerstatus.ParseAuthStatusOutput(status.AuthOutputParserKind, output)
	if !ok {
		return providerstatus.AuthUnknown
	}
	return auth.Status
}

func (o *providerOps) watchProviderLogin(providerID string, descriptor providerregistry.ProviderDescriptor) {
	defer o.releaseLogin(providerID)
	deadline := o.now().Add(providerLoginWatchTimeout)
	for o.now().Before(deadline) {
		time.Sleep(providerLoginPollInterval)
		binary := o.resolveBinary(descriptor.Status.BinaryNames)
		if binary == "" {
			continue
		}
		auth := o.probeAuthQuick(context.Background(), descriptor, binary)
		if auth == providerstatus.AuthAuthenticated || auth == providerstatus.AuthConfigured {
			return
		}
	}
}

// launchInteractiveLogin prefers a terminal emulator so TTY-based login CLIs
// work on graphical hosts. Headless / SSH / browser-remote hosts (no DISPLAY)
// return mode "command" without spawning a GUI terminal the user cannot see.
// Detached process launch remains the fallback when a graphical session exists
// but no terminal emulator is available (typical for OAuth browser flows).
func (o *providerOps) launchInteractiveLogin(binary string, loginArgs []string) (mode string, command []string, err error) {
	direct := append([]string{binary}, loginArgs...)
	if !loginPrefersTerminalEmulator(o.environ()) {
		// Do not spawn gnome-terminal/xterm on a machine the user only reaches
		// through a remote browser — they would never see the window. The UI
		// copies DisplayCommand into the user's own SSH / web terminal.
		return "command", direct, nil
	}
	if terminalCmd, ok := buildLoginTerminalCommand(binary, loginArgs, o.environ()); ok {
		cmd := exec.Command(terminalCmd[0], terminalCmd[1:]...)
		cmd.Env = o.environ()
		detachProviderProcess(cmd)
		if startErr := cmd.Start(); startErr != nil {
			// Fall through to detached direct launch.
		} else {
			go func() { _ = cmd.Wait() }()
			return "terminal", direct, nil
		}
	}

	cmd := newProviderExecCommand(context.Background(), binary, loginArgs...)
	cmd.Env = o.environ()
	cmd.Stdin = nil
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	detachProviderProcess(cmd)
	if err := cmd.Start(); err != nil {
		return "", nil, fmt.Errorf("failed to start login process: %w", err)
	}
	go func() { _ = cmd.Wait() }()
	return "detached", direct, nil
}

// loginPrefersTerminalEmulator is true only when this daemon process has a
// graphical session. Remote SSH / headless hosts must not open local GUI
// terminals. Override with AGORAX_LOGIN_HEADLESS=1 (force command) or
// AGORAX_LOGIN_TERMINAL=<bin> (force a specific emulator).
func loginPrefersTerminalEmulator(environ []string) bool {
	if strings.TrimSpace(envValueLast(environ, "AGORAX_LOGIN_HEADLESS")) == "1" {
		return false
	}
	if strings.TrimSpace(envValueLast(environ, "AGORAX_LOGIN_TERMINAL")) != "" {
		return true
	}
	display := strings.TrimSpace(envValueLast(environ, "DISPLAY"))
	wayland := strings.TrimSpace(envValueLast(environ, "WAYLAND_DISPLAY"))
	return display != "" || wayland != ""
}
