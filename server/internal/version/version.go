// Package version carries the server's build identity.
//
// There is one variable and it is set at link time, because the alternative,
// a constant edited by hand, is a constant that is wrong. The release image
// passes the git tag through:
//
//	go build -ldflags="-X github.com/athenaeum-app/athena/server/internal/version.Version=v2.3.0"
//
// An unset build (a developer's `go build ./...`, or `go test`) reports "dev",
// which is the honest answer and is also what the client renders.
package version

// Version is the server's release identity. Overridden at link time; see above.
var Version = "dev"
