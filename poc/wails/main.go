// Usable desktop prototype. The production Go module stays dependency-free.
package main

import (
	"context"
	"crypto/sha256"
	"embed"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/menu"
	"github.com/wailsapp/wails/v2/pkg/menu/keys"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

//go:embed all:assets
var embedded embed.FS

//go:embed bridge.js
var bridge string

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "ghl-desktop:", err)
		os.Exit(1)
	}
}

func run() error {
	cwd, err := os.Getwd()
	if err != nil {
		return err
	}
	args := os.Args[1:]
	windowMode := len(args) > 0 && args[0] == "--desktop-window"
	if windowMode {
		args = args[1:]
	}
	initial, err := parseLaunch(args, cwd)
	if errors.Is(err, flag.ErrHelp) {
		fmt.Print(help)
		return nil
	}
	if err != nil {
		return err
	}
	// Wails changes cwd to the executable directory before sending a second
	// instance notification. Preserve the terminal's cwd in canonical arguments.
	os.Args = append([]string{os.Args[0]}, initial.arguments()...)
	if !windowMode {
		executable, err := os.Executable()
		if err != nil {
			return err
		}
		executable, err = filepath.EvalSymlinks(executable)
		if err != nil {
			return err
		}
		bundle := filepath.Dir(filepath.Dir(filepath.Dir(executable)))
		if filepath.Ext(bundle) != ".app" {
			return fmt.Errorf("run the prototype from its .app bundle (task wails:run)")
		}
		// LaunchServices gives the window a Dock identity and lets the terminal
		// return. -n delivers later requests through Wails' single-instance callback.
		openArgs := []string{"-n", "-a", bundle}
		if probe := os.Getenv("GHL_DESKTOP_PROBE"); probe != "" {
			openArgs = append(openArgs, "--env", "GHL_DESKTOP_PROBE="+probe)
		}
		openArgs = append(openArgs, "--args", "--desktop-window")
		return exec.Command("/usr/bin/open", append(openArgs, os.Args[1:]...)...).Run()
	}
	assets, err := fs.Sub(embedded, "assets")
	if err != nil {
		return err
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	backend, err := startBackend(ctx, assets)
	if err != nil {
		return err
	}
	defer backend.close()
	// Local acceptance tests may supply a probe; no test script runs by default.
	var probe []byte
	instanceID := "cf7c8359-dbb0-4c1c-a09f-301b26d2a917"
	if path := os.Getenv("GHL_DESKTOP_PROBE"); path != "" {
		probe, err = os.ReadFile(path)
		if err != nil {
			return err
		}
		// Fixture windows must never join the user's running prototype.
		instanceID = fmt.Sprintf("ghl-test-%x", sha256.Sum256([]byte(path)))
	}
	desktop := &desktopApp{backend: backend, requests: make(chan launch, 16)}
	desktop.requests <- initial
	appMenu := menu.NewMenuFromItems(menu.AppMenu(), menu.EditMenu())
	fileMenu := appMenu.AddSubmenu("File")
	fileMenu.AddText("Open repository…", keys.CmdOrCtrl("o"), func(*menu.CallbackData) { desktop.chooseRepository() })
	fileMenu.AddText("Refresh", keys.CmdOrCtrl("r"), func(*menu.CallbackData) { runtime.WindowReload(desktop.runtimeContext()) })
	fileMenu.AddText("Close tab", keys.CmdOrCtrl("w"), func(*menu.CallbackData) { desktop.CloseTab(desktop.Tabs().Active) })
	return wails.Run(&options.App{
		Title: "ghl — desktop prototype", Width: 1280, Height: 800, MinWidth: 800, MinHeight: 500,
		Menu: appMenu, EnableDefaultContextMenu: true,
		BackgroundColour: options.NewRGBA(34, 39, 46, 255),
		AssetServer:      &assetserver.Options{Handler: backend.handler()},
		Bind:             []interface{}{desktop},
		OnStartup: func(windowCtx context.Context) {
			desktop.startup(windowCtx)
			go func() {
				select {
				case <-ctx.Done():
					runtime.Quit(windowCtx)
				case <-windowCtx.Done():
				}
			}()
		},
		OnDomReady: func(ctx context.Context) {
			runtime.WindowExecJS(ctx, bridge)
			if len(probe) > 0 {
				runtime.WindowExecJS(ctx, string(probe))
			}
			desktop.ready.Do(func() { go desktop.process(ctx) })
		},
		OnShutdown: func(context.Context) { backend.close() },
		SingleInstanceLock: &options.SingleInstanceLock{
			UniqueId:               instanceID,
			OnSecondInstanceLaunch: desktop.secondLaunch,
		},
	})
}
