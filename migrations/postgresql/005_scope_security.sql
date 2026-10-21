-- SEC10: trusted relational ancestry and transaction-local application scope.
-- The separately credentialled migrator owns these objects; API/worker never own or bypass RLS.
CREATE TABLE clubs(id text PRIMARY KEY,name text NOT NULL,status text NOT NULL DEFAULT 'active' CHECK(status='active'));
ALTER TABLE teams ADD COLUMN club_id text REFERENCES clubs(id), ADD COLUMN scope_status text NOT NULL DEFAULT 'unresolved' CHECK(scope_status IN('resolved','unresolved'));
ALTER TABLE teams ADD CONSTRAINT teams_resolved_scope CHECK((scope_status='resolved')=(club_id IS NOT NULL));
ALTER TABLE teams ADD CONSTRAINT teams_club_identity UNIQUE(id,club_id);
-- Conflicting recorded club ancestry is an error, never a guessed reassignment.
DO $scope$ BEGIN
 IF EXISTS(SELECT team_id FROM documents WHERE kind='preparation' AND NULLIF(value_json#>>'{club,id}','') IS NOT NULL GROUP BY team_id HAVING count(DISTINCT value_json#>>'{club,id}')>1) THEN RAISE EXCEPTION 'Conflicting recorded team club ancestry' USING ERRCODE='23514'; END IF;
END $scope$;
INSERT INTO clubs(id,name) SELECT value_json#>>'{club,id}', min(COALESCE(NULLIF(value_json#>>'{club,name}',''),value_json#>>'{club,id}')) FROM documents WHERE kind='preparation' AND NULLIF(value_json#>>'{club,id}','') IS NOT NULL GROUP BY value_json#>>'{club,id}';
UPDATE teams t SET club_id=d.club_id,scope_status='resolved' FROM (SELECT team_id,min(value_json#>>'{club,id}') AS club_id FROM documents WHERE kind='preparation' AND NULLIF(value_json#>>'{club,id}','') IS NOT NULL GROUP BY team_id)d WHERE d.team_id=t.id;
CREATE TABLE team_seasons(club_id text NOT NULL,team_id text NOT NULL,season_id text NOT NULL,label text,start_year smallint,start_date date,end_date date,
 PRIMARY KEY(club_id,team_id,season_id),UNIQUE(team_id,season_id),FOREIGN KEY(team_id,club_id) REFERENCES teams(id,club_id),CHECK(start_year IS NULL OR start_year BETWEEN 2000 AND 2100),CHECK(start_date IS NULL OR end_date IS NULL OR start_date<=end_date));
CREATE UNIQUE INDEX team_seasons_known_year ON team_seasons(team_id,start_year) WHERE start_year IS NOT NULL;
INSERT INTO team_seasons(club_id,team_id,season_id) SELECT DISTINCT t.club_id,s.team_id,s.season_id FROM (SELECT team_id,season_id FROM memberships UNION SELECT team_id,season_id FROM matches UNION SELECT team_id,season_id FROM documents)s JOIN teams t ON t.id=s.team_id WHERE t.club_id IS NOT NULL;
DO $scope$ DECLARE row record; previous record; BEGIN
 FOR row IN SELECT d.team_id,t.club_id,x.value FROM documents d JOIN teams t ON t.id=d.team_id CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.value_json->'seasons','[]'::jsonb))x WHERE d.kind='preparation' AND t.club_id IS NOT NULL LOOP
  SELECT * INTO previous FROM team_seasons WHERE team_id=row.team_id AND season_id=row.value->>'id';
  IF previous.start_year IS NOT NULL AND previous.start_year<>(row.value->>'startYear')::smallint THEN RAISE EXCEPTION 'Conflicting recorded season metadata' USING ERRCODE='23514'; END IF;
  INSERT INTO team_seasons(club_id,team_id,season_id,label,start_year,start_date,end_date) VALUES(row.club_id,row.team_id,row.value->>'id',row.value->>'label',(row.value->>'startYear')::smallint,(row.value->>'startDate')::date,(row.value->>'endDate')::date)
  ON CONFLICT(club_id,team_id,season_id) DO UPDATE SET label=EXCLUDED.label,start_year=EXCLUDED.start_year,start_date=EXCLUDED.start_date,end_date=EXCLUDED.end_date;
 END LOOP;
END $scope$;
ALTER TABLE matches ADD COLUMN club_id text;
ALTER TABLE memberships ADD COLUMN club_id text;
ALTER TABLE documents ADD COLUMN club_id text;
UPDATE matches x SET club_id=t.club_id FROM teams t WHERE t.id=x.team_id;
UPDATE memberships x SET club_id=t.club_id FROM teams t WHERE t.id=x.team_id;
UPDATE documents x SET club_id=t.club_id FROM teams t WHERE t.id=x.team_id;
ALTER TABLE matches ADD CONSTRAINT matches_full_identity UNIQUE(id,club_id,team_id,season_id),ADD CONSTRAINT matches_season_scope FOREIGN KEY(club_id,team_id,season_id) REFERENCES team_seasons(club_id,team_id,season_id);
ALTER TABLE memberships ADD CONSTRAINT memberships_season_scope FOREIGN KEY(club_id,team_id,season_id) REFERENCES team_seasons(club_id,team_id,season_id);
ALTER TABLE documents ADD CONSTRAINT documents_season_scope FOREIGN KEY(club_id,team_id,season_id) REFERENCES team_seasons(club_id,team_id,season_id);
CREATE TABLE game_contexts(id text NOT NULL,club_id text NOT NULL,team_id text NOT NULL,season_id text NOT NULL,source text NOT NULL CHECK(source IN('accepted_match','community_match')),PRIMARY KEY(id,club_id,team_id,season_id),UNIQUE(id),FOREIGN KEY(club_id,team_id,season_id) REFERENCES team_seasons(club_id,team_id,season_id));
INSERT INTO game_contexts SELECT id,club_id,team_id,season_id,'accepted_match' FROM matches WHERE club_id IS NOT NULL;
DO $scope$ DECLARE d record; item jsonb; p record; BEGIN
 FOR d IN SELECT * FROM documents WHERE kind='community' AND club_id IS NOT NULL LOOP
  FOR item IN SELECT value FROM jsonb_array_elements(COALESCE(d.value_json->'matches','[]'::jsonb)) LOOP
   IF item->>'teamId'=d.team_id AND item->>'seasonId'=d.season_id THEN
    SELECT * INTO p FROM game_contexts WHERE id=item->>'id';
    IF FOUND AND (p.club_id<>d.club_id OR p.team_id<>d.team_id OR p.season_id<>d.season_id) THEN RAISE EXCEPTION 'Conflicting recorded game ancestry' USING ERRCODE='23514'; END IF;
    INSERT INTO game_contexts(id,club_id,team_id,season_id,source) VALUES(item->>'id',d.club_id,d.team_id,d.season_id,'community_match') ON CONFLICT(id) DO NOTHING;
   END IF;
  END LOOP;
 END LOOP;
END $scope$;
CREATE FUNCTION record_game_contexts() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,longball AS $fn$
DECLARE item jsonb; p record; game_id text; BEGIN
 IF TG_TABLE_NAME='matches' THEN
  game_id=NEW.id;
  SELECT * INTO p FROM longball.game_contexts WHERE id=game_id;
  IF FOUND AND (p.club_id<>NEW.club_id OR p.team_id<>NEW.team_id OR p.season_id<>NEW.season_id) THEN RAISE EXCEPTION 'Object scope unavailable' USING ERRCODE='42501'; END IF;
  IF NOT FOUND THEN INSERT INTO longball.game_contexts(id,club_id,team_id,season_id,source) VALUES(game_id,NEW.club_id,NEW.team_id,NEW.season_id,'accepted_match'); END IF;
 ELSIF NEW.kind='community' THEN
  FOR item IN SELECT value FROM jsonb_array_elements(COALESCE(NEW.value_json->'matches','[]'::jsonb)) LOOP
   IF item->>'teamId'=NEW.team_id AND item->>'seasonId'=NEW.season_id THEN
    SELECT * INTO p FROM longball.game_contexts WHERE id=item->>'id';
    IF FOUND AND (p.club_id<>NEW.club_id OR p.team_id<>NEW.team_id OR p.season_id<>NEW.season_id) THEN RAISE EXCEPTION 'Object scope unavailable' USING ERRCODE='42501'; END IF;
    IF NOT FOUND THEN INSERT INTO longball.game_contexts(id,club_id,team_id,season_id,source) VALUES(item->>'id',NEW.club_id,NEW.team_id,NEW.season_id,'community_match'); END IF;
   END IF;
  END LOOP;
 END IF; RETURN NEW;
END $fn$;
CREATE TRIGGER matches_game_context AFTER INSERT ON matches FOR EACH ROW EXECUTE FUNCTION record_game_contexts();
CREATE TRIGGER documents_game_context AFTER INSERT OR UPDATE OF value_json ON documents FOR EACH ROW EXECUTE FUNCTION record_game_contexts();
CREATE FUNCTION context_json() RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$ SELECT COALESCE(NULLIF(current_setting('longball.context',true),'')::jsonb,'{}'::jsonb) $$;
CREATE FUNCTION context_now() RETURNS bigint LANGUAGE sql VOLATILE SET search_path=pg_catalog,longball AS $$ SELECT greatest(COALESCE((longball.context_json()->>'nowMs')::bigint,0),floor(extract(epoch FROM clock_timestamp())*1000)::bigint) $$;
CREATE TABLE runtime_roles(role_name name PRIMARY KEY,purpose text NOT NULL CHECK(purpose IN('api','worker')));
CREATE FUNCTION runtime_purpose() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,longball AS $$ SELECT COALESCE((SELECT purpose FROM longball.runtime_roles WHERE role_name=session_user::name),CASE WHEN EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname='longball' AND pg_has_role(session_user,n.nspowner,'MEMBER')) OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname=session_user AND r.rolsuper) THEN 'maintenance' ELSE NULL END) $$;
CREATE FUNCTION actor_valid() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,longball AS $$ SELECT longball.runtime_purpose() IN('api','maintenance') AND longball.context_json()->>'kind'='actor' AND EXISTS(SELECT 1 FROM longball.accounts a WHERE a.id=longball.context_json()->>'accountId' AND a.issuer=longball.context_json()->>'issuer' AND a.subject=longball.context_json()->>'subject' AND a.status='active') $$;
CREATE FUNCTION context_matches(c text,t text,s text) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,longball AS $$ SELECT c IS NOT NULL AND (longball.context_json()->>'clubId' IS NULL OR longball.context_json()->>'clubId'=c) AND (longball.context_json()->>'teamId' IS NULL OR longball.context_json()->>'teamId'=t) AND (longball.context_json()->>'seasonId' IS NULL OR longball.context_json()->>'seasonId'=s OR (longball.context_json()->>'operation'='season.create' AND longball.context_json()->>'newSeasonId'=s)) $$;
CREATE FUNCTION raw_spectator_grant(a text,c text,t text,s text) RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $$ SELECT c IS NOT NULL AND EXISTS(SELECT 1 FROM longball.documents d CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.value_json->'grants','[]'::jsonb))g WHERE d.club_id=c AND d.team_id=t AND d.season_id=s AND d.kind='community' AND g->>'accountId'=a AND g->>'teamId'=t AND g->>'seasonId'=s AND g->>'revokedAtMs' IS NULL AND (g->>'startsAtMs')::bigint<=longball.context_now() AND (g->>'expiresAtMs')::bigint>longball.context_now()) $$;
CREATE FUNCTION actor_role(c text,t text,s text) RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $fn$
DECLARE chosen text; BEGIN
 IF NOT longball.actor_valid() OR NOT longball.context_matches(c,t,s) THEN RETURN NULL; END IF;
 SELECT m.role INTO chosen FROM longball.memberships m JOIN longball.accounts a ON a.id=m.account_id
 WHERE m.account_id=longball.context_json()->>'accountId' AND m.club_id=c AND m.team_id=t AND m.season_id=s AND m.revoked_at IS NULL AND (m.expires_at IS NULL OR m.expires_at>longball.context_now())
 AND (CASE WHEN COALESCE(longball.context_json()->>'requestedRole','default')='default' THEN (m.role IN('manager','player','spectator') OR (m.role='administrator' AND longball.context_json()->>'operation' IN('staff.read','staff.assign','staff.revoke','configuration.read','configuration.write','season.options','season.create'))) ELSE m.role=longball.context_json()->>'requestedRole' END)
 AND (m.role NOT IN('manager','administrator') OR (a.classification='adult_individual' AND a.adult_verified=1 AND longball.context_json()->>'strongAuth'='true'))
 AND (m.role<>'spectator' OR longball.raw_spectator_grant(m.account_id,c,t,s))
 ORDER BY CASE m.role WHEN 'manager' THEN 1 WHEN 'player' THEN 2 WHEN 'spectator' THEN 3 ELSE 4 END LIMIT 1;
 RETURN chosen;
