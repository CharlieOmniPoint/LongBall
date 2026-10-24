-- Prepared PostgreSQL migration; NOT executed by the SQLite development service.
-- Deploy with a dedicated migration role, separate app/worker roles and reviewed RLS policies.
BEGIN;
CREATE TABLE account (
  id uuid PRIMARY KEY, issuer text NOT NULL, subject text NOT NULL,
  identity_classification text NOT NULL CHECK (identity_classification IN ('child_shared','adult_individual','unclassified')),
  adult_verified boolean NOT NULL DEFAULT false, strong_auth_enrolled boolean NOT NULL DEFAULT false,
  status text NOT NULL CHECK (status IN ('active','disabled')), UNIQUE (issuer,subject)
);
CREATE TABLE team (id uuid PRIMARY KEY, club_id uuid NOT NULL, name text NOT NULL);
CREATE TABLE season (id uuid PRIMARY KEY, team_id uuid NOT NULL REFERENCES team(id), label text NOT NULL, starts_on date NOT NULL, ends_on date NOT NULL, UNIQUE(team_id,id), CHECK(starts_on<=ends_on));
CREATE TABLE membership (
  account_id uuid NOT NULL REFERENCES account(id), team_id uuid NOT NULL REFERENCES team(id), season_id uuid NOT NULL,
  role text NOT NULL CHECK(role IN ('administrator','manager','player','spectator')), player_id uuid, expires_at timestamptz, revoked_at timestamptz,
  PRIMARY KEY(account_id,team_id,season_id,role), FOREIGN KEY(team_id,season_id) REFERENCES season(team_id,id)
);
CREATE TABLE match (
  id uuid PRIMARY KEY, team_id uuid NOT NULL REFERENCES team(id), season_id uuid NOT NULL,
  config jsonb NOT NULL, projection jsonb NOT NULL, revision bigint NOT NULL DEFAULT 0, sharing_policy jsonb NOT NULL,
  last_sync_at timestamptz, UNIQUE(team_id,season_id,id), FOREIGN KEY(team_id,season_id) REFERENCES season(team_id,id)
);
CREATE TABLE controller_grant (
  match_id uuid PRIMARY KEY REFERENCES match(id), epoch bigint NOT NULL CHECK(epoch>0), account_id uuid NOT NULL REFERENCES account(id),
  device_id text NOT NULL CHECK (char_length(device_id) BETWEEN 1 AND 120 AND device_id ~ '^[A-Za-z0-9_-]+$'), capability_hash bytea NOT NULL, frozen boolean NOT NULL DEFAULT false
);
CREATE TABLE match_event (
  event_id uuid PRIMARY KEY, match_id uuid NOT NULL REFERENCES match(id), device_id text NOT NULL CHECK (char_length(device_id) BETWEEN 1 AND 120 AND device_id ~ '^[A-Za-z0-9_-]+$'), client_sequence bigint NOT NULL CHECK(client_sequence>0),
  controller_epoch bigint NOT NULL, engine_version text NOT NULL, schema_version integer NOT NULL,
  previous_event_id uuid, base_revision bigint NOT NULL, effective_half smallint, half_elapsed_ms bigint CHECK(half_elapsed_ms>=0),
  match_elapsed_ms bigint CHECK(match_elapsed_ms>=0), envelope jsonb NOT NULL, disposition text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(), UNIQUE(match_id,device_id,client_sequence)
);
CREATE TABLE device_stream (match_id uuid NOT NULL REFERENCES match(id),device_id text NOT NULL CHECK (char_length(device_id) BETWEEN 1 AND 120 AND device_id ~ '^[A-Za-z0-9_-]+$'),sequence bigint NOT NULL,previous_event_id uuid NOT NULL,PRIMARY KEY(match_id,device_id));
CREATE TABLE application_document (
  team_id uuid NOT NULL,season_id uuid NOT NULL,kind text NOT NULL CHECK(kind IN ('preparation','community','records')),revision bigint NOT NULL,value jsonb NOT NULL,
  PRIMARY KEY(team_id,season_id,kind),FOREIGN KEY(team_id,season_id) REFERENCES season(team_id,id)
);
CREATE TABLE outbox_job (
  id uuid PRIMARY KEY,business_key text NOT NULL UNIQUE,kind text NOT NULL,payload jsonb NOT NULL,due_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'pending',attempts integer NOT NULL DEFAULT 0,lease_until timestamptz,last_error_code text
);
CREATE INDEX due_jobs ON outbox_job(state,due_at);
CREATE INDEX match_event_replay ON match_event(match_id,received_at,event_id);
-- Manager assignment transaction MUST lock the team row FOR UPDATE, count DISTINCT active
-- manager account IDs across team seasons, verify adult eligibility, then reject the fifth.
-- This migration alone does not enforce that service operation or prove concurrent PostgreSQL behavior.
-- Enable FORCE ROW LEVEL SECURITY and reviewed current-membership policies before granting app access.
-- No production role grants or permissive placeholder RLS policies are installed here.
COMMIT;
