# Read tool routing

Discover schemas at runtime. Use this list only to select a tool family.

| Need | Tool | Identity notes |
| --- | --- | --- |
| Approved implementation baseline | `get_approved_specification` | `projectId` + `documentId` |
| Current Markdown and revision | `get_current_specification` | `projectId` + `documentId` |
| Ordered specification tree | `get_specification_structure` | `projectId` |
| Database or API catalog | `get_current_product_catalog` | `catalogKind`: `database` or `api` |
| Test catalog and coverage | `get_current_assurance` | `projectId` |
| HTML screens, states, links, comments | `get_current_ui_definitions` | `projectId`; filter by `specificationLinks` |
| Implementation task list | `list_tasks` | Cross-project, project, or specification filters |
| One implementation task | `get_task` | Use the exact task ID returned by Baynex |

Prefer one narrow read first, then follow explicit identifiers. Never match records only by display text when a stable ID exists.