END $fn$;
CREATE FUNCTION actor_admin(c text,t text,s text) RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $$ SELECT longball.actor_role(c,t,s)='administrator' $$;
CREATE FUNCTION actor_manager(c text,t text,s text) RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $$ SELECT longball.actor_role(c,t,s)='manager' $$;
CREATE FUNCTION invite_capability(c text,t text,s text) RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $$ SELECT longball.actor_valid() AND longball.context_matches(c,t,s) AND longball.context_json()->>'teamId'=t AND longball.context_json()->>'seasonId'=s AND longball.context_json()->>'operation'='invite.accept' AND EXISTS(SELECT 1 FROM longball.documents d CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.value_json->'invitations','[]'::jsonb))i WHERE d.club_id=c AND d.team_id=t AND d.season_id=s AND d.kind='community' AND encode(sha256(convert_to(i->>'reviewCode','UTF8')),'hex')=longball.context_json()->>'invitationTokenHash' AND i->>'revokedAtMs' IS NULL AND (i->>'acceptedBy' IS NULL OR i->>'acceptedBy'=longball.context_json()->>'accountId') AND (i->>'expiresAtMs')::bigint>longball.context_now()) $$;
-- Job ancestry comes from stored payload scope once, then cannot be changed by a worker.
ALTER TABLE jobs ADD COLUMN club_id text,ADD COLUMN team_id text,ADD COLUMN season_id text,ADD COLUMN lease_token_hash text CHECK(lease_token_hash IS NULL OR lease_token_hash ~ '^[a-f0-9]{64}$');
UPDATE jobs j SET team_id=j.payload_json->>'teamId',season_id=j.payload_json->>'seasonId',club_id=t.club_id FROM teams t WHERE t.id=j.payload_json->>'teamId';
ALTER TABLE jobs ADD CONSTRAINT jobs_season_scope FOREIGN KEY(club_id,team_id,season_id) REFERENCES team_seasons(club_id,team_id,season_id);
CREATE FUNCTION worker_job_valid(c text,t text,s text) RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $$ SELECT longball.runtime_purpose() IN('worker','maintenance') AND longball.context_json()->>'kind'='worker_job' AND longball.context_json()->>'clubId'=c AND longball.context_json()->>'teamId'=t AND longball.context_json()->>'seasonId'=s AND EXISTS(SELECT 1 FROM longball.jobs j WHERE j.id=longball.context_json()->>'jobId' AND j.club_id=c AND j.team_id=t AND j.season_id=s AND j.state='leased' AND j.lease_until>longball.context_now() AND j.lease_token_hash=encode(sha256(convert_to(longball.context_json()->>'leaseToken','UTF8')),'hex')) $$;
CREATE FUNCTION worker_kind() RETURNS text LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $$ SELECT j.kind FROM longball.jobs j WHERE j.id=longball.context_json()->>'jobId' AND longball.worker_job_valid(j.club_id,j.team_id,j.season_id) $$;
CREATE FUNCTION worker_account(a text,c text,t text,s text) RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $$ SELECT longball.worker_job_valid(c,t,s) AND EXISTS(SELECT 1 FROM longball.jobs j WHERE j.id=longball.context_json()->>'jobId' AND ((j.kind='notification.dispatch' AND j.payload_json->>'accountId'=a) OR (j.kind='award.finalise' AND EXISTS(SELECT 1 FROM longball.memberships m WHERE m.account_id=a AND m.club_id=c AND m.team_id=t AND m.season_id=s)))) $$;
CREATE FUNCTION spectator_grant_active(a text,c text,t text,s text) RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $$ SELECT ((longball.actor_valid() AND (a=longball.context_json()->>'accountId' OR longball.actor_role(c,t,s) IS NOT NULL)) OR longball.worker_account(a,c,t,s)) AND longball.raw_spectator_grant(a,c,t,s) $$;
CREATE FUNCTION activation_account(a text,verified boolean DEFAULT false) RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $fn$
BEGIN
 IF longball.runtime_purpose() NOT IN('api','maintenance') OR longball.runtime_purpose() IS NULL OR longball.context_json()->>'kind'<>'activation_token' OR (verified AND COALESCE(longball.context_json()->>'completionVerified','false')<>'true') OR to_regclass('longball.lb_activation_tokens') IS NULL THEN RETURN false; END IF;
 RETURN EXISTS(SELECT 1 FROM longball.lb_activation_tokens x WHERE x.account_id=a AND x.token_hash=longball.context_json()->>'tokenHash' AND (longball.context_json()->>'activationId' IS NULL OR x.id=longball.context_json()->>'activationId') AND x.state IN('issued','redeeming','completed') AND x.expires_at>longball.context_now());
