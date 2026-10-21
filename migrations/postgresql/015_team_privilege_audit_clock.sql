-- Audit receipt time is database evidence. Never compare two volatile clock
-- observations or accept an application-supplied timestamp as its provenance.
CREATE FUNCTION longball.stamp_team_privilege_decision_received() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,longball AS $$
 BEGIN
  NEW.created_at=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
  RETURN NEW;
 END $$;
CREATE TRIGGER team_privilege_decision_received BEFORE INSERT ON longball.team_privilege_decisions
 FOR EACH ROW EXECUTE FUNCTION longball.stamp_team_privilege_decision_received();
ALTER POLICY team_privilege_decision_insert ON longball.team_privilege_decisions
 WITH CHECK(longball.team_privilege_manager(club_id,team_id)
 AND longball.context_json()->>'operation'='privileges.write'
 AND actor_id=longball.context_json()->>'accountId'
 AND longball.team_privilege_target(club_id,team_id,target_account_id));
REVOKE ALL ON FUNCTION longball.stamp_team_privilege_decision_received() FROM PUBLIC;
