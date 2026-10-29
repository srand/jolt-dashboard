// Signs users in with the OpenID Connect provider of the scheduler, with the
// authorization code flow and PKCE. The dashboard sends the ID token to the
// scheduler when the user cancels a build, and the scheduler decides if the
// user may. The tokens are kept for the browser session only.

const STORAGE_KEY = 'jolt-dashboard.auth.v1';
const PENDING_KEY = 'jolt-dashboard.auth.pending.v1';
// Refresh tokens that expire within this many seconds.
const REFRESH_MARGIN = 60;

function storage() {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function load(key) {
  try {
    return JSON.parse(storage()?.getItem(key)) || null;
  } catch {
    return null;
  }
}

function save(key, value) {
  try {
    if (value) {
      storage()?.setItem(key, JSON.stringify(value));
    } else {
      storage()?.removeItem(key);
    }
  } catch {
    // Without storage, the user just isn't signed in after a reload.
  }
}

function base64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomString() {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

// Returns the claims of a JWT, without verifying it: the scheduler does.
export function claims(token) {
  try {
    const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(decodeURIComponent(escape(atob(payload))));
  } catch {
    return {};
  }
}

function redirectUri() {
  return window.location.origin + window.location.pathname;
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error_description || body.error || `${url}: ${response.status}`);
  }
  return body;
}

async function provider(config) {
  return fetchJson(config.issuer.replace(/\/$/, '') + '/.well-known/openid-configuration');
}

// The provider configured in the dashboard backend, or null if signing in
// isn't configured.
export async function loadConfig() {
  const config = await fetchJson('/api/v1/auth');
  return config.issuer ? config : null;
}

// The signed-in user, or null.
export function currentUser() {
  const session = load(STORAGE_KEY);
  if (!session) {
    return null;
  }
  const idClaims = claims(session.idToken);
  return { name: idClaims.preferred_username || idClaims.name || idClaims.sub || 'unknown' };
}

// Redirects the browser to the provider to sign in.
export async function signIn() {
  const config = await loadConfig();
  if (!config) {
    throw new Error('Signing in is not configured on this dashboard');
  }
  const endpoints = await provider(config);
  const verifier = randomString();
  const state = randomString();
  const challenge = base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  save(PENDING_KEY, { verifier, state, config });

  const url = new URL(endpoints.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: redirectUri(),
    scope: 'openid profile offline_access',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  }).toString();
  window.location.assign(url.toString());
}

async function requestTokens(config, form) {
  const endpoints = await provider(config);
  const tokens = await fetchJson(endpoints.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.clientId, ...form }).toString(),
  });
  if (!tokens.id_token) {
    throw new Error('The provider did not return an ID token');
  }
  const previous = load(STORAGE_KEY);
  save(STORAGE_KEY, {
    config,
    idToken: tokens.id_token,
    refreshToken: tokens.refresh_token || previous?.refreshToken || null,
  });
}

// Completes a sign-in when the provider redirects back to the dashboard.
// Returns true if the URL was a response from the provider.
export async function completeSignIn() {
  const params = new URLSearchParams(window.location.search);
  const pending = load(PENDING_KEY);
  if (!pending || !params.has('state') || params.get('state') !== pending.state) {
    return false;
  }
  save(PENDING_KEY, null);
  window.history.replaceState(null, '', redirectUri());
  if (params.has('error')) {
    throw new Error(params.get('error_description') || params.get('error'));
  }
  await requestTokens(pending.config, {
    grant_type: 'authorization_code',
    code: params.get('code'),
    redirect_uri: redirectUri(),
    code_verifier: pending.verifier,
  });
  return true;
}

// Returns a valid ID token of the signed-in user, refreshed if needed, or
// null if the user isn't signed in.
export async function idToken() {
  const session = load(STORAGE_KEY);
  if (!session) {
    return null;
  }
  const expires = claims(session.idToken).exp || 0;
  if (expires - Date.now() / 1000 > REFRESH_MARGIN) {
    return session.idToken;
  }
  if (!session.refreshToken) {
    signOut();
    return null;
  }
  try {
    await requestTokens(session.config, { grant_type: 'refresh_token', refresh_token: session.refreshToken });
  } catch {
    signOut();
    return null;
  }
  return load(STORAGE_KEY).idToken;
}

export function signOut() {
  save(STORAGE_KEY, null);
}
