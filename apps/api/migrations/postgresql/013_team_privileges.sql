-- SEC17 team-wide contribution privileges. A season change never resets a decision.
CREATE TABLE longball.team_privilege_states(
 team_id text PRIMARY KEY,club_id text NOT NULL,revision integer NOT NULL CHECK(revision>=0),state_json jsonb NOT NULL,
 FOREIGN KEY(club_id,team_id) REFERENCES longball.teams(club_id,id),
 CHECK(state_json->>'schemaVersion'='1' AND state_json->>'teamId'=team_id AND (state_json->>'revision')::integer=revision AND jsonb_typeof(state_json->'restrictions')='array'));
CREATE TABLE longball.team_privilege_decisions(
 team_id text NOT NULL,club_id text NOT NULL,revision integer NOT NULL CHECK(revision>0),command_id text NOT NULL,
 actor_id text NOT NULL REFERENCES longball.accounts(id),target_account_id text NOT NULL REFERENCES longball.accounts(id),
 privilege text NOT NULL CHECK(privilege IN('uploads','invitations')),suspended boolean NOT NULL,
 reason_code text NOT NULL CHECK(reason_code~'^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$'),private_note text CHECK(length(private_note)<=1000),created_at bigint NOT NULL,
 PRIMARY KEY(team_id,revision),UNIQUE(team_id,actor_id,command_id),FOREIGN KEY(club_id,team_id) REFERENCES longball.teams(club_id,id));
INSERT INTO longball.team_privilege_states(team_id,club_id,revision,state_json)
 SELECT id,club_id,0,jsonb_build_object('schemaVersion',1,'teamId',id,'revision',0,'restrictions','[]'::jsonb) FROM longball.teams WHERE club_id IS NOT NULL;
CREATE FUNCTION longball.initialize_team_privileges() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,longball AS $$
 BEGIN IF NEW.club_id IS NOT NULL THEN INSERT INTO longball.team_privilege_states(team_id,club_id,revision,state_json)
 VALUES(NEW.id,NEW.club_id,0,jsonb_build_object('schemaVersion',1,'teamId',NEW.id,'revision',0,'restrictions','[]'::jsonb)) ON CONFLICT(team_id) DO NOTHING; END IF; RETURN NEW; END $$;
CREATE TRIGGER team_privileges_new_team AFTER INSERT OR UPDATE OF club_id ON longball.teams FOR EACH ROW EXECUTE FUNCTION longball.initialize_team_privileges();
CREATE FUNCTION longball.team_privilege_manager(p_club text,p_team text) RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $$
 SELECT longball.runtime_purpose() IN('api','maintenance') AND p_team=longball.context_json()->>'teamId' AND p_club=longball.context_json()->>'clubId'
 AND longball.actor_manager(p_club,p_team,longball.context_json()->>'seasonId') $$;
CREATE FUNCTION longball.team_privilege_target(p_club text,p_team text,p_account text) RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $$
 SELECT longball.team_privilege_manager(p_club,p_team) AND EXISTS(SELECT 1 FROM longball.memberships m JOIN longball.accounts a ON a.id=m.account_id
 WHERE m.account_id=p_account AND m.club_id=p_club AND m.team_id=p_team AND m.season_id=longball.context_json()->>'seasonId'
 AND m.revoked_at IS NULL AND (m.expires_at IS NULL OR m.expires_at>longball.context_now()) AND a.status='active') $$;
-- Only an authenticated account's own boolean can cross the upload/invitation boundary.
CREATE FUNCTION longball.team_privilege_allowed(p_team text,p_account text,p_privilege text,p_lock boolean DEFAULT false) RETURNS boolean
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $$
 DECLARE r record; c text; BEGIN
 IF longball.runtime_purpose() NOT IN('api','maintenance') OR NOT longball.actor_valid() OR p_account IS DISTINCT FROM longball.context_json()->>'accountId'
 OR p_team IS DISTINCT FROM longball.context_json()->>'teamId' OR p_privilege NOT IN('uploads','invitations') THEN RETURN false; END IF;
 SELECT club_id INTO c FROM longball.teams WHERE id=p_team AND scope_status='resolved';
 IF c IS NULL OR c IS DISTINCT FROM longball.context_json()->>'clubId' OR longball.actor_role(c,p_team,longball.context_json()->>'seasonId') IS NULL THEN RETURN false; END IF;
 IF p_lock THEN SELECT * INTO r FROM longball.team_privilege_states WHERE team_id=p_team AND club_id=c FOR SHARE;
 ELSE SELECT * INTO r FROM longball.team_privilege_states WHERE team_id=p_team AND club_id=c; END IF;
 IF NOT FOUND OR r.state_json->>'schemaVersion'<>'1' OR r.state_json->>'teamId'<>p_team OR (r.state_json->>'revision')::integer<>r.revision OR jsonb_typeof(r.state_json->'restrictions')<>'array' THEN RETURN false; END IF;
 RETURN NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r.state_json->'restrictions')x(value) WHERE x.value->>'accountId'=p_account AND x.value->>'privilege'=p_privilege AND x.value->>'suspended'='true');
 END $$;