END $fn$;
CREATE FUNCTION account_visible(a text) RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $$ SELECT (longball.actor_valid() AND (a=longball.context_json()->>'accountId' OR EXISTS(SELECT 1 FROM longball.memberships m WHERE m.account_id=a AND m.club_id IS NOT NULL AND m.team_id=longball.context_json()->>'teamId' AND ((m.season_id=longball.context_json()->>'seasonId' AND longball.actor_role(m.club_id,m.team_id,m.season_id) IS NOT NULL) OR (longball.context_json()->>'operation' IN('staff.read','staff.assign','staff.revoke') AND longball.actor_admin(m.club_id,m.team_id,longball.context_json()->>'seasonId')))) OR (a=longball.context_json()->>'staffTargetAccountId' AND longball.context_json()->>'operation' IN('staff.assign','staff.revoke') AND EXISTS(SELECT 1 FROM longball.team_seasons ts WHERE ts.team_id=longball.context_json()->>'teamId' AND ts.season_id=longball.context_json()->>'seasonId' AND longball.actor_admin(ts.club_id,ts.team_id,ts.season_id))))) OR longball.activation_account(a) OR EXISTS(SELECT 1 FROM longball.jobs j WHERE j.id=longball.context_json()->>'jobId' AND j.kind='notification.dispatch' AND longball.worker_account(a,j.club_id,j.team_id,j.season_id)) $$;
CREATE FUNCTION activation_account_update_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,longball AS $fn$
BEGIN
 IF longball.context_json()->>'kind'='activation_token' AND (NOT longball.activation_account(OLD.id,true) OR NEW.id IS DISTINCT FROM OLD.id OR NEW.issuer IS DISTINCT FROM OLD.issuer OR NEW.subject IS DISTINCT FROM OLD.subject OR NEW.classification IS DISTINCT FROM OLD.classification OR NEW.adult_verified IS DISTINCT FROM OLD.adult_verified OR NEW.strong_auth_enrolled IS DISTINCT FROM OLD.strong_auth_enrolled OR NEW.status<>'active') THEN RAISE EXCEPTION 'Activation account update unavailable' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $fn$;
