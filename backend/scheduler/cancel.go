package scheduler

import (
	"context"

	"github.com/srand/jolt-dashboard/protocol"
	"google.golang.org/grpc"
)

// BuildCanceller cancels builds on behalf of the users of the dashboard.
//
// The scheduler decides whether a user may cancel a build: its owners and
// administrators may. The user's token is therefore sent instead of the
// dashboard's own, which only needs to read.
type BuildCanceller struct {
	uri     string
	options Options
}

func NewBuildCanceller(uri string, options Options) *BuildCanceller {
	return &BuildCanceller{uri: uri, options: options}
}

// CancelBuild cancels a build with the token of a user. Errors are gRPC
// status errors, such as PermissionDenied if the user may not cancel it.
func (c *BuildCanceller) CancelBuild(ctx context.Context, token, buildID string) error {
	target, err := parseUri(c.uri)
	if err != nil {
		return err
	}

	options := c.options
	options.Token = token
	opts, err := dialOptions(c.uri, options)
	if err != nil {
		return err
	}

	conn, err := grpc.NewClient(target, opts...)
	if err != nil {
		return err
	}
	defer conn.Close()

	_, err = protocol.NewSchedulerClient(conn).CancelBuild(ctx, &protocol.CancelBuildRequest{BuildId: buildID})
	return err
}
