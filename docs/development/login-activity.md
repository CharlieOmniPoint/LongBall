# Super Admin login and activity reports

The owner requested application-wide login reporting, club/team breakdowns and active-user summaries. The **Login activity** dashboard is available only to Super Admin. Its purple layout adapts to phone and tablet screens and uses actual server observations. It does not create demonstration login history to fill charts.

## Reading the dashboard

Club, team, account-type, event and time-period filters refine the report. The default is seven UK calendar days including today; 30 days also uses UK calendar days. The 24-hour selection is a rolling period. London summer-time changes are included. Timestamps display in UK time with two-digit years.

| Measure | Meaning |
| --- | --- |
| Sign-ins | Accepted application sign-in observations in the selected event window. OIDC observations have the narrower meaning described below. |
| Failed attempts | Recorded rejected demo/PIN credential evaluations and bounded limit observations. Unknown attempted identities remain unattributed. This is not a complete network-flood or upstream-provider audit. |
| Unique accounts | Distinct known accounts represented by the selected recorded events. Selecting logout events counts their known accounts; it does not make them new sign-ins. A shared Player account is one account, not a count of people. |
| Active accounts | Enabled LongBall accounts seen making authenticated API requests in the last 15 minutes. Foreground automatic polling is included. This does not prove that a person is currently online. |
| Current local sessions | Known unexpired, unrevoked local sessions observed within 15 minutes and held by this running service. The value is unavailable when the selected activity includes OIDC observations whose provider-session validity cannot be established. |
| Enabled accounts | Known LongBall accounts with current matching access. This is not a complete external identity-provider user directory or a guarantee that an external credential is configured. |

Event filtering affects recorded-event totals and the chart; the recent-activity window and current enabled-account counts remain independent. Recent activity uses access observed at the time, while enabled access is checked now. These are different populations after an access change and must not be treated as a strict adoption percentage.

Historical events keep their accepted account-type and club/team access snapshot. A Manager with access to two teams can appear in both team breakdowns while the global unique-account count remains one. These snapshots show access membership, not proof that the person visited a particular team screen. Super Admin activity is application-wide and unscoped; it is not copied onto every club or team. Unknown rejected credentials have no assigned club, team, account type or account label and are excluded by those filters.

The timeline shows at most 50 events per page. Its opaque, versioned cursor binds the normalized filter selection, event observation time and a persisted event-ordinal high-water mark and expires after one hour. Later inserts cannot enter that page sequence even if their timestamp matches or predates an earlier page. It is not an authentication capability. `eventAsOf` freezes the event window during pagination while `observedAt` describes current activity/report observations. Current account/catalog information can change independently.

The dashboard checks for updates every minute while open in the foreground and shows the last successful update time. Automatic checks stop in the background. While the Events tab has more than 50 loaded rows, automatic refresh pauses so older history stays in place. A successful manual **Refresh** returns to the first page and resumes automatic checks; leaving Events also resumes them. Failed refreshes keep the last successful report visible, while authorization failures clear it.

## Collection and privacy boundaries

Demo and Spectator PIN sign-ins are recorded only after credential and current-principal validation. Session sign-out is recorded once. API use updates the last-seen observation at most once per session per minute; refreshing a screen does not create repeated sign-in events. Expiry/restart does not invent an explicit sign-out.

OIDC collection records verified application use of an authentication context. It cannot see an identity provider's upstream wrong-password attempts, provider-only sign-outs, or every provider sign-in. The dashboard reports this coverage explicitly. It does not backfill activity before observation began.

Stored reporting data is limited to event type, provider category, timestamps, opaque account/internal observation IDs, display labels and server-derived access snapshots. Passwords, passcodes, access/refresh tokens, bearer-token digests, submitted unknown usernames, addresses and device fingerprints are excluded. Internal session-observation IDs are not returned to the report client. Display labels do not expose the configured login-credential list.

Collection errors never replace a successful authentication or the original safe authentication failure. They mark report collection unhealthy so missing observations are not silently described as complete. Repeated post-limit attempts are bounded in the observation stream; the report is not a replacement for a provider/security log collector.

## Bounds and authorization

`GET /v1/administration/login-analytics` is a private, no-store read. It rejects unknown/repeated query fields. A current Super Admin grant and stronger verified-adult authentication are checked again on the server and in the restricted PostgreSQL report function. This read-only report does not impose a five-minute step-up window; existing privileged administrative writes retain their separate recent-authentication requirements. Club Admin, Manager, Player and Spectator accounts cannot gain access by changing a role header or filter. The dashboard does not add a client-supplied event-write endpoint.

PostgreSQL migration 028 adds four row-secured reporting tables and narrow service functions. API and worker roles cannot read or change the raw reporting tables. Anonymous credential-rejection observations are a trusted service operation; identified observations must remain bound to the verified account. The worker cannot invoke collection or reporting functions. The expected core schema is 28 with 51 row-secured tables.

The report reads at most the newest 20,000 source events and a bounded recent-session/catalog set. An account access snapshot contains at most 500 distinct team-season grants. Up to 1,000 deduplicated access snapshots are resolved for a report; absent/truncated snapshot metadata is flagged rather than converted into guessed scope. At most 100 recent accounts are returned. Directory lists are capped at 20,000 entries each. The coverage flags identify event, activity/catalog and scope/snapshot truncation so charts and breakdowns are not presented as exhaustive when partial.

The read window and technical row caps are not a production retention decision. The existing owner-deferred Q05/Q09/Q10 request-verification, retention and support-authority decisions remain pending. Before production, the operator must configure the approved retention/deletion handling for these observations alongside the wider application policy. This development change does not select a retention period or approve privacy/support fulfilment. The bounded review service still starts from a fresh seeded database when renewed.

## Validation and remaining limits

The maintained runtime OpenAPI extension and `scripts/test-login-activity-contract.py` check strict report/query shape, nested metadata minimization, page/cap constants and the Super Admin wire boundary. Separate service and real PostgreSQL tests establish actual authorization, collection, aggregation and denial behavior. Browser checks cover visual layout, filters, role isolation and refresh/late-response handling. Counts and source-qualified outcomes are recorded in the dated evidence and review register.

Browser/API checks do not establish OS background behavior or physical iPhone/iPad/Android acceptance. Existing device and production identity/operating gates remain separate. No paid analytics service was provisioned.
