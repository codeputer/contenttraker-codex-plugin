# Cross-platform verification matrix

Evidence snapshot: 2026-07-21. Implementation commits are local and unpushed, so the new GitHub Actions matrix has not yet produced remote run evidence.

| Requirement | Current evidence | Status |
| --- | --- | --- |
| Portable production bundle | Deterministic SHA256 `CB05DC6508BC35AF172A63488C7C390DC24563DCFC1FA9FD0DFFEDDF24C9FEDB`; production startup exposes 21 expected tools; forbidden runtime, credential-config, and internal-test markers absent | Verified locally |
| Windows desktop credential provider | Native Windows Credential Manager set/get/delete round trip passed; the randomized temporary entry was deleted | Verified locally |
| Windows Node 18 | Workflow job is defined on `windows-latest` with Node 18 but has not run from this unpushed branch | Pending CI (#9) |
| macOS desktop and Keychain | Capability, command transport, redaction, and restoration fixtures pass; Node 18 and native Keychain workflow steps are defined but unrun | Pending CI/native evidence (#9) |
| Linux desktop | Capability and Secret Service fixtures pass; WSLg Firefox and GNOME Keyring pass live; Ubuntu Node 18 workflow is defined but unrun; no separate non-WSL desktop evidence has been captured | Partial; pending CI/native evidence (#9) |
| WSL / Linux Node 18 bundle | The committed bundle started under `AIHarness-Pilot` Node `v18.19.1` and exposed all 21 tools | Verified locally |
| Current isolated WSL capabilities | Ubuntu 24.04 `AIHarness-Pilot` has D-Bus, WSLg display, `secret-tool`, and GNOME Keyring; a randomized cross-process Secret Service set/get/delete round trip passed and removed its temporary entry; the plugin reports `ready`, persistent `linux-secret-service`, and cross-task restoration available | Keyring verified locally (#11) |
| WSL-native delegated OAuth | Firefox `152.0.6-1` runs inside WSLg; the plugin selected `wsl-desktop` + `wsl-native`, launched PKCE authorization, and completed staging sign-in without Windows browser interoperability | Verified live (#11) |
| Device authorization provider | Advertised/absent/malformed metadata, pending, slow-down, denial, expiry, cancellation, timeout, scope/resource binding, redaction, and delegated keyring persistence tests pass | Plugin side verified; server blocked (#12) |
| Headless manual loopback | Manual URL, callback lifetime, cancellation, timeout, and redaction tests pass | Automated fixture verified |
| Docker/Kubernetes/CI workload OAuth | Auto-selection fails closed and raw bearer configuration is removed; live metadata advertises no workload grant; local Docker engine is stopped | Workload contract/provider blocked (#13); local container run pending (#9) |
| Explicit ephemeral container | Delegated + memory selection and non-restoration behavior are tested | Automated fixture verified |
| Cross-task restoration | Durable profile binding, refresh rotation, new-task rediscovery, stale cleanup, and cross-process lock tests pass; a new WSL adapter process restored/refreshed the live CAPIC profile without browser interaction | Verified live and by fixtures (#11) |
| Concurrent users and refreshes | Session isolation, caller verification, single-flight refresh, rotation races, revocation, audience binding, and redaction tests pass | Automated fixture verified |
| Production OAuth metadata | Both public documents return HTTP 200 and match resource, authority, endpoints, scopes, bearer headers, code response, PKCE, and public-client auth; authorization-server grants contain only `authorization_code` and omit required `refresh_token` | Blocked at production authorization server (#10) |
| CAPIC effective identity | Live `get_current_user` returned exactly `richard.reukema@capic.ca`; the configured identity policy matched | Verified live (#11) |
| Authorized workspace isolation | Live `list_workspaces` returned the caller's single authorized workspace, `KUA Workspace` | Verified live (#11) |
| CAPIC workspace selection | The local registry maps `/home/harness/projects/HighConsulting` to `KUA Workspace`; a new process resolved that exact context before asset operations | Verified live (#11) |
| Live API readiness | `/me`, authorized workspace matching, and the optional workspace-project endpoint returned HTTP 200 after removing the false local-to-remote project fallback | Verified live (#11) |
| Approval-gated asset workflow | Contract and mock API tests pass; the live draft operation awaits an explicit user approval statement | Pending explicit approval (#11) |

The epic is not complete while any required live or external row remains pending or blocked. Automated fixtures prove adapter behavior; they do not substitute for native host, authorization-server, identity, or workspace evidence.
