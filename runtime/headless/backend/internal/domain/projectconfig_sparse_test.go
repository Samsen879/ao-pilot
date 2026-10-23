package domain

import "testing"

func TestSparseCheckoutValidation(t *testing.T) {
	for _, name := range []string{"", " ", "\t", "../escape", "/absolute"} {
		if err := (ProjectConfig{SparseCheckout: []string{name}}).Validate(); err == nil {
			t.Errorf("invalid sparse directory accepted: %q", name)
		}
	}
	cfg := ProjectConfig{SparseCheckout: []string{"src/keep", "--stdin"}}
	if err := cfg.ValidateForKind(ProjectKindSingleRepo); err != nil {
		t.Fatal(err)
	}
	for _, kind := range []ProjectKind{ProjectKindWorkspace, ProjectKindScratch} {
		if err := cfg.ValidateForKind(kind); err == nil {
			t.Errorf("sparse setting silently accepted for %s", kind)
		}
	}
}
