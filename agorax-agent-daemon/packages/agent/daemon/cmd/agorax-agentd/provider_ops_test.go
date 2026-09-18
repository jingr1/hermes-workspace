package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"agorax.local/agent-daemon/packages/agent/daemon/managednpm"
)

// These tests exercise the real receiving boundary: provider detection runs
// fake executables through the runtime command resolver and execs them with
// argv arrays, and managed npm installs run a fake npm launcher that records
// its argv. The Windows .cmd/.ps1 interpreter routing lives behind
// newProviderExecCommand; the POSIX lane covers the direct-exec contract here
// and the Windows CI lane owns the cmd.exe adapter path.

const fakeClaudeScript = `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "--version" ]; then
    echo "2.1.0 (claude code)"
    exit 0
  fi
done
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  echo '{"loggedIn":true,"accountLabel":"dev@example.com","authMethod":"oauth"}'
  exit 0
fi
echo "unsupported invocation: $*" >&2
exit 1
`

const fakeCodexScript = `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "--version" ]; then
    echo "codex-cli 0.153.4"
    exit 0
  fi
done
if [ "$1" = "-c" ]; then
  echo "logged in as dev@example.com"
  exit 0
fi
echo "unsupported invocation: $*" >&2
exit 1
`

// fakeNPMScript installs a codex binary printing newVersion into the prefix
// passed via --prefix and records every argv line into NPM_ARGV_LOG.
// Coreutils are referenced by absolute path because the test environment
// restricts PATH to the fake bin directory.
const fakeNPMScriptTemplate = `#!/bin/sh
log="${NPM_ARGV_LOG:?}"
printf '%%s\n' "$@" >> "$log" || exit 1
prefix=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--prefix" ]; then prefix="$arg"; fi
  prev="$arg"
done
if [ -z "$prefix" ]; then
  echo "missing --prefix" >&2
  exit 1
fi
/bin/mkdir -p "$prefix/bin" || exit 1
{
  printf '#!/bin/sh\n'
  printf 'echo "codex-cli %s"\n'
} > "$prefix/bin/codex" || exit 1
/bin/chmod +x "$prefix/bin/codex" || exit 1
echo "+ codex@%s"
exit 0
`

func writeExecutable(t *testing.T, dir string, name string, content string) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("POSIX fake-bin script tests do not run on Windows")
	}
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(content), 0o755); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
	return path
}

// fakeProviderEnv builds a providerOps whose resolver searches binDir, whose
// home is homeDir, and whose registry probes go through registryServer (or a
// pinned override when non-nil).
func fakeProviderOps(t *testing.T, binDir string, homeDir string, envExtra []string) *providerOps {
	t.Helper()
	env := append([]string{"PATH=" + binDir}, envExtra...)
	ops := &providerOps{
		httpClient:   &http.Client{Timeout: 2 * time.Second},
		environ:      func() []string { return env },
		homeDir:      func() (string, error) { return homeDir, nil },
		now:          time.Now,
		latestCached: map[string]latestVersionEntry{},
		installing:   map[string]bool{},
	}
	ops.resolver.Environ = ops.environ
	ops.resolver.HomeDir = ops.homeDir
	return ops
}

