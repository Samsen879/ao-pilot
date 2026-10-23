package specgen

import (
	"bytes"
	"os"
	"testing"
)

func TestBuildMatchesEmbeddedContract(t *testing.T) {
	got, err := Build()
	if err != nil {
		t.Fatal(err)
	}
	want, err := os.ReadFile("../openapi.yaml")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatal("embedded OpenAPI differs from Go contract; run go generate ./internal/httpd/apispec")
	}
}
