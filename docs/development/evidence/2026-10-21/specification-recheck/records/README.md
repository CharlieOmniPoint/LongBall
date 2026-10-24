# Records browser evidence

These are isolated browser checks using sample Roma U10 data. They do not verify a deployed URL or native hardware.

| Compiled source | Evidence scope |
| --- | --- |
| `70ed8cf41f60ec495d4c73c7ea8ec0a0578cdad3` | Historical accepted baseline: 16 successful checks/groups across six harnesses. Records scenarios 01–04 and 05 ran separately. |
| `ee7cb613695b8d96388e742a60dc248277b24091` | Records 01 and readable workspace choices; 03–05 passed together, including rollover, forced-denial recovery and human invitation context. Separate 05 also passed. |
| `60789694c89dd4bc8aa5902ddb984dc84f6cba45` | Focused records 02: accepted match archive plus actual worker CSV/PDF jobs and browser downloads. PDF text includes Roma, Richmond Rovers, 2026/27 and Maple FC; foreign team/account fixture values are absent. |

There was no uninterrupted five-scenario all-pass run at 607. Earlier observations and the focused 607 export check use different compiled artifacts and scenario inputs. The artifact manifests bind each copied web/API/worker/font build; report and download digests bind the observations. Downloaded files and screenshots are not included.

The ee7 failures remain recorded: an incorrect DOM attribute assumption in the harness, a real PDF team-name omission later fixed and verified at 607, and an execution-host transport interruption. No failure is silently converted into a pass. See `ee7-failed-attempts.json`.

The 403 denial is an explicit browser transport fixture. This browser check verifies closure and fresh-identity recovery; actual membership/grant revocation is covered by separate API checks. Native sharing, device timing, encrypted device storage and OS prompts require native acceptance.

All owned browser/API/worker/static processes were stopped after these runs; temporary export keys were removed. These local records do not claim a publication status. No capabilities, session headers, keys, databases, raw logs, downloaded files or screenshots are copied here.
