-- Add git storage metadata to artifact versions
ALTER TABLE artifact_versions ADD COLUMN git_commit_sha TEXT;
ALTER TABLE artifact_versions ADD COLUMN git_path TEXT;
