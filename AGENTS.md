# ContentTraker public distribution boundary

This repository is the public release and distribution mirror for the
ContentTraker Codex plugin. It is not an implementation repository.

The only authoritative source is:

- repository: `PhxBiz/ArticleMngrSLN`
- branch: `development`
- component: `components/contenttraker-codex-plugin/`

If a task requests a source change, bug fix, feature, test change, or generated
runtime update here, stop and move the work to a development-based branch in
`PhxBiz/ArticleMngrSLN`. Do not independently implement or merge source changes
in this mirror.

This repository may receive a reviewed distribution export only after the
canonical source change has merged and passed its complete validation suite.
Every release export must record:

1. the canonical commit and component tree;
2. the mirror commit and immutable tag;
3. the packaged runtime SHA-256;
4. the public release URL;
5. installed-runtime verification.

Installed plugin caches, `node_modules`, generated test caches, local credential
stores, deployed artifacts, and runtime state are never source inputs.
