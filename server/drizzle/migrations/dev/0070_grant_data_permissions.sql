-- Export and import used to be gated on the admin and core_admin roles. They now
-- require the data.export and data.import permissions. Memberships and pending
-- invites with an explicit permission list predate these permissions, so append
-- them for those roles to keep the access they already had. The CASE guards stop
-- a malformed stored value from aborting the migration. Rows with no list
-- fall back to the role defaults, which already include them.

UPDATE organization_user
SET permissions = json_insert(permissions, '$[#]', 'data.export')
WHERE role IN ('admin', 'core_admin')
  AND permissions IS NOT NULL
  AND CASE WHEN json_valid(permissions) THEN json_type(permissions) END = 'array'
  AND NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(organization_user.permissions) THEN organization_user.permissions ELSE '[]' END) WHERE value = 'data.export');

UPDATE organization_user
SET permissions = json_insert(permissions, '$[#]', 'data.import')
WHERE role IN ('admin', 'core_admin')
  AND permissions IS NOT NULL
  AND CASE WHEN json_valid(permissions) THEN json_type(permissions) END = 'array'
  AND NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(organization_user.permissions) THEN organization_user.permissions ELSE '[]' END) WHERE value = 'data.import');

UPDATE invite
SET permissions_override = json_insert(permissions_override, '$[#]', 'data.export')
WHERE role IN ('admin', 'core_admin')
  AND used_at IS NULL
  AND permissions_override IS NOT NULL
  AND CASE WHEN json_valid(permissions_override) THEN json_type(permissions_override) END = 'array'
  AND NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(invite.permissions_override) THEN invite.permissions_override ELSE '[]' END) WHERE value = 'data.export');

UPDATE invite
SET permissions_override = json_insert(permissions_override, '$[#]', 'data.import')
WHERE role IN ('admin', 'core_admin')
  AND used_at IS NULL
  AND permissions_override IS NOT NULL
  AND CASE WHEN json_valid(permissions_override) THEN json_type(permissions_override) END = 'array'
  AND NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(invite.permissions_override) THEN invite.permissions_override ELSE '[]' END) WHERE value = 'data.import');
