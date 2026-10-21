ALTER TABLE longball.media_uploads ADD COLUMN club_id text;
UPDATE longball.media_uploads u SET club_id=g.club_id FROM longball.game_contexts g WHERE g.id=u.match_id AND g.team_id=u.team_id AND g.season_id=u.season_id;
ALTER TABLE longball.media_uploads ADD CONSTRAINT media_uploads_match_scope FOREIGN KEY(match_id,club_id,team_id,season_id) REFERENCES longball.game_contexts(id,club_id,team_id,season_id);
CREATE FUNCTION longball.derive_media_game_scope() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,longball AS $fn$
DECLARE p record; BEGIN
 SELECT club_id,team_id,season_id INTO p FROM longball.game_contexts WHERE id=NEW.match_id;
 IF p.club_id IS NULL OR NEW.club_id IS NOT NULL AND NEW.club_id<>p.club_id OR NEW.team_id IS DISTINCT FROM p.team_id OR NEW.season_id IS DISTINCT FROM p.season_id THEN RAISE EXCEPTION 'Object scope unavailable' USING ERRCODE='42501'; END IF;
 NEW.club_id=p.club_id; RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION longball.derive_media_game_scope() FROM PUBLIC;
CREATE TRIGGER media_uploads_scope BEFORE INSERT OR UPDATE OF match_id,club_id,team_id,season_id ON longball.media_uploads FOR EACH ROW EXECUTE FUNCTION longball.derive_media_game_scope();
ALTER TABLE longball.media_uploads ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION longball.media_gallery_allowed(p text,v integer,m text,o text,c text,t text,s text) RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $$ SELECT longball.actor_role(c,t,s) IN('player','spectator') AND EXISTS(
 SELECT 1 FROM longball.documents d CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.value_json->'photos','[]'::jsonb))photo
 CROSS JOIN LATERAL jsonb_array_elements(COALESCE(photo->'revisions','[]'::jsonb))r(value)
 WHERE d.club_id=c AND d.team_id=t AND d.season_id=s AND d.kind='community' AND d.value_json->>'synthetic'='true'
 AND photo->>'id'=p AND photo->>'matchId'=m AND photo->>'teamId'=t AND photo->>'seasonId'=s AND photo->>'uploaderAccountId'=o AND photo->>'removedAtMs' IS NULL
 AND (photo->>'publishedRevision')::integer=v AND (r.value->>'version')::integer=v AND r.value->>'status'='published'
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(d.value_json->'matches','[]'::jsonb))match WHERE match->>'id'=m AND match->>'teamId'=t AND match->>'seasonId'=s AND match->>'sharing'='fictional_review_only')
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(d.value_json->'hiddenUploaders','[]'::jsonb))hidden WHERE hidden->>'accountId'=longball.context_json()->>'accountId' AND hidden->>'uploaderAccountId'=o)) $$;
REVOKE ALL ON FUNCTION longball.media_gallery_allowed(text,integer,text,text,text,text,text) FROM PUBLIC;
CREATE POLICY media_read ON longball.media_uploads FOR SELECT USING (
 team_id=longball.context_json()->>'teamId' AND season_id=longball.context_json()->>'seasonId' AND
 (longball.actor_manager(club_id,team_id,season_id) OR (owner_id=longball.context_json()->>'accountId' AND longball.actor_role(club_id,team_id,season_id) IN('player','spectator'))
 OR (status='linked' AND longball.media_gallery_allowed(photo_id,display_revision,match_id,owner_id,club_id,team_id,season_id))));
CREATE POLICY media_insert ON longball.media_uploads FOR INSERT WITH CHECK (owner_id=longball.context_json()->>'accountId' AND longball.actor_role(club_id,team_id,season_id) IN('manager','player') AND longball.context_json()->>'operation'='media.prepare');
CREATE POLICY media_update ON longball.media_uploads FOR UPDATE USING (owner_id=longball.context_json()->>'accountId' AND longball.actor_role(club_id,team_id,season_id) IN('manager','player') AND longball.context_json()->>'operation' IN('media.upload','media.complete')) WITH CHECK (owner_id=longball.context_json()->>'accountId' AND longball.actor_role(club_id,team_id,season_id) IN('manager','player'));
