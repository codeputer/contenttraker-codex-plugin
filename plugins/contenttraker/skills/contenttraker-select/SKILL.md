---
name: contenttraker-select
description: Live-verify and save a human-confirmed ContentTraker workspace and optional project for the current Git worktree.
---

# Select ContentTraker Context

Use this skill when the user wants to choose, confirm, change, or durably remember the ContentTraker destination for the current worktree.

The supported user-facing invocation is `$contenttraker-select` or a plain-language request such as “select the ContentTraker context for this worktree.” Native `/contenttraker-select` aliases are not part of the current plugin contract.

## Workflow

1. Resolve the exact Git worktree root and normalized repository identity. Pass that absolute root as `repositoryRoot`; the adapter runs from its installed plugin directory and cannot infer the user's worktree from its own process directory.
2. Authenticate through the plugin. If necessary, use `begin_contenttraker_login` and `poll_contenttraker_login`, then verify the effective identity with `get_current_user`.
3. Use `list_workspaces` and the authenticated project lookup to resolve the exact workspace and optional project. Never substitute a similarly named workspace or infer a workspace from a project.
4. Show the user the environment, repository, workspace, and optional project that will be saved. Require explicit human confirmation of that exact selection. If the user's request already names the exact target and explicitly asks to select or confirm it, do not ask again.
5. Call `confirm_contenttraker_context` with:
   - the absolute `repositoryRoot`;
   - one exact workspace selector: `workspaceId`, `workspaceKey`, or an unambiguous `workspaceName`;
   - an optional exact project selector;
   - `confirmation: "CONFIRM_CONTENTTRAKER_CONTEXT"`.
6. Treat the selection as saved only when the tool returns `status: "confirmed"`. Report the environment, repository identity, marker path, workspace, optional project, and correlation IDs.

The confirmation tool performs live authorization checks before writing. It records identifiers and display names only in `.contenttraker-codex/context.json`; it never writes an access token, refresh credential, keyring value, cookie, authorization code, or remote ContentTraker asset.

## Resolution rules

For later ContentTraker operations:

1. An explicit per-call `workspaceId`, `workspaceKey`, or `workspaceName` wins.
2. Otherwise, pass `repositoryRoot` so the adapter can load and live-verify the human-confirmed worktree marker.
3. An exact environment-scoped registry mapping is considered only when no marker binding or reset tombstone applies.
4. If no reliable context exists, resolve live and obtain the smallest necessary human confirmation.

Never depend on remote ambient session context. Do not use `.contenttraker/project-binding.json`, a local proxy, copied credentials, or a direct remote MCP registration.
