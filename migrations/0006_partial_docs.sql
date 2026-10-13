-- Phase 06 (/review L8): an analysis whose documentation could not all be read
-- (a truncated tree, skipped or unreadable docs) is marked partial, not only noted.
ALTER TABLE analyses
  ADD COLUMN docs_partial boolean NOT NULL DEFAULT false;
