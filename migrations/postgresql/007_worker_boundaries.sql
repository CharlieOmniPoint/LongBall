-- Preserve installed 006 while bounding fanout independently of caller-selected business keys.
ALTER TABLE longball.jobs ADD COLUMN award_source_job_id text REFERENCES longball.jobs(id);
CREATE UNIQUE INDEX award_notification_recipient ON longball.jobs(award_source_job_id,(payload_json->>'accountId')) WHERE award_source_job_id IS NOT NULL AND kind='notification.dispatch';
CREATE FUNCTION guard_award_job_origin() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,longball AS $fn$
BEGIN
 IF TG_OP='UPDATE' AND NEW.award_source_job_id IS DISTINCT FROM OLD.award_source_job_id THEN RAISE EXCEPTION 'Immutable notification origin' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' AND NEW.award_source_job_id IS NOT NULL AND (longball.runtime_purpose() IS DISTINCT FROM 'worker' OR NEW.award_source_job_id IS DISTINCT FROM longball.context_json()->>'jobId' OR NOT longball.worker_job_valid(NEW.club_id,NEW.team_id,NEW.season_id) OR longball.worker_kind()<>'award.finalise' OR NEW.kind<>'notification.dispatch') THEN RAISE EXCEPTION 'Award notification origin unavailable' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $fn$;
CREATE TRIGGER zz_jobs_award_origin BEFORE INSERT OR UPDATE OF award_source_job_id ON longball.jobs FOR EACH ROW EXECUTE FUNCTION guard_award_job_origin();
REVOKE ALL ON FUNCTION guard_award_job_origin() FROM PUBLIC;
CREATE OR REPLACE FUNCTION worker_job_valid(c text,t text,s text) RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $$ SELECT longball.runtime_purpose() ='worker' AND longball.context_json()->>'kind'='worker_job' AND longball.context_json()->>'clubId'=c AND longball.context_json()->>'teamId'=t AND longball.context_json()->>'seasonId'=s AND EXISTS(SELECT 1 FROM longball.jobs j WHERE j.id=longball.context_json()->>'jobId' AND j.club_id=c AND j.team_id=t AND j.season_id=s AND j.state='leased' AND j.lease_until>longball.context_now() AND j.lease_token_hash=encode(sha256(convert_to(longball.context_json()->>'leaseToken','UTF8')),'hex')) $$;
CREATE OR REPLACE FUNCTION claim_due_job(p_kind text,p_now bigint,p_capability text) RETURNS SETOF jobs LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $fn$
DECLARE selected_id text; BEGIN
 IF longball.runtime_purpose()<>'worker' OR longball.runtime_purpose() IS NULL OR longball.context_json()->>'kind'<>'worker_claim' OR p_kind NOT IN('award.finalise','notification.dispatch') OR p_kind IS DISTINCT FROM longball.context_json()->>'jobKind' OR p_now IS DISTINCT FROM (longball.context_json()->>'nowMs')::bigint OR p_capability !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Job claim unavailable' USING ERRCODE='42501'; END IF;
 SELECT j.id INTO selected_id FROM longball.jobs j WHERE j.kind=p_kind AND j.club_id IS NOT NULL AND ((j.state='pending' AND j.due_at<=p_now) OR (j.state='leased' AND j.lease_until<=p_now)) ORDER BY j.due_at,j.id FOR UPDATE SKIP LOCKED LIMIT 1;
 IF selected_id IS NULL THEN RETURN; END IF;
 UPDATE longball.jobs SET state='leased',lease_until=p_now+30000,lease_token_hash=encode(sha256(convert_to(p_capability,'UTF8')),'hex') WHERE id=selected_id;
 RETURN QUERY SELECT * FROM longball.jobs WHERE id=selected_id;
