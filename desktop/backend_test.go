package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
)

func TestCallingDirectoryAndArguments(t *testing.T) {
	got, err := parseLaunch([]string{"topic", "--repo", "review space/é", "--base=HEAD"}, "/tmp/caller")
	if err != nil || got.repo != "/tmp/caller/review space/é" || got.target != "topic" || got.base != "HEAD" {
		t.Fatalf("%+v, %v", got, err)
	}
	// Wails notifications contain arguments without the executable and use its
	// directory. Reconstructing them must preserve the original caller's repo.
	notified, err := parseLaunch(got.arguments(), "/tmp/app/Contents/MacOS")
	if err != nil || notified != got {
		t.Fatalf("notification changed selection: %+v (%v)", notified, err)
	}
	for _, args := range [][]string{{"--port", "7777"}, {"--repo"}, {"--base="}, {"--base", "--daemon"}, {"a", "b"}, {"--", "--daemon"}, {"--repo", "a\x00b"}} {
		if _, err := parseLaunch(args, "/tmp/caller"); err == nil {
			t.Fatalf("accepted %q", args)
		}
	}
	if _, err := parseLaunch(nil, "relative"); err == nil {
		t.Fatal("accepted untrusted relative working directory")
	}
	if _, err := parseLaunch([]string{"--help"}, "/tmp"); !errors.Is(err, flag.ErrHelp) {
		t.Fatal(err)
	}
}

func fixtureRepo(t *testing.T, name string) string {
	t.Helper()
	repo := filepath.Join(t.TempDir(), name)
	if err := os.Mkdir(repo, 0755); err != nil {
		t.Fatal(err)
	}
	git := func(args ...string) {
		cmd := exec.Command("git", append([]string{"-C", repo}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git: %s (%v)", out, err)
		}
	}
	git("init", "-b", "main")
	git("config", "user.name", "Desktop fixture")
	git("config", "user.email", "fixture@example.invalid")
	if err := os.WriteFile(filepath.Join(repo, "hello.txt"), []byte("before\n"), 0644); err != nil {
		t.Fatal(err)
	}
	git("add", ".")
	git("commit", "-m", "base")
	if err := os.WriteFile(filepath.Join(repo, "hello.txt"), []byte("after\n"), 0644); err != nil {
		t.Fatal(err)
	}
	return repo
}

func TestSharedBackendNativeOriginAndShutdown(t *testing.T) {
	ctx := context.Background()
	b, err := startBackend(ctx, fstest.MapFS{"index.html": {Data: []byte("<!doctype html><html><head></head><body>fixture</body></html>")}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(b.close)
	first := fixtureRepo(t, "repo space é")
	second := fixtureRepo(t, "another")
	firstRoute, err := b.open(ctx, launch{repo: first, base: "HEAD"})
	if err != nil || !strings.HasSuffix(firstRoute, "/?base=HEAD") {
		t.Fatalf("%q (%v)", firstRoute, err)
	}
	secondRoute, err := b.open(ctx, launch{repo: second, base: "HEAD"})
	if err != nil || secondRoute == firstRoute {
		t.Fatalf("%q (%v)", secondRoute, err)
	}
	if _, err := b.open(ctx, launch{repo: first, base: "does-not-exist"}); err == nil {
		t.Fatal("invalid base accepted")
	}
	if _, err := b.open(ctx, launch{repo: t.TempDir(), base: "HEAD"}); err == nil {
		t.Fatal("invalid repo accepted")
	}
	handler := b.handler()
	request := func(method, path, origin, body string) *httptest.ResponseRecorder {
		t.Helper()
		r, err := http.NewRequest(method, "wails://wails"+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		if origin != "" {
			r.Header.Set("Origin", origin)
		}
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	u, _ := url.Parse(firstRoute)
	prefix := strings.TrimSuffix(u.Path, "/")
	w := request("GET", prefix+"/api/diff?base=HEAD", "", "")
	if w.Code != 200 || !strings.Contains(w.Body.String(), "hello.txt") {
		t.Fatalf("diff: %d %s", w.Code, w.Body.String())
	}
	var diff struct{ Range string }
	if err := json.Unmarshal(w.Body.Bytes(), &diff); err != nil {
		t.Fatal(err)
	}
	comment, _ := json.Marshal(map[string]any{"id": "desktop-test", "path": "hello.txt", "start": 1, "end": 1, "side": "additions", "range": diff.Range, "body": "persistent native comment"})
	w = request("POST", prefix+"/api/comments?base=HEAD", "wails://wails", string(comment))
	if w.Code != 200 {
		t.Fatalf("comment: %d %s", w.Code, w.Body.String())
	}
	for _, origin := range []string{"null", "wails://wails", ""} {
		if w := request("POST", "/api/heartbeat", origin, "{}"); w.Code != 200 {
			t.Fatalf("native origin %q: %d", origin, w.Code)
		}
	}
	if w := request("POST", "/api/heartbeat", "https://evil.example", "{}"); w.Code != 403 {
		t.Fatal("external origin passed the bridge")
	}
	// The public listener still rejects Wails' custom origin.
	req, _ := http.NewRequest("POST", fmt.Sprintf("http://127.0.0.1:%d/api/heartbeat", b.port), strings.NewReader("{}"))
	req.Header.Set("Origin", "wails://wails")
	client := &http.Client{Transport: &http.Transport{Proxy: nil}}
	res, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, res.Body)
	res.Body.Close()
	if res.StatusCode != 403 {
		t.Fatal("public Origin check changed")
	}
	w = request("GET", "/api/health", "", "")
	var health struct {
		PID   int
		Repos []any
	}
	if err := json.Unmarshal(w.Body.Bytes(), &health); err != nil {
		t.Fatal(err)
	}
	if health.PID != os.Getpid() || len(health.Repos) != 2 {
		t.Fatalf("backend is not in process: %+v", health)
	}
	b.close()
	if res, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/api/health", b.port)); err == nil {
		res.Body.Close()
		t.Fatal("server left running after close")
	}
	data, err := os.ReadFile(filepath.Join(first, ".git", "ghl", "state.json"))
	if err != nil || !strings.Contains(string(data), "persistent native comment") {
		t.Fatalf("state: %s (%v)", data, err)
	}
}