CREATE TRIGGER activation_account_update_boundary BEFORE UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION activation_account_update_guard();
CREATE FUNCTION derive_season_scope() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,longball AS $fn$
DECLARE c text; BEGIN
 SELECT club_id INTO c FROM longball.teams WHERE id=NEW.team_id AND scope_status='resolved';
 IF c IS NULL OR (NEW.club_id IS NOT NULL AND NEW.club_id<>c) THEN RAISE EXCEPTION 'Object scope unavailable' USING ERRCODE='42501'; END IF;
 NEW.club_id=c;
 IF NOT EXISTS(SELECT 1 FROM longball.team_seasons WHERE club_id=c AND team_id=NEW.team_id AND season_id=NEW.season_id) THEN RAISE EXCEPTION 'Object scope unavailable' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $fn$;
CREATE TRIGGER matches_scope BEFORE INSERT OR UPDATE OF club_id,team_id,season_id ON matches FOR EACH ROW EXECUTE FUNCTION derive_season_scope();
CREATE TRIGGER memberships_scope BEFORE INSERT OR UPDATE OF club_id,team_id,season_id ON memberships FOR EACH ROW EXECUTE FUNCTION derive_season_scope();
CREATE TRIGGER documents_scope BEFORE INSERT OR UPDATE OF club_id,team_id,season_id ON documents FOR EACH ROW EXECUTE FUNCTION derive_season_scope();
CREATE FUNCTION derive_match_scope() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,longball AS $fn$
DECLARE p record; BEGIN
 SELECT club_id,team_id,season_id INTO p FROM longball.matches WHERE id=NEW.match_id;
 IF p.club_id IS NULL OR (NEW.club_id IS NOT NULL AND NEW.club_id<>p.club_id) OR (NEW.team_id IS NOT NULL AND NEW.team_id<>p.team_id) OR (NEW.season_id IS NOT NULL AND NEW.season_id<>p.season_id) THEN RAISE EXCEPTION 'Object scope unavailable' USING ERRCODE='42501'; END IF;
 NEW.club_id=p.club_id; NEW.team_id=p.team_id; NEW.season_id=p.season_id; RETURN NEW;
END $fn$;
DO $scope$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['controller_grants','controller_history','events','streams','conflicting_submissions','transfers','clock_challenges','clock_mappings','reconciliation_proposals'] LOOP
  EXECUTE format('ALTER TABLE longball.%I ADD COLUMN club_id text,ADD COLUMN team_id text,ADD COLUMN season_id text',tab);
  EXECUTE format('UPDATE longball.%I x SET club_id=m.club_id,team_id=m.team_id,season_id=m.season_id FROM longball.matches m WHERE m.id=x.match_id',tab);
  EXECUTE format('ALTER TABLE longball.%I ADD CONSTRAINT %I FOREIGN KEY(match_id,club_id,team_id,season_id) REFERENCES longball.matches(id,club_id,team_id,season_id)',tab,tab||'_match_scope');
  EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OF match_id,club_id,team_id,season_id ON longball.%I FOR EACH ROW EXECUTE FUNCTION longball.derive_match_scope()',tab||'_scope',tab);
 END LOOP;
