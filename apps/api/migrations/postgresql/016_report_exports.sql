-- Encrypted, requester-bound report artifacts. No worker receives raw report documents.
CREATE TABLE report_exports (
 id text PRIMARY KEY, job_id text NOT NULL UNIQUE REFERENCES jobs(id), account_id text NOT NULL REFERENCES accounts(id),
 issuer text NOT NULL, subject text NOT NULL, club_id text NOT NULL, team_id text NOT NULL, season_id text NOT NULL,
 role text NOT NULL CHECK(role IN('manager','player','spectator')), player_id text,
 request_json jsonb NOT NULL, status text NOT NULL CHECK(status IN('queued','working','ready','failed','expired')),
 created_at bigint NOT NULL, expires_at bigint NOT NULL, generated_at bigint, failure_code text,
 publication_json jsonb NOT NULL, source_fingerprint text NOT NULL CHECK(source_fingerprint ~ '^[a-f0-9]{64}$'),
 snapshot_ciphertext text, artifact_ciphertext text, artifact_sha256 text, key_id text NOT NULL,
 version integer NOT NULL DEFAULT 0 CHECK(version>=0),
 FOREIGN KEY(club_id,team_id,season_id) REFERENCES team_seasons(club_id,team_id,season_id),
 CHECK((role='player' AND player_id IS NOT NULL) OR (role<>'player' AND player_id IS NULL)),
 CHECK(expires_at>created_at AND expires_at<=created_at+86400000),
 CHECK(octet_length(COALESCE(snapshot_ciphertext,''))<=7340032 AND octet_length(COALESCE(artifact_ciphertext,''))<=7340032),
 CHECK(status<>'ready' OR (artifact_ciphertext IS NOT NULL AND artifact_sha256 IS NOT NULL AND artifact_sha256 ~ '^[a-f0-9]{64}$' AND generated_at IS NOT NULL)),
 CHECK(status NOT IN('failed','expired') OR (snapshot_ciphertext IS NULL AND artifact_ciphertext IS NULL AND artifact_sha256 IS NULL))
);
CREATE INDEX report_exports_expiry ON report_exports(expires_at,id) WHERE status<>'expired';
ALTER TABLE report_exports ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION report_export_actor(a text,r text,c text,t text,s text,p text) RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $$
 SELECT longball.runtime_purpose()='api' AND longball.actor_valid() AND a=longball.context_json()->>'accountId'
 AND longball.context_matches(c,t,s) AND COALESCE(longball.context_json()->>'requestedRole','default') IN('default',r)
 AND longball.context_json()->>'operation' IN('exports.request','exports.read','exports.download')
 AND EXISTS(SELECT 1 FROM longball.memberships m JOIN longball.accounts ac ON ac.id=m.account_id
 WHERE m.account_id=a AND m.club_id=c AND m.team_id=t AND m.season_id=s AND m.role=r
 AND m.revoked_at IS NULL AND (m.expires_at IS NULL OR m.expires_at>longball.context_now())
 AND ((r='player' AND p IS NOT NULL AND m.player_id=p) OR (r<>'player' AND p IS NULL))
 AND (r<>'manager' OR (ac.classification='adult_individual' AND ac.adult_verified=1 AND ac.strong_auth_enrolled=1 AND longball.context_json()->>'strongAuth'='true'))
 AND (r<>'spectator' OR longball.raw_spectator_grant(a,c,t,s)))
$$;
CREATE FUNCTION report_export_worker(e text,j text,c text,t text,s text) RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $$
 SELECT j=longball.context_json()->>'jobId' AND longball.worker_job_valid(c,t,s)
 AND EXISTS(SELECT 1 FROM longball.jobs q WHERE q.id=j AND q.kind='report.export' AND q.payload_json->>'exportId'=e)
