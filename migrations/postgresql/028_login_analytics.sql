-- Minimal application authentication observations. These are not provider audit logs.
-- No password, bearer/digest, attempted username, address or device fingerprint is stored.
CREATE TABLE longball.login_reporting_state(singleton integer PRIMARY KEY CHECK(singleton=1),started_at bigint);
INSERT INTO longball.login_reporting_state VALUES(1,NULL);
CREATE TABLE longball.login_access_snapshots(id text PRIMARY KEY,account_id text NOT NULL REFERENCES longball.accounts(id),label text NOT NULL,role text NOT NULL CHECK(role IN('super_admin','club_admin','manager','player','spectator')),scopes_json jsonb NOT NULL,scopes_truncated boolean NOT NULL DEFAULT false);
CREATE TABLE longball.login_events(ordinal bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,id text NOT NULL UNIQUE,at bigint NOT NULL CHECK(at BETWEEN 0 AND 9007199254740991),type text NOT NULL CHECK(type IN('login_success','login_failure','logout')),provider text NOT NULL CHECK(provider IN('demo','spectator_pin','oidc')),account_id text REFERENCES longball.accounts(id),snapshot_id text REFERENCES longball.login_access_snapshots(id),session_id text,reason text,count integer NOT NULL DEFAULT 1 CHECK(count BETWEEN 1 AND 1000000),CHECK((type='login_failure' AND account_id IS NULL AND snapshot_id IS NULL AND session_id IS NULL) OR(type<>'login_failure' AND account_id IS NOT NULL AND snapshot_id IS NOT NULL AND session_id IS NOT NULL)));
CREATE INDEX login_events_at ON longball.login_events(at DESC,id DESC);
CREATE INDEX login_events_account ON longball.login_events(account_id,at DESC);
CREATE TABLE longball.login_sessions(session_id text PRIMARY KEY,account_id text NOT NULL REFERENCES longball.accounts(id),snapshot_id text NOT NULL REFERENCES longball.login_access_snapshots(id),provider text NOT NULL CHECK(provider IN('demo','spectator_pin','oidc')),runtime_id text NOT NULL,issued_at bigint NOT NULL,expires_at bigint,last_seen_at bigint NOT NULL,ended_at bigint);
CREATE INDEX login_sessions_seen ON longball.login_sessions(last_seen_at DESC);
ALTER TABLE longball.login_reporting_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE longball.login_access_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE longball.login_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE longball.login_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY login_reporting_no_direct_access ON longball.login_reporting_state USING(false);
CREATE POLICY login_access_no_direct_access ON longball.login_access_snapshots USING(false);
CREATE POLICY login_events_no_direct_access ON longball.login_events USING(false);
CREATE POLICY login_sessions_no_direct_access ON longball.login_sessions USING(false);

CREATE FUNCTION longball.login_telemetry_writer() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,longball AS $$
 SELECT COALESCE(longball.runtime_purpose()='api',false) OR session_user=current_user
$$;
CREATE FUNCTION longball.login_reporting_initialize(p_now bigint) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,longball AS $$
BEGIN
 IF NOT longball.login_telemetry_writer() OR p_now IS NULL OR p_now NOT BETWEEN 0 AND 9007199254740991 THEN RAISE EXCEPTION 'Login reporting unavailable' USING ERRCODE='42501';END IF;
 UPDATE longball.login_reporting_state SET started_at=COALESCE(started_at,p_now) WHERE singleton=1;
