-- Public rule metadata contains no account names or verifiers. Only current
-- strongly authenticated Super Admins may change the singleton.
CREATE TABLE longball.application_sign_in_rules(singleton integer PRIMARY KEY CHECK(singleton=1),revision bigint NOT NULL CHECK(revision>=0),rules_json jsonb NOT NULL,provider_revision bigint);
ALTER TABLE longball.application_sign_in_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY sign_in_rules_no_direct_access ON longball.application_sign_in_rules USING(false);
INSERT INTO longball.application_sign_in_rules(singleton,revision,rules_json) VALUES(1,0,'{"username":{"minLength":3,"maxLength":40,"allowNumbers":true,"allowSeparators":true},"password":{"minLength":12,"requireUppercase":true,"requireLowercase":true,"requireNumber":true,"requireSymbol":true,"disallowUsername":true},"spectatorPin":{"blockSimpleCodes":true}}');
CREATE FUNCTION longball.sign_in_rules_read() RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $$
 SELECT jsonb_build_object('revision',revision,'rules_json',rules_json,'provider_revision',provider_revision) FROM longball.application_sign_in_rules WHERE singleton=1 AND longball.runtime_purpose()='api'
$$;
CREATE FUNCTION longball.sign_in_rules_lock() RETURNS bigint LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $$
DECLARE result bigint;
BEGIN
 IF NOT longball.administration_allowed(NULL,true) OR longball.context_json()->>'operation' IS DISTINCT FROM 'administration.write' THEN RAISE EXCEPTION 'Sign-in rule administration unavailable' USING ERRCODE='42501'; END IF;
 SELECT revision INTO result FROM longball.application_sign_in_rules WHERE singleton=1 FOR UPDATE;
 RETURN result;
END $$;
CREATE FUNCTION longball.sign_in_rules_save(p_revision bigint,p_rules jsonb,p_provider_revision bigint) RETURNS bigint LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $$
DECLARE result bigint;
BEGIN
 IF NOT longball.administration_allowed(NULL,true) OR longball.context_json()->>'operation' IS DISTINCT FROM 'administration.write' THEN RAISE EXCEPTION 'Sign-in rule administration unavailable' USING ERRCODE='42501'; END IF;
 IF p_rules IS NULL OR jsonb_typeof(p_rules) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(p_rules))<>3 OR NOT p_rules ?& ARRAY['username','password','spectatorPin'] OR
 jsonb_typeof(p_rules->'username') IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(p_rules->'username'))<>4 OR NOT (p_rules->'username') ?& ARRAY['minLength','maxLength','allowNumbers','allowSeparators'] OR
 jsonb_typeof(p_rules->'password') IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(p_rules->'password'))<>6 OR NOT (p_rules->'password') ?& ARRAY['minLength','requireUppercase','requireLowercase','requireNumber','requireSymbol','disallowUsername'] OR
 jsonb_typeof(p_rules->'spectatorPin') IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(p_rules->'spectatorPin'))<>1 OR NOT (p_rules->'spectatorPin') ? 'blockSimpleCodes' OR
 jsonb_typeof(p_rules#>'{username,minLength}') IS DISTINCT FROM 'number' OR jsonb_typeof(p_rules#>'{username,maxLength}') IS DISTINCT FROM 'number' OR jsonb_typeof(p_rules#>'{password,minLength}') IS DISTINCT FROM 'number' OR
 p_rules#>>'{username,minLength}' !~ '^\d+$' OR (p_rules#>>'{username,minLength}')::integer NOT BETWEEN 3 AND 32 OR
 p_rules#>>'{username,maxLength}' !~ '^\d+$' OR (p_rules#>>'{username,maxLength}')::integer NOT BETWEEN GREATEST(8,(p_rules#>>'{username,minLength}')::integer) AND 40 OR
 p_rules#>>'{password,minLength}' !~ '^\d+$' OR (p_rules#>>'{password,minLength}')::integer NOT BETWEEN 8 AND 64 OR
 EXISTS(SELECT 1 FROM (VALUES(p_rules#>'{username,allowNumbers}'),(p_rules#>'{username,allowSeparators}'),(p_rules#>'{password,requireUppercase}'),(p_rules#>'{password,requireLowercase}'),(p_rules#>'{password,requireNumber}'),(p_rules#>'{password,requireSymbol}'),(p_rules#>'{password,disallowUsername}'),(p_rules#>'{spectatorPin,blockSimpleCodes}'))v(value) WHERE jsonb_typeof(value) IS DISTINCT FROM 'boolean') OR
 (p_provider_revision IS NOT NULL AND p_provider_revision<>p_revision+1) THEN RAISE EXCEPTION 'Invalid sign-in rules' USING ERRCODE='23514'; END IF;
 UPDATE longball.application_sign_in_rules SET revision=revision+1,rules_json=p_rules,provider_revision=p_provider_revision WHERE singleton=1 AND revision=p_revision RETURNING revision INTO result;
 IF result IS NULL THEN RAISE EXCEPTION 'Sign-in rules revision conflict' USING ERRCODE='40001'; END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION longball.sign_in_rules_read(),longball.sign_in_rules_lock(),longball.sign_in_rules_save(bigint,jsonb,bigint) FROM PUBLIC;

CREATE FUNCTION longball.sign_in_rules_provider_confirm(p_revision bigint) RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,longball AS $$
BEGIN
 IF longball.runtime_purpose() IS DISTINCT FROM 'api' THEN RETURN false; END IF;
 UPDATE longball.application_sign_in_rules SET provider_revision=p_revision WHERE singleton=1 AND revision=p_revision;
 RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION longball.sign_in_rules_provider_confirm(bigint) FROM PUBLIC;
