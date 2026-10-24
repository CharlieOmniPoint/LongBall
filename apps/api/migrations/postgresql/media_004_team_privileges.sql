-- SEC17 current contribution checks supplement, never replace, media ownership and scan/revision rules.
CREATE POLICY media_team_privilege_insert ON longball.media_uploads AS RESTRICTIVE FOR INSERT WITH CHECK(longball.team_privilege_allowed(team_id,owner_id,'uploads',true));
-- Processing may finish privately after suspension; it cannot link a new contributed revision.
CREATE POLICY media_team_privilege_link ON longball.media_uploads AS RESTRICTIVE FOR UPDATE USING(true) WITH CHECK(status<>'linked' OR longball.team_privilege_allowed(team_id,owner_id,'uploads',true));
CREATE FUNCTION longball.media_completion_write(c text,t text,s text,k text) RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $$
 SELECT longball.runtime_purpose() IN('api','maintenance') AND k='community' AND longball.context_json()->>'operation'='media.complete'
 AND longball.actor_role(c,t,s)='player' AND t=longball.context_json()->>'teamId' AND s=longball.context_json()->>'seasonId'
 AND longball.team_privilege_allowed(t,longball.context_json()->>'accountId','uploads',true) $$;
-- Canonical player completion writes the pending community projection and verified private manifest atomically.
CREATE POLICY documents_player_media_insert ON longball.documents FOR INSERT WITH CHECK(longball.media_completion_write(club_id,team_id,season_id,kind));
CREATE POLICY documents_player_media_update ON longball.documents FOR UPDATE USING(longball.media_completion_write(club_id,team_id,season_id,kind)) WITH CHECK(longball.media_completion_write(club_id,team_id,season_id,kind));
REVOKE ALL ON FUNCTION longball.media_completion_write(text,text,text,text) FROM PUBLIC;
