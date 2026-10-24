# Club expansion dependency checks

The actual audits captured on 24 October 2026 at 21:22:30–21:22:34 UTC leave the workspace dependency gate **failed and unwaived**. The separately locked API/worker runtime and compiler audits passed with zero reported vulnerabilities. The [sanitized audit rollup](evidence/2026-10-24/club-expansion/dependencies.json) preserves each result, timestamp, lock SHA256, captured source `2ee01461160b83fad7a77c3a5d5d4240d2883b63` and `workingTreeDirty: true`. These are observations of the working tree at those times, not audit passes for a later final commit. All three current lockfiles still matched those captured fingerprints when the rollup was written.

| Workspace finding | Installed version and dependency path | Observed status |
| --- | --- | --- |
| High `node-forge`, [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv) | `1.4.0`, through Expo → `@expo/cli`, directly and through `@expo/code-signing-certificates` | Advisory covers `<=1.4.0`; audit reports no published patched version. The live npm registry still lists `1.4.0` as latest. |
| High `zod`, [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) | `3.25.76`, through Expo → `@expo/cli` | Reviewed advisory updated 23 October covers `<4.6.6`, patched `4.6.6`. Current workspace audit reports this additional high finding. |

Both paths come from the existing Expo CLI dependency graph. The added workbook dependency `@e965/xlsx@0.20.3` and QR dependency `qrcode-generator@2.0.4` have no findings in the captured workspace audit. This observation does not claim they are permanently vulnerability-free. The workspace audit classifies these Expo paths as `dev: false` because Expo is an application dependency; their tooling use does not remove them from the full dependency gate. The separate runtime/compiler audit passes do not waive that gate or establish a native release pass.

## Compatible update investigation

Read-only live npm metadata in the rollup records:

| Package | Latest stable observed | Relevant dependency |
| --- | --- | --- |
| `expo` | `58.0.19` | `@expo/cli: ^58.1.15` |
| `@expo/cli` | `58.1.15` | `zod: ^3.25.76` |
| `zod` | `4.6.7` | Latest stable v3 remains `3.25.76`. |
| `node-forge` | `1.4.0` | No patched published version was found. |

Installed CLI `58.1.13` also requires `zod: ^3.25.76`. Its `DevToolsPlugin.schema` and `createMCPDevToolsExtensionSchema` modules import the root `zod` entrypoint. Updating to the latest published Expo 58/CLI 58 patch therefore does not fix the Zod finding. No dependency override, patch, suppression or lockfile mutation was made during this investigation.

The [official Zod versioning documentation](https://zod.dev/v4/versioning) states that the root `zod` import changes from the v3 API to the v4 API in package major 4; the two schema types are not interchangeable. A forced `3 → 4` override is consequently not an established compatible fix for Expo's declared v3 dependency. Selecting `zod/v3` from a version-4 package retains the v3 engine rather than applying the v4 security fix; obtaining a cleaner version-only scan that way would not establish remediation.

The [upstream v4 fix](https://github.com/colinhacks/zod/pull/6652) rejects oversized bounded collections before walking their elements. Its author explicitly says unbounded containers are unchanged. Installed v3 `ZodArray._parse` checks a maximum, adds an issue and marks the result dirty, then still parses every element. The [v3 issue](https://github.com/colinhacks/zod/issues/6653) remains open; on 12 October the maintainer stated that new v3 versions are no longer being published and disputed the vulnerability classification. That dispute does not override the current reviewed advisory or approve a LongBall exception.

A supported upstream Expo CLI release that adopts a patched v4 engine, or a separately reviewed and tested backport, is still needed. Neither was implemented here. No application exploit was claimed from this dependency inspection. Functional feature checks may proceed, while both high findings remain recorded release blockers.