$$;
CREATE FUNCTION report_export_fingerprint_raw(t text,s text) RETURNS text LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $$
 SELECT encode(sha256(convert_to(jsonb_build_object(
 'documents',COALESCE((SELECT jsonb_agg(jsonb_build_array(d.kind,d.revision,d.value_json) ORDER BY d.kind) FROM longball.documents d WHERE d.team_id=t AND d.season_id=s AND d.kind IN('records','preparation','community')),'[]'::jsonb),
 'matches',COALESCE((SELECT jsonb_agg(jsonb_build_array(m.id,m.config_json,m.state_json,m.sharing_policy_json,m.last_sync_at) ORDER BY m.id COLLATE "C") FROM longball.matches m WHERE m.team_id=t AND m.season_id=s),'[]'::jsonb)
 )::text,'UTF8')),'hex')
$$;
CREATE FUNCTION report_export_source(t text,s text) RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $fn$
DECLARE c text; BEGIN
 SELECT ts.club_id INTO c FROM longball.team_seasons ts WHERE ts.team_id=t AND ts.season_id=s;
 IF longball.runtime_purpose() IS DISTINCT FROM 'api' OR longball.context_json()->>'operation' IS DISTINCT FROM 'exports.request' OR longball.context_json()->>'teamId' IS DISTINCT FROM t OR longball.context_json()->>'seasonId' IS DISTINCT FROM s OR c IS NULL OR longball.actor_role(c,t,s) NOT IN('manager','player','spectator') OR longball.actor_role(c,t,s) IS NULL THEN RAISE EXCEPTION 'Export source unavailable' USING ERRCODE='42501'; END IF;
 RETURN longball.report_export_fingerprint_raw(t,s);
END $fn$;
CREATE FUNCTION report_export_current(e text) RETURNS TABLE(allowed boolean,source_fingerprint text,now_ms bigint) LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $fn$
DECLARE row longball.report_exports%ROWTYPE; moment bigint:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint; permitted boolean; BEGIN
 SELECT * INTO row FROM longball.report_exports WHERE id=e;
 IF NOT FOUND OR NOT ((longball.report_export_actor(row.account_id,row.role,row.club_id,row.team_id,row.season_id,row.player_id) AND longball.context_matches(row.club_id,row.team_id,row.season_id)) OR longball.report_export_worker(row.id,row.job_id,row.club_id,row.team_id,row.season_id)) THEN RAISE EXCEPTION 'Export unavailable' USING ERRCODE='42501'; END IF;
 SELECT EXISTS(SELECT 1 FROM longball.accounts a JOIN longball.memberships m ON m.account_id=a.id
 WHERE a.id=row.account_id AND a.issuer=row.issuer AND a.subject=row.subject AND a.status='active'
 AND m.club_id=row.club_id AND m.team_id=row.team_id AND m.season_id=row.season_id AND m.role=row.role AND m.revoked_at IS NULL AND (m.expires_at IS NULL OR m.expires_at>moment)
 AND (row.role<>'player' OR m.player_id=row.player_id)
 AND (row.role<>'manager' OR (a.classification='adult_individual' AND a.adult_verified=1 AND a.strong_auth_enrolled=1 AND (longball.runtime_purpose()='worker' OR longball.context_json()->>'strongAuth'='true')))
 AND (row.role<>'spectator' OR longball.raw_spectator_grant(a.id,row.club_id,row.team_id,row.season_id))) INTO permitted;
 RETURN QUERY SELECT permitted,CASE WHEN permitted THEN longball.report_export_fingerprint_raw(row.team_id,row.season_id) ELSE NULL END,moment;
END $fn$;