END $scope$;
ALTER TABLE audit ADD COLUMN club_id text,ADD COLUMN team_id text,ADD COLUMN season_id text,ADD COLUMN context_operation text;
ALTER TABLE idempotency ADD COLUMN club_id text,ADD COLUMN team_id text,ADD COLUMN season_id text,ADD COLUMN context_operation text,ADD COLUMN requested_role text;
ALTER TABLE audit ADD CONSTRAINT audit_season_scope FOREIGN KEY(club_id,team_id,season_id) REFERENCES team_seasons(club_id,team_id,season_id);
ALTER TABLE idempotency ADD CONSTRAINT idempotency_season_scope FOREIGN KEY(club_id,team_id,season_id) REFERENCES team_seasons(club_id,team_id,season_id);
CREATE FUNCTION stamp_request_scope() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,longball AS $fn$
DECLARE c text; BEGIN
 IF longball.context_json()->>'kind'='actor' THEN
  IF NEW.team_id IS NOT NULL AND NEW.team_id IS DISTINCT FROM longball.context_json()->>'teamId' OR NEW.season_id IS NOT NULL AND NEW.season_id IS DISTINCT FROM longball.context_json()->>'seasonId' THEN RAISE EXCEPTION 'Object scope unavailable' USING ERRCODE='42501'; END IF;
  NEW.team_id=longball.context_json()->>'teamId'; NEW.season_id=longball.context_json()->>'seasonId';
  IF NEW.team_id IS NOT NULL THEN SELECT club_id INTO c FROM longball.teams WHERE id=NEW.team_id; IF c IS NULL THEN RAISE EXCEPTION 'Object scope unavailable' USING ERRCODE='42501'; END IF; END IF;
  NEW.club_id=c; NEW.context_operation=longball.context_json()->>'operation';
  IF TG_TABLE_NAME='idempotency' THEN NEW.requested_role=COALESCE(longball.context_json()->>'requestedRole','default'); END IF;
 END IF;
 RETURN NEW;
END $fn$;
CREATE TRIGGER audit_scope BEFORE INSERT ON audit FOR EACH ROW EXECUTE FUNCTION stamp_request_scope();
CREATE TRIGGER idempotency_scope BEFORE INSERT ON idempotency FOR EACH ROW EXECUTE FUNCTION stamp_request_scope();
CREATE FUNCTION derive_job_scope() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,longball AS $fn$
DECLARE c text; BEGIN
 IF TG_OP='UPDATE' AND (NEW.kind IS DISTINCT FROM OLD.kind OR NEW.business_key IS DISTINCT FROM OLD.business_key OR NEW.club_id IS DISTINCT FROM OLD.club_id OR NEW.team_id IS DISTINCT FROM OLD.team_id OR NEW.season_id IS DISTINCT FROM OLD.season_id OR (NEW.payload_json->>'accountId') IS DISTINCT FROM (OLD.payload_json->>'accountId') OR (NEW.payload_json->>'teamId') IS DISTINCT FROM (OLD.payload_json->>'teamId') OR (NEW.payload_json->>'seasonId') IS DISTINCT FROM (OLD.payload_json->>'seasonId') OR (NEW.payload_json->>'matchId') IS DISTINCT FROM (OLD.payload_json->>'matchId') OR (NEW.payload_json->>'entityId') IS DISTINCT FROM (OLD.payload_json->>'entityId') OR (NEW.payload_json->>'category') IS DISTINCT FROM (OLD.payload_json->>'category') OR (NEW.payload_json->>'audience') IS DISTINCT FROM (OLD.payload_json->>'audience') OR (NEW.payload_json->>'playerId') IS DISTINCT FROM (OLD.payload_json->>'playerId')) THEN RAISE EXCEPTION 'Immutable job scope' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND longball.context_json()->>'kind'='worker_job' AND (NEW.lease_token_hash IS DISTINCT FROM OLD.lease_token_hash OR (NEW.lease_until IS NOT NULL AND (OLD.lease_until IS NULL OR NEW.lease_until>OLD.lease_until)) OR NEW.attempts<OLD.attempts OR NEW.attempts>OLD.attempts+1) THEN RAISE EXCEPTION 'Immutable worker lease boundary' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.team_id IS NOT NULL AND NEW.team_id IS DISTINCT FROM NEW.payload_json->>'teamId' OR NEW.season_id IS NOT NULL AND NEW.season_id IS DISTINCT FROM NEW.payload_json->>'seasonId' THEN RAISE EXCEPTION 'Object scope unavailable' USING ERRCODE='42501'; END IF;
  NEW.team_id=NEW.payload_json->>'teamId'; NEW.season_id=NEW.payload_json->>'seasonId';
  SELECT club_id INTO c FROM longball.teams WHERE id=NEW.team_id AND scope_status='resolved';
  IF c IS NULL OR NEW.club_id IS NOT NULL AND NEW.club_id<>c THEN RAISE EXCEPTION 'Object scope unavailable' USING ERRCODE='42501'; END IF; NEW.club_id=c;
 END IF; RETURN NEW;
END $fn$;
CREATE TRIGGER jobs_scope BEFORE INSERT OR UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION derive_job_scope();
ALTER TABLE privacy_requests ADD COLUMN club_id text;
UPDATE privacy_requests r SET club_id=t.club_id FROM teams t WHERE t.id=r.team_id;
ALTER TABLE privacy_requests ADD CONSTRAINT privacy_request_season_scope FOREIGN KEY(club_id,team_id,season_id) REFERENCES team_seasons(club_id,team_id,season_id);
CREATE FUNCTION derive_privacy_scope() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,longball AS $fn$
DECLARE c text; BEGIN
 IF NEW.team_id IS NULL THEN
  IF NEW.season_id IS NOT NULL OR NEW.club_id IS NOT NULL THEN RAISE EXCEPTION 'Object scope unavailable' USING ERRCODE='42501'; END IF;
 ELSE
  SELECT ts.club_id INTO c FROM longball.team_seasons ts WHERE ts.team_id=NEW.team_id AND ts.season_id=NEW.season_id;
  IF c IS NULL OR NEW.club_id IS NOT NULL AND NEW.club_id<>c THEN RAISE EXCEPTION 'Object scope unavailable' USING ERRCODE='42501'; END IF;
  NEW.club_id=c;
 END IF; RETURN NEW;
