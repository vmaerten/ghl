package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

const help = `ghl-desktop — usable Wails prototype (macOS)

Usage: ghl-desktop [target] [--repo <path>] [--base <ref>]

Defaults to the current checkout. Returns to the terminal after opening.
Launching it again reuses the same window.
Relative paths are resolved from the calling terminal, including later launches.
Cmd+O opens another repository; Cmd+R reloads; Cmd+Q quits and stops the server.
Uses the same .git/ghl/state.json as the browser CLI.
This prototype is separate from the installed ghl command. No Caddy is needed.
`

type launch struct {
	repo, base, target string
}

func (request launch) arguments() []string {
	args := []string{"--repo", request.repo}
	if request.base != "" {
		args = append(args, "--base", request.base)
	}
	if request.target != "" {
		args = append(args, request.target)
	}
	return args
}

// Instance notifications are untrusted input; accept only this small CLI surface.
func parseLaunch(args []string, cwd string) (launch, error) {
	result := launch{repo: cwd}
	if !filepath.IsAbs(cwd) {
		return result, fmt.Errorf("the calling directory must be absolute")
	}
	positional := false
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if !positional && (arg == "--help" || arg == "-h") {
			return result, flag.ErrHelp
		}
		if !positional && arg == "--" {
			positional = true
			continue
		}
		if !positional && strings.HasPrefix(arg, "-") {
			name, value, inline := strings.Cut(arg, "=")
			if name != "--repo" && name != "--base" {
				return result, fmt.Errorf("unknown option %q; use --help", arg)
			}
			if !inline {
				i++
				if i == len(args) {
					return result, fmt.Errorf("%s needs a value", name)
				}
				value = args[i]
			}
			if value == "" || strings.HasPrefix(value, "-") || strings.ContainsRune(value, 0) {
				return result, fmt.Errorf("invalid value for %s", name)
			}
			if name == "--repo" {
				result.repo = value
			} else {
				result.base = value
			}
			continue
		}
		if arg == "" || strings.HasPrefix(arg, "-") || strings.ContainsRune(arg, 0) || result.target != "" {
			return result, fmt.Errorf("unexpected target %q", arg)
		}
		result.target = arg
	}
	if !filepath.IsAbs(result.repo) {
		result.repo = filepath.Join(cwd, result.repo)
	}
	result.repo = filepath.Clean(result.repo)
	return result, nil
}

type desktopApp struct {
	ctx      context.Context
	mu       sync.RWMutex
	backend  *reviewBackend
	requests chan launch
	ready    sync.Once
}

func (d *desktopApp) startup(ctx context.Context) {
	d.mu.Lock()
	d.ctx = ctx
	d.mu.Unlock()
}

func (d *desktopApp) runtimeContext() context.Context {
	d.mu.RLock()
	defer d.mu.RUnlock()
	return d.ctx
}

func (d *desktopApp) secondLaunch(data options.SecondInstanceData) {
	// Wails v2 sends os.Args[1:] and the executable directory, not terminal cwd.
	// main canonicalizes --repo before Wails constructs this notification.
	request, err := parseLaunch(data.Args, data.WorkingDirectory)
	if err != nil {
		d.showError(err)
		return
	}
	select {
	case d.requests <- request:
	default:
		d.showError(fmt.Errorf("too many pending openings; retry"))
	}
}

func (d *desktopApp) process(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case request := <-d.requests:
			work, cancel := context.WithTimeout(ctx, 30*time.Second)
			route, err := d.backend.open(work, request)
			cancel()
			if err != nil {
				d.showError(err)
				continue
			}
			encoded, _ := json.Marshal(route)
			runtime.WindowSetTitle(ctx, "ghl — "+filepath.Base(request.repo)+" (prototype)")
			// A trailing slash keeps Wails' runtime injection on every review page.
			// Repeating the same selection only focuses the window, preserving drafts.
			runtime.WindowExecJS(ctx, "if (location.pathname + location.search !== "+string(encoded)+") location.replace("+string(encoded)+")")
			runtime.WindowUnminimise(ctx)
			runtime.Show(ctx)
		}
	}
}

func (d *desktopApp) chooseRepository() {
	path, err := runtime.OpenDirectoryDialog(d.runtimeContext(), runtime.OpenDialogOptions{Title: "Open a Git repository"})
	if err != nil {
		d.showError(err)
		return
	}
	if path != "" {
		select {
		case d.requests <- launch{repo: path}:
		default:
			d.showError(fmt.Errorf("too many pending openings; retry"))
		}
	}
}

func (d *desktopApp) showError(err error) {
	fmt.Println("ghl-desktop:", err)
	if ctx := d.runtimeContext(); ctx != nil {
		runtime.WindowUnminimise(ctx)
		runtime.Show(ctx)
		_, _ = runtime.MessageDialog(ctx, runtime.MessageDialogOptions{
			Type: runtime.ErrorDialog, Title: "Could not open repository", Message: err.Error(),
		})
	}
}
