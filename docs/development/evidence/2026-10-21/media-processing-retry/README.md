# Private media processing retry

[The report](report.json) records 49 passing checks across five files, with restricted PostgreSQL and the maintained native HEIC decoder configured; no tests were skipped. Actual child-process tests distinguish timeout, signal/crash, missing executable and filesystem failure from an explicit decoder rejection. HTTP tests then verify the same private upload, capability and completion identity can retry after each transient failure, while malformed content remains rejected and unpublished. Supplied logos use the same classification and retain their private uploaded record on transient failure.

The decoder keeps its existing 12-second process limit, 128 MB V8 heap, image byte/pixel limits, original hash/type verification, scanner gate and metadata stripping. Only a normal decoder exit with the explicit rejection marker becomes HTTP 415. Uncertain process outcomes become existing retryable `MEDIA_PROCESSING_FAILED` HTTP 503; no gallery or published slot is created by failure or retry alone.

The earlier full-suite HTTP 415 discarded its worker error, so its cause remains unconfirmed. This correction does not attribute that incident to host load. The report binds the changed sources and isolated API build artifacts; it does not claim a new public deployment, browser or native-device acceptance.