END $fn$;
CREATE TRIGGER privacy_scope BEFORE INSERT OR UPDATE OF club_id,team_id,season_id ON privacy_requests FOR EACH ROW EXECUTE FUNCTION derive_privacy_scope();
-- NULL club legacy rows remain retained but are deliberately not visible to runtime roles.
DO $scope$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['clubs','teams','team_seasons','game_contexts','accounts','memberships','matches','documents','devices','controller_grants','controller_history','events','streams','conflicting_submissions','transfers','clock_challenges','clock_mappings','reconciliation_proposals','audit','idempotency','privacy_requests','privacy_pending_keys','jobs'] LOOP EXECUTE format('ALTER TABLE longball.%I ENABLE ROW LEVEL SECURITY',tab); END LOOP;
END $scope$;
CREATE POLICY accounts_read ON accounts FOR SELECT USING ((runtime_purpose() IN('api','maintenance') AND context_json()->>'kind'='identity' AND issuer=context_json()->>'issuer' AND subject=context_json()->>'subject') OR account_visible(id));
CREATE POLICY accounts_create ON accounts FOR INSERT WITH CHECK (id=context_json()->>'provisionAccountId' AND classification='child_shared' AND status='disabled' AND adult_verified=0 AND strong_auth_enrolled=0 AND EXISTS(SELECT 1 FROM team_seasons ts WHERE ts.team_id=context_json()->>'teamId' AND ts.season_id=context_json()->>'seasonId' AND actor_manager(ts.club_id,ts.team_id,ts.season_id)));
CREATE POLICY accounts_update ON accounts FOR UPDATE USING (activation_account(id,true) OR (id=context_json()->>'provisionAccountId' AND classification='child_shared' AND EXISTS(SELECT 1 FROM team_seasons ts WHERE ts.team_id=context_json()->>'teamId' AND ts.season_id=context_json()->>'seasonId' AND actor_manager(ts.club_id,ts.team_id,ts.season_id)))) WITH CHECK(classification='child_shared' AND adult_verified=0 AND strong_auth_enrolled=0);
CREATE POLICY teams_read ON teams FOR SELECT USING (club_id IS NOT NULL AND ((actor_valid() AND EXISTS(SELECT 1 FROM memberships m WHERE m.account_id=context_json()->>'accountId' AND m.team_id=teams.id AND (context_json()->>'teamId' IS NULL OR context_json()->>'teamId'=teams.id))) OR EXISTS(SELECT 1 FROM team_seasons ts WHERE ts.team_id=teams.id AND invite_capability(ts.club_id,ts.team_id,ts.season_id)) OR worker_job_valid(club_id,id,context_json()->>'seasonId')));
CREATE POLICY clubs_read ON clubs FOR SELECT USING (EXISTS(SELECT 1 FROM teams t WHERE t.club_id=clubs.id));
CREATE POLICY seasons_read ON team_seasons FOR SELECT USING ((actor_valid() AND ((team_id=context_json()->>'teamId' AND EXISTS(SELECT 1 FROM memberships m WHERE m.account_id=context_json()->>'accountId' AND m.team_id=team_seasons.team_id AND m.season_id=context_json()->>'seasonId' AND m.revoked_at IS NULL AND (m.expires_at IS NULL OR m.expires_at>context_now()))) OR EXISTS(SELECT 1 FROM memberships m WHERE m.account_id=context_json()->>'accountId' AND m.club_id=team_seasons.club_id AND m.team_id=team_seasons.team_id AND m.season_id=team_seasons.season_id))) OR invite_capability(club_id,team_id,season_id) OR worker_job_valid(club_id,team_id,season_id));
CREATE POLICY seasons_create ON team_seasons FOR INSERT WITH CHECK (context_json()->>'operation'='season.create' AND team_id=context_json()->>'teamId' AND season_id=context_json()->>'newSeasonId' AND actor_admin(club_id,team_id,context_json()->>'seasonId'));
CREATE POLICY game_contexts_read ON game_contexts FOR SELECT USING (actor_role(club_id,team_id,season_id) IN('manager','player','spectator') OR worker_job_valid(club_id,team_id,season_id));
CREATE POLICY game_contexts_insert ON game_contexts FOR INSERT WITH CHECK (actor_manager(club_id,team_id,season_id));
CREATE POLICY memberships_read ON memberships FOR SELECT USING (club_id IS NOT NULL AND ((actor_valid() AND ((account_id=context_json()->>'accountId' AND (context_json()->>'teamId' IS NULL OR team_id=context_json()->>'teamId') AND (context_json()->>'seasonId' IS NULL OR season_id=context_json()->>'seasonId' OR context_json()->>'operation' IN('staff.read','staff.assign','staff.revoke','season.options','season.create'))) OR (team_id=context_json()->>'teamId' AND season_id=context_json()->>'seasonId' AND actor_role(club_id,team_id,season_id) IS NOT NULL) OR (team_id=context_json()->>'teamId' AND context_json()->>'operation' IN('staff.read','staff.assign','staff.revoke') AND actor_admin(club_id,team_id,context_json()->>'seasonId')))) OR worker_account(account_id,club_id,team_id,season_id)));
CREATE POLICY memberships_insert ON memberships FOR INSERT WITH CHECK ((actor_manager(club_id,team_id,season_id) AND ((role='player' AND account_id=context_json()->>'provisionAccountId') OR role='spectator')) OR (actor_admin(club_id,team_id,COALESCE(context_json()->>'seasonId',season_id)) AND ((role='manager' AND account_id=context_json()->>'staffTargetAccountId') OR (context_json()->>'operation'='season.create' AND season_id=context_json()->>'newSeasonId'))) OR (role='spectator' AND account_id=context_json()->>'accountId' AND invite_capability(club_id,team_id,season_id)));
CREATE POLICY memberships_update ON memberships FOR UPDATE USING ((actor_manager(club_id,team_id,season_id) AND role='spectator') OR (actor_admin(club_id,team_id,season_id) AND role='manager' AND account_id=context_json()->>'staffTargetAccountId') OR (role='spectator' AND account_id=context_json()->>'accountId' AND invite_capability(club_id,team_id,season_id))) WITH CHECK ((actor_manager(club_id,team_id,season_id) AND role='spectator') OR (actor_admin(club_id,team_id,season_id) AND role='manager' AND account_id=context_json()->>'staffTargetAccountId') OR (role='spectator' AND account_id=context_json()->>'accountId' AND invite_capability(club_id,team_id,season_id)));
CREATE FUNCTION document_write(c text,t text,s text,k text) RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $$ SELECT
 longball.actor_manager(c,t,s)
 OR (longball.actor_admin(c,t,longball.context_json()->>'seasonId') AND ((k='preparation' AND longball.context_json()->>'operation'='configuration.write' AND s=longball.context_json()->>'seasonId') OR (k='staff' AND longball.context_json()->>'operation' IN('staff.assign','staff.revoke') AND s=longball.context_json()->>'seasonId') OR (longball.context_json()->>'operation'='season.create' AND s=longball.context_json()->>'newSeasonId')))
 OR (longball.actor_role(c,t,s) IN('player','spectator') AND ((k='community' AND longball.context_json()->>'operation'='community.write') OR (k='preparation' AND longball.context_json()->>'operation'='preparation.own.write')))
 OR (k='community' AND longball.invite_capability(c,t,s))
 OR (k='community' AND longball.worker_job_valid(c,t,s) AND longball.worker_kind()='award.finalise') $$;
