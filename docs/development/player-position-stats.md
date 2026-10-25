# Selected-player season position maps

Manager Player Stats opens the selected player's season map by default. Choosing any player, including the currently selected player, returns the map to Selected player. An explicit Whole team choice remains available until another player selection; ordinary refresh and rotation preserve that choice for the same scoped player.

Recorded position cards with exactly zero known time and zero percent use readable grey text. Unknown data is not converted into zero. Small positive percentages below 0.1% display `<0.1%`, preserving the distinction from a true zero.

Current declared primary positions have a solid red outline; secondary positions have a dotted red outline. A labelled legend and accessible rank descriptions accompany the visual markers. Preferences come from the Manager's existing, authorized preparation profile for the same club, team and season. Recorded playing time does not determine preference rank. A core position absent from the reference formation appears as an explicitly labelled outside-layout chip; no pitch location or time is invented.

Whole-team maps have no individual preference outlines. Administrator statistics keep their existing aggregate-only data contract and do not acquire private profile access; administrators can use their existing Manager context for the Manager view. Missing preferences are shown as unavailable or not recorded.

The shared Button now exposes selected toggle state as `aria-pressed` on the browser while preserving native accessibility state. This corrected the first browser check's accessibility finding. Native iPhone/Android and phone/tablet targets remain unchanged. Physical-device and existing production/privacy/security gates remain separate.

Source-qualified tests, screenshots and publication evidence are recorded in the dated evidence register. The backend, shared rules, locks and native configuration were unchanged from `d07cf42`; rebuilt API/worker binaries were byte-identical to that previously tested release. No credential values are included in the evidence.
