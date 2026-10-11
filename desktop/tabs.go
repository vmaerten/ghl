package main

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"sync"
)

type reviewTab struct {
	ID    string          `json:"id"`
	Name  string          `json:"name"`
	Route string          `json:"route"`
	View  json.RawMessage `json:"view,omitempty"`
}
type tabSnapshot struct {
	Revision uint64      `json:"revision"`
	Active   string      `json:"active"`
	Tabs     []reviewTab `json:"tabs"`
}
type reviewTabs struct {
	mu    sync.Mutex
	state tabSnapshot
	next  uint64
}

func comparisonKey(route string) string {
	u, _ := url.Parse(route)
	q := url.Values{}
	for _, key := range []string{"base", "target"} {
		if value := u.Query().Get(key); value != "" {
			q.Set(key, value)
		}
	}
	return strings.TrimSuffix(u.Path, "/") + "?" + q.Encode()
}
func (t *reviewTabs) snapshotLocked() tabSnapshot {
	result := t.state
	result.Tabs = append([]reviewTab{}, t.state.Tabs...)
	for i := range result.Tabs {
		result.Tabs[i].View = append(json.RawMessage(nil), result.Tabs[i].View...)
	}
	return result
}
func (t *reviewTabs) snapshot() tabSnapshot {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.snapshotLocked()
}
func (t *reviewTabs) open(route string) tabSnapshot {
	t.mu.Lock()
	defer t.mu.Unlock()
	key := comparisonKey(route)
	// Prefer the active match when selectors have made two tabs equivalent.
	for _, tab := range t.state.Tabs {
		if tab.ID == t.state.Active && comparisonKey(tab.Route) == key {
			return t.snapshotLocked()
		}
	}
	for _, tab := range t.state.Tabs {
		if comparisonKey(tab.Route) == key {
			t.state.Active = tab.ID
			t.state.Revision++
			return t.snapshotLocked()
		}
	}
	t.next++
	id := fmt.Sprint(t.next)
	u, _ := url.Parse(route)
	name := strings.TrimPrefix(strings.TrimSuffix(u.Path, "/"), "/r/")
	// IDs supplied by the runtime end with '-' plus seven SHA-1 characters.
	if len(name) > 8 {
		name = name[:len(name)-8]
	}
	t.state.Tabs = append(t.state.Tabs, reviewTab{ID: id, Name: name, Route: route})
	t.state.Active = id
	t.state.Revision++
	return t.snapshotLocked()
}
func (t *reviewTabs) activate(id string) tabSnapshot {
	t.mu.Lock()
	defer t.mu.Unlock()
	for _, tab := range t.state.Tabs {
		if tab.ID == id && t.state.Active != id {
			t.state.Active = id
			t.state.Revision++
			break
		}
	}
	return t.snapshotLocked()
}
func (t *reviewTabs) close(id string) tabSnapshot {
	t.mu.Lock()
	defer t.mu.Unlock()
	for i, tab := range t.state.Tabs {
		if tab.ID != id {
			continue
		}
		t.state.Tabs = append(t.state.Tabs[:i], t.state.Tabs[i+1:]...)
		if t.state.Active == id {
			t.state.Active = ""
			if len(t.state.Tabs) > 0 {
				if i >= len(t.state.Tabs) {
					i = len(t.state.Tabs) - 1
				}
				t.state.Active = t.state.Tabs[i].ID
			}
		}
		t.state.Revision++
		break
	}
	return t.snapshotLocked()
}
func (t *reviewTabs) update(id, route string) (tabSnapshot, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	// A delayed event from an unmounted review cannot overwrite the new tab.
	if id != t.state.Active {
		return t.snapshotLocked(), nil
	}
	u, err := url.Parse(route)
	if err != nil || u.Scheme != "" || u.Host != "" || u.Fragment != "" {
		return t.snapshotLocked(), fmt.Errorf("invalid tab route")
	}
	for i, tab := range t.state.Tabs {
		if tab.ID != id {
			continue
		}
		old, _ := url.Parse(tab.Route)
		if old.Path != u.Path {
			return t.snapshotLocked(), fmt.Errorf("cannot change a tab's repository")
		}
		if tab.Route != route {
			t.state.Tabs[i].Route = route
			t.state.Revision++
		}
	}
	return t.snapshotLocked(), nil
}

func (d *desktopApp) Tabs() tabSnapshot                 { return d.tabs.snapshot() }
func (d *desktopApp) ActivateTab(id string) tabSnapshot { return d.publish(d.tabs.activate(id)) }
func (d *desktopApp) CloseTab(id string) tabSnapshot    { return d.publish(d.tabs.close(id)) }
func (d *desktopApp) UpdateTabURL(id, route string) (tabSnapshot, error) {
	state, err := d.tabs.update(id, route)
	if err != nil {
		return state, err
	}
	return d.publish(state), nil
}
func (d *desktopApp) OpenRepository() { d.chooseRepository() }

func (t *reviewTabs) saveView(id, raw string) error {
	if len(raw) > 2*1024*1024 || !json.Valid([]byte(raw)) {
		return fmt.Errorf("invalid or oversized tab view")
	}
	var header struct {
		Version int `json:"version"`
	}
	if err := json.Unmarshal([]byte(raw), &header); err != nil || header.Version != 1 {
		return fmt.Errorf("unsupported tab view")
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	for i := range t.state.Tabs {
		if t.state.Tabs[i].ID == id {
			t.state.Tabs[i].View = append(json.RawMessage(nil), raw...)
			return nil
		}
	}
	return nil // A closed tab is never resurrected by a delayed capture.
}
func (d *desktopApp) SaveTabView(id, raw string) error { return d.tabs.saveView(id, raw) }
