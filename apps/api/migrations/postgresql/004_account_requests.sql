-- Expand only. Requests remain pending human verification/policy; this migration
-- does not erase data, revoke memberships or approve any privacy action.
ALTER TABLE longball.privacy_requests
  ADD COLUMN team_id text REFERENCES longball.teams(id),
  ADD COLUMN season_id text,
  ADD COLUMN affected_memberships_json jsonb
    CHECK(affected_memberships_json IS NULL OR jsonb_typeof(affected_memberships_json)='array');

-- Earlier leave-team requests did not record a confirmed team/season. They must
-- never become an implicit global request. Preserve any already nonpending state.
UPDATE longball.privacy_requests SET status='needs_scope'
WHERE kind='leave_team' AND status='pending_verification_and_policy'
  AND (team_id IS NULL OR season_id IS NULL);

CREATE TABLE longball.privacy_pending_keys(
  business_key text PRIMARY KEY,
  request_id text NOT NULL UNIQUE REFERENCES longball.privacy_requests(id)
);

-- Retain every historical row/status and its unknown(NULL) confirmation snapshot.
-- Only the earliest pending row is canonical. Explicit JSON string quoting keeps
-- these exact bytes aligned with JSON.stringify in the shared application helper.
WITH scoped AS (
  SELECT id,created_at,
    CASE
      WHEN kind IN('export','delete_account') AND team_id IS NULL AND season_id IS NULL
        THEN '['||to_json(account_id)::text||','||to_json(kind)::text||',"all_memberships"]'
      WHEN kind='leave_team' AND team_id IS NOT NULL AND season_id IS NOT NULL
        THEN '['||to_json(account_id)::text||','||to_json(kind)::text||',"team_season",'||to_json(team_id)::text||','||to_json(season_id)::text||']'
    END AS business_key
  FROM longball.privacy_requests WHERE status='pending_verification_and_policy'
), canonical AS (
  SELECT DISTINCT ON(business_key) business_key,id
  FROM scoped WHERE business_key IS NOT NULL
  ORDER BY business_key,created_at,id
)
INSERT INTO longball.privacy_pending_keys(business_key,request_id)
SELECT business_key,id FROM canonical;

ALTER TABLE longball.documents DROP CONSTRAINT documents_kind_check;
ALTER TABLE longball.documents ADD CONSTRAINT documents_kind_check
  CHECK(kind IN('preparation','community','records','staff'));
