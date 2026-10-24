# Team position catalogue

Each team's preparation projection can store `positionCatalogue` entries with `code`, `label` and `active`. Existing preparations without this field inherit the original eight positions. Codes are exactly two uppercase ASCII letters; labels have at most 60 characters. Core codes remain in the catalogue, and GK must remain active. A code is an identity: to replace it, add the new code and make the old one inactive.

Inactive positions remain readable in saved profiles, formations and match snapshots. An existing profile may retain an inactive preference or eligibility value when other profile details change; a new assignment must use an active code. New formation versions and newly prepared matches reject inactive slots. There is no automatic substitution of another position. An already saved match continues to use its frozen slots and player eligibility, including position codes subsequently made inactive.

Custom codes pass through profiles, saved formations, match configuration and the actual rotation planner. The existing football rules still require exactly one GK slot and a first- or second-choice eligible goalkeeper. Position eligibility remains a manager decision; a player preference alone never grants eligibility. The existing three distinct ranked preferences and nonempty eligibility requirements remain in force.

The own-player DTO includes only the public catalogue metadata alongside the authorised player's existing view. It does not expose other player profiles. Its strict parser validates the catalogue and dynamic position codes. Legacy DTOs without a catalogue retain the original defaults.

The player editor separates Details and Positions, shows one ranked-position selector at a time, and offers Select all for active manager-approved eligibility. Previously retained inactive eligibility values remain until explicitly removed. Team Edit and Archive actions share a row with minimum 48px touch targets and full accessible player names. Add player appears before the roster; import and activation tools sit behind Squad tools. Calendar storage and date editor values stay ISO, while displayed dates use the shared UK formatter.

Catalogue and profile drafts retain source-revision checks. Saved lineup setup commands pass their reviewed command identity and revision through the preparation boundary. No cataloguing action rewrites past snapshots, confirms a proposed lineup or starts the match clock. Safe cancellation UI is injected separately by the connected workspace; existing postponed/cancelled event history is retained.

Focused checks cover legacy defaults, code validation, GK protection, custom-code planning, immutable inactive history, own-player DTO boundaries and stale/replayed commands. Browser layout and native-device acceptance remain separate checks.
