# Two-manager viewing and handover browser evidence

Passed four actual browser/HTTP groups on 21 October 2026 against the isolated development bundle `index-eb1a18b79ec7636e393b14e3846dd781.js`, SHA-256 `5bc1bc9ef67fc62919076745cdfd729809c62d44b3edbbb062ecf7a4bd45f806`.

The harness used a fresh fictional SQLite HTTP service on port 4385 and a separate browser export on port 4384. Fixture preparation, attendance, staged lineup, controller acquisition, upload, addressed offer and acceptance used existing authorised API operations. No application projection was injected, and no existing database was reset.

- Manager A prepared and uploaded the before-kickoff accepted lineup through the existing controller.
- Manager B at 320 px saw the accepted pitch/list/bench and static checkpoint, with no recording editor or normal acquisition action. Opening Request handover sent no POST. A forbidden write returned HTTP 403 without changing the accepted revision.
- The real addressed offer succeeded before kickoff. Wrong-device acceptance returned HTTP 404. Correct account/device acceptance confirmed epoch 2 and downloaded its authoritative checkpoint before recording became available.
- Manager A at 390 px refreshed to Viewing after transfer; match-edit controls were absent and the accepted lineup was unchanged.

There were no browser page errors or horizontal overflow. [evidence.json](evidence.json) records the asset and exact group scope; the screenshots show request details and the former recorder's available bench/observation. The before-kickoff journey required no referee-clock pause, running transfer, message or notification.

Repeat after exporting to `.local/accepted-view-web` with `node scripts/accepted-view-review.mjs`. The script owns only its unique local fixture and ports 4384/4385. It retains failures and prints no controller capability. Production authentication, native encrypted storage, physical iPhone/Android use and running handover are not claimed. The accepted-policy summary is covered by pure tests for forward integration with the separately committed policy increment; this baseline browser fixture has no versioned policy event.
