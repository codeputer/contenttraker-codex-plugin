# Cross-platform verification matrix

Evidence snapshot: 2026-07-21. Implementation commits are local and unpushed, so the new GitHub Actions matrix has not yet produced remote run evidence.

| Requirement | Current evidence | Status |
| --- | --- | --- |
| Portable production bundle | Deterministic SHA256 `CDA9737DA6B2B01BB8B0EA7393506D162457DA4234E0D6CB7D35D227D9A1DC7E`; production startup exposes 21 expected tools; forbidden runtime, credential-config, and internal-test markers absent | Verified locally |
| Windows desktop credential provider | Native Windows Credential Manager set/get/delete round trip passed; the randomized temporary entry was deleted | Verified locally |
| Windows Node 18 | Workflow job is defined on `windows-latest` with Node 18 but has not run from this unpushed branch | Pending CI (#9) |
| macOS desktop and Keychain | Capability, command transport, redaction, and restoration fixtures pass; Node 18 and native Keychain workflow steps are defined but unrun | Pending CI/native evidence (#9) |
| Linux desktop | Capability and Secret Service fixtures pass; Ubuntu Node 18 workflow is defined but unrun; no live desktop browser/keyring test has been captured | Partial; pending CI/native evidence (#9) |
| WSL / Linux Node 18 bundle | The committed bundle started under `AIHarness-Pilot` Node `v18.19.1` and exposed all 21 tools | Verified locally |
| Current isolated WSL capabilities | Ubuntu 24.04 `AIHarness-Pilot` reports D-Bus and display present, no Linux browser, `secret-tool`, or GNOME Keyring, and no passwordless `sudo`; plugin diagnostic selects `headless`, `manual-url`, delegated authentication, and returns `blocked: Linux Secret Service requires secret-tool` | Blocked at Linux keyring (#11) |
| WSL-native delegated OAuth | Live staging metadata succeeds inside that WSL distro, but device authorization is not advertised and no Linux browser exists | Blocked at interaction/server capability after keyring setup (#11, #12) |
| Device authorization provider | Advertised/absent/malformed metadata, pending, slow-down, denial, expiry, cancellation, timeout, scope/resource binding, redaction, and delegated keyring persistence tests pass | Plugin side verified; server blocked (#12) |
| Headless manual loopback | Manual URL, callback lifetime, cancellation, timeout, and redaction tests pass | Automated fixture verified |
| Docker/Kubernetes/CI workload OAuth | Auto-selection fails closed and raw bearer configuration is removed; live metadata advertises no workload grant; local Docker engine is stopped | Workload contract/provider blocked (#13); local container run pending (#9) |
| Explicit ephemeral container | Delegated + memory selection and non-restoration behavior are tested | Automated fixture verified |
| Cross-task restoration | Durable profile binding, refresh rotation, new-task rediscovery, stale cleanup, and cross-process lock tests pass | Automated fixture verified |
| Concurrent users and refreshes | Session isolation, caller verification, single-flight refresh, rotation races, revocation, audience binding, and redaction tests pass | Automated fixture verified |
| Production OAuth metadata | Both public documents return HTTP 200 and match resource, authority, endpoints, scopes, bearer headers, code response, PKCE, and public-client auth; authorization-server grants contain only `authorization_code` and omit required `refresh_token` | Blocked at production authorization server (#10) |
| CAPIC effective identity | Required result is `richard.reukema@capic.ca`; no authenticated live result has been captured | Pending live authorization (#11) |
| Authorized workspace isolation | `list_workspaces` must return only that caller's workspaces; no live result has been captured | Pending live authorization (#11) |
| CAPIC workspace selection | The workspace must be explicitly resolved before asset operations; no live CAPIC context result has been captured | Pending live authorization/context (#11) |
| Approval-gated asset workflow | Contract and mock API tests pass; no representative live CAPIC asset operation has been executed | Pending user identity and workspace verification (#11) |

The epic is not complete while any required live or external row remains pending or blocked. Automated fixtures prove adapter behavior; they do not substitute for native host, authorization-server, identity, or workspace evidence.
