-- Session revocation counter. Session tokens embed the value they were issued
-- with. Logout and password changes increment it, invalidating older tokens.
ALTER TABLE `user` ADD `token_version` integer DEFAULT 0 NOT NULL;