func TestProviderStatusAggregatesDetectedRuntimes(t *testing.T) {
	binDir := t.TempDir()
	writeExecutable(t, binDir, "claude", fakeClaudeScript)
	writeExecutable(t, binDir, "codex", fakeCodexScript)
	ops := fakeProviderOps(t, binDir, t.TempDir(), nil)
	// Pin registry discovery so the test never touches the network.
	ops.latestCached["@anthropic-ai/claude-code"] = latestVersionEntry{version: "2.1.0", checked: time.Now()}
	ops.latestCached["@openai/codex"] = latestVersionEntry{version: "0.153.4", checked: time.Now()}
	ops.registeredProviders = func() map[string]bool {
		return map[string]bool{"claude-code": true, "acp:kimi-code": true}
	}

	server, _ := newTestServerWithOps(t, ops)
	status, body := getJSON(t, server.URL+"/v1/provider-status")
	if status != http.StatusOK {
		t.Fatalf("status = %d body = %v", status, body)
	}
	providers, ok := body["providers"].([]any)
	if !ok || len(providers) != 5 {
		t.Fatalf("providers = %v", body["providers"])
	}
	byID := map[string]map[string]any{}
	for _, raw := range providers {
		entry := raw.(map[string]any)
		byID[entry["provider"].(string)] = entry
	}

	claude := byID["claude-code"]
	if claude == nil || claude["installed"] != true || claude["registered"] != true {
		t.Fatalf("claude-code = %v", claude)
	}
	if claude["version"] != "2.1.0" || claude["binaryPath"] == nil {
		t.Fatalf("claude-code detail = %v", claude)
	}
	auth := claude["auth"].(map[string]any)
	if auth["status"] != "authenticated" || auth["accountLabel"] != "dev@example.com" {
		t.Fatalf("claude-code auth = %v", auth)
	}
	if claude["updateAvailable"] != false {
		t.Fatalf("claude-code updateAvailable = %v", claude["updateAvailable"])
	}
	install := claude["install"].(map[string]any)
	if install["packageName"] != "@anthropic-ai/claude-code" || install["binaryName"] != "claude" || install["managedNpm"] != true {
		t.Fatalf("claude-code install = %v", install)
	}

	codex := byID["codex"]
	if codex == nil || codex["installed"] != true || codex["version"] != "0.153.4" {
		t.Fatalf("codex = %v", codex)
	}
	if codex["updateAvailable"] != false {
		t.Fatalf("codex updateAvailable = %v", codex["updateAvailable"])
	}

	// kimi-code has no descriptor: detected by its bare binary name and
	// registered under the ACP extension key.
	kimi := byID["kimi-code"]
	if kimi == nil || kimi["installed"] != false || kimi["registered"] != true {
		t.Fatalf("kimi-code = %v", kimi)
	}
	if kimi["error"] != nil && kimi["error"] != "" {
		t.Fatalf("kimi-code error = %v", kimi["error"])
	}

	if byID["cursor"]["installed"] != false || byID["opencode"]["installed"] != false {
		t.Fatalf("cursor/opencode = %v / %v", byID["cursor"], byID["opencode"])
	}
}

func TestProviderStatusFlagsUpdateAvailable(t *testing.T) {
	binDir := t.TempDir()
	writeExecutable(t, binDir, "claude", fakeClaudeScript)
	ops := fakeProviderOps(t, binDir, t.TempDir(), nil)
	// Registry advertises a newer release than the installed 2.1.0.
	ops.latestCached["@anthropic-ai/claude-code"] = latestVersionEntry{version: "2.2.0", checked: time.Now()}

	server, _ := newTestServerWithOps(t, ops)
	_, body := getJSON(t, server.URL+"/v1/provider-status")
	providers := body["providers"].([]any)
	claude := providers[1].(map[string]any) // catalog order: codex, claude-code, ...
	if claude["provider"] != "claude-code" {
		t.Fatalf("provider order changed: %v", claude["provider"])
	}
	if claude["updateAvailable"] != true || claude["latestVersion"] != "2.2.0" {
		t.Fatalf("claude-code update = %v", claude)
	}
}

func TestProviderStatusKeepsProbeErrorsNonFatal(t *testing.T) {
	binDir := t.TempDir()
	// Version probe exits non-zero and prints nothing parseable.
	writeExecutable(t, binDir, "claude", "#!/bin/sh\necho 'boom' >&2\nexit 1\n")
	ops := fakeProviderOps(t, binDir, t.TempDir(), nil)

	server, _ := newTestServerWithOps(t, ops)
	status, body := getJSON(t, server.URL+"/v1/provider-status")
	if status != http.StatusOK {
		t.Fatalf("status = %d body = %v", status, body)
	}
	for _, raw := range body["providers"].([]any) {
		entry := raw.(map[string]any)
		if entry["provider"] != "claude-code" {
			continue
		}
		if entry["installed"] != true || entry["version"] != nil {
			t.Fatalf("claude-code = %v", entry)
		}
		if entry["error"] == "" {
			t.Fatalf("expected probe error, got %v", entry)
		}
		return
	}
	t.Fatal("claude-code missing from provider-status")
}

