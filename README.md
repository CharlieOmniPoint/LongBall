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

`pnpm dev` starts Metro for a custom native development client. Expo Go cannot prove SQLCipher. Native code includes a sleep-inclusive clock, continuity checks, SQLCipher/SecureStore journal and backup exclusions. JavaScript exports do not prove native compilation or physical phone behaviour. Standard public CI compiled Android debug and the unsigned iOS simulator application for source `36223f7`. Binaries were not retained. Physical-phone behaviour remains unproved; see the review evidence.

- [Review, commands and actual evidence](docs/development/review.md)
- [Full feature implementation and remaining gates](docs/development/full-build-plan.md)
- [Independent audit](docs/development/independent-audit.md)
- [All 28 features](docs/development/traceability.md) and [unresolved decisions](docs/development/decisions.md)
- [Native M0 proof register](docs/development/implementation-scope.md)
- [API and worker](apps/api/README.md), [media pipeline](docs/development/media-ingestion.md), [records](docs/development/records-implementation.md)
- [Preserved supplied pack](docs/longball/README.md) and [canonical specification](docs/longball/LongBall_Mobile_Build_Pack_v0_1.md)
- [Cloud review deployment](infra/browser-review.md) and [native compilation workflow](infra/ci/README.md)

The API now runs against real PostgreSQL, with separate migration/API/worker roles and SELECT-only runtime schema checks. The disposable runtime has passed access/controller/correction/season/report tests, actual ClamAV scanning, private photo processing, paired database/file restore, and restricted container API/worker checks. SQLite remains an explicit fictional alternative. See [runtime setup and limits](infra/runtime/README.md).

Connected reports include audited historical corrections, explicit accepted-match context/archive, permitted JSON/CSV exports and source-preserving season rollover. History review preserves original event bytes, previews minute changes and saves immutable reconciliation proposals. Final disputed-history approval remains gated by the unresolved owner policy. Generic notification jobs recheck current access/preferences; absent push configuration is visibly blocked and never labelled delivered.

The lasting fictional browser review is prepared for GitHub Pages, with the owner enabling Actions publishing on 21 October. Publication and its live address must be verified before sharing; see [review deployment](infra/browser-review.md). It uses each browser’s fictional local records; the temporary API session remains separate. Native iPhone/Android, physical-device proof, operating ownership and unresolved child-account/privacy/publication decisions remain required. No paid infrastructure or real child data has been introduced.