CREATE FUNCTION worker_match(m text,c text,t text,s text) RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $$ SELECT longball.worker_job_valid(c,t,s) AND EXISTS(SELECT 1 FROM longball.jobs j WHERE j.id=longball.context_json()->>'jobId' AND ((j.kind='award.finalise' AND j.payload_json->>'matchId'=m) OR (j.kind='notification.dispatch' AND j.payload_json->>'category'='match' AND j.payload_json->>'entityId'=m))) $$;
CREATE POLICY documents_read ON documents FOR SELECT USING ((team_id=context_json()->>'teamId' AND season_id=context_json()->>'seasonId' AND (actor_role(club_id,team_id,season_id) IN('manager','player','spectator') OR (actor_admin(club_id,team_id,season_id) AND ((kind IN('community','staff') AND context_json()->>'operation' IN('staff.read','staff.assign','staff.revoke')) OR (kind='preparation' AND context_json()->>'operation' IN('configuration.read','configuration.write')) OR (kind IN('preparation','community','records') AND context_json()->>'operation' IN('season.options','season.create')))))) OR (kind='community' AND invite_capability(club_id,team_id,season_id)) OR (worker_job_valid(club_id,team_id,season_id) AND ((kind='community') OR (kind='preparation' AND worker_kind()='notification.dispatch' AND EXISTS(SELECT 1 FROM jobs j WHERE j.id=context_json()->>'jobId' AND j.payload_json->>'category'='schedule')))));
CREATE POLICY documents_insert ON documents FOR INSERT WITH CHECK (document_write(club_id,team_id,season_id,kind));
CREATE POLICY documents_update ON documents FOR UPDATE USING (document_write(club_id,team_id,season_id,kind)) WITH CHECK (document_write(club_id,team_id,season_id,kind));
CREATE POLICY matches_read ON matches FOR SELECT USING ((actor_role(club_id,team_id,season_id) IN('manager','player','spectator') AND (context_json()->>'matchId' IS NULL OR id=context_json()->>'matchId')) OR worker_match(id,club_id,team_id,season_id));
CREATE POLICY matches_insert ON matches FOR INSERT WITH CHECK (actor_manager(club_id,team_id,season_id));
CREATE POLICY matches_update ON matches FOR UPDATE USING (actor_manager(club_id,team_id,season_id)) WITH CHECK (actor_manager(club_id,team_id,season_id));
CREATE POLICY devices_read ON devices FOR SELECT USING (actor_valid() AND (account_id=context_json()->>'accountId' OR account_visible(account_id)));
CREATE POLICY devices_insert ON devices FOR INSERT WITH CHECK (actor_valid() AND account_id=context_json()->>'accountId');
CREATE POLICY devices_update ON devices FOR UPDATE USING (actor_valid() AND account_id=context_json()->>'accountId') WITH CHECK (actor_valid() AND account_id=context_json()->>'accountId');
DO $scope$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['controller_grants','controller_history','events','streams','conflicting_submissions','transfers','clock_challenges','clock_mappings','reconciliation_proposals'] LOOP
  EXECUTE format('CREATE POLICY scoped_read ON longball.%I FOR SELECT USING (longball.actor_manager(club_id,team_id,season_id) AND (longball.context_json()->>''matchId'' IS NULL OR match_id=longball.context_json()->>''matchId''))',tab);
  EXECUTE format('CREATE POLICY scoped_insert ON longball.%I FOR INSERT WITH CHECK (longball.actor_manager(club_id,team_id,season_id))',tab);
  EXECUTE format('CREATE POLICY scoped_update ON longball.%I FOR UPDATE USING (longball.actor_manager(club_id,team_id,season_id) OR (longball.context_json()->>''operation''=''staff.revoke'' AND longball.actor_admin(club_id,team_id,season_id))) WITH CHECK (longball.actor_manager(club_id,team_id,season_id) OR (longball.context_json()->>''operation''=''staff.revoke'' AND longball.actor_admin(club_id,team_id,season_id)))',tab);
 END LOOP;
