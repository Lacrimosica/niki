-- Distinguish member invites (join an existing org) from org-creation invites
-- (create an additional org in invite_only mode). Existing rows were all issued
-- as member invites, so they take the 'member' default.

ALTER TABLE invite ADD COLUMN kind TEXT NOT NULL DEFAULT 'member' CHECK (kind IN ('member', 'org_creation'));
