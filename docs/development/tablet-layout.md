# Manager and Administrator tablet layouts

Manager and Administrator workspaces have a display preference for the current device. Open the **layout icon in the workspace header**, then choose **Auto**, **Phone** or **Tablet**. The selected choice is shown in the control's accessible label.

| Choice | Behaviour |
| --- | --- |
| Auto | Uses tablet layout when the available window is at least 768px wide and its short edge is at least 600px. Short landscape phones keep the phone layout. |
| Phone | Centres the narrow workspace, including on a larger screen. |
| Tablet | Uses the available tablet workspace, with a safe single-column fallback wherever a panel cannot fit. |

The preference is shared between staff roles on this device and remembered across sessions. It contains no credentials or account identifiers: the browser uses local storage and native builds use SecureStore. If saving fails, the choice stays active for the current session and the control explains that it could not be remembered. A saved preference grants no access; current verified membership still determines every view and command. Player and Spectator workspaces remain single-column experiences and do not show the staff layout control, even when a staff preference is saved on the same device.

Tablet preparation, roster/form editing, statistics, staff configuration and live match panels use columns in portrait or landscape when their measured space permits. Windows at least 1024px wide and 600px high can add a navigation rail; large text removes the rail. Nested panels measure their own width before splitting, so narrow split-screen windows, short windows and larger text can return to readable single columns without changing the saved choice.

Layout changes keep the same state-owning components mounted. Unsaved fields, selected players, staged lineups and pending event confirmations are intended to survive resizing, rotation and Auto/Phone/Tablet changes. Reflow does not save configuration, claim control, accept an event, upload, start or pause a match. A running clock must remain running with its controls reachable. This continuity applies to layout changes; it does not promise that an unsaved in-memory draft survives refresh or sign-out.

Native configuration retains iPhone support and enables iPad, tablet orientations and window resizing without requiring full-screen mode. The generated Android activity handles orientation, screen-size/layout and keyboard configuration changes without requesting activity recreation for those changes. SQLCipher, backup exclusions, app identifiers and production network/notification protections remain configured. These configuration choices require separate compile and device evidence.

## Validation status

The maintained isolated browser runner is `pnpm test:tablet:e2e`. It uses generated fictional accounts, an owned loopback API and exact built artifacts; it does not exercise a real operating identity provider or physical tablet.

Early runs completed the 36 role/viewport journeys and identified a small logo acknowledgement target and lost keyboard focus after choosing a layout. Both controls have been updated; the full source-bound rerun is still pending. Earlier failed attempts retain their original reports and do not establish full acceptance.

Final source-bound evidence will be linked here after verification, covering:

- Auto/Phone/Tablet selection, shared staff preference, refresh/relogin persistence and narrow or large-text fallback.
- Unsaved Administrator/profile/lineup/event-review values and running-clock continuity, with no layout-caused HTTP write, journal change or outbox entry.
- Fresh development/production native configuration assertions, JavaScript exports and actual native compilation results, each with its own source and artifact scope.

Physical iPad/Android-tablet rotation, keyboard, split-window, accessibility and background behaviour remain unproved; browser or compilation evidence cannot establish them. Existing owner-deferred privacy decisions and the dependency release gate remain unchanged. No paid services are provisioned.
