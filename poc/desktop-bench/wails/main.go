// Throwaway envelope; production's standard-library Go module stays separate.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

func main() {
	var target string
	for _, arg := range os.Args[1:] {
		if strings.HasPrefix(arg, "http://127.0.0.1:") {
			target = arg
		}
	}
	if target == "" {
		panic("Missing local benchmark URL")
	}
	encoded, _ := json.Marshal(target)
	err := wails.Run(&options.App{
		Title: "ghl desktop benchmark — Wails", Width: 1280, Height: 720,
		// Wails's disabled-context-menu script assumes its own runtime is in
		// every document. The external Go page deliberately has no Wails bridge.
		EnableDefaultContextMenu: true,
		AssetServer: &assetserver.Options{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			fmt.Fprint(w, "<!doctype html><html><body></body></html>")
		})},
		OnDomReady: func(ctx context.Context) {
			runtime.WindowExecJS(ctx, "if (!location.href.startsWith('http://')) location.replace("+string(encoded)+")")
		},
	})
	if err != nil {
		panic(err)
	}
}