func TestProviderInstallIsIdempotentWhenSatisfied(t *testing.T) {
	home := t.TempDir()
	binDir := t.TempDir()
	// npm launcher that would record argv; must never run on the idempotent path.
	npmPath := writeExecutable(t, binDir, "npm", "#!/bin/sh\nexit 99\n")
	prefixBin := filepath.Join(home, ".local", "bin")
	if err := os.MkdirAll(prefixBin, 0o755); err != nil {
		t.Fatalf("mkdir prefix bin: %v", err)
	}
	writeExecutable(t, prefixBin, "codex", "#!/bin/sh\necho 'codex-cli 0.200.0'\n")

	ops := fakeProviderOps(t, binDir, home, nil)
	ops.latestCached["@openai/codex"] = latestVersionEntry{version: "0.200.0", checked: time.Now()}

	result, httpStatus, err := ops.installProvider(context.Background(), "codex", "")
	if err != nil {
		t.Fatalf("installProvider: %v", err)
	}
	if httpStatus != http.StatusOK || result.Status != "already" {
		t.Fatalf("result = (%d, %+v)", httpStatus, result)
	}
	if result.Version == nil || *result.Version != "0.200.0" {
		t.Fatalf("version = %+v", result)
	}
	if _, statErr := os.Stat(npmPath); statErr != nil {
		t.Fatalf("npm path missing: %v", statErr)
	}
	// The fake npm exits 99 when run; the idempotent path must not invoke it at
	// all, which a successful "already" result already proves.
}

