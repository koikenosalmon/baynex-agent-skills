# Audited write routing

Discover and obey the current server schema. Map each mutation to exactly one audit operation.

| Mutation | Writer | `intendedOperation` |
| --- | --- | --- |
| Replace specification Markdown | `update_specification` | `updateSpecification` |
| Replace DB/API catalog Markdown | `update_product_catalog` | `updateProductCatalog` |
| Replace assurance slice | `update_assurance` | `update_assurance` |
| Create specification in the tree | `create_specification` | `createSpecification` |
| Move/reorder specification | `move_specification` | `moveSpecification` |
| Derive implementation tasks | `create_tasks_from_specification` | `create_tasks_from_specification` |

`set_task_progress` uses a task's optimistic version and is not a substitute for an audited specification change.

## Recovery rules

- `workspace_revision_conflict`: re-read and rebuild the complete proposal.
- `specification_merge_conflict`: stop and show the conflicting requirement ranges to the user.
- `slack_conversation_not_found`: prepare the source using the original human Slack tuple.
- `slack_source_message_consumed`: do not reuse the message; obtain a new human instruction.
- `slack_audit_source_operation_mismatch`: stop; the prepared source cannot authorize this writer.
- Persistence uncertain: perform canonical readback before any retry.
