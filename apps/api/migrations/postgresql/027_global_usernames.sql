-- One private namespace for provider identities, spectator PINs and configured
-- demo logins. Triggers reserve atomically, including across otherwise hidden
-- clubs. Clients cannot list the registry or probe it through an API endpoint.
CREATE TABLE longball.global_usernames(
 normalized_username text PRIMARY KEY CHECK(normalized_username=lower(normalized_username)),
 account_id text NOT NULL REFERENCES longball.accounts(id));
ALTER TABLE longball.global_usernames ENABLE ROW LEVEL SECURITY;
CREATE POLICY global_usernames_no_direct_access ON longball.global_usernames USING(false) WITH CHECK(false);

CREATE FUNCTION longball.claim_global_username(p_username text,p_account text) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,longball AS $$
BEGIN
 INSERT INTO longball.global_usernames(normalized_username,account_id) VALUES(lower(p_username),p_account)
 ON CONFLICT(normalized_username) DO NOTHING;
 IF EXISTS(SELECT 1 FROM longball.global_usernames WHERE normalized_username=lower(p_username) AND account_id<>p_account)
 THEN RAISE EXCEPTION 'Username unavailable' USING ERRCODE='23505',CONSTRAINT='global_username'; END IF;
END $$;
CREATE FUNCTION longball.global_username_claim() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,longball AS $$
BEGIN
 PERFORM longball.claim_global_username(NEW.username,NEW.account_id);
 RETURN NEW;
END $$;

DO $$ DECLARE r record; BEGIN
 FOR r IN SELECT username,account_id FROM longball.lb_spectator_activation_accounts
 UNION SELECT username,account_id FROM longball.spectator_pin_credentials
 LOOP PERFORM longball.claim_global_username(r.username,r.account_id); END LOOP;
END $$;
CREATE TRIGGER spectator_provider_global_username BEFORE INSERT OR UPDATE OF username,account_id ON longball.lb_spectator_activation_accounts FOR EACH ROW EXECUTE FUNCTION longball.global_username_claim();
CREATE TRIGGER spectator_pin_global_username BEFORE INSERT OR UPDATE OF username,account_id ON longball.spectator_pin_credentials FOR EACH ROW EXECUTE FUNCTION longball.global_username_claim();

-- Child activation feature tables may be created after the core migration on a
-- fresh database; the separate schema-owner feature migrator calls this too.
CREATE FUNCTION longball.install_child_username_registry() RETURNS void
 LANGUAGE plpgsql SET search_path=pg_catalog,longball AS $$
DECLARE r record;
BEGIN
 IF to_regclass('longball.lb_activation_children') IS NULL THEN RETURN; END IF;
 FOR r IN SELECT username,account_id FROM longball.lb_activation_children
 LOOP PERFORM longball.claim_global_username(r.username,r.account_id); END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid='longball.lb_activation_children'::regclass AND tgname='child_global_username') THEN
  CREATE TRIGGER child_global_username BEFORE INSERT OR UPDATE OF username,account_id ON longball.lb_activation_children FOR EACH ROW EXECUTE FUNCTION longball.global_username_claim();
 END IF;
END $$;
SELECT longball.install_child_username_registry();

CREATE FUNCTION longball.claim_configured_demo_username(p_username text,p_account text) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,longball AS $$
BEGIN
 IF p_username!~'^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$'
 OR p_account!~'^synthetic-account-[A-Za-z0-9_-]+$'
 OR NOT EXISTS(SELECT 1 FROM longball.accounts WHERE id=p_account AND issuer='urn:longball:synthetic')
 OR (longball.runtime_purpose() IS DISTINCT FROM 'api' AND session_user<>current_user)
 THEN RAISE EXCEPTION 'Demo identity unavailable' USING ERRCODE='42501'; END IF;
 PERFORM longball.claim_global_username(p_username,p_account);
END $$;
REVOKE ALL ON longball.global_usernames FROM PUBLIC;
REVOKE ALL ON FUNCTION longball.claim_global_username(text,text),longball.global_username_claim(),longball.install_child_username_registry(),longball.claim_configured_demo_username(text,text) FROM PUBLIC;
