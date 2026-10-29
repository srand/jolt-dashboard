package scheduler

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"os"
	"strings"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
)

// Options of the connection to the scheduler.
type Options struct {
	// Token that authenticates the dashboard. It needs the read permission.
	Token string
	// PEM file with the certificates of the authorities that the certificate
	// of the scheduler is verified with, in addition to those of the system.
	CACert string
	// Send the token without TLS.
	AllowInsecureToken bool
}

// OptionsFromEnvironment returns the options in JOLT_SCHEDULER_TOKEN,
// JOLT_CA_CERT and JOLT_ALLOW_INSECURE_TOKEN, the variables that Jolt uses.
func OptionsFromEnvironment() Options {
	allow := strings.ToLower(os.Getenv("JOLT_ALLOW_INSECURE_TOKEN"))
	return Options{
		Token:              os.Getenv("JOLT_SCHEDULER_TOKEN"),
		CACert:             os.Getenv("JOLT_CA_CERT"),
		AllowInsecureToken: allow == "1" || allow == "true" || allow == "yes" || allow == "on",
	}
}

type tokenCredentials struct {
	token  string
	secure bool
}

func (t tokenCredentials) GetRequestMetadata(ctx context.Context, uri ...string) (map[string]string, error) {
	return map[string]string{"authorization": "Bearer " + t.token}, nil
}

func (t tokenCredentials) RequireTransportSecurity() bool {
	return t.secure
}

// dialOptions returns the credentials of a connection to the scheduler.
// tls:// URIs use TLS, and the token is only sent over TLS unless that is
// explicitly allowed.
func dialOptions(uri string, options Options) ([]grpc.DialOption, error) {
	secure := strings.HasPrefix(uri, "tls://")
	opts := []grpc.DialOption{}

	if secure {
		pool, err := x509.SystemCertPool()
		if err != nil {
			pool = x509.NewCertPool()
		}
		if options.CACert != "" {
			data, err := os.ReadFile(options.CACert)
			if err != nil {
				return nil, err
			}
			if !pool.AppendCertsFromPEM(data) {
				return nil, fmt.Errorf("no certificates in %s", options.CACert)
			}
		}
		config := &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}
		opts = append(opts, grpc.WithTransportCredentials(credentials.NewTLS(config)))
	} else {
		opts = append(opts, grpc.WithTransportCredentials(insecure.NewCredentials()))
	}

	if options.Token != "" {
		if !secure && !options.AllowInsecureToken {
			return nil, fmt.Errorf("refusing to send the scheduler token without TLS to %s, use a tls:// URI", uri)
		}
		opts = append(opts, grpc.WithPerRPCCredentials(tokenCredentials{token: options.Token, secure: secure}))
	}

	return opts, nil
}
