-- Remove the provisional direct worker fanout permission in previously installed 005.
DROP POLICY jobs_insert ON longball.jobs;
CREATE POLICY jobs_insert ON longball.jobs FOR INSERT WITH CHECK (longball.actor_manager(club_id,team_id,season_id) OR (longball.actor_role(club_id,team_id,season_id) IN('player','spectator') AND kind='notification.dispatch' AND longball.context_json()->>'operation'='community.write'));
-- A claimed award may enqueue only generic notifications about that exact award.
-- It gains no SELECT policy on other jobs or private account data.
CREATE FUNCTION enqueue_award_notification(p_id text,p_business_key text,p_payload jsonb,p_due bigint) RETURNS integer
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
 INSERT INTO longball.jobs(id,business_key,kind,payload_json,due_at) VALUES(p_id,p_business_key,'notification.dispatch',canonical,p_due) ON CONFLICT(business_key) DO NOTHING;
 GET DIAGNOSTICS changed=ROW_COUNT;RETURN changed;
END $fn$;
REVOKE ALL ON FUNCTION enqueue_award_notification(text,text,jsonb,bigint) FROM PUBLIC;
