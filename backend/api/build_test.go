package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type fakeCanceller struct {
	token, buildID string
	err            error
}

func (c *fakeCanceller) CancelBuild(ctx context.Context, token, buildID string) error {
	c.token, c.buildID = token, buildID
	return c.err
}

func cancelBuild(t *testing.T, canceller *fakeCanceller, authorization string) *httptest.ResponseRecorder {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/v1/builds/{id}/cancel", NewBuildApi(canceller, AuthConfig{}).CancelBuild)
	request := httptest.NewRequest(http.MethodPost, "/api/v1/builds/build-1/cancel", nil)
	if authorization != "" {
		request.Header.Set("Authorization", authorization)
	}
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, request)
	return response
}

func TestCancelBuildRequiresSignIn(t *testing.T) {
	canceller := &fakeCanceller{}
	for _, authorization := range []string{"", "Bearer ", "Basic dXNlcjpwdw=="} {
		if response := cancelBuild(t, canceller, authorization); response.Code != http.StatusUnauthorized {
			t.Fatalf("%q: status = %d, want 401", authorization, response.Code)
		}
	}
	if canceller.buildID != "" {
		t.Fatal("the scheduler was called without a token")
	}
}

func TestCancelBuildForwardsTheUsersToken(t *testing.T) {
	canceller := &fakeCanceller{}
	response := cancelBuild(t, canceller, "Bearer user-token")
	if response.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204: %s", response.Code, response.Body.String())
	}
	if canceller.token != "user-token" || canceller.buildID != "build-1" {
		t.Fatalf("cancelled %q with %q", canceller.buildID, canceller.token)
	}
}

func TestCancelBuildReportsTheDecisionOfTheScheduler(t *testing.T) {
	for code, want := range map[codes.Code]int{
		codes.Unauthenticated:  http.StatusUnauthorized,
		codes.PermissionDenied: http.StatusForbidden,
		codes.NotFound:         http.StatusNotFound,
		codes.Unavailable:      http.StatusBadGateway,
	} {
		response := cancelBuild(t, &fakeCanceller{err: status.Error(code, "denied")}, "Bearer user-token")
		var body map[string]string
		if response.Code != want || json.Unmarshal(response.Body.Bytes(), &body) != nil || body["error"] == "" {
			t.Fatalf("%v: status = %d, body = %s, want %d with an error", code, response.Code, response.Body.String(), want)
		}
	}
}

func TestGetAuth(t *testing.T) {
	response := httptest.NewRecorder()
	NewBuildApi(nil, AuthConfig{Issuer: "https://idp/realms/jolt", ClientID: "jolt"}).GetAuth(response, httptest.NewRequest(http.MethodGet, "/api/v1/auth", nil))
	if response.Body.String() != `{"issuer":"https://idp/realms/jolt","clientId":"jolt"}`+"\n" {
		t.Fatalf("auth config = %s", response.Body.String())
	}
}
