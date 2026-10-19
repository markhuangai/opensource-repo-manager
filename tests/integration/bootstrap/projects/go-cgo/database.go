package bootstrap

// #cgo pkg-config: sqlite3
// #include <sqlite3.h>
import "C"

func DatabaseVersion() int { return int(C.sqlite3_libversion_number()) }
