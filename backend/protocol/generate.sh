#!/bin/sh
# Regenerates the vendored Jolt scheduler protocol stubs in this directory.
#
# The dashboard only consumes the Administration service; common.proto and
# scheduler.proto are pulled in because administration.proto depends on them.
#
# Requires a checkout of https://github.com/srand/jolt and:
#   go install google.golang.org/protobuf/cmd/protoc-gen-go@v1.34.1
#   go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@v1.3.0
#
# Usage: ./generate.sh /path/to/jolt

set -e

JOLT="${1:-../../jolt}"
OUT="$(cd "$(dirname "$0")/.." && pwd)"

# The protos declare go_package = "pkg/protocol", which belongs to the jolt
# module. Remap them onto this module so the generated code compiles here.
MAP="github.com/srand/jolt-dashboard/protocol"

protoc -I"$JOLT" \
    --go_out="$OUT" \
    --go_opt=module=github.com/srand/jolt-dashboard \
    --go_opt=Mjolt/common.proto=$MAP \
    --go_opt=Mjolt/plugins/remote_execution/scheduler.proto=$MAP \
    --go_opt=Mjolt/plugins/remote_execution/administration.proto=$MAP \
    --go-grpc_out="$OUT" \
    --go-grpc_opt=module=github.com/srand/jolt-dashboard \
    --go-grpc_opt=Mjolt/common.proto=$MAP \
    --go-grpc_opt=Mjolt/plugins/remote_execution/scheduler.proto=$MAP \
    --go-grpc_opt=Mjolt/plugins/remote_execution/administration.proto=$MAP \
    jolt/common.proto \
    jolt/plugins/remote_execution/scheduler.proto \
    jolt/plugins/remote_execution/administration.proto
