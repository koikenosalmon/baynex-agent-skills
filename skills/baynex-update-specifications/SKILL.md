---
name: baynex-update-specifications
description: Apply authorized Baynex specification, catalog, assurance, hierarchy, or implementation-task changes through Slack-audited MCP writers. Use when a human asks to create, edit, reorganize, or derive tasks from a Baynex specification, especially from Slack. Trigger for requests such as 仕様書を更新, 仕様を追加, 仕様を移動, カタログ更新, テスト保証更新, or 仕様からタスク作成. Do not use for HTML UI screen changes; use baynex-manage-ui-definitions instead.
---

# Update Baynex specifications

Apply mutations only through the writer tools exposed by the `baynex-specifications` MCP server.

## Required inputs

Identify the exact project and target document. For audited mutations, retain the original human Slack tuple:

- `sourceChannelId`
- `sourceThreadTs`
- `sourceMessageTs`

Also determine the control specification, intended writer operation, and a concise summary. Never fabricate Slack timestamps or reuse a message for another operation.

## Workflow

1. Discover current MCP tools and read the target with its current revision. For Markdown updates, preserve the complete returned Markdown as `baseMarkdown`.
2. Translate the request into the smallest complete proposed artifact. Preserve unrelated content, stable IDs, ordering, and cross-links.
3. Bind the human source to the writer:
   - If the exact human message is already in the target document's canonical Slack thread, pass its canonical thread and message timestamps.
   - Otherwise call `prepare_slack_audit_source` with the original tuple and the exact intended operation. Use only the returned `slackThreadTs` and `sourceMessageTs` for that one writer call.
4. Call the exact writer using the revision and full base returned by the canonical read. Do not send undeclared fields.
5. On a revision conflict, re-read, re-evaluate the human request against the new artifact, and retry only when the intent remains unambiguous.
6. Verify success using the corresponding canonical MCP read. Check identity, revision, and the requested semantic change.
7. Report the committed revision and any merge or duplicate-replay result.

Read [references/write-routing.md](references/write-routing.md) before selecting an audited writer or recovering from an audit error.

## Fail closed

- If audit-source preparation fails, make zero managed-artifact writes and report that audit error separately from MCP connection errors.
- Treat `slack_conversation_not_found` as an audit-source mismatch, not an MCP outage. Prepare the source once from the original tuple, then use its returned tuple.
- If a source is consumed or bound to another operation, require a new human Slack message.
- After `*_persistence_uncertain`, read back before deciding whether to retry.
- Never substitute browser editing, direct REST, D1, provider consoles, or repository content for an MCP writer.
- Do not call `set_task_progress` unless the user asked to claim a task or record implementation progress. Use the exact optimistic task version from `get_task`.