CREATE FUNCTION guard_report_export() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,longball AS $fn$
DECLARE c text; parent longball.jobs%ROWTYPE; moment bigint:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint; BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.created_at<moment-30000 OR NEW.created_at>moment+30000 OR NEW.expires_at<=moment THEN RAISE EXCEPTION 'Export time unavailable' USING ERRCODE='23514'; END IF;
  IF longball.runtime_purpose()='api' AND (NEW.issuer IS DISTINCT FROM longball.context_json()->>'issuer' OR NEW.subject IS DISTINCT FROM longball.context_json()->>'subject') THEN RAISE EXCEPTION 'Export requester unavailable' USING ERRCODE='42501'; END IF;
  SELECT ts.club_id INTO c FROM longball.team_seasons ts WHERE ts.team_id=NEW.team_id AND ts.season_id=NEW.season_id;
  IF c IS NULL OR (NEW.club_id IS NOT NULL AND NEW.club_id<>c) THEN RAISE EXCEPTION 'Export ancestry unavailable' USING ERRCODE='42501'; END IF;
  NEW.club_id=c; SELECT * INTO parent FROM longball.jobs WHERE id=NEW.job_id;
  IF parent.kind IS DISTINCT FROM 'report.export' OR parent.club_id IS DISTINCT FROM c OR parent.team_id IS DISTINCT FROM NEW.team_id OR parent.season_id IS DISTINCT FROM NEW.season_id OR parent.payload_json->>'exportId' IS DISTINCT FROM NEW.id OR parent.payload_json->>'accountId' IS DISTINCT FROM NEW.account_id OR parent.payload_json->>'audience' IS DISTINCT FROM NEW.role OR parent.payload_json->>'playerId' IS DISTINCT FROM NEW.player_id THEN RAISE EXCEPTION 'Export job unavailable' USING ERRCODE='42501'; END IF;
  IF NEW.status<>'queued' OR NEW.generated_at IS NOT NULL OR NEW.artifact_ciphertext IS NOT NULL OR NEW.artifact_sha256 IS NOT NULL OR NEW.snapshot_ciphertext IS NULL OR NEW.failure_code IS NOT NULL OR NEW.version<>0 THEN RAISE EXCEPTION 'Export initial state unavailable' USING ERRCODE='23514'; END IF;
 ELSE
  IF ROW(NEW.id,NEW.job_id,NEW.account_id,NEW.issuer,NEW.subject,NEW.club_id,NEW.team_id,NEW.season_id,NEW.role,NEW.player_id,NEW.request_json,NEW.created_at,NEW.expires_at,NEW.publication_json,NEW.source_fingerprint,NEW.key_id)
    IS DISTINCT FROM ROW(OLD.id,OLD.job_id,OLD.account_id,OLD.issuer,OLD.subject,OLD.club_id,OLD.team_id,OLD.season_id,OLD.role,OLD.player_id,OLD.request_json,OLD.created_at,OLD.expires_at,OLD.publication_json,OLD.source_fingerprint,OLD.key_id) THEN RAISE EXCEPTION 'Immutable export scope' USING ERRCODE='23514'; END IF;
  IF NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'Export revision unavailable' USING ERRCODE='23514'; END IF;
  IF longball.runtime_purpose()='api' AND (NOT longball.report_export_actor(OLD.account_id,OLD.role,OLD.club_id,OLD.team_id,OLD.season_id,OLD.player_id) OR NEW.status NOT IN('failed','expired') OR NEW.snapshot_ciphertext IS NOT NULL OR NEW.artifact_ciphertext IS NOT NULL OR NEW.artifact_sha256 IS NOT NULL OR NEW.generated_at IS DISTINCT FROM OLD.generated_at OR (NEW.status='expired' AND OLD.expires_at>moment)) THEN RAISE EXCEPTION 'Export update unavailable' USING ERRCODE='42501'; END IF;
  IF longball.runtime_purpose()='worker' AND NOT longball.report_export_worker(OLD.id,OLD.job_id,OLD.club_id,OLD.team_id,OLD.season_id) AND NOT (longball.context_json()->>'kind'='worker_claim' AND longball.context_json()->>'jobKind'='report.export' AND OLD.expires_at<=moment AND NEW.status='expired' AND NEW.snapshot_ciphertext IS NULL AND NEW.artifact_ciphertext IS NULL AND NEW.artifact_sha256 IS NULL AND NEW.generated_at IS NOT DISTINCT FROM OLD.generated_at) THEN RAISE EXCEPTION 'Export worker unavailable' USING ERRCODE='42501'; END IF;
  IF OLD.status IN('failed','expired') AND NEW.status<>OLD.status AND NEW.status<>'expired' THEN RAISE EXCEPTION 'Export terminal state unavailable' USING ERRCODE='23514'; END IF;
  IF NEW.snapshot_ciphertext IS DISTINCT FROM OLD.snapshot_ciphertext AND NEW.snapshot_ciphertext IS NOT NULL THEN RAISE EXCEPTION 'Immutable export snapshot' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $fn$;