END $$;
CREATE FUNCTION longball.login_account_snapshot(p_account text,p_now bigint) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,longball AS $$
DECLARE a longball.accounts%ROWTYPE;r text;v_scopes jsonb;label text;scope_count integer;
BEGIN
 IF NOT longball.login_telemetry_writer() OR p_now IS NULL OR p_now<0 THEN RETURN NULL; END IF;
 SELECT * INTO a FROM longball.accounts WHERE id=p_account;IF NOT FOUND THEN RETURN NULL;END IF;
 r=CASE WHEN EXISTS(SELECT 1 FROM longball.administration_grants WHERE account_id=p_account AND level='super') THEN 'super_admin' WHEN EXISTS(SELECT 1 FROM longball.administration_grants WHERE account_id=p_account AND level='club') THEN 'club_admin' WHEN EXISTS(SELECT 1 FROM longball.memberships WHERE account_id=p_account AND role='manager' AND revoked_at IS NULL AND(expires_at IS NULL OR expires_at>p_now)) THEN 'manager' WHEN EXISTS(SELECT 1 FROM longball.memberships WHERE account_id=p_account AND role='player' AND revoked_at IS NULL AND(expires_at IS NULL OR expires_at>p_now)) THEN 'player' ELSE 'spectator' END;
 IF r='super_admin' THEN v_scopes='[]'::jsonb;scope_count=0;
 ELSE
  SELECT count(*) INTO scope_count FROM(SELECT DISTINCT team_id,season_id FROM longball.memberships WHERE account_id=p_account AND revoked_at IS NULL AND(expires_at IS NULL OR expires_at>p_now))m;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('clubId',s.club_id,'clubName',s.club_name,'teamId',s.team_id,'teamName',s.team_name||CASE WHEN s.age_group<>'' AND right(lower(s.team_name),length(s.age_group)+1)<>' '||lower(s.age_group) THEN ' '||s.age_group ELSE '' END,'seasonId',s.season_id,'role',r) ORDER BY s.club_name,s.team_name,s.team_id,s.season_id),'[]'::jsonb) INTO v_scopes FROM(
   SELECT DISTINCT t.club_id,COALESCE(doc.value_json#>>'{club,name}',c.name) club_name,m.team_id,COALESCE(doc.value_json#>>'{team,name}',t.name) team_name,COALESCE(doc.value_json#>>'{team,ageGroup}','') age_group,m.season_id FROM longball.memberships m JOIN longball.teams t ON t.id=m.team_id JOIN longball.clubs c ON c.id=t.club_id LEFT JOIN longball.documents doc ON doc.team_id=m.team_id AND doc.season_id=m.season_id AND doc.kind='preparation' WHERE m.account_id=p_account AND m.revoked_at IS NULL AND(m.expires_at IS NULL OR m.expires_at>p_now) ORDER BY club_name,team_name,m.team_id,m.season_id LIMIT 500
  )s;
 END IF;
 SELECT p->>'displayName' INTO label FROM longball.memberships m JOIN longball.documents d ON d.team_id=m.team_id AND d.season_id=m.season_id AND d.kind='preparation' CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.value_json->'profiles','[]'::jsonb))p WHERE m.account_id=p_account AND m.role='player' AND p->>'playerId'=m.player_id LIMIT 1;
 label=COALESCE(NULLIF(label,''),CASE p_account WHEN 'synthetic-account-manager' THEN 'Alex Morgan' WHEN 'synthetic-account-manager-2' THEN 'Priya Shah' WHEN 'synthetic-account-manager-3' THEN 'Dan Foster' WHEN 'synthetic-account-manager-4' THEN 'Chris Lewis' WHEN 'synthetic-account-manager-5' THEN 'Nicky Hughes' WHEN 'synthetic-account-admin' THEN 'Sam Taylor' WHEN 'synthetic-account-spectator' THEN 'Jamie Bennett' WHEN 'synthetic-account-invitee' THEN 'Casey Bennett' WHEN 'synthetic-account-other-manager' THEN 'Robin Ellis' ELSE NULL END,CASE r WHEN 'super_admin' THEN 'Super Admin' WHEN 'club_admin' THEN 'Club Admin' WHEN 'manager' THEN 'Manager' WHEN 'player' THEN 'Player' ELSE 'Spectator' END||' · '||right(p_account,6));
 RETURN jsonb_build_object('accountId',p_account,'label',left(label,120),'role',r,'enabled',a.status='active','scopes',v_scopes,'scopesTruncated',scope_count>500);
