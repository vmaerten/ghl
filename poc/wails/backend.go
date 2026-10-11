package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/vmaerten/ghl/internal/app"
)

type reviewBackend struct {
	port   int
	cancel context.CancelFunc
	done   chan int
	once   sync.Once
}

// Reuse the existing runtime in this process; no external binary or daemon.
func startBackend(ctx context.Context, assets fs.FS) (*reviewBackend, error) {
	ctx, cancel := context.WithCancel(ctx)
	read, write := io.Pipe()
	backend := &reviewBackend{cancel: cancel, done: make(chan int, 1)}
	var stderr bytes.Buffer
	go func() {
		code := app.Main(ctx, []string{"--daemon", "--port", "0", "--idle", "0"}, write, &stderr, app.Options{Assets: assets})
		write.Close()
		backend.done <- code
	}()
	ready := make(chan error, 1)
	go func() {
		defer read.Close()
		var announcement struct{ Port int }
		err := json.NewDecoder(read).Decode(&announcement)
		if err == nil && (announcement.Port <= 0 || announcement.Port > 65535) {
			err = fmt.Errorf("invalid server port")
		}
		backend.port = announcement.Port
		ready <- err
	}()
	select {
	case err := <-ready:
		if err == nil {
			return backend, nil
		}
		backend.close()
		return nil, fmt.Errorf("server startup failed: %s (%w)", strings.TrimSpace(stderr.String()), err)
	case <-time.After(10 * time.Second):
		read.Close()
		backend.close()
		return nil, fmt.Errorf("server startup timed out")
	}
}

func (b *reviewBackend) close() {
	b.once.Do(func() {
		b.cancel()
		select {
		case <-b.done:
		case <-time.After(6 * time.Second):
		}
	})
}

func (b *reviewBackend) open(ctx context.Context, request launch) (string, error) {
	client := &http.Client{Transport: &http.Transport{Proxy: nil},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	defer client.CloseIdleConnections()
	payload, _ := json.Marshal(map[string]string{"repoPath": request.repo})
	req, err := http.NewRequestWithContext(ctx, "POST", fmt.Sprintf("http://127.0.0.1:%d/api/repos", b.port), bytes.NewReader(payload))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	response, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		return "", fmt.Errorf("%s", strings.TrimSpace(string(body)))
	}
	var registered struct{ ID string }
	if err := json.NewDecoder(response.Body).Decode(&registered); err != nil {
		return "", err
	}
	if registered.ID == "" {
		return "", fmt.Errorf("missing repository identity")
	}
	query := url.Values{}
	if request.base != "" {
		query.Set("base", request.base)
	}
	if request.target != "" {
		query.Set("target", request.target)
	}
	prefix := "/r/" + url.PathEscape(registered.ID)
	selection := optionalQuery(query.Encode())
	// Validate with the runtime's existing comparison rules before replacing the
	// current review. No daemon/client launcher and no executable-hash race on rebuild.
	req, err = http.NewRequestWithContext(ctx, "GET", fmt.Sprintf("http://127.0.0.1:%d%s/api/diff%s", b.port, prefix, selection), nil)
	if err != nil {
		return "", err
	}
	response, err = client.Do(req)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		return "", fmt.Errorf("%s", strings.TrimSpace(string(body)))
	}
	if _, err := io.Copy(io.Discard, response.Body); err != nil {
		return "", err
	}
	return prefix + "/" + selection, nil
}

func optionalQuery(query string) string {
	if query == "" {
		return ""
	}
	return "?" + query
}

func (b *reviewBackend) handler() http.Handler {
	target, _ := url.Parse("http://127.0.0.1:" + strconv.Itoa(b.port))
	proxy := &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(target)
			// The handler is available only through Wails' private asset protocol.
			// Translate its verified origin; public runtime Host/Origin checks stay intact.
			if r.In.Header.Get("Origin") != "" {
				r.Out.Header.Set("Origin", target.String())
			}
		},
		Transport: &http.Transport{Proxy: nil},
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if len(r.Header.Values("Origin")) > 1 || (origin != "" && origin != "null" && origin != "wails://wails") {
			http.Error(w, "unexpected desktop origin", http.StatusForbidden)
			return
		}
		if r.URL.Path == "/" {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			fmt.Fprint(w, `<!doctype html><html><head><meta charset="utf-8"><title>ghl</title></head><body style="background:#22272e;color:#adbac7;font:16px system-ui;padding:48px"><h1>ghl</h1><p>Opening your review…</p><p>Open another repository with File → Open repository (⌘O).</p></body></html>`)
			return
		}
		proxy.ServeHTTP(w, r)
	})
}
