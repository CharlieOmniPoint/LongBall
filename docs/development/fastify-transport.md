# Fastify API transport (DS01)

The API now uses pinned Fastify5.12.7 for its real HTTP request lifecycle. Domain
handlers, strict command parsers, role checks, PostgreSQL contexts, idempotency and
SQLite serialization remain in the existing typed dispatcher. Requests enter
Fastify routing, onRequest hooks, content parsing and validation before reaching
that dispatcher; no alternate domain HTTP listener bypasses the framework.

Fastify parses JSON commands with a256KiB byte limit, rejects nested prototype and
constructor poisoning, rejects malformed route encoding with a safe envelope, and requires a JSON object without coercing other types.
Content-type, parse, validation and size failures use the canonical safe error
shape. Origin checks run before parsing, so allowed browser callers receive CORS
headers on parser errors; rejected origins never reach body parsing. Fastify
creates validated request IDs and handles unsupported methods through its404 path.

Only exact photo/logo PUT routes have an encapsulated raw stream parser. The
existing authenticated manifest readers still check declared bytes, actual image
bytes and the15MiB cap while reading. JSON commands cannot use that parser. The
canonical dispatcher uses Fastify's documented reply.hijack for its existing
exact JSON, static, protected image and report-attachment responses; Fastify's
onResponse hooks still observe their completion. Upload and ordinary errors retain
private no-store envelopes without framework stacks or SQL details.

createApi remains synchronous and exposes the existing native server.listen API.
A custom Fastify server factory waits for framework readiness before processing
any native-server request. A preClose hook drains externally started native
listeners as part of framework.close; database/media cleanup follows that drain.
The65000ms request and10000ms header timeouts remain explicit on the native server.
Production bundles externalize Fastify so its supported CommonJS dependency graph
loads through Node; both production backend manifests and locks pin the same
version. No additional hosted service is introduced.

Twelve transport checks cover framework hooks/readiness/close, request IDs, JSON
object parsing, nested poisoning, declared and chunked size limits, unsupported
content types/methods, parser-error CORS, preflight and explicit static GET/HEAD.
Existing application/media/branding/restricted PostgreSQL and protected PDF/CSV
checks provide compatibility coverage. Current-source aggregate verification is
recorded separately; this document does not replace that evidence.

Official APIs consulted:

- https://fastify.dev/docs/latest/Reference/ContentTypeParser/
- https://fastify.dev/docs/latest/Reference/Server/
- https://fastify.dev/docs/latest/Reference/Reply/#hijack
