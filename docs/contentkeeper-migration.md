# ContentKeeper identity and migration

## Durable contract

`ContentKeeperId` is the authorization and routing identifier used by the ContentTraker domain. The current HTTPS JSON API calls the same value `workspaceId` and keeps `/workspaces/{workspaceId}` routes.

Plugin 0.5.0 therefore uses:

- `contentKeeperId` as the canonical field in new tool inputs, internal contexts, marker schema v2, registry schema v3, and business results;
- `workspaceId` as a deprecated compatibility alias containing the exact same value;
- `projectId` and `projectKey` only as optional provenance within an already authorized ContentKeeper.

If both identifier aliases are supplied and their trimmed values differ, the adapter returns `content_keeper_alias_mismatch` before authentication discovery or a business API request.

## Preferred tool input

New calls should use the discriminated `context` field:

```json
{
  "context": {
    "source": "content-keeper",
    "contentKeeperId": "019f..."
  }
}
```

For a previously confirmed worktree:

```json
{
  "context": {
    "source": "worktree",
    "repositoryRoot": "C:\\source\\repository"
  }
}
```

Top-level `contentKeeperId`, `workspaceId`, `workspaceKey`, `workspaceName`, and `repositoryRoot` remain accepted during migration. Do not combine the preferred context with conflicting top-level selectors.

## Fail-closed routing

Business operations use only this order:

1. explicit ContentKeeper selector;
2. live-authorized, human-confirmed marker for the exact worktree and environment;
3. exact repository-root registry mapping, followed by live authorization;
4. block with `contentkeeper_selection_required`.

Environment defaults and project-name-only mappings never authorize or route business operations. Existing registry defaults remain readable so diagnostics and migration tooling can report them.

## Stored-data migration

- Marker schema v1 remains readable. Its `workspaceId` becomes both aliases in memory. The next confirmed write emits marker schema v2 with equal `contentKeeperId` and `workspaceId`.
- Registry v1 and v2 remain readable. The next registry update emits v3 and adds the canonical identifier to mappings and retained diagnostic defaults.
- Existing explicit `workspaceId` calls remain compatible.
- No token, credential, ContentTraker asset, or project provenance is rewritten by this migration.

Do not remove `workspaceId` from the public contract until the HTTPS API and supported installed clients have completed a separately reviewed deprecation.
