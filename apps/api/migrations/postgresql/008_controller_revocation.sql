-- A current administrator may freeze only the explicitly revoked target's controller.
-- This does not grant administrator access to native match state or event streams.
ALTER POLICY scoped_read ON longball.controller_grants USING (
 (longball.actor_manager(club_id,team_id,season_id) AND (longball.context_json()->>'matchId' IS NULL OR match_id=longball.context_json()->>'matchId'))
 OR (longball.context_json()->>'operation'='staff.revoke' AND account_id=longball.context_json()->>'staffTargetAccountId' AND longball.actor_admin(club_id,team_id,season_id)));
CREATE FUNCTION guard_admin_controller_revocation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,longball AS $fn$
BEGIN
 IF longball.context_json()->>'operation'='staff.revoke' AND longball.actor_admin(OLD.club_id,OLD.team_id,OLD.season_id) THEN
  IF OLD.account_id IS DISTINCT FROM longball.context_json()->>'staffTargetAccountId' OR NEW.frozen<>1 OR ROW(NEW.match_id,NEW.epoch,NEW.account_id,NEW.device_id,NEW.capability_hash,NEW.club_id,NEW.team_id,NEW.season_id) IS DISTINCT FROM ROW(OLD.match_id,OLD.epoch,OLD.account_id,OLD.device_id,OLD.capability_hash,OLD.club_id,OLD.team_id,OLD.season_id) THEN RAISE EXCEPTION 'Controller revocation may only freeze the exact assignment' USING ERRCODE='42501'; END IF;
 END IF;RETURN NEW;
END $fn$;
CREATE TRIGGER controller_revocation_boundary BEFORE UPDATE ON longball.controller_grants FOR EACH ROW EXECUTE FUNCTION guard_admin_controller_revocation();
REVOKE ALL ON FUNCTION guard_admin_controller_revocation() FROM PUBLIC;
