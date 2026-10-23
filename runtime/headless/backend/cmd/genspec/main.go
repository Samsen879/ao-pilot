// Command genspec regenerates the embedded HTTP contract from its Go types.
package main

import (
	"flag"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apispec/specgen"
	"log"
	"os"
)

func main() {
	output := flag.String("out", "openapi.yaml", "output path")
	flag.Parse()
	body, err := specgen.Build()
	if err != nil {
		log.Fatal(err)
	}
	if err := os.WriteFile(*output, body, 0644); err != nil {
		log.Fatal(err)
	}
}