CREATE TRIGGER report_export_guard BEFORE INSERT OR UPDATE ON report_exports FOR EACH ROW EXECUTE FUNCTION guard_report_export();
CREATE POLICY report_exports_read ON report_exports FOR SELECT USING((report_export_actor(account_id,role,club_id,team_id,season_id,player_id) AND context_matches(club_id,team_id,season_id)) OR report_export_worker(id,job_id,club_id,team_id,season_id));
CREATE POLICY report_exports_insert ON report_exports FOR INSERT WITH CHECK(report_export_actor(account_id,role,club_id,team_id,season_id,player_id) AND context_json()->>'operation'='exports.request' AND team_id=context_json()->>'teamId' AND season_id=context_json()->>'seasonId' AND actor_role(club_id,team_id,season_id)=role);
CREATE POLICY report_exports_update ON report_exports FOR UPDATE USING((report_export_actor(account_id,role,club_id,team_id,season_id,player_id) AND context_matches(club_id,team_id,season_id)) OR report_export_worker(id,job_id,club_id,team_id,season_id)) WITH CHECK((report_export_actor(account_id,role,club_id,team_id,season_id,player_id) AND context_matches(club_id,team_id,season_id)) OR report_export_worker(id,job_id,club_id,team_id,season_id));
CREATE POLICY report_export_jobs_insert ON jobs FOR INSERT WITH CHECK(kind='report.export' AND context_json()->>'operation'='exports.request' AND payload_json->>'accountId'=context_json()->>'accountId' AND actor_role(club_id,team_id,season_id)=payload_json->>'audience' AND team_id=context_json()->>'teamId' AND season_id=context_json()->>'seasonId');

-- Existing document access belongs only to the award and notification workers.
-- An export capability exposes the encrypted snapshot and guarded hash, never raw community records.
DROP POLICY documents_read ON documents;
CREATE POLICY documents_read ON documents FOR SELECT USING ((team_id=context_json()->>'teamId' AND season_id=context_json()->>'seasonId' AND (actor_role(club_id,team_id,season_id) IN('manager','player','spectator') OR (actor_admin(club_id,team_id,season_id) AND ((kind IN('community','staff') AND context_json()->>'operation' IN('staff.read','staff.assign','staff.revoke')) OR (kind='preparation' AND context_json()->>'operation' IN('configuration.read','configuration.write')) OR (kind IN('preparation','community','records') AND context_json()->>'operation' IN('season.options','season.create')))))) OR (kind='community' AND invite_capability(club_id,team_id,season_id)) OR (worker_job_valid(club_id,team_id,season_id) AND worker_kind() IN('award.finalise','notification.dispatch') AND ((kind='community') OR (kind='preparation' AND worker_kind()='notification.dispatch' AND EXISTS(SELECT 1 FROM jobs j WHERE j.id=context_json()->>'jobId' AND j.payload_json->>'category'='schedule')))));

CREATE FUNCTION guard_report_export_job() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,longball AS $fn$
BEGIN
 IF OLD.kind='report.export' AND NEW.payload_json IS DISTINCT FROM OLD.payload_json THEN RAISE EXCEPTION 'Immutable export job' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $fn$;
CREATE TRIGGER report_export_job_guard BEFORE UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION guard_report_export_job();

CREATE OR REPLACE FUNCTION claim_due_job(p_kind text,p_now bigint,p_capability text) RETURNS SETOF jobs LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $fn$
DECLARE selected_id text; clock_now bigint:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint; BEGIN
 IF longball.runtime_purpose()<>'worker' OR longball.runtime_purpose() IS NULL OR longball.context_json()->>'kind' IS DISTINCT FROM 'worker_claim' OR p_kind IS NULL OR p_kind NOT IN('award.finalise','notification.dispatch','report.export') OR p_kind IS DISTINCT FROM longball.context_json()->>'jobKind' OR p_now IS NULL OR p_now IS DISTINCT FROM (longball.context_json()->>'nowMs')::bigint OR p_capability IS NULL OR p_capability !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Job claim unavailable' USING ERRCODE='42501'; END IF;
 IF p_now<clock_now-30000 OR p_now>clock_now+30000 THEN RAISE EXCEPTION 'Worker clock observation unavailable' USING ERRCODE='42501'; END IF;
 SELECT j.id INTO selected_id FROM longball.jobs j WHERE j.kind=p_kind AND j.club_id IS NOT NULL AND ((j.state='pending' AND j.due_at<=clock_now) OR (j.state='leased' AND j.lease_until<=clock_now)) ORDER BY j.due_at,j.id FOR UPDATE SKIP LOCKED LIMIT 1;
 IF selected_id IS NULL THEN RETURN; END IF;
 UPDATE longball.jobs SET state='leased',lease_until=clock_now+30000,lease_token_hash=encode(sha256(convert_to(p_capability,'UTF8')),'hex') WHERE id=selected_id;
 RETURN QUERY SELECT * FROM longball.jobs WHERE id=selected_id;