CREATE FUNCTION longball.guard_team_privilege_state() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,longball AS $$
 BEGIN IF ROW(NEW.team_id,NEW.club_id) IS DISTINCT FROM ROW(OLD.team_id,OLD.club_id) OR NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'Invalid team privilege revision' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
CREATE TRIGGER team_privilege_state_guard BEFORE UPDATE ON longball.team_privilege_states FOR EACH ROW EXECUTE FUNCTION longball.guard_team_privilege_state();
CREATE FUNCTION longball.team_privilege_audit_required() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,longball AS $$
 DECLARE d record; before_other jsonb; after_other jsonb; BEGIN
 SELECT * INTO d FROM longball.team_privilege_decisions WHERE team_id=NEW.team_id AND revision=NEW.revision;
 IF NOT FOUND OR d.club_id<>NEW.club_id THEN RAISE EXCEPTION 'Team privilege decision audit required' USING ERRCODE='23514'; END IF;
 SELECT COALESCE(jsonb_agg(x.value ORDER BY x.value->>'accountId',x.value->>'privilege'),'[]'::jsonb) INTO before_other FROM jsonb_array_elements(OLD.state_json->'restrictions')x(value) WHERE NOT(x.value->>'accountId'=d.target_account_id AND x.value->>'privilege'=d.privilege);
 SELECT COALESCE(jsonb_agg(x.value ORDER BY x.value->>'accountId',x.value->>'privilege'),'[]'::jsonb) INTO after_other FROM jsonb_array_elements(NEW.state_json->'restrictions')x(value) WHERE NOT(x.value->>'accountId'=d.target_account_id AND x.value->>'privilege'=d.privilege);
 IF before_other IS DISTINCT FROM after_other OR (SELECT count(*) FROM jsonb_array_elements(NEW.state_json->'restrictions')x(value) WHERE x.value->>'accountId'=d.target_account_id AND x.value->>'privilege'=d.privilege AND (x.value->>'suspended')::boolean=d.suspended)<>1 THEN RAISE EXCEPTION 'Team privilege audit does not match its revision' USING ERRCODE='23514'; END IF;
 RETURN NULL; END $$;
CREATE CONSTRAINT TRIGGER team_privilege_audit_required AFTER UPDATE ON longball.team_privilege_states DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION longball.team_privilege_audit_required();
CREATE FUNCTION longball.immutable_team_privilege_decision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,longball AS $$ BEGIN RAISE EXCEPTION 'Immutable team privilege decision' USING ERRCODE='23514'; END $$;
CREATE TRIGGER immutable_team_privilege_decision BEFORE UPDATE OR DELETE ON longball.team_privilege_decisions FOR EACH ROW EXECUTE FUNCTION longball.immutable_team_privilege_decision();
ALTER TABLE longball.team_privilege_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE longball.team_privilege_decisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY team_privilege_state_read ON longball.team_privilege_states FOR SELECT USING(longball.team_privilege_manager(club_id,team_id) AND longball.context_json()->>'operation' IN('privileges.read','privileges.write'));
CREATE POLICY team_privilege_state_update ON longball.team_privilege_states FOR UPDATE USING(longball.team_privilege_manager(club_id,team_id) AND longball.context_json()->>'operation'='privileges.write') WITH CHECK(longball.team_privilege_manager(club_id,team_id) AND longball.context_json()->>'operation'='privileges.write');
CREATE POLICY team_privilege_decision_read ON longball.team_privilege_decisions FOR SELECT USING(longball.team_privilege_manager(club_id,team_id) AND longball.context_json()->>'operation' IN('privileges.read','privileges.write') AND target_account_id<>longball.context_json()->>'accountId');
CREATE POLICY team_privilege_decision_insert ON longball.team_privilege_decisions FOR INSERT WITH CHECK(longball.team_privilege_manager(club_id,team_id) AND longball.context_json()->>'operation'='privileges.write' AND actor_id=longball.context_json()->>'accountId' AND longball.team_privilege_target(club_id,team_id,target_account_id) AND created_at=longball.context_now());
REVOKE ALL ON FUNCTION longball.initialize_team_privileges(),longball.team_privilege_manager(text,text),longball.team_privilege_target(text,text,text),longball.team_privilege_allowed(text,text,text,boolean),longball.guard_team_privilege_state(),longball.team_privilege_audit_required(),longball.immutable_team_privilege_decision() FROM PUBLIC;