func TestProviderInstallEnsureDoesNotUpgrade(t *testing.T) {
	// Empty-version installs are "ensure present": a newer registry release
	// alone must not trigger a reinstall/upgrade.
	home := t.TempDir()
	binDir := t.TempDir()
	argvLog := filepath.Join(t.TempDir(), "npm-argv.log")
	prefixBin := filepath.Join(home, ".local", "bin")
	if err := os.MkdirAll(prefixBin, 0o755); err != nil {
		t.Fatalf("mkdir prefix bin: %v", err)
	}
	writeExecutable(t, prefixBin, "claude", "#!/bin/sh\nfor a in \"$@\"; do [ \"$a\" = \"--version\" ] && echo '2.1.268 (Claude Code)'; done\n")
	// npm exits 99 if invoked; the idempotent path must never call it.
	writeExecutable(t, binDir, "npm", "#!/bin/sh\nexit 99\n")
	ops := fakeProviderOps(t, binDir, home, nil)
	ops.latestCached["@anthropic-ai/claude-code"] = latestVersionEntry{version: "2.1.276", checked: time.Now()}

	result, httpStatus, err := ops.installProvider(context.Background(), "claude-code", "")
	if err != nil {
		t.Fatalf("installProvider: %v", err)
	}
	if httpStatus != http.StatusOK || result.Status != "already" {
		t.Fatalf("result = (%d, %+v)", httpStatus, result)
	}
	if _, err := os.Stat(argvLog); !os.IsNotExist(err) {
		t.Fatalf("npm was invoked on the ensure path: %v", err)
	}

	// An explicit "latest" upgrade with a newer release available proceeds.
	registry := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"version":"0.200.0"}`))
	}))
	t.Cleanup(registry.Close)
	ops.environ = func() []string {
		return []string{"PATH=" + binDir, "NPM_ARGV_LOG=" + argvLog, managednpm.RegistryOverrideEnv + "=" + registry.URL}
	}
	writeExecutable(t, prefixBin, "codex", "#!/bin/sh\necho 'codex-cli 0.153.4'\n")
	writeExecutable(t, binDir, "npm", fmt.Sprintf(fakeNPMScriptTemplate, "0.200.0", "0.200.0"))
	ops.latestCached["@openai/codex"] = latestVersionEntry{version: "0.200.0", checked: time.Now()}
	upgrade, upgradeStatus, err := ops.installProvider(context.Background(), "codex", "latest")
	if err != nil {
		t.Fatalf("installProvider latest: %v", err)
	}
	if upgradeStatus != http.StatusOK || upgrade.Status != "installed" || upgrade.Version == nil || *upgrade.Version != "0.200.0" {
		t.Fatalf("upgrade = (%d, %+v)", upgradeStatus, upgrade)
	}
}

func TestProviderInstallExactPinMatchesBelowFloor(t *testing.T) {
	// An explicit version pin that matches the installed binary is satisfied
	// even below the descriptor floor: no gratuitous reinstall.
	home := t.TempDir()
	binDir := t.TempDir()
	prefixBin := filepath.Join(home, ".local", "bin")
	if err := os.MkdirAll(prefixBin, 0o755); err != nil {
		t.Fatalf("mkdir prefix bin: %v", err)
	}
	writeExecutable(t, prefixBin, "codex", "#!/bin/sh\necho 'codex-cli 0.100.0'\n")
	writeExecutable(t, binDir, "npm", "#!/bin/sh\nexit 99\n")
	ops := fakeProviderOps(t, binDir, home, nil)

	result, httpStatus, err := ops.installProvider(context.Background(), "codex", "0.100.0")
	if err != nil {
		t.Fatalf("installProvider: %v", err)
	}
	if httpStatus != http.StatusOK || result.Status != "already" {
		t.Fatalf("result = (%d, %+v)", httpStatus, result)
	}
}

func TestCleanupNPMStagingDirs(t *testing.T) {
	prefix := t.TempDir()
	pkgDir := filepath.Join(prefix, "lib", "node_modules", "@openai", "codex")
	if err := os.MkdirAll(pkgDir, 0o755); err != nil {
		t.Fatalf("mkdir package dir: %v", err)
	}
	staging := filepath.Join(prefix, "lib", "node_modules", "@openai", ".codex-KXFLsmgY")
	if err := os.MkdirAll(filepath.Join(staging, "node_modules"), 0o755); err != nil {
		t.Fatalf("mkdir staging dir: %v", err)
	}
	// An unrelated sibling package must survive cleanup.
	other := filepath.Join(prefix, "lib", "node_modules", "@openai", "other")
	if err := os.MkdirAll(other, 0o755); err != nil {
		t.Fatalf("mkdir other package: %v", err)
	}

	cleanupNPMStagingDirs(prefix, "@openai/codex")
	if _, err := os.Stat(staging); !os.IsNotExist(err) {
		t.Fatalf("staging dir still present: %v", err)
	}
	if _, err := os.Stat(pkgDir); err != nil {
		t.Fatalf("package dir removed: %v", err)
	}
	if _, err := os.Stat(other); err != nil {
		t.Fatalf("unrelated package removed: %v", err)
	}

	if got := managedNPMGlobalPackageDir(prefix, "@openai/codex"); got != pkgDir {
		t.Fatalf("managedNPMGlobalPackageDir = %q want %q", got, pkgDir)
	}
	if got := managedNPMGlobalPackageDir(prefix, "../evil"); got != "" {
		t.Fatalf("path traversal accepted: %q", got)
	}
}

func TestProviderInstallRunsNPMWithArgvAndVerifies(t *testing.T) {
	home := t.TempDir()
	binDir := t.TempDir()
	argvLog := filepath.Join(t.TempDir(), "npm-argv.log")
	registry := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"version":"0.200.0"}`))
	}))
	t.Cleanup(registry.Close)

	npmScript := fmt.Sprintf(fakeNPMScriptTemplate, "0.200.0", "0.200.0")
	writeExecutable(t, binDir, "npm", npmScript)
	ops := fakeProviderOps(t, binDir, home, []string{
		"NPM_ARGV_LOG=" + argvLog,
		managednpm.RegistryOverrideEnv + "=" + registry.URL,
	})

	result, httpStatus, err := ops.installProvider(context.Background(), "codex", "")
	if err != nil {
		t.Fatalf("installProvider: %v", err)
	}
	if httpStatus != http.StatusOK || result.Status != "installed" {
		t.Fatalf("result = (%d, %+v)", httpStatus, result)
	}
	if result.Version == nil || *result.Version != "0.200.0" {
		t.Fatalf("version = %+v", result)
	}
	if result.Registry != registry.URL {
		t.Fatalf("registry = %q want %q", result.Registry, registry.URL)
	}
	if result.BinaryPath == nil || !strings.HasPrefix(*result.BinaryPath, filepath.Join(home, ".local")) {
		t.Fatalf("binaryPath = %+v", result.BinaryPath)
	}

	raw, err := os.ReadFile(argvLog)
	if err != nil {
		t.Fatalf("read argv log: %v", err)
	}
	argv := strings.Split(strings.TrimSpace(string(raw)), "\n")
	want := []string{"install", "-g", "--prefix", filepath.Join(home, ".local"), "@openai/codex@latest", "--include=optional"}
	if strings.Join(argv, " ") != strings.Join(want, " ") {
		t.Fatalf("npm argv = %q want %q", strings.Join(argv, " "), strings.Join(want, " "))
	}
	if result.Command[0] != filepath.Join(binDir, "npm") {
		t.Fatalf("command npm = %q", result.Command[0])
	}
}