END $fn$;
CREATE FUNCTION purge_report_exports() RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $fn$
DECLARE item record; changed integer:=0; moment bigint:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint; BEGIN
 IF longball.runtime_purpose() IS DISTINCT FROM 'worker' OR longball.context_json()->>'kind' IS DISTINCT FROM 'worker_claim' OR longball.context_json()->>'jobKind' IS DISTINCT FROM 'report.export' THEN RAISE EXCEPTION 'Export cleanup unavailable' USING ERRCODE='42501'; END IF;
 FOR item IN SELECT id,job_id FROM longball.report_exports WHERE expires_at<=moment AND status<>'expired' ORDER BY expires_at,id FOR UPDATE SKIP LOCKED LIMIT 20 LOOP
  UPDATE longball.report_exports SET status='expired',failure_code='EXPORT_EXPIRED',snapshot_ciphertext=NULL,artifact_ciphertext=NULL,artifact_sha256=NULL,version=version+1 WHERE id=item.id;
  UPDATE longball.jobs SET state='failed',lease_until=NULL,last_error_code='EXPORT_EXPIRED' WHERE id=item.job_id AND state IN('pending','leased');
  changed=changed+1;
 END LOOP; RETURN changed;
END $fn$;
REVOKE ALL ON FUNCTION report_export_actor(text,text,text,text,text,text),report_export_worker(text,text,text,text,text),report_export_fingerprint_raw(text,text),report_export_source(text,text),report_export_current(text),guard_report_export(),guard_report_export_job(),purge_report_exports(),claim_due_job(text,bigint,text) FROM PUBLIC;

