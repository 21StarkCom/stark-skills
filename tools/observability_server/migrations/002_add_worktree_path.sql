-- Add `worktree_path` to runs so the UI tree can group runs by the
-- physical checkout they came from. A git worktree (under
-- `.worktrees/<name>`) shares a remote + branch with the primary
-- checkout but lives at a different filesystem path; without this
-- column they collide in the same `<repo> > <branch>` tree node and
-- the operator can't tell which checkout produced which run.
--
-- Nullable: older rows + the synthetic emit-harness keep null and the
-- UI labels those as "primary".

ALTER TABLE runs ADD COLUMN worktree_path TEXT;
