import * as auth from './auth';

function token(claims) {
    // JWTs encode their JSON as UTF-8
    const encode = (value) => btoa(unescape(encodeURIComponent(JSON.stringify(value))))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return `${encode({ alg: 'RS256' })}.${encode(claims)}.signature`;
}

const config = { issuer: 'https://idp/realms/jolt', clientId: 'jolt' };
const endpoints = {
    authorization_endpoint: 'https://idp/realms/jolt/auth',
    token_endpoint: 'https://idp/realms/jolt/token',
};

function respond(body, ok = true) {
    return Promise.resolve({ ok, status: ok ? 200 : 400, json: () => Promise.resolve(body) });
}

beforeEach(() => {
    window.sessionStorage.clear();
    window.history.replaceState(null, '', '/');
});

afterEach(() => {
    delete global.fetch;
});

test('the claims of a token are read without verifying it', () => {
    expect(auth.claims(token({ preferred_username: 'älice' }))).toEqual({ preferred_username: 'älice' });
    expect(auth.claims('not a token')).toEqual({});
});

test('a response from the provider completes the sign-in', async () => {
    window.sessionStorage.setItem('jolt-dashboard.auth.pending.v1', JSON.stringify({ verifier: 'verifier', state: 'state', config }));
    window.history.replaceState(null, '', '/?code=the-code&state=state');
    const idToken = token({ preferred_username: 'alice', exp: Date.now() / 1000 + 3600 });
    global.fetch = jest.fn((url) => url.endsWith('openid-configuration')
        ? respond(endpoints) : respond({ id_token: idToken, refresh_token: 'refresh' }));

    expect(await auth.completeSignIn()).toBe(true);
    expect(window.location.search).toBe('');
    const [url, options] = fetch.mock.calls[1];
    expect(url).toBe(endpoints.token_endpoint);
    expect(Object.fromEntries(new URLSearchParams(options.body))).toEqual({
        client_id: 'jolt', grant_type: 'authorization_code', code: 'the-code',
        redirect_uri: 'http://localhost/', code_verifier: 'verifier',
    });
    expect(auth.currentUser()).toEqual({ name: 'alice' });
    expect(await auth.idToken()).toBe(idToken);
});

test('a response with another state is ignored', async () => {
    window.sessionStorage.setItem('jolt-dashboard.auth.pending.v1', JSON.stringify({ verifier: 'v', state: 'mine', config }));
    window.history.replaceState(null, '', '/?code=code&state=forged');
    global.fetch = jest.fn();
    expect(await auth.completeSignIn()).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(auth.currentUser()).toBeNull();
});

test('expiring tokens are refreshed, and a failed refresh signs out', async () => {
    const expiring = token({ preferred_username: 'alice', exp: Date.now() / 1000 + 10 });
    const fresh = token({ preferred_username: 'alice', exp: Date.now() / 1000 + 3600 });
    window.sessionStorage.setItem('jolt-dashboard.auth.v1', JSON.stringify({ config, idToken: expiring, refreshToken: 'refresh' }));
    global.fetch = jest.fn((url) => url.endsWith('openid-configuration') ? respond(endpoints) : respond({ id_token: fresh }));
    expect(await auth.idToken()).toBe(fresh);
    expect(Object.fromEntries(new URLSearchParams(fetch.mock.calls[1][1].body))).toMatchObject({
        grant_type: 'refresh_token', refresh_token: 'refresh',
    });

    window.sessionStorage.setItem('jolt-dashboard.auth.v1', JSON.stringify({ config, idToken: expiring, refreshToken: 'revoked' }));
    global.fetch = jest.fn((url) => url.endsWith('openid-configuration') ? respond(endpoints) : respond({ error: 'invalid_grant' }, false));
    expect(await auth.idToken()).toBeNull();
    expect(auth.currentUser()).toBeNull();
});
