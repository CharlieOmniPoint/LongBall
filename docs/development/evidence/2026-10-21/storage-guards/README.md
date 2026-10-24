# Retained browser storage guard evidence

`node scripts/storage-guard-review.mjs` passed three real-browser cases on entry `index-25ef8375d2900f017af0882d72abda65.js`, SHA256 `44c470778f2fce51e094180d16d834587de95c062da8787a6b12cef871a8e98e`. No API was used.

Each case began in a new isolated fictional context, allowed normal application bootstrap to finish, then deliberately altered one field as a corruption fixture:

1. Empty retained device ID.
2. A valid-looking device ID with a terminal line feed; it must not be trimmed or normalized into a replacement identity.
3. A saved projection whose fixture ID differs from its requested journal namespace. The original raw command/config history was left intact.

After reopening, each displayed the explicit retained-data error with **Retry opening match**, rather than an indefinite spinner. A retry produced the same error. The exact serialized whole record, both original events and sequence checkpoints were unchanged after reopen and retry. Each retained record's SHA256 appears in `results.json`. No ID, match, event or checkpoint was deleted, reset, reseeded, relabelled or replaced. Screenshots show the actual error states.

The initial harness invocation stopped before any corruption because it expected an optional old banner. The harness now requires the current explicit “fictional players” and “Local manager review · no live team data” labels plus the synthetic fixture identity. Its original failed boundary result is retained separately; it was not a product guard failure.

These defensive corruption guards do not establish a cause or fix for the earlier intermittent cold-start timeout. The [album-review incidents and twenty clean startup checks](../album-review/README.md) remain recorded separately. This is fictional browser storage evidence, not native SQLCipher/reboot/recovery evidence.
