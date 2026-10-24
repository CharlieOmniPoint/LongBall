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

The clean-source suite **passed for `7da2226a2b24a878ea2ac1c6cb55fe07df33a220`**: 36 role/viewport journeys across four roles and nine sizes, plus two composite business groups. It captured 39 screenshots and used ten bounded logins. There were no recorded HTTP, runtime or transport failures. The checks covered shared preference persistence, role boundaries, unsaved Administrator/profile/lineup/event-review values and running-clock continuity; layout actions left the exact local journal/outbox and HTTP writes unchanged. The accepted server match remained unstarted at revision 0 until explicit upload.

The [source-bound evidence register](evidence/2026-10-24/tablet-layout/README.md) links the report, native/configuration results and hosted outcomes as they become available. Product tree `c77fb0240e7565fa7cb86936992d0f03dadaccc1` and source-bundle SHA256 `92c8f1972c6a1e4eba72a82c99892266624bb7b734a98ad0f54569bf322eabf4` identify the published product. Earlier failures found a small logo acknowledgement target and lost keyboard focus after choosing a layout; both were corrected before the complete pass, and the original failed reports remain retained.

[Six evaluated native-configuration groups passed](evidence/2026-10-24/tablet-layout/native-config-7da2226a.json). The matching-product CI also passed the complete tablet suite. The new API ready marker and Pages deployment are observed; the [external public-browser proof](evidence/2026-10-24/tablet-layout/public-browser-7da2226a.json) passed 12 role/viewport entries and 18 keyboard layout choices with matching source/assets/API. Staff focus/expanded state, preference persistence and measured panels passed; Player/Spectator remained single-column with no staff controls. Current Android Debug arm64 and unsigned x86_64 iOS Simulator compilations both passed for published source `7da2226a`. Local browser/configuration results do not establish those outcomes. Existing functionality checks retain their separate sources; no aggregate baseline count is silently reattributed to this tablet product.

A separate [six-group branding regression](evidence/2026-10-24/tablet-layout/baseline-brand-evidence.json) passed on recorded `30cd554` assets with real ClamAV processing: private upload, explicit exact-image/rights publication, published badges at 320/390px and team→club→neutral inheritance with retained assets/preparation. It retains its earlier artifact scope rather than proving the final tablet presentation.

Physical iPad/Android-tablet rotation, keyboard, split-window, accessibility and background behaviour remain unproved; browser or compilation evidence cannot establish them. Existing owner-deferred privacy decisions and the dependency release gate remain unchanged. No paid services are provisioned.
