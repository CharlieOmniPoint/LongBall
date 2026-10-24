-- Executed by the real asynchronous runtime adapter. Independent longball schema;
-- 001_initial.sql is the earlier preparation, never executed against SQLite.
CREATE TABLE accounts(id text PRIMARY KEY,issuer text NOT NULL,subject text NOT NULL,
  classification text NOT NULL CHECK(classification IN ('child_shared','adult_individual','unclassified')),
  adult_verified integer NOT NULL DEFAULT 0 CHECK(adult_verified IN(0,1)),
  strong_auth_enrolled integer NOT NULL DEFAULT 0 CHECK(strong_auth_enrolled IN(0,1)),
  status text NOT NULL DEFAULT 'active' CHECK(status IN('active','disabled')),UNIQUE(issuer,subject));
CREATE TABLE teams(id text PRIMARY KEY,name text NOT NULL);
CREATE TABLE memberships(account_id text NOT NULL REFERENCES accounts(id),team_id text NOT NULL REFERENCES teams(id),season_id text NOT NULL,
  role text NOT NULL CHECK(role IN('administrator','manager','player','spectator')),player_id text,expires_at bigint,revoked_at bigint,
  PRIMARY KEY(account_id,team_id,season_id,role));
CREATE TABLE matches(id text PRIMARY KEY,team_id text NOT NULL REFERENCES teams(id),season_id text NOT NULL,
  config_json jsonb NOT NULL,state_json jsonb NOT NULL,sharing_policy_json jsonb NOT NULL,last_sync_at bigint);
CREATE TABLE devices(id text PRIMARY KEY CHECK(char_length(id) BETWEEN 1 AND 120 AND id ~ '^[A-Za-z0-9_-]+$'),account_id text NOT NULL REFERENCES accounts(id));
CREATE TABLE controller_grants(match_id text PRIMARY KEY REFERENCES matches(id),epoch bigint NOT NULL CHECK(epoch>0),account_id text NOT NULL REFERENCES accounts(id),
  device_id text NOT NULL REFERENCES devices(id),capability_hash text NOT NULL,frozen integer NOT NULL DEFAULT 0 CHECK(frozen IN(0,1)));
CREATE TABLE controller_history(id text PRIMARY KEY,match_id text NOT NULL REFERENCES matches(id),epoch bigint NOT NULL,actor_id text NOT NULL REFERENCES accounts(id),
  from_device text,to_device text NOT NULL,kind text NOT NULL,reason text,created_at bigint NOT NULL);
CREATE TABLE events(event_id text PRIMARY KEY,match_id text NOT NULL REFERENCES matches(id),device_id text NOT NULL REFERENCES devices(id),client_sequence bigint NOT NULL CHECK(client_sequence>0),
  envelope_json jsonb NOT NULL,signature text NOT NULL,disposition text NOT NULL CHECK(disposition IN('accepted','quarantined')),reason text,revision bigint,received_at bigint NOT NULL,
  actor_id text REFERENCES accounts(id),UNIQUE(match_id,device_id,client_sequence));
CREATE TABLE streams(match_id text NOT NULL REFERENCES matches(id),device_id text NOT NULL REFERENCES devices(id),sequence bigint NOT NULL,previous_event_id text NOT NULL,
  PRIMARY KEY(match_id,device_id));
CREATE TABLE conflicting_submissions(id text PRIMARY KEY,match_id text NOT NULL REFERENCES matches(id),actor_id text NOT NULL REFERENCES accounts(id),original_json jsonb NOT NULL,reason text NOT NULL,created_at bigint NOT NULL);
CREATE TABLE transfers(id text PRIMARY KEY,match_id text NOT NULL REFERENCES matches(id),from_epoch bigint NOT NULL,to_account_id text NOT NULL REFERENCES accounts(id),to_device_id text NOT NULL,state text NOT NULL,created_at bigint NOT NULL);
CREATE TABLE idempotency(account_id text NOT NULL REFERENCES accounts(id),operation text NOT NULL,key text NOT NULL,signature text NOT NULL,response_json jsonb NOT NULL,PRIMARY KEY(account_id,operation,key));
CREATE TABLE audit(id text PRIMARY KEY,actor_id text NOT NULL REFERENCES accounts(id),action text NOT NULL,object_id text NOT NULL,outcome text NOT NULL,created_at bigint NOT NULL);
CREATE TABLE privacy_requests(id text PRIMARY KEY,account_id text NOT NULL REFERENCES accounts(id),kind text NOT NULL,status text NOT NULL,policy_version text,verified_at bigint,created_at bigint NOT NULL);
CREATE TABLE jobs(id text PRIMARY KEY,business_key text NOT NULL UNIQUE,kind text NOT NULL,payload_json jsonb NOT NULL,due_at bigint NOT NULL,state text NOT NULL DEFAULT 'pending',attempts integer NOT NULL DEFAULT 0,lease_until bigint,last_error_code text);
CREATE TABLE documents(team_id text NOT NULL REFERENCES teams(id),season_id text NOT NULL,kind text NOT NULL CHECK(kind IN('preparation','community','records')),revision bigint NOT NULL,value_json jsonb NOT NULL,PRIMARY KEY(team_id,season_id,kind));
CREATE INDEX pending_jobs ON jobs(state,due_at);
CREATE INDEX match_event_order ON events(match_id,revision);
CREATE INDEX membership_scope ON memberships(team_id,season_id,role);
-- Runtime transactions serialize domain writes by PostgreSQL advisory transaction lock.
-- Operator identity/household/competition approvals are separate records, never inferred by migration.
