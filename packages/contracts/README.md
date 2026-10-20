# Shared contracts boundary

The preserved source contract is `docs/longball/contracts/openapi.yaml`. `pnpm test:contracts` checks its archive checksums, artifact invariants and full OpenAPI 3.1 validity. Add generated client/server types here only when an implementation needs them; validate semantic consistency with confirmed product rules before generation.