END $$;
CREATE FUNCTION longball.login_activity_write(p jsonb) RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $$
DECLARE kind text;at_ms bigint;provider text;account text;session text;runtime text;meta jsonb;snapshot text;prior longball.login_sessions%ROWTYPE;affected integer;
BEGIN
 IF NOT longball.login_telemetry_writer() OR jsonb_typeof(p) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(p)k WHERE k NOT IN('type','at','provider','accountId','sessionId','runtimeId','issuedAtMs','expiresAtMs','reason','eventId')) THEN RAISE EXCEPTION 'Invalid login observation' USING ERRCODE='23514';END IF;
 kind=p->>'type';provider=p->>'provider';account=p->>'accountId';session=p->>'sessionId';runtime=p->>'runtimeId';
 IF kind IS NULL OR provider IS NULL OR kind NOT IN('login_success','login_failure','logout','activity') OR provider NOT IN('demo','spectator_pin','oidc') OR jsonb_typeof(p->'type') IS DISTINCT FROM 'string' OR jsonb_typeof(p->'provider') IS DISTINCT FROM 'string' OR jsonb_typeof(p->'runtimeId') IS DISTINCT FROM 'string' OR runtime IS NULL OR runtime!~'^[A-Za-z0-9_-]{1,100}$' OR jsonb_typeof(p->'at') IS DISTINCT FROM 'number' OR p->>'at' !~ '^\d+$' THEN RAISE EXCEPTION 'Invalid login observation' USING ERRCODE='23514';END IF;
 at_ms=(p->>'at')::bigint;IF at_ms NOT BETWEEN 0 AND 9007199254740991 THEN RAISE EXCEPTION 'Invalid login observation' USING ERRCODE='23514';END IF;
 -- Serialise event allocation through commit, so a committed high-water prefix
 -- cannot later gain an older ordinal from another in-flight writer.
 PERFORM pg_advisory_xact_lock(hashtextextended('longball.login-events.writer.v1',0));
 IF kind='login_failure' THEN
  IF account IS NOT NULL OR session IS NOT NULL OR jsonb_typeof(p->'eventId') IS DISTINCT FROM 'string' OR p->>'eventId' IS NULL OR p->>'eventId'!~'^[A-Za-z0-9_-]{1,100}$' OR p->>'reason' IS NULL OR p->>'reason' NOT IN('invalid_credentials','rate_limited','locked','capacity','access_denied') THEN RAISE EXCEPTION 'Invalid login observation' USING ERRCODE='23514';END IF;
  INSERT INTO longball.login_events(id,at,type,provider,reason) VALUES('failure-'||(p->>'eventId'),at_ms,kind,provider,p->>'reason') ON CONFLICT(id) DO NOTHING;RETURN;
 END IF;
 IF jsonb_typeof(p->'sessionId') IS DISTINCT FROM 'string' OR jsonb_typeof(p->'accountId') IS DISTINCT FROM 'string' OR session IS NULL OR session!~'^[A-Za-z0-9_-]{1,100}$' OR account IS NULL THEN RAISE EXCEPTION 'Invalid login observation' USING ERRCODE='23514';END IF;
 IF kind='logout' THEN
  IF NOT COALESCE((longball.actor_valid() AND longball.context_json()->>'operation'='login.activity' AND longball.context_json()->>'accountId'=account) OR(longball.context_json()->>'kind'='identity' AND EXISTS(SELECT 1 FROM longball.accounts a WHERE a.id=account AND a.issuer=longball.context_json()->>'issuer' AND a.subject=longball.context_json()->>'subject')),false) THEN RAISE EXCEPTION 'Login observation unavailable' USING ERRCODE='42501';END IF;
  UPDATE longball.login_sessions SET ended_at=at_ms WHERE session_id=session AND account_id=account AND runtime_id=runtime AND login_sessions.provider=(p->>'provider') AND ended_at IS NULL RETURNING * INTO prior;
  IF FOUND THEN INSERT INTO longball.login_events(id,at,type,provider,account_id,snapshot_id,session_id) VALUES('logout-'||encode(sha256(convert_to(session,'UTF8')),'hex'),at_ms,'logout',provider,account,prior.snapshot_id,session) ON CONFLICT(id) DO NOTHING;END IF;RETURN;
 END IF;
 IF longball.context_json()->>'operation' IS DISTINCT FROM 'login.activity' OR NOT longball.actor_valid() OR longball.context_json()->>'accountId' IS DISTINCT FROM account OR jsonb_typeof(p->'issuedAtMs') IS DISTINCT FROM 'number' OR p->>'issuedAtMs' !~ '^\d+$' OR (p->>'issuedAtMs')::bigint>at_ms OR (p->>'issuedAtMs')::bigint<0 OR (p->>'issuedAtMs')::bigint>9007199254740991 OR NOT p ? 'expiresAtMs' OR (p->'expiresAtMs'<>'null'::jsonb AND(jsonb_typeof(p->'expiresAtMs') IS DISTINCT FROM 'number' OR p->>'expiresAtMs' !~ '^\d+$')) THEN RAISE EXCEPTION 'Login observation unavailable' USING ERRCODE='42501';END IF;
 IF (p->'expiresAtMs'<>'null'::jsonb AND((p->>'expiresAtMs')::bigint NOT BETWEEN (p->>'issuedAtMs')::bigint AND 9007199254740991)) OR (provider<>'oidc' AND p->'expiresAtMs'='null'::jsonb) THEN RAISE EXCEPTION 'Invalid login observation' USING ERRCODE='23514';END IF;
 meta=longball.login_account_snapshot(account,at_ms);IF meta IS NULL OR meta->>'enabled'<>'true' THEN RAISE EXCEPTION 'Login observation unavailable' USING ERRCODE='42501';END IF;
 snapshot=encode(sha256(convert_to(meta::text,'UTF8')),'hex');
 INSERT INTO longball.login_access_snapshots(id,account_id,label,role,scopes_json,scopes_truncated) VALUES(snapshot,account,meta->>'label',meta->>'role',meta->'scopes',(meta->>'scopesTruncated')::boolean) ON CONFLICT(id) DO NOTHING;
 INSERT INTO longball.login_sessions(session_id,account_id,snapshot_id,provider,runtime_id,issued_at,expires_at,last_seen_at) VALUES(session,account,snapshot,provider,runtime,(p->>'issuedAtMs')::bigint,(p->>'expiresAtMs')::bigint,at_ms) ON CONFLICT(session_id) DO UPDATE SET snapshot_id=EXCLUDED.snapshot_id,last_seen_at=EXCLUDED.last_seen_at WHERE longball.login_sessions.account_id=EXCLUDED.account_id AND longball.login_sessions.runtime_id=EXCLUDED.runtime_id AND longball.login_sessions.ended_at IS NULL;
 INSERT INTO longball.login_events(id,at,type,provider,account_id,snapshot_id,session_id) VALUES('login-'||encode(sha256(convert_to(session,'UTF8')),'hex'),at_ms,'login_success',provider,account,snapshot,session) ON CONFLICT(id) DO NOTHING;
