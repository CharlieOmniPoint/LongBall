# Current-source quality and release evidence

The independent GitHub check of development commit
`60789694c89dd4bc8aa5902ddb984dc84f6cba45` completed. Its production-image job passed.
Its quality job failed solely at the explicit dependency-audit gate. No gate was
disabled or treated as release approval.

The runner checked out PR merge `94f32d694e56cf09926fbd3c81e1f5182016c00e`.
GitHub's commit API independently confirms that both complete Git trees are
`cd0f9877c1cdaa71de5e2250342125f1c0437784`. The recorded results therefore cover
the exact development source, including the narrow PostgreSQL lock hierarchy
and the global device-ownership prerequisite.

- [Current CI result](current-ci.json): 742 shared/platform tests, 377 API passes
  and three explicit HEIC skips, 24 migration tests and ten browser checks.
  Frozen install, lint/types, canonical/runtime contracts, source publication,
  fixture checks, evaluated native configuration and JavaScript exports passed.
- [Actual image evidence](runtime-image.json): separately built source image,
  dedicated migrator, schema16, 16 restricted API checks and 24 worker checks,
  nonroot read-only runtimes with no published ports, ClamAV clean/EICAR checks,
  actual JPEG/HEIC decoding and a real packaged Unicode PDF generation/read.
- [Dependency audits](dependency-audits.json): workspace gate failed; isolated
  runtime and compiler dependency locks each reported zero vulnerabilities.
- [Secret scan](secret-scan.json): Gitleaks8.24.3 scanned 876 current-source files,
  found no unexpected secret and retained 26 exact reviewed metadata/prose false
  positives. This is not a history scan.
- [Inventory](inventory-summary.json) and [SPDX inventory](sbom.spdx.json):
  411 resolved JavaScript packages and one licensed PDF font. All 320 retained
  licence-file hashes were independently verified against the downloaded ZIP.
  These are dependency/font records, not legal approval or an OS/native SBOM.

The three source-job HEIC skips are not relabelled as passes. The separate image
job actually exercised the maintained decoder; the full local source run with
that decoder is separate evidence. The image job did not exercise paired restore,
production identity, actual push delivery, physical devices or an operational
scanner-update SLA. The separately recorded host restore must retain its own scope.

The native exports in this CI job are Hermes JavaScript bundles for Android and
iOS. They do not prove a native executable, signing, installation or device
behaviour. The subsequent native compilation workflow has its own transport and
source-bundle proof and must be assessed separately.

The two high findings remain `node-forge` / [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv)
and `braces` / [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm).
The registry returned no patched version for either. They occur in Expo signing
and Metro build tooling. The full-severity read on the same dependency lock also
retains `uuid` / [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq),
moderate, affecting v3/v5/v6 with supplied buffers; the recorded Xcode helper calls
v4. No speculative crypto patch or unreviewed transitive major override was applied.
The current quality gate remains failed.

The image and quality ZIPs were downloaded and matched their GitHub SHA256
digests. IDs, sizes, digests and three-day expiry dates are in `current-ci.json`.
The JSON evidence is retained here because the hosted ZIPs expire. Historical
[ee7cb6](historical-ee7cb6.json) and [bb509f7](historical-bb509f7.json) runs are
explicitly scoped to their earlier complete source trees; their acceptance is
not substituted for the current run.

Independent source reviews checked report scope, role/requester isolation,
idempotency, current-policy checks, encrypted artifacts, worker leases/retries,
expiry and download integrity; font/cloud packaging; Fastify parsing, safe errors,
CORS and shutdown; capability-bound invitation names and own-membership display
metadata; bounded notification inserts; and the lock hierarchy's compatibility
with existing global writers. Two concrete defects were closed before this
checkpoint: mandatory wire-length equality on decoded/chunked downloads, and a
global device-key race. The latter has three actual restricted-PostgreSQL HTTP
tests across independent API instances, including a controlled concurrent barrier.
The hierarchy received separate multi-instance barrier/revocation tests. A source
review is not production or legal approval.

Report exports do not fulfil privacy requests. Q05/Q09/Q10 remain explicitly
pending at the user's request. Native hardware checks, provider/hosting choices
and the unresolved dependency gate remain release limits. No paid service was
provisioned by these checks.