END $scope$;
CREATE POLICY audit_read ON audit FOR SELECT USING (actor_valid() AND actor_id=context_json()->>'accountId' AND context_matches(club_id,team_id,season_id));
CREATE POLICY audit_insert ON audit FOR INSERT WITH CHECK (actor_valid() AND actor_id=context_json()->>'accountId' AND context_operation=context_json()->>'operation' AND ((team_id IS NULL AND season_id IS NULL) OR context_matches(club_id,team_id,season_id)));
CREATE POLICY idempotency_read ON idempotency FOR SELECT USING (actor_valid() AND account_id=context_json()->>'accountId' AND context_operation=context_json()->>'operation' AND requested_role=COALESCE(context_json()->>'requestedRole','default') AND team_id IS NOT DISTINCT FROM context_json()->>'teamId' AND season_id IS NOT DISTINCT FROM context_json()->>'seasonId');
CREATE POLICY idempotency_insert ON idempotency FOR INSERT WITH CHECK (actor_valid() AND account_id=context_json()->>'accountId' AND context_operation=context_json()->>'operation' AND requested_role=COALESCE(context_json()->>'requestedRole','default') AND team_id IS NOT DISTINCT FROM context_json()->>'teamId' AND season_id IS NOT DISTINCT FROM context_json()->>'seasonId');
CREATE POLICY privacy_read ON privacy_requests FOR SELECT USING (actor_valid() AND account_id=context_json()->>'accountId');
CREATE POLICY privacy_insert ON privacy_requests FOR INSERT WITH CHECK (actor_valid() AND account_id=context_json()->>'accountId' AND context_json()->>'operation'='privacy.request' AND ((team_id IS NULL AND season_id IS NULL AND kind<>'leave_team') OR EXISTS(SELECT 1 FROM memberships m WHERE m.account_id=privacy_requests.account_id AND m.team_id=privacy_requests.team_id AND m.season_id=privacy_requests.season_id)));
CREATE POLICY privacy_keys_read ON privacy_pending_keys FOR SELECT USING (EXISTS(SELECT 1 FROM privacy_requests r WHERE r.id=request_id));
CREATE POLICY privacy_keys_insert ON privacy_pending_keys FOR INSERT WITH CHECK (EXISTS(SELECT 1 FROM privacy_requests r WHERE r.id=request_id AND r.account_id=context_json()->>'accountId' AND r.status='pending_verification_and_policy'));
CREATE POLICY privacy_keys_update ON privacy_pending_keys FOR UPDATE USING (EXISTS(SELECT 1 FROM privacy_requests r WHERE r.id=request_id)) WITH CHECK (EXISTS(SELECT 1 FROM privacy_requests r WHERE r.id=request_id AND r.account_id=context_json()->>'accountId' AND r.status='pending_verification_and_policy'));
CREATE POLICY jobs_read ON jobs FOR SELECT USING (actor_role(club_id,team_id,season_id) IN('manager','player','spectator') OR (id=context_json()->>'jobId' AND worker_job_valid(club_id,team_id,season_id)));
CREATE POLICY jobs_insert ON jobs FOR INSERT WITH CHECK (actor_manager(club_id,team_id,season_id) OR (actor_role(club_id,team_id,season_id) IN('player','spectator') AND kind='notification.dispatch' AND context_json()->>'operation'='community.write'));
CREATE POLICY jobs_update ON jobs FOR UPDATE USING (id=context_json()->>'jobId' AND worker_job_valid(club_id,team_id,season_id)) WITH CHECK (id=context_json()->>'jobId' AND club_id=context_json()->>'clubId' AND team_id=context_json()->>'teamId' AND season_id=context_json()->>'seasonId');
CREATE FUNCTION claim_due_job(p_kind text,p_now bigint,p_capability text) RETURNS SETOF jobs LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $fn$
DECLARE selected_id text; BEGIN
 IF longball.runtime_purpose() NOT IN('worker','maintenance') OR longball.runtime_purpose() IS NULL OR longball.context_json()->>'kind'<>'worker_claim' OR p_kind NOT IN('award.finalise','notification.dispatch') OR p_kind IS DISTINCT FROM longball.context_json()->>'jobKind' OR p_now IS DISTINCT FROM (longball.context_json()->>'nowMs')::bigint OR p_capability !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Job claim unavailable' USING ERRCODE='42501'; END IF;
 SELECT j.id INTO selected_id FROM longball.jobs j WHERE j.kind=p_kind AND j.club_id IS NOT NULL AND ((j.state='pending' AND j.due_at<=p_now) OR (j.state='leased' AND j.lease_until<=p_now)) ORDER BY j.due_at,j.id FOR UPDATE SKIP LOCKED LIMIT 1;
 IF selected_id IS NULL THEN RETURN; END IF;
 UPDATE longball.jobs SET state='leased',lease_until=p_now+30000,lease_token_hash=encode(sha256(convert_to(p_capability,'UTF8')),'hex') WHERE id=selected_id;
 RETURN QUERY SELECT * FROM longball.jobs WHERE id=selected_id;
END $fn$;
-- No new function inherits default PUBLIC execution. Runtime grants are explicit and role-specific.
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA longball FROM PUBLIC;