-- Invitation previews expose only these names after the exact token's existing
-- capability/account checks. They never grant preparation or roster access.
CREATE FUNCTION longball.invitation_preview_context(p_hash text)
 RETURNS TABLE(club_name text,team_name text,age_group text,season_label text,inviter_label text)
 LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $$
 WITH permitted AS (
  SELECT x.id,x.club_id,x.team_id,x.season_id FROM longball.invitation_accept_scope(p_hash) x
  UNION
  SELECT x.id,x.club_id,x.team_id,x.season_id FROM longball.invitation_preflight(p_hash) x
 )
 SELECT COALESCE(NULLIF(d.value_json#>>'{club,name}',''),c.name),
  COALESCE(NULLIF(d.value_json#>>'{team,name}',''),t.name),NULLIF(d.value_json#>>'{team,ageGroup}',''),
  COALESCE(season_name.label,s.label),
  CASE WHEN EXISTS(
   SELECT 1 FROM longball.memberships m JOIN longball.accounts a ON a.id=m.account_id
   WHERE m.account_id=i.inviter_account_id AND m.club_id=i.club_id AND m.team_id=i.team_id AND m.season_id=i.season_id
   AND m.role='manager' AND m.revoked_at IS NULL AND(m.expires_at IS NULL OR m.expires_at>longball.context_now())
   AND a.status='active' AND a.classification='adult_individual' AND a.adult_verified=1
  ) THEN 'Team manager' ELSE 'Team member' END
 FROM permitted p
 JOIN longball.spectator_invitations i ON i.id=p.id AND i.club_id=p.club_id AND i.team_id=p.team_id AND i.season_id=p.season_id AND i.token_hash=p_hash
 JOIN longball.teams t ON t.id=i.team_id AND t.club_id=i.club_id AND t.scope_status='resolved'
 JOIN longball.clubs c ON c.id=i.club_id
 JOIN longball.team_seasons s ON s.club_id=i.club_id AND s.team_id=i.team_id AND s.season_id=i.season_id
 LEFT JOIN longball.documents d ON d.club_id=i.club_id AND d.team_id=i.team_id AND d.season_id=i.season_id AND d.kind='preparation'
  AND d.value_json#>>'{club,id}'=i.club_id AND d.value_json#>>'{team,id}'=i.team_id
  AND(SELECT count(*) FROM jsonb_array_elements(COALESCE(d.value_json->'seasons','[]'::jsonb)) x WHERE x.value->>'id'=i.season_id)=1
 LEFT JOIN LATERAL (
  SELECT CASE WHEN count(*)=1 THEN min(NULLIF(x.value->>'label','')) END AS label
  FROM jsonb_array_elements(COALESCE(d.value_json->'seasons','[]'::jsonb)) x WHERE x.value->>'id'=i.season_id
 ) season_name ON true
 WHERE longball.runtime_purpose()='api'
 AND(longball.context_json()->>'clubId' IS NULL OR longball.context_json()->>'clubId'=i.club_id)
 AND(longball.context_json()->>'teamId' IS NULL OR longball.context_json()->>'teamId'=i.team_id)
 AND(longball.context_json()->>'seasonId' IS NULL OR longball.context_json()->>'seasonId'=i.season_id) $$;
REVOKE ALL ON FUNCTION longball.invitation_preview_context(text) FROM PUBLIC;

-- /me needs current display names without opening preparation documents. This
-- no-argument helper exposes only the caller's existing current memberships.
CREATE FUNCTION longball.workspace_membership_names()
 RETURNS TABLE(team_id text,season_id text,team_name text,age_group text,season_label text,club_name text)
 LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $$
 SELECT DISTINCT m.team_id,m.season_id,
  COALESCE(NULLIF(d.value_json#>>'{team,name}',''),t.name),NULLIF(d.value_json#>>'{team,ageGroup}',''),
  COALESCE(season_name.label,s.label),COALESCE(NULLIF(d.value_json#>>'{club,name}',''),c.name)
 FROM longball.memberships m
 JOIN longball.teams t ON t.id=m.team_id AND t.club_id=m.club_id AND t.scope_status='resolved'
 JOIN longball.clubs c ON c.id=m.club_id
 JOIN longball.team_seasons s ON s.club_id=m.club_id AND s.team_id=m.team_id AND s.season_id=m.season_id
 LEFT JOIN longball.documents d ON d.club_id=m.club_id AND d.team_id=m.team_id AND d.season_id=m.season_id AND d.kind='preparation'
  AND d.value_json#>>'{club,id}'=m.club_id AND d.value_json#>>'{team,id}'=m.team_id
  AND(SELECT count(*) FROM jsonb_array_elements(COALESCE(d.value_json->'seasons','[]'::jsonb)) x WHERE x.value->>'id'=m.season_id)=1
 LEFT JOIN LATERAL (
  SELECT CASE WHEN count(*)=1 THEN min(NULLIF(x.value->>'label','')) END AS label
  FROM jsonb_array_elements(COALESCE(d.value_json->'seasons','[]'::jsonb)) x WHERE x.value->>'id'=m.season_id
 ) season_name ON true
 WHERE longball.runtime_purpose()='api' AND longball.context_json()->>'kind'='actor' AND longball.actor_valid()
 AND longball.context_json()->>'operation'='account.read'
 AND longball.context_json()->>'clubId' IS NULL AND longball.context_json()->>'teamId' IS NULL
 AND longball.context_json()->>'seasonId' IS NULL AND longball.context_json()->>'matchId' IS NULL
 AND m.account_id=longball.context_json()->>'accountId' AND m.revoked_at IS NULL
 AND(m.expires_at IS NULL OR m.expires_at>longball.context_now())
 AND(m.role<>'spectator' OR longball.spectator_grant_active(m.account_id,m.club_id,m.team_id,m.season_id)) $$;
REVOKE ALL ON FUNCTION longball.workspace_membership_names() FROM PUBLIC;
