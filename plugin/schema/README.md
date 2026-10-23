# Pinned manifest schema

`MicrosoftTeams.v1.29.schema.json` is an unmodified snapshot of Microsoft's
[unified app manifest v1.29 schema](https://developer.microsoft.com/json-schemas/teams/v1.29/MicrosoftTeams.schema.json).
It is included so package validation works offline and does not change when the
upstream schema changes.

SHA-256: `53e860fd650fd03fe587379d92af6c91374e791f041ce3f26c92d5e74aeafa0b`

When deliberately updating it, review the upstream changes, replace the snapshot,
update this checksum, and rerun the plugin tests. Schema validation is structural;
it does not verify tenant policy, OAuth configuration, or live MCP connectivity.