func TestProviderInstallBelowFloorRepairs(t *testing.T) {
	home := t.TempDir()
	binDir := t.TempDir()
	argvLog := filepath.Join(t.TempDir(), "npm-argv.log")
	registry := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"version":"0.153.4"}`))
	}))
	t.Cleanup(registry.Close)
	writeExecutable(t, binDir, "npm", fmt.Sprintf(fakeNPMScriptTemplate, "0.153.4", "0.153.4"))
	// Existing install below the codex minimum version (0.153.4 exactly meets
	// it; use an older line to prove the floor triggers a repair).
	prefixBin := filepath.Join(home, ".local", "bin")
	if err := os.MkdirAll(prefixBin, 0o755); err != nil {
		t.Fatalf("mkdir prefix bin: %v", err)
	}
	writeExecutable(t, prefixBin, "codex", "#!/bin/sh\necho 'codex-cli 0.100.0'\n")
	ops := fakeProviderOps(t, binDir, home, []string{
		"NPM_ARGV_LOG=" + argvLog,
		managednpm.RegistryOverrideEnv + "=" + registry.URL,
	})

	result, httpStatus, err := ops.installProvider(context.Background(), "codex", "")
	if err != nil {
		t.Fatalf("installProvider: %v", err)
	}
	if httpStatus != http.StatusOK || result.Status != "installed" {
		t.Fatalf("result = (%d, %+v)", httpStatus, result)
	}
	if _, err := os.Stat(argvLog); err != nil {
		t.Fatalf("npm was not invoked for below-floor repair: %v", err)
	}
}

func TestProviderInstallRejectsConcurrentAndUnsupported(t *testing.T) {
	home := t.TempDir()
	binDir := t.TempDir()
	ops := fakeProviderOps(t, binDir, home, nil)

	ops.installMu.Lock()
	ops.installing["codex"] = true
	ops.installMu.Unlock()
	if _, status, err := ops.installProvider(context.Background(), "codex", ""); status != http.StatusConflict || err == nil {
		t.Fatalf("concurrent install = (%d, %v)", status, err)
	}
	ops.releaseInstall("codex")

	// cursor ships an official-script installer without a managed npm package;
	// kimi-code has no installer descriptor at all.
	for _, provider := range []string{"cursor", "kimi-code"} {
		if _, status, err := ops.installProvider(context.Background(), provider, ""); status != http.StatusUnprocessableEntity || err == nil {
			t.Fatalf("%s install = (%d, %v)", provider, status, err)
		}
	}
	if _, status, err := ops.installProvider(context.Background(), "nexight", ""); status != http.StatusNotFound || err == nil {
		t.Fatalf("unknown provider = (%d, %v)", status, err)
	}
}

func TestProviderInstallEndpointDecodesBody(t *testing.T) {
	home := t.TempDir()
	binDir := t.TempDir()
	registry := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"version":"0.153.4"}`))
	}))
	t.Cleanup(registry.Close)
	argvLog := filepath.Join(t.TempDir(), "npm-argv.log")
	writeExecutable(t, binDir, "npm", fmt.Sprintf(fakeNPMScriptTemplate, "0.153.4", "0.153.4"))
	ops := fakeProviderOps(t, binDir, home, []string{
		"NPM_ARGV_LOG=" + argvLog,
		managednpm.RegistryOverrideEnv + "=" + registry.URL,
	})

	server, _ := newTestServerWithOps(t, ops)
	response, err := http.Post(server.URL+"/v1/providers/codex/install", "application/json", strings.NewReader(`{"version":"0.153.4"}`))
	if err != nil {
		t.Fatalf("POST install: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("install status = %d", response.StatusCode)
	}
	var result providerInstallResultDTO
	if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
		t.Fatalf("decode install result: %v", err)
	}
	if result.Status != "installed" || result.Version == nil || *result.Version != "0.153.4" {
		t.Fatalf("install result = %+v", result)
	}
	raw, err := os.ReadFile(argvLog)
	if err != nil {
		t.Fatalf("read argv log: %v", err)
	}
	if !strings.Contains(string(raw), "@openai/codex@0.153.4") {
		t.Fatalf("npm argv = %q", string(raw))
	}
}

