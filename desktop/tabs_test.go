package main

import (
	"sync"
	"testing"
)

func TestTabsComparisonIdentityAndClosing(t *testing.T) {
	var tabs reviewTabs
	first := tabs.open("/r/repo-1234567/?base=main")
	id := first.Active
	changed, err := tabs.update(id, "/r/repo-1234567/?base=main&committed=1&commit=abcd")
	if err != nil {
		t.Fatal(err)
	}
	duplicate := tabs.open("/r/repo-1234567/?base=main")
	if len(duplicate.Tabs) != 1 || duplicate.Active != id || duplicate.Tabs[0].Route != changed.Tabs[0].Route {
		t.Fatalf("duplicate reset the existing review: %+v", duplicate)
	}
	other := tabs.open("/r/repo-1234567/?base=other")
	if len(other.Tabs) != 2 || other.Active == id {
		t.Fatal(other)
	}
	last := tabs.open("/r/another-7654321/")
	middle := tabs.close(other.Active)
	if middle.Active != last.Active || len(middle.Tabs) != 2 {
		t.Fatal(middle)
	}
	closed := tabs.close(last.Active)
	if closed.Active != id || len(closed.Tabs) != 1 {
		t.Fatal(closed)
	}
	empty := tabs.close(id)
	if empty.Active != "" || len(empty.Tabs) != 0 {
		t.Fatal(empty)
	}
	reopened := tabs.open("/r/repo-1234567/?base=main")
	if reopened.Active == id {
		t.Fatal("closed IDs must not be reused by delayed events")
	}
	// Mutating a caller's snapshot must not corrupt the registry.
	reopened.Tabs[0].Route = "corrupted"
	if tabs.snapshot().Tabs[0].Route == "corrupted" {
		t.Fatal("snapshot aliases state")
	}
}

func TestTabsRejectCrossRepositoryAndStaleUpdates(t *testing.T) {
	var tabs reviewTabs
	first := tabs.open("/r/first-1234567/?base=main")
	second := tabs.open("/r/second-1234567/?base=main")
	state, err := tabs.update(first.Active, "/r/first-1234567/?target=late")
	if err != nil || state.Revision != second.Revision {
		t.Fatalf("stale update changed tabs: %+v %v", state, err)
	}
	for _, route := range []string{"https://evil.example/r/second-1234567/", "//evil.example/r/second-1234567/", "/r/first-1234567/", "/r/second-1234567/#script"} {
		if _, err := tabs.update(second.Active, route); err == nil {
			t.Fatalf("accepted %q", route)
		}
	}
}

func TestConcurrentTabOpenDoesNotDuplicate(t *testing.T) {
	var tabs reviewTabs
	var group sync.WaitGroup
	for i := 0; i < 50; i++ {
		group.Add(1)
		go func() { defer group.Done(); tabs.open("/r/shared-1234567/?base=main") }()
	}
	group.Wait()
	if len(tabs.snapshot().Tabs) != 1 {
		t.Fatal("concurrent launch duplicated tabs")
	}
}

func TestVolatileViewCapturesAreIsolatedAndNotResurrected(t *testing.T) {
	var tabs reviewTabs
	state := tabs.open("/r/first-1234567/")
	id := state.Active
	view := `{"version":1,"drafts":[["line","unsaved text"]],"scrollTop":350}`
	if err := tabs.saveView(id, view); err != nil {
		t.Fatal(err)
	}
	tabs.open("/r/second-1234567/")
	state = tabs.activate(id)
	if string(state.Tabs[0].View) != view {
		t.Fatal("draft was lost")
	}
	state.Tabs[0].View[0] = 'x'
	if string(tabs.snapshot().Tabs[0].View) != view {
		t.Fatal("capture aliases live view")
	}
	for _, invalid := range []string{"{}", `{"version":2}`, `"string"`, "{"} {
		if tabs.saveView(id, invalid) == nil {
			t.Fatal("accepted invalid view")
		}
	}
	tabs.close(id)
	if err := tabs.saveView(id, view); err != nil || len(tabs.snapshot().Tabs) != 1 {
		t.Fatal("closed tab resurrected")
	}
}
