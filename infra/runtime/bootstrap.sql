-- Executed once by the PostgreSQL bootstrap administrator on an empty volume.
-- Passwords are mounted files; do not commit generated secrets or enable SQL echo.
\set ON_ERROR_STOP on
SELECT format('CREATE ROLE longball_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', btrim(pg_read_file('/run/secrets/migrator_password'), E'\r\n')) \gexec
SELECT format('CREATE ROLE longball_api LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', btrim(pg_read_file('/run/secrets/api_password'), E'\r\n')) \gexec
SELECT format('CREATE ROLE longball_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', btrim(pg_read_file('/run/secrets/worker_password'), E'\r\n')) \gexec
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON DATABASE longball FROM PUBLIC;
GRANT CONNECT ON DATABASE longball TO longball_migrator,longball_api,longball_worker;
CREATE SCHEMA longball AUTHORIZATION longball_migrator;
REVOKE ALL ON SCHEMA longball FROM PUBLIC;
