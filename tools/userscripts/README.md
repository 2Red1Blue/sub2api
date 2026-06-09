# Sub2API Userscripts

## Account checker

`sub2api-account-checker.user.js` is a Tampermonkey/Violentmonkey userscript for the admin accounts page.

It adds a floating "账号巡检" panel on `/admin/accounts` and can:

- Read the current admin `Authorization` token automatically.
- Detect the target group from URL/query, group filter controls, or the visible accounts table when every visible row belongs to the same group.
- Resolve a group name such as `codex` to the numeric group ID required by the admin accounts API.
- Let the operator manually enter and save the target group.
- Batch test account models and optionally turn off account scheduling when a model check fails.

## Authorization source

The `Authorization` value is the Sub2API admin login token for the current browser session.

The script reads it in this order:

1. `localStorage.auth_token` or `sessionStorage.auth_token` from the Sub2API page.
2. Previously saved `__sub2api_checker_auth__`.
3. `Authorization` headers from the page's own `fetch`/XHR API requests.
4. Manual input in the script panel.

It is not an upstream provider key and not an OpenAI API key.

## Group detection

The script reads the target group in this order:

1. URL params: `group`, `groups`, `account_group`, `accountGroup`.
2. Native or Ant Design-like group controls.
3. The visible accounts table's "分组" column, only when all visible rows resolve to one same group.
4. Manual input in the "测活分组" field.

If the visible table contains multiple groups, the script will ask for manual confirmation instead of guessing.

The admin accounts API requires `group` to be a numeric group ID or `ungrouped`. When the panel has a group name, the script fetches `/api/v1/admin/groups/all` and converts the name to its ID before requesting `/api/v1/admin/accounts`.
