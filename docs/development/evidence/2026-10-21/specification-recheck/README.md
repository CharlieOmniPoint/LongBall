# Specification recheck evidence

Product source: `60789694c89dd4bc8aa5902ddb984dc84f6cba45`. These records preserve each run’s source and artifact binding; earlier browser runs are not retroactively relabelled as the final source. Counts from overlapping focused checks must not be added to full-suite totals. Original failures and test-environment limitations remain recorded.

| Evidence | Result and practical limit |
| --- | --- |
| [Host verification](source/verification-6078969.json) | 742 shared/platform and 380 API tests passed without skips; 24 migration checks, lint, both type checks, contracts and source/native/browser exports passed. JavaScript exports do not establish native compilation. |
| [CI and image](quality/README.md) | Source-equivalent CI tree: 742 unit, 377 API passes plus three explicit decoder skips, 24 migration and ten browser checks. Actual maintained-decoder/scanner/PDF production-image check passed separately. Dependency enforcement failed on two high build-tool advisories; no exception was granted. |
| [Native compilation](quality/native-compilation.json) | Both actual native jobs passed for `6078969`: Android Debug and unsigned iOS Simulator. Upload was disabled; no downloadable binary, production signing, installation or physical runtime proof is claimed. |
| [Paired restore](source/host-paired-restore-6078969.json) | Actual host schema16 and private-object backup/restore, encrypted export/key recovery and wrong-key rejection passed. This is not offsite recovery or an operating SLA. |
| [Phone layouts](phone/summary.json) | Source-qualified 320/390px account and matchday journeys, safe screenshots and artifact digests. Browser evidence does not establish physical-phone timing, storage, alerts or signing. |
| [Records](records/README.md) | Final-source actual-worker PDF browser scenario02 passed, including a saved and parsed report with readable Roma/Maple context. Historical and earlier-scope checks and failures remain separate. |
| [Performance](performance/README.md) | The unchanged local 1,000-request/50-session workload passed narrowly: read p95 489.948ms, command p95 483.195ms. Maxima exceed 500ms. Four earlier failed/diagnostic runs remain; no production-network/device capacity claim. |
| [Public publication](source/publication-6078969.json) | Actual matching Pages/API build information and Pages JavaScript bytes verified. All four connected roles opened at 390px without horizontal overflow or page errors; authorised photo loaded. PDF/CSV returned protected HTTP200 attachments. Managed browser disk saving was canceled; the same authorised requests were replayed to inspect the binary responses. Local saved-PDF proof is separate. |

Review at https://charlieomnipoint.github.io/LongBall/ using **Explore Roma U10 demo → choose a role → Open connected demo**. Static Pages is lasting; the current separate API session expires at **04:28:27 UTC on 22 October 2026**. Its product source is `6078969`, runtime transport is `ad3ee0b` and Pages transport is `11f627a`. No paid service or real child data was introduced.

The full [specification recheck](../../../specification-recheck.md) and [work register](../../../full-build-plan.md) retain the remaining implementation and acceptance gates: deferred privacy verification/retention/support decisions and SEC20/SEC21 fulfilment/UI34 operator console, physical-device checks, real provider/operating services and policies, and unresolved dependency advisories. Demo sharing and ballot configuration do not approve production policy.