END $$;
CREATE FUNCTION longball.login_analytics_snapshot(p_from bigint,p_until bigint,p_active_since bigint,p_highwater bigint DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $$
DECLARE event_rows jsonb;session_rows jsonb;scope_rows jsonb;account_rows jsonb;clubs jsonb;teams jsonb;started bigint;highwater bigint;actual_highwater bigint;
BEGIN
 IF NOT COALESCE(longball.administration_allowed(NULL,true),false) OR longball.context_json()->>'operation' IS DISTINCT FROM 'administration.read' OR p_from IS NULL OR p_until IS NULL OR p_active_since IS NULL OR p_from<0 OR p_until<p_from OR p_until-p_from>2678400000 OR p_until>longball.context_now() OR p_until>9007199254740991 OR p_active_since<0 OR p_active_since<longball.context_now()-960000 OR p_active_since>longball.context_now() THEN RAISE EXCEPTION 'Login reports unavailable' USING ERRCODE='42501';END IF;
 SELECT COALESCE(MAX(ordinal),0) INTO actual_highwater FROM longball.login_events;highwater=COALESCE(p_highwater,actual_highwater);
 IF highwater<0 OR highwater>9007199254740991 OR highwater>actual_highwater THEN RAISE EXCEPTION 'Invalid login cursor' USING ERRCODE='23514';END IF;
 SELECT COALESCE(jsonb_agg(to_jsonb(e)),'[]'::jsonb) INTO event_rows FROM(SELECT ordinal,id,at,type,provider,account_id,snapshot_id,reason,count FROM longball.login_events WHERE at>=p_from AND at<=p_until AND ordinal<=highwater ORDER BY at DESC,id DESC LIMIT 20001)e;
 SELECT COALESCE(jsonb_agg(to_jsonb(s)),'[]'::jsonb) INTO session_rows FROM(SELECT s.* FROM longball.login_sessions s JOIN longball.accounts a ON a.id=s.account_id WHERE a.status='active' AND s.last_seen_at>=p_active_since ORDER BY s.last_seen_at DESC,s.session_id LIMIT 20001)s;
 SELECT COALESCE(jsonb_agg(to_jsonb(a)),'[]'::jsonb) INTO scope_rows FROM(SELECT * FROM longball.login_access_snapshots WHERE id IN(SELECT e->>'snapshot_id' FROM jsonb_array_elements(event_rows)e UNION SELECT s->>'snapshot_id' FROM jsonb_array_elements(session_rows)s) ORDER BY id LIMIT 1001)a;
 account_rows='[]'::jsonb;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'name',name)),'[]'::jsonb) INTO clubs FROM(SELECT c.id,COALESCE((SELECT value_json#>>'{club,name}' FROM longball.documents WHERE kind='preparation' AND club_id=c.id ORDER BY season_id DESC LIMIT 1),c.name) name FROM longball.clubs c ORDER BY name,id LIMIT 20001)c;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('id',team_id,'clubId',club_id,'name',name,'ageGroup',age_group)),'[]'::jsonb) INTO teams FROM(SELECT t.id team_id,t.club_id,COALESCE((SELECT value_json#>>'{team,name}' FROM longball.documents WHERE team_id=t.id AND kind='preparation' ORDER BY season_id DESC LIMIT 1),t.name) name,COALESCE((SELECT value_json#>>'{team,ageGroup}' FROM longball.documents WHERE team_id=t.id AND kind='preparation' ORDER BY season_id DESC LIMIT 1),'') age_group FROM longball.teams t ORDER BY name,t.id LIMIT 20001)t;
 SELECT started_at INTO started FROM longball.login_reporting_state WHERE singleton=1;
 RETURN jsonb_build_object('highWater',highwater,'events',event_rows,'sessions',session_rows,'snapshots',scope_rows,'accounts',account_rows,'directory',jsonb_build_object('clubs',clubs,'teams',teams),'startedAt',started);
END $$;
REVOKE ALL ON longball.login_reporting_state,longball.login_access_snapshots,longball.login_events,longball.login_sessions FROM PUBLIC;
REVOKE ALL ON FUNCTION longball.login_telemetry_writer(),longball.login_reporting_initialize(bigint),longball.login_account_snapshot(text,bigint),longball.login_activity_write(jsonb),longball.login_analytics_snapshot(bigint,bigint,bigint,bigint) FROM PUBLIC;

CREATE FUNCTION longball.login_analytics_enabled_accounts(p_club text,p_team text,p_role text) RETURNS integer LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,longball AS $$
DECLARE result integer;
BEGIN
 IF NOT COALESCE(longball.administration_allowed(NULL,true),false) OR longball.context_json()->>'operation' IS DISTINCT FROM 'administration.read' THEN RAISE EXCEPTION 'Login reports unavailable' USING ERRCODE='42501';END IF;
 SELECT count(*)::integer INTO result FROM(
 SELECT a.id,CASE WHEN EXISTS(SELECT 1 FROM longball.administration_grants g WHERE g.account_id=a.id AND g.level='super') THEN 'super_admin' WHEN EXISTS(SELECT 1 FROM longball.administration_grants g WHERE g.account_id=a.id AND g.level='club') THEN 'club_admin' WHEN EXISTS(SELECT 1 FROM longball.memberships m WHERE m.account_id=a.id AND m.role='manager' AND m.revoked_at IS NULL AND(m.expires_at IS NULL OR m.expires_at>longball.context_now())) THEN 'manager' WHEN EXISTS(SELECT 1 FROM longball.memberships m WHERE m.account_id=a.id AND m.role='player' AND m.revoked_at IS NULL AND(m.expires_at IS NULL OR m.expires_at>longball.context_now())) THEN 'player' ELSE 'spectator' END role FROM longball.accounts a WHERE a.status='active' AND(EXISTS(SELECT 1 FROM longball.memberships m WHERE m.account_id=a.id AND m.revoked_at IS NULL AND(m.expires_at IS NULL OR m.expires_at>longball.context_now())) OR EXISTS(SELECT 1 FROM longball.administration_grants g WHERE g.account_id=a.id))
 )a WHERE(p_role IS NULL OR a.role=p_role) AND((p_club IS NULL AND p_team IS NULL) OR(a.role<>'super_admin' AND EXISTS(SELECT 1 FROM longball.memberships m JOIN longball.teams d ON d.id=m.team_id WHERE m.account_id=a.id AND m.revoked_at IS NULL AND(m.expires_at IS NULL OR m.expires_at>longball.context_now()) AND(p_club IS NULL OR d.club_id=p_club) AND(p_team IS NULL OR m.team_id=p_team))));
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION longball.login_analytics_enabled_accounts(text,text,text) FROM PUBLIC;
