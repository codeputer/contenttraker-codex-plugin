---
name: contenttraker-reset
description: Reset only the current worktree and environment's saved ContentTraker context while preserving authentication and remote assets.
---

# Reset ContentTraker Context

Use this skill when the user wants the current worktree to forget its selected ContentTraker workspace or project and ask again on the next operation.

The supported user-facing invocation is `$contenttraker-reset` or a plain-language request such as “reset the ContentTraker context for this worktree.” Native `/contenttraker-reset` aliases are not part of the current plugin contract.

## Workflow

1. Resolve the exact Git worktree root and active ContentTraker environment. Pass the absolute root as `repositoryRoot`.
2. Confirm that the request applies only to this worktree and the adapter's active `staging` or `production` environment. Invoking this skill or plainly asking to reset that exact scope is sufficient authorization; ask only when the worktree or environment is ambiguous.
3. Call `reset_contenttraker_context` with:
   - the absolute `repositoryRoot`;
   - the active environment when useful for mismatch detection;
   - `confirmation: "RESET_CONTENTTRAKER_CONTEXT"`.
4. Report exactly:
   - whether the environment's human-confirmed marker binding was cleared;
   - how many exact registry mappings were removed;
   - whether a reset tombstone was created;
   - the marker path and repository identity;
   - that OAuth/keyring credentials, other worktrees, valid other-environment entries, and all remote ContentTraker assets were preserved;
   - or, for a wholly unreadable/untrusted marker, that other-environment marker preservation could not be proven.

The reset tombstone prevents an old registry mapping or environment default from silently reselecting a workspace. The next context-dependent operation must use an explicit workspace selector or run `$contenttraker-select`.

Reset is not logout. Never call `logout_contenttraker`, `forget_contenttraker_credential`, delete a keyring entry, or change a remote ContentTraker asset as part of this workflow.