END $fn$;
CREATE OR REPLACE FUNCTION enqueue_award_notification(p_id text,p_business_key text,p_payload jsonb,p_due bigint) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $fn$
DECLARE parent longball.jobs%ROWTYPE; canonical jsonb; existing longball.jobs%ROWTYPE; changed integer;
BEGIN
 SELECT * INTO parent FROM longball.jobs WHERE id=longball.context_json()->>'jobId';
 IF longball.runtime_purpose()<>'worker' OR longball.runtime_purpose() IS NULL OR parent.kind IS DISTINCT FROM 'award.finalise' OR NOT longball.worker_job_valid(parent.club_id,parent.team_id,parent.season_id) THEN RAISE EXCEPTION 'Award notification unavailable' USING ERRCODE='42501'; END IF;
 IF p_id !~ '^[A-Za-z0-9_.:-]{1,200}$' OR p_business_key !~ '^[A-Za-z0-9_.:-]{1,200}$' OR p_due<0 OR p_payload->>'accountId' !~ '^[A-Za-z0-9_.:-]{1,200}$' OR p_payload->>'audience' NOT IN('manager','player','spectator') OR p_payload->>'teamId' IS DISTINCT FROM parent.team_id OR p_payload->>'seasonId' IS DISTINCT FROM parent.season_id OR p_payload->>'category' IS DISTINCT FROM 'awards' OR p_payload->>'entityId' IS DISTINCT FROM parent.payload_json->>'matchId' THEN RAISE EXCEPTION 'Award notification scope unavailable' USING ERRCODE='23514'; END IF;
 canonical=jsonb_build_object('id',p_id,'businessKey',p_business_key,'accountId',p_payload->>'accountId','teamId',parent.team_id,'seasonId',parent.season_id,'audience',p_payload->>'audience','playerId',p_payload->'playerId','category','awards','entityId',parent.payload_json->>'matchId','dueAtMs',p_due,'schemaVersion',1,'revision',0,'state','pending','attempts',0,'deliveryAttempts',0,'lease',NULL,'lastCode',NULL,'providerReceiptId',NULL,'acceptedAtMs',NULL);
 IF p_payload IS DISTINCT FROM canonical THEN RAISE EXCEPTION 'Unexpected retained notification data' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM longball.memberships m JOIN longball.accounts a ON a.id=m.account_id WHERE m.account_id=p_payload->>'accountId' AND m.club_id=parent.club_id AND m.team_id=parent.team_id AND m.season_id=parent.season_id AND m.role=p_payload->>'audience' AND m.revoked_at IS NULL AND (m.expires_at IS NULL OR m.expires_at>longball.context_now()) AND a.status='active' AND (m.role<>'player' OR (p_payload->>'playerId'=m.player_id AND m.player_id IS NOT NULL)) AND (m.role='player' OR p_payload->>'playerId' IS NULL) AND (m.role<>'manager' OR (a.classification='adult_individual' AND a.adult_verified=1 AND a.strong_auth_enrolled=1)) AND (m.role<>'spectator' OR longball.raw_spectator_grant(m.account_id,m.club_id,m.team_id,m.season_id))) THEN RETURN 0; END IF;
 SELECT * INTO existing FROM longball.jobs WHERE business_key=p_business_key;
 IF FOUND THEN
  IF existing.kind<>'notification.dispatch' OR existing.club_id IS DISTINCT FROM parent.club_id OR existing.team_id IS DISTINCT FROM parent.team_id OR existing.season_id IS DISTINCT FROM parent.season_id OR existing.payload_json->>'accountId' IS DISTINCT FROM p_payload->>'accountId' OR existing.payload_json->>'audience' IS DISTINCT FROM p_payload->>'audience' OR existing.payload_json->'playerId' IS DISTINCT FROM p_payload->'playerId' OR existing.payload_json->>'category' IS DISTINCT FROM 'awards' OR existing.payload_json->>'entityId' IS DISTINCT FROM parent.payload_json->>'matchId' THEN RAISE EXCEPTION 'Notification business key conflict' USING ERRCODE='23514'; END IF;
  RETURN 0;
 END IF;
 INSERT INTO longball.jobs(id,business_key,kind,payload_json,due_at,award_source_job_id) VALUES(p_id,p_business_key,'notification.dispatch',canonical,p_due,parent.id) ON CONFLICT(business_key) DO NOTHING;
 GET DIAGNOSTICS changed=ROW_COUNT;RETURN changed;
END $fn$;
REVOKE ALL ON FUNCTION enqueue_award_notification(text,text,jsonb,bigint) FROM PUBLIC;
