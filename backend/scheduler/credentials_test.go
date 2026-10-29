package scheduler

import (
	"context"
	"testing"
)

func TestDialOptions(t *testing.T) {
	opts, err := dialOptions("tcp://scheduler:9090", Options{})
	if err != nil || len(opts) != 1 {
		t.Fatalf("plain connection: %d options, %v", len(opts), err)
	}

	if _, err := dialOptions("tcp://scheduler:9090", Options{Token: "token"}); err == nil {
		t.Fatal("token sent without TLS")
	}

	opts, err = dialOptions("tcp://scheduler:9090", Options{Token: "token", AllowInsecureToken: true})
	if err != nil || len(opts) != 2 {
		t.Fatalf("allowed insecure token: %d options, %v", len(opts), err)
	}

	opts, err = dialOptions("tls://scheduler:9090", Options{Token: "token"})
	if err != nil || len(opts) != 2 {
		t.Fatalf("TLS with token: %d options, %v", len(opts), err)
	}

	if _, err := dialOptions("tls://scheduler:9090", Options{CACert: "/nonexistent.pem"}); err == nil {
		t.Fatal("missing CA file accepted")
	}

	md, err := tokenCredentials{token: "token"}.GetRequestMetadata(context.Background())
	if err != nil || md["authorization"] != "Bearer token" {
		t.Fatalf("metadata %v, %v", md, err)
	}
}

func TestOptionsFromEnvironment(t *testing.T) {
	t.Setenv("JOLT_SCHEDULER_TOKEN", "token")
	t.Setenv("JOLT_CA_CERT", "/etc/jolt/ca.pem")
	t.Setenv("JOLT_ALLOW_INSECURE_TOKEN", "True")

	options := OptionsFromEnvironment()
	if options.Token != "token" || options.CACert != "/etc/jolt/ca.pem" || !options.AllowInsecureToken {
		t.Fatalf("options %+v", options)
	}
}

func TestParseTlsUri(t *testing.T) {
	target, err := parseUri("tls://scheduler")
	if err != nil || target != "scheduler:9090" {
		t.Fatalf("target %q, %v", target, err)
	}
}
