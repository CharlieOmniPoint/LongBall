# Manager and Administrator tablet layouts

The staff workspace has one device-local display preference: Auto, Phone or Tablet. It is presentation only; the current verified membership still determines every view and command. Player and Spectator workspaces remain simple single-column experiences, including on a device with a saved staff preference.

Auto uses tablet layout when the available window is at least768px wide and its short edge is at least600px. This avoids treating a short landscape phone as a tablet. Explicit Tablet is allowed on any window but safely falls back to one column when the content cannot fit. Phone centres the existing narrow workspace. The preference is shared across staff roles on this device and stored without credentials/account identifiers.

Tablet preparation, roster/form editing, statistics, staff configuration and live match panels use available width. Large landscape windows add a navigation rail. Nested panels measure their own space before splitting; large text and narrow split-screen windows retain readable columns. Layout changes do not change football rules or automatically save, accept, upload, start or pause anything. State owners, inputs, lineup drafts and event confirmations remain mounted during reflow.

Native configuration supports both iPhone and iPad and all tablet orientations. Android uses resizable orientation handling without recreating the activity. SQLCipher, backup exclusions, app identifiers and production network/notification protections remain configured.

## Acceptance

- Four roles across phone, tablet portrait/landscape and short landscape-phone viewports.
- Explicit staff preference, Auto behavior, role boundaries, refresh/relogin persistence and safe narrow fallback.
- Actual panel geometry, navigation, minimum touch targets, typography and no horizontal overflow.
- Unsaved staff/profile/lineup/event values and running-clock state preserved across resize/toggle; no new command, upload or journal/outbox entry caused by layout.
- Fresh-source development/production native configuration assertions, JavaScript exports and actual native compile checks.

The maintained isolated browser runner is `pnpm test:tablet:e2e`. Detailed source-bound results and the current published review window will be linked here after verification. Physical iPad/Android-tablet rotation, keyboard, split-window, accessibility and background behavior still require device testing; compilation/browser evidence cannot establish those. Existing owner-deferred privacy decisions and the dependency release gate remain unchanged. No paid services are provisioned.
