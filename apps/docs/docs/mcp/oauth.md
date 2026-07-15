---
sidebar_position: 2
---

# OAuth

`@forgewisp/mcp` supports **OAuth 2.1 + PKCE** for protecting MCP servers. You implement an
`OAuthClientProvider` (token storage, redirect plumbing) and pass it as `authProvider`; the SDK
handles discovery (RFC 9728/8414/7591), PKCE, token-exchange, and refresh via
`StreamableHTTPClientTransport`'s `authProvider` option.

`authProvider` takes precedence over `apiKey` — the two are mutually exclusive (if both are set,
`authProvider` wins and `apiKey` is ignored).

## The state machine

The consumer-visible state is `McpAuthState = 'authorized' | 'pending'`:

1. A first connect that needs auth returns `authState: 'pending'` with **empty tools** instead of
   throwing. The handle/result stays alive with a `finishAuth(authorizationCode): Promise<void>`
   method.
2. The SDK has already called `provider.redirectToAuthorization` before surfacing `pending`, so you
   redirect the user to the authorization server.
3. When the redirect-back arrives with `code` (and `state`), call `handle.finishAuth(code)`.

```ts
const result = await createMcpTools({
  name: 'oauth-mcp',
  url: 'https://example.com/mcp',
  authProvider: myProvider, // your OAuthClientProvider
  defaultTier: 'read',
  hasConfirmation: true,
});

if (result.authState === 'pending') {
  // user is being redirected; persist `result` and the pending config.
  // on redirect-back, with the code:
  await result.finishAuth(code);
}
```

## Fresh transport on resume

`finishAuth(code)` is **not** "reconnect the spent transport." Here's why, and what it does instead:

- The SDK's `Client.connect` catches the `UnauthorizedError` thrown during the redirect, calls
  `void this.close()` (which aborts the transport's `_abortController` but does **not** null it),
  and rethrows — so a second `start()` on that transport throws `"already started"`. The same
  transport cannot be re-`connect`ed.
- So `finishAuth(code)` **exchanges the code on the spent transport** (its `finishAuth` only calls
  `auth()`, independent of `start()`) to save tokens into the provider, disconnects the spent
  client, builds a **fresh transport** whose `connect` reads `provider.tokens()` and succeeds, then
  re-lists tools and splices them into the caller's `tools` array in place.

The same fresh-transport pattern backs `McpConnectOptions.authorizationCode` — the page-reload resume
path: exchange the code on a fresh transport *before* connecting.

## What you own

You implement `OAuthClientProvider` and own:

- **Token storage** (e.g. `localStorage` keyed by server name).
- **Redirect plumbing** — `redirectToAuthorization` opens the auth server URL; the redirect-back
  page hands the `code` + `state` back to your app (popup `postMessage` or same-tab
  `location.replace`).
- **PKCE verifier persistence** and a `state()` correlation id (the OAuth `state` parameter the SDK
  injects into the authorize URL).

The `apps/mcp-demo` ships a `LocalStorageOAuthProvider` reference implementation and an
`oauth-callback.html` redirect-back page you can crib from.

## Auth module is isolated

`client/auth.js` (and its `UnauthorizedError`) is **dynamically imported only on the OAuth path** —
non-OAuth consumers never load the auth module, so it lands in its own dynamic-import chunk (Vite
emits a separate `auth-*.js` alongside `streamableHttp-*.js`). `UnauthorizedError` is matched with
`instanceof` (the SDK gives it no custom `.name`, so a name check fails).

## Pending preflight

`registerMcpServer` **defers the confirmation preflight** when `authState === 'pending'` (no tools
to tier yet); the handle's `finishAuth` runs the `hasConfirmation` preflight *after* listing tools,
then registers — and on preflight failure deregisters anything already registered, disconnects, and
throws the same clear error (mirroring the non-pending semantics).

See the API reference for `McpServerConfig`, `McpAuthState`, `McpConnectOptions`,
`McpServerHandle`, `McpToolsResult`, and the SDK type-only re-exports
(`OAuthClientProvider`, `OAuthTokens`, `OAuthClientMetadata`, `OAuthClientInformationMixed`).