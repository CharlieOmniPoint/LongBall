# LongBall

Native iPhone and Android football team management, with a phone-friendly browser review of the same interface and shared match rules. The initial **M0 synthetic journey** covers Roma U10 home, explicit attendance, staged lineup, manual halves, clock pause/resume, live lineup review and a local participation record. All F01–F28 remain the integrated pilot scope; M0 physical-device proof is incomplete.

Use Node **24.19.0** and pnpm **11.25.0**:

```bash
bash scripts/setup.sh
source scripts/dev-env.sh
pnpm check
pnpm build:web
pnpm preview:web
```

Open `http://localhost:4173` on the machine running the server. A cloud workspace's localhost is not a public link. The browser uses only fictional Player 01–13 data and independent IndexedDB storage. Start with **Prepare match → check in → continue → place seven → start**. Complete both halves, or reopen a running session to try explicit clock recovery. Native notification/encryption experiments are under **More → Feasibility lab**.

`pnpm dev` starts Metro for a custom native development client. Expo Go cannot prove SQLCipher. Native code includes a sleep-inclusive clock, boot continuity evidence, SQLCipher/SecureStore journal and backup-exclusion handling. These require native compilation and physical iPhone/Android testing; JavaScript exports do not prove them. Android compilation is currently blocked by the environment's denial of the official `repo.reactnative.dev` artifact host. No APK or signed iOS build is claimed.

- [Review, commands and actual evidence](docs/development/review.md)
- [M0 scope and native proof register](docs/development/implementation-scope.md)
- [All 28 features](docs/development/traceability.md) and [unresolved decisions](docs/development/decisions.md)
- [Android build evidence](docs/development/android-build-evidence.md)
- [Toolchain/setup](docs/development/setup.md) and [architecture](docs/development/architecture-review.md)
- [Preserved supplied pack](docs/longball/README.md) and [canonical specification](docs/longball/LongBall_Mobile_Build_Pack_v0_1.md)
- [Later browser deployment preparation](infra/browser-review.md)

No backend identity, remote sync, spectator access, ballots, photos or full substitution solver is connected yet. These are later milestones. No real child data, paid services, hosting or store provisioning is needed for this increment.
