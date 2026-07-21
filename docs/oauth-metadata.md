# OAuth metadata and server capabilities

The plugin reads two unauthenticated HTTPS documents:

- `<resource>/.well-known/oauth-protected-resource`
- `<issuer>/.well-known/oauth-authorization-server`

`inspect_contenttraker_oauth_metadata` validates and reports this contract without starting authorization, reading credentials, or calling a business API. Metadata requests reject redirects, time out after ten seconds, share concurrent fetches, and remain cached only in process memory for five minutes.

## Required delegated contract

The protected-resource document must name the exact configured resource and authorization server, advertise bearer headers, and include every requested scope. The authorization-server document must provide the exact issuer, same-authority HTTPS authorization and token endpoints, code response type, authorization-code and refresh-token grants, public-client token authentication `none`, PKCE `S256`, and the same requested scopes.

The authorization and refresh clients use the validated advertised endpoints. A token response must repeat the configured resource and every requested scope. Missing or mismatched values fail at the metadata or token-exchange layer without returning server bodies, credentials, cookies, or OAuth codes.

## Staging evidence

On 2026-07-21, staging advertised the delegated contract for public client `codex-mcp`. The automated live probe also submitted the required scopes, resource, PKCE challenge, and a randomized `http://127.0.0.1:<port>/oauth/callback`; the authorization server accepted the request and advanced to its configured identity provider.

Staging did not advertise a device authorization endpoint, device-code grant, client-credentials grant, token-exchange grant, or JWT-bearer grant. The plugin therefore reports device and workload authorization as unavailable. It does not synthesize endpoints or downgrade to credentials in configuration.

Run the optional, non-secret live verification from `plugins/contenttraker`:

```bash
CONTENTTRAKER_TEST_LIVE_OAUTH_METADATA=1 npm run oauth-metadata
```

The device interaction provider is implemented and activates only after the server publishes the endpoint and grant. Workload OAuth still requires both authorization-server implementation and a corresponding host workload provider.
