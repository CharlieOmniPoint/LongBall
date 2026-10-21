# LongBall

Native iPhone and Android team management, with a phone-friendly browser review using the same interface and shared match rules. Development branch: `dev/longball-m0-journey`. The expanded development build implements preparation, attendance, lineup and clock control, goals and audited corrections, substitution planning, participation reports/history, invitations, private awards and moderated photo workflows. All review accounts and Roma U10 data are fictional. It is **not a completed production release**; native device proof and operating decisions remain open.

Use Node **24.19.0** and pnpm **11.25.0**:

```bash
bash scripts/setup.sh
source scripts/dev-env.sh
pnpm check
pnpm build:web
pnpm build:api
LONGBALL_SYNTHETIC_AUTH=1 LONGBALL_STATIC_DIRECTORY="$PWD/apps/mobile/dist-web" pnpm dev:api
```

The combined development server defaults to `http://127.0.0.1:4310`. Open it on that machine; cloud localhost does not reach a desktop browser. For a shared cloud review, use the current verified HTTPS session linked in the chat and recorded in `preview/longball-m0:preview-status.json`. That temporary session lasts up to one hour and uses fictional data only. No Windows setup is needed for the shared link.

Start with **Prepare match → check in → continue → place starters → start**. **More** opens team settings, photos, invitations, awards, the native feasibility lab and the connected service. The connected workspace has its own persistent HTTP data; local rehearsal changes are not silently uploaded. Separate fictional player/spectator accounts demonstrate their restricted views. A production build (`EXPO_PUBLIC_ENVIRONMENT=production`) starts at connected sign-in and disables fictional identities.

`pnpm dev` starts Metro for a custom native development client. Expo Go cannot prove SQLCipher. Native code includes a sleep-inclusive clock, continuity checks, SQLCipher/SecureStore journal and backup exclusions. JavaScript exports do not prove native compilation or physical phone behaviour. A pinned, standard public CI workflow is prepared for native compilation; actual run evidence belongs in the review register.

- [Review, commands and actual evidence](docs/development/review.md)
- [Full feature implementation and remaining gates](docs/development/full-build-plan.md)
- [Independent audit](docs/development/independent-audit.md)
- [All 28 features](docs/development/traceability.md) and [unresolved decisions](docs/development/decisions.md)
- [Native M0 proof register](docs/development/implementation-scope.md)
- [API and worker](apps/api/README.md), [media pipeline](docs/development/media-ingestion.md), [records](docs/development/records-implementation.md)
- [Preserved supplied pack](docs/longball/README.md) and [canonical specification](docs/longball/LongBall_Mobile_Build_Pack_v0_1.md)
- [Cloud review deployment](infra/browser-review.md) and [native compilation workflow](infra/ci/README.md)

The API uses durable SQLite for development and verifies configured OIDC identities. Production identity/provider activation, PostgreSQL deployment/restore, scanning service operation, native offline/device acceptance and unresolved child-account/privacy/publication policies are not approved by this build. No paid infrastructure or real child data has been introduced.