func TestReadNPMRegistryLatestVersionUsesLatestAliasManifest(t *testing.T) {
	// Full packuments run to tens of MB for providers like @openai/codex, so
	// discovery resolves the compact `latest` version-alias manifest instead.
	var requestedPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestedPath = r.URL.Path
		_, _ = w.Write([]byte(`{"name":"@acme/pkg","version":"9.8.7"}`))
	}))
	t.Cleanup(server.Close)
	version, err := readNPMRegistryLatestVersion(t.Context(), &http.Client{Timeout: 5 * time.Second}, server.URL, "@acme/pkg")
	if err != nil {
		t.Fatalf("readNPMRegistryLatestVersion: %v", err)
	}
	if version != "9.8.7" {
		t.Fatalf("version = %q", version)
	}
	if !strings.HasSuffix(requestedPath, "/latest") {
		t.Fatalf("request path = %q, want the latest alias manifest", requestedPath)
	}
}

func TestUpdateAvailableComparison(t *testing.T) {
	version := "1.2.3"
	cases := []struct {
		name        string
		version     *string
		minVersion  string
		recommended string
		latest      string
		want        bool
	}{
		{name: "no version", version: nil, latest: "9.9.9", want: false},
		{name: "up to date", version: &version, latest: "1.2.3", want: false},
		{name: "newer latest", version: &version, latest: "1.3.0", want: true},
		{name: "newer recommended", version: &version, recommended: "2.0.0", want: true},
		{name: "below floor", version: &version, minVersion: "1.3.0", want: true},
		{name: "unparseable latest ignored", version: &version, latest: "beta-1", want: false},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := updateAvailable(testCase.version, testCase.minVersion, testCase.recommended, testCase.latest); got != testCase.want {
				t.Fatalf("updateAvailable = %v want %v", got, testCase.want)
			}
		})
	}
}
