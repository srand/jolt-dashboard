package api

import (
	"context"
	"net/http"
	"strings"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// Cancels a build with the token of a user.
type BuildCanceller interface {
	CancelBuild(ctx context.Context, token, buildID string) error
}

// The OpenID Connect provider that users sign in with, to cancel builds.
type AuthConfig struct {
	Issuer   string `json:"issuer"`
	ClientID string `json:"clientId"`
}

type BuildApi struct {
	canceller BuildCanceller
	auth      AuthConfig
}

func NewBuildApi(canceller BuildCanceller, auth AuthConfig) *BuildApi {
	return &BuildApi{canceller: canceller, auth: auth}
}

func writeError(w http.ResponseWriter, code int, message string) {
	writeJSON(w, code, map[string]string{"error": message})
}

// GetAuth returns the provider that the frontend signs users in with. The
// issuer is empty if signing in isn't configured.
func (api *BuildApi) GetAuth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, api.auth)
}

// CancelBuild cancels a build on behalf of the user whose token is in the
// Authorization header. The scheduler decides if the user may.
func (api *BuildApi) CancelBuild(w http.ResponseWriter, r *http.Request) {
	scheme, token, _ := strings.Cut(r.Header.Get("Authorization"), " ")
	if !strings.EqualFold(scheme, "bearer") || strings.TrimSpace(token) == "" {
		w.Header().Set("WWW-Authenticate", `Bearer realm="jolt"`)
		writeError(w, http.StatusUnauthorized, "sign in to cancel builds")
		return
	}

	err := api.canceller.CancelBuild(r.Context(), strings.TrimSpace(token), r.PathValue("id"))
	if err == nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	switch status.Code(err) {
	case codes.Unauthenticated:
		writeError(w, http.StatusUnauthorized, "the scheduler did not accept the sign-in")
	case codes.PermissionDenied:
		writeError(w, http.StatusForbidden, "only the owners of a build and administrators may cancel it")
	case codes.NotFound:
		writeError(w, http.StatusNotFound, "the build is no longer known to the scheduler")
	default:
		writeError(w, http.StatusBadGateway, err.Error())
	}
}
