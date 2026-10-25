# Install the fictional iPhone kit from Windows

Download the [verified unsigned iPhone kit](https://github.com/CharlieOmniPoint/LongBall/actions/runs/39616024656/artifacts/12352708819) before
**14:39:52 UTC on 22 October 2026**. [Build39616024656](https://github.com/CharlieOmniPoint/LongBall/actions/runs/39616024656)
and the actual downloaded ZIP/IPA/checksums passed verification;
[provenance](evidence/2026-10-21/feature-completion/ios-device-kit.json).

Use `LongBall-fictional-c71-local-only-unsigned.ipa` from the extracted artifact
ZIP. It requires **iOS16.4 or later** and contains an actual device ARM64 Release
app with embedded JavaScript; it needs no Metro. It is **unsigned**: local signing
on the owner’s Windows PC is still required before installation. No local
signing, installation, renewal or phone behaviour has been proved. The Simulator
app cannot run on iPhone.

IPA SHA256: `3812c755233b58241669b634f4cf685794b6bb2176ac38a849fa971f6aa175fa`.

[Sideloadly](https://sideloadly.io/) documents free Apple Account signing on
Windows. It is third-party software that communicates with Apple: choosing it
is a local trust decision. Enter credentials/verification codes **in the expected
Apple/tool flow on your PC**, never in chat, CI or shared logs. No paid membership
or EAS service is needed for this proposed test.

## Prepare and verify

1. Do not erase the phone, uninstall an existing LongBall app or clear data to
   fix installation. Do not assume a phone backup can restore LongBall’s
   protected unsynchronised journal.
2. Follow [Sideloadly’s official prerequisites](https://sideloadly.io/faq).
   Windows 10+ is recommended. Use Apple’s **web versions of iTunes and iCloud**,
   rather than Microsoft Store versions, through the Apple links on
   [Sideloadly’s site](https://sideloadly.io/). Review existing installations before
   replacing them. No software has been installed for you.
3. Download and extract the artifact ZIP linked above. The signing input is
   the **`.ipa` inside it**; do not unpack the IPA’s `Payload`. Check iOS16.4+
   support and the declared local-notification-only variant in `build-proof.json`.
   Verify:

   ```powershell
   Get-FileHash .\LongBall-fictional-c71-local-only-unsigned.ipa -Algorithm SHA256
   ```

   Compare with the exact IPA SHA256 above, `SHA256SUMS`, the verified proof and
   published run summary. Stop on a mismatch. Do not use an APK/Simulator ZIP or override minimum iOS support.

## Sign and install locally

4. Connect the unlocked iPhone by USB. Select **Trust This Computer** and enter
   the phone passcode there when asked. Confirm iTunes/Sideloadly detect it.
5. Open Sideloadly, select the phone and drag in
   `LongBall-fictional-c71-local-only-unsigned.ipa`. Keep the default Apple
   ID signing mode, enter the owner’s Apple Account and click **Start**. Complete
   any password, two-factor or free developer-agreement prompt locally. App-specific passwords are not
   assumed: Sideloadly’s FAQ limits them to particular paid-account settings.
6. Keep normal options: no tweak/dylib injection, minimum-OS spoofing, extra file
   sharing or restriction-removal options. The first signer may assign an App ID
   prefix or unique bundle identifier. Record that **final initial identity**,
   signing account and expiry privately; keep them stable on renewals. Never send
   us passwords, verification codes, private keys or provisioning profiles.
7. When required, trust the developer profile under **Settings → General →
   VPN & Device Management**. On iOS 16+, enable **Settings → Privacy & Security →
   Developer Mode**, restart and confirm. See [Apple’s instructions](https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device).
   On failure, report the error; do not erase records or change signing identity.

## First launch and renewal

8. Open **LongBall Synthetic Lab**, then enable airplane mode, turn Wi-Fi off,
   close and reopen it. It should show fictional Roma U10 without Metro. Follow
   the [physical-device checklist](device-review.md) and record iPhone storage,
   clock and reminder results. Installation alone is not an M0 pass. Use no real
   child data.
9. Free profiles expire after **seven days**. Apple limits free accounts to three
   installed apps per device, ten App IDs and three registered devices. Renew
   **before expiry** with the same account/final app identity using USB or
   configured Wi-Fi. The optional refresh daemon needs the PC available. Renew
   the existing app rather than uninstalling. On key-access failure, preserve the
   installation and report it; do not reset the journal.

This verified variant uses source `c71f19d` with one recorded `app.json` change,
`enableRemoteNotifications:false`. The main application’s configuration and full
feature scope are unchanged. This variant omits APNs entitlement: it can test **local** notifications, not
remote push/universal links. Native account authentication and PKCE need a
separately configured trusted issuer/API. See [Apple’s free-account limits](https://developer.apple.com/help/account/basics/about-your-developer-account)
and [Sideloadly’s renewal FAQ](https://sideloadly.io/faq).

For help, send Windows/iOS versions, kit SHA256, tool version, failing step and
exact **redacted** error. Remove Apple Account email, device UDID, tokens, codes
and profile details. Do not send raw signing/device logs.
