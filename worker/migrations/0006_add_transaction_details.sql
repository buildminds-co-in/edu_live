-- Additive only (see docs/ENVIRONMENTS.md): details shown in the dashboard's
-- Transactions tab. Older rows keep NULL in these columns.
ALTER TABLE transactions ADD COLUMN answer_style TEXT;
ALTER TABLE transactions ADD COLUMN grounded_in TEXT;
ALTER TABLE transactions ADD COLUMN retrieval_mode TEXT;
