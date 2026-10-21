ALTER TABLE longball.lb_activation_children ADD COLUMN club_id text;
UPDATE longball.lb_activation_children c SET club_id=t.club_id FROM longball.teams t WHERE t.id=c.team_id;
ALTER TABLE longball.lb_activation_children ADD CONSTRAINT activation_child_full_identity UNIQUE(account_id,club_id,team_id,season_id),ADD CONSTRAINT activation_child_season_scope FOREIGN KEY(club_id,team_id,season_id) REFERENCES longball.team_seasons(club_id,team_id,season_id);
CREATE TRIGGER activation_children_scope BEFORE INSERT OR UPDATE OF club_id,team_id,season_id ON longball.lb_activation_children FOR EACH ROW EXECUTE FUNCTION longball.derive_season_scope();
CREATE FUNCTION longball.derive_activation_scope() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,longball AS $fn$
DECLARE p record; BEGIN
 SELECT club_id,team_id,season_id INTO p FROM longball.lb_activation_children WHERE account_id=NEW.account_id;
 IF p.club_id IS NULL OR (NEW.club_id IS NOT NULL AND NEW.club_id<>p.club_id) OR (NEW.team_id IS NOT NULL AND NEW.team_id<>p.team_id) OR (NEW.season_id IS NOT NULL AND NEW.season_id<>p.season_id) THEN RAISE EXCEPTION 'Object scope unavailable' USING ERRCODE='42501'; END IF;
 NEW.club_id=p.club_id; NEW.team_id=p.team_id; NEW.season_id=p.season_id; RETURN NEW;
END $fn$;
DO $scope$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['lb_activation_issues','lb_activation_tokens'] LOOP
  EXECUTE format('ALTER TABLE longball.%I ADD COLUMN club_id text,ADD COLUMN team_id text,ADD COLUMN season_id text',tab);
  EXECUTE format('UPDATE longball.%I x SET club_id=c.club_id,team_id=c.team_id,season_id=c.season_id FROM longball.lb_activation_children c WHERE c.account_id=x.account_id',tab);
  EXECUTE format('ALTER TABLE longball.%I ADD CONSTRAINT %I FOREIGN KEY(account_id,club_id,team_id,season_id) REFERENCES longball.lb_activation_children(account_id,club_id,team_id,season_id)',tab,tab||'_child_scope');
  EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OF account_id,club_id,team_id,season_id ON longball.%I FOR EACH ROW EXECUTE FUNCTION longball.derive_activation_scope()',tab||'_scope',tab);
 END LOOP;
END $scope$;
ALTER TABLE longball.lb_activation_verification_requests ADD COLUMN club_id text;
UPDATE longball.lb_activation_verification_requests x SET club_id=t.club_id FROM longball.teams t WHERE t.id=x.team_id;
ALTER TABLE longball.lb_activation_verification_requests ADD CONSTRAINT activation_verification_season_scope FOREIGN KEY(club_id,team_id,season_id) REFERENCES longball.team_seasons(club_id,team_id,season_id);
CREATE TRIGGER activation_verification_scope BEFORE INSERT OR UPDATE OF club_id,team_id,season_id ON longball.lb_activation_verification_requests FOR EACH ROW EXECUTE FUNCTION longball.derive_season_scope();
ALTER TABLE longball.lb_activation_children ENABLE ROW LEVEL SECURITY;
ALTER TABLE longball.lb_activation_issues ENABLE ROW LEVEL SECURITY;
ALTER TABLE longball.lb_activation_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE longball.lb_activation_verification_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY activation_children_read ON longball.lb_activation_children FOR SELECT USING (longball.actor_manager(club_id,team_id,season_id) OR longball.activation_account(account_id));
CREATE POLICY activation_children_insert ON longball.lb_activation_children FOR INSERT WITH CHECK (longball.actor_manager(club_id,team_id,season_id) AND account_id=longball.context_json()->>'provisionAccountId' AND created_by=longball.context_json()->>'accountId');
CREATE POLICY activation_children_update ON longball.lb_activation_children FOR UPDATE USING (longball.actor_manager(club_id,team_id,season_id) OR longball.activation_account(account_id,true)) WITH CHECK (longball.actor_manager(club_id,team_id,season_id) OR (longball.activation_account(account_id,true) AND state='active'));
CREATE POLICY activation_issues_read ON longball.lb_activation_issues FOR SELECT USING (longball.actor_manager(club_id,team_id,season_id));
CREATE POLICY activation_issues_insert ON longball.lb_activation_issues FOR INSERT WITH CHECK (longball.actor_manager(club_id,team_id,season_id));
CREATE POLICY activation_issues_update ON longball.lb_activation_issues FOR UPDATE USING (longball.actor_manager(club_id,team_id,season_id)) WITH CHECK (longball.actor_manager(club_id,team_id,season_id));
CREATE POLICY activation_tokens_read ON longball.lb_activation_tokens FOR SELECT USING (longball.actor_manager(club_id,team_id,season_id) OR (token_hash=longball.context_json()->>'tokenHash' AND longball.activation_account(account_id)));
CREATE POLICY activation_tokens_insert ON longball.lb_activation_tokens FOR INSERT WITH CHECK (longball.actor_manager(club_id,team_id,season_id) AND issued_by=longball.context_json()->>'accountId');
CREATE POLICY activation_tokens_update ON longball.lb_activation_tokens FOR UPDATE USING (longball.actor_manager(club_id,team_id,season_id) OR (token_hash=longball.context_json()->>'tokenHash' AND longball.activation_account(account_id))) WITH CHECK (longball.actor_manager(club_id,team_id,season_id) OR (token_hash=longball.context_json()->>'tokenHash' AND ((state='redeeming' AND longball.activation_account(account_id)) OR (state='completed' AND longball.activation_account(account_id,true)))));
CREATE POLICY activation_verification_read ON longball.lb_activation_verification_requests FOR SELECT USING (longball.actor_manager(club_id,team_id,season_id) AND actor_id=longball.context_json()->>'accountId');
CREATE POLICY activation_verification_insert ON longball.lb_activation_verification_requests FOR INSERT WITH CHECK (longball.actor_manager(club_id,team_id,season_id) AND actor_id=longball.context_json()->>'accountId');
REVOKE ALL ON FUNCTION longball.derive_activation_scope() FROM PUBLIC;

CREATE POLICY activation_completion_audit ON longball.audit FOR INSERT WITH CHECK (
 longball.activation_account(actor_id,true) AND actor_id=object_id AND action='identity.activation_completed' AND outcome='provider_verified_sign_in_required' AND context_operation='activation.complete'
 AND EXISTS(SELECT 1 FROM longball.lb_activation_children c WHERE c.account_id=actor_id AND c.club_id=audit.club_id AND c.team_id=audit.team_id AND c.season_id=audit.season_id));
