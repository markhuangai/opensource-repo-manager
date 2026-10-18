package bootstrap

import (
	"os"
	"testing"
	"github.com/google/uuid"
)

func TestDatabase(t *testing.T) {
	if os.Getuid() == 0 || DatabaseVersion() < 3000000 || len(uuid.NewString()) != 36 {
		t.Fatal("unprivileged CGO/SQLite setup unavailable")
	}
	if err := os.WriteFile(".tests-ran-go", []byte("passed"), 0600); err != nil {
		t.Fatal(err)
	}
}
