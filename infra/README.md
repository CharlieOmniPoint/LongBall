# Local infrastructure

M0 fixture, contract and mobile bundling checks need no hosted services or credentials. Android SDK setup is described in `docs/development/setup.md`; iOS requires macOS/Xcode.

Add disposable PostgreSQL and other services when integration work needs them. Fastify, a PostgreSQL job worker, Keycloak evaluation and private media storage are later boundaries. Hosting purchases, store enrolment and production provisioning are outside this repository preparation.
