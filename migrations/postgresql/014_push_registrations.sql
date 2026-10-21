-- Delivery metadata only. No push token, device ID or permission report grants authentication.
CREATE TABLE longball.push_registrations(
 account_id text NOT NULL REFERENCES longball.accounts(id),issuer text NOT NULL,device_id text NOT NULL REFERENCES longball.native_app_devices(device_id),platform text NOT NULL CHECK(platform IN('ios','android')),
 transport text CHECK(transport IN('apns','fcm','expo')),provider_config_id text,token_ciphertext text CHECK(char_length(token_ciphertext)<=16000),token_digest text CHECK(token_digest~'^[a-f0-9]{64}$'),
 permission text NOT NULL CHECK(permission IN('granted','provisional','denied')),state text NOT NULL CHECK(state IN('registered','revoked')),revision bigint NOT NULL CHECK(revision>=1),
 app_build text NOT NULL CHECK(char_length(app_build)<=60),registered_at bigint,updated_at bigint NOT NULL,revoked_at bigint,last_operation_id text NOT NULL CHECK(last_operation_id~'^[A-Za-z0-9_-]{8,150}$'),
 PRIMARY KEY(account_id,device_id),CHECK((state='registered' AND token_ciphertext IS NOT NULL AND token_digest IS NOT NULL AND transport IS NOT NULL AND provider_config_id IS NOT NULL AND permission<>'denied' AND registered_at IS NOT NULL AND revoked_at IS NULL) OR(state='revoked' AND token_ciphertext IS NULL AND token_digest IS NULL AND revoked_at IS NOT NULL)));
CREATE FUNCTION longball.push_registration_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,longball AS $$
DECLARE observed bigint:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
BEGIN
 IF NOT longball.actor_valid() OR longball.context_json()->>'operation' NOT IN('push.register','push.revoke') OR NEW.account_id<>longball.context_json()->>'accountId' OR NEW.issuer<>longball.context_json()->>'issuer' OR NOT EXISTS(SELECT 1 FROM longball.native_app_devices d WHERE d.device_id=NEW.device_id AND d.account_id=NEW.account_id AND d.issuer=NEW.issuer AND d.platform=NEW.platform) THEN RAISE EXCEPTION 'Enrolled own push device required' USING ERRCODE='42501'; END IF;
 IF (longball.context_json()->>'operation'='push.register' AND NEW.state<>'registered') OR (longball.context_json()->>'operation'='push.revoke' AND NEW.state<>'revoked') THEN RAISE EXCEPTION 'Push operation state required' USING ERRCODE='42501'; END IF;
 IF TG_OP='UPDATE' THEN
  IF ROW(NEW.account_id,NEW.issuer,NEW.device_id) IS DISTINCT FROM ROW(OLD.account_id,OLD.issuer,OLD.device_id) OR NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'Immutable push identity or stale revision' USING ERRCODE='42501';END IF;
  IF OLD.registered_at IS NOT NULL THEN NEW.registered_at=OLD.registered_at;ELSIF NEW.state='registered' THEN NEW.registered_at=observed;END IF;
 ELSE IF NEW.revision<>1 THEN RAISE EXCEPTION 'Initial push revision required' USING ERRCODE='42501';END IF;IF NEW.state='registered' THEN NEW.registered_at=observed;END IF;END IF;
 NEW.updated_at=observed;IF NEW.state='revoked' THEN NEW.revoked_at=observed;ELSE NEW.revoked_at=NULL;END IF;RETURN NEW;
END $$;
CREATE TRIGGER push_registration_boundary BEFORE INSERT OR UPDATE ON longball.push_registrations FOR EACH ROW EXECUTE FUNCTION longball.push_registration_guard();
ALTER TABLE longball.push_registrations ENABLE ROW LEVEL SECURITY;
CREATE POLICY push_read ON longball.push_registrations FOR SELECT USING(longball.actor_valid() AND account_id=longball.context_json()->>'accountId' AND issuer=longball.context_json()->>'issuer' AND longball.context_json()->>'operation' IN('push.read','push.register','push.revoke'));
CREATE POLICY push_insert ON longball.push_registrations FOR INSERT WITH CHECK(longball.actor_valid() AND account_id=longball.context_json()->>'accountId' AND issuer=longball.context_json()->>'issuer' AND longball.context_json()->>'operation' IN('push.register','push.revoke'));
CREATE POLICY push_update ON longball.push_registrations FOR UPDATE USING(longball.actor_valid() AND account_id=longball.context_json()->>'accountId' AND issuer=longball.context_json()->>'issuer' AND longball.context_json()->>'operation' IN('push.register','push.revoke')) WITH CHECK(longball.actor_valid() AND account_id=longball.context_json()->>'accountId' AND issuer=longball.context_json()->>'issuer');
CREATE POLICY native_devices_push_read ON longball.native_app_devices FOR SELECT USING(longball.actor_valid() AND account_id=longball.context_json()->>'accountId' AND issuer=longball.context_json()->>'issuer' AND longball.context_json()->>'operation' IN('push.read','push.register','push.revoke'));
-- Only a genuine worker login holding the exact currently leased notification job may
-- obtain encrypted destinations for that job's original recipient. API and unclaimed
-- worker contexts cannot use this function; no broad worker table read is granted.
CREATE FUNCTION longball.push_targets_for_current_job(p_account text) RETURNS SETOF longball.push_registrations LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $$
 SELECT p.* FROM longball.push_registrations p JOIN longball.native_app_devices d ON d.device_id=p.device_id AND d.account_id=p.account_id AND d.issuer=p.issuer AND d.platform=p.platform JOIN longball.accounts a ON a.id=p.account_id AND a.issuer=p.issuer AND a.status='active'
 WHERE longball.runtime_purpose()='worker' AND longball.worker_kind()='notification.dispatch' AND EXISTS(SELECT 1 FROM longball.jobs j WHERE j.id=longball.context_json()->>'jobId' AND j.payload_json->>'accountId'=p_account AND longball.worker_job_valid(j.club_id,j.team_id,j.season_id))
 AND p.account_id=p_account AND p.state='registered' AND p.permission IN('granted','provisional') ORDER BY p.device_id $$;
REVOKE ALL ON FUNCTION longball.push_registration_guard(),longball.push_targets_for_current_job(text) FROM PUBLIC;
