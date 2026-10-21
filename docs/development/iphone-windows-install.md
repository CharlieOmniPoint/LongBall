# Install the fictional iPhone kit from Windows

A Windows PC and iPhone are available. **The verified IPA is pending** in
[build 39612410823](https://github.com/CharlieOmniPoint/LongBall/actions/runs/39612410823).
Wait for its successful build, verified artifact link and IPA SHA256 before
signing. The Simulator app cannot run on iPhone. LongBall signing/install on the
owner’s PC and phone remains unproved.

[Sideloadly](https://sideloadly.io/) documents free Apple Account signing on
Windows. It is third-party software that communicates with Apple: choosing it
is a local trust decision. Enter credentials/verification codes **in the expected
Apple/tool flow on your PC**, never in chat, CI or shared logs. No paid membership
or EAS service is needed for this proposed test.

## Prepare and verify

1. Check your normal phone backup is current. Do not erase the phone, uninstall
   an existing LongBall app or clear data to fix installation. Do not assume a
   phone backup can restore LongBall’s protected unsynchronised journal.
2. Follow [Sideloadly’s official prerequisites](https://sideloadly.io/faq).
   Windows 10+ is recommended. Use Apple’s **web versions of iTunes and iCloud**,
   rather than Microsoft Store versions, through the Apple links on
   [Sideloadly’s site](https://sideloadly.io/). Review existing installations before
   replacing them. No software has been installed for you.
3. Once available, download and extract the artifact ZIP. The signing input is
   the **`.ipa` inside it**; do not unpack the IPA’s `Payload`. Check the minimum
   iOS version and local-notification-only variant in `build-proof.json`. Verify:

   ```powershell
   Get-FileHash .\LongBall-fictional-c71-local-only-unsigned.ipa -Algorithm SHA256
   ```

   Compare with `SHA256SUMS`, the verified proof and published run summary. Stop
   on a mismatch. Do not use an APK/Simulator ZIP or override minimum iOS support.

## Sign and install locally

4. Connect the unlocked iPhone by USB. Select **Trust This Computer** and enter
   the phone passcode there when asked. Confirm iTunes/Sideloadly detect it.
5. Open Sideloadly, select the phone and drag in the IPA. Keep the default Apple
   ID signing mode, enter the owner’s Apple Account and click **Start**. Complete any password, two-factor
   or free developer-agreement prompt locally. App-specific passwords are not
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

This variant omits APNs entitlement: it can test **local** notifications, not
remote push/universal links. Native account authentication and PKCE need a
separately configured trusted issuer/API. See [Apple’s free-account limits](https://developer.apple.com/help/account/basics/about-your-developer-account)
and [Sideloadly’s renewal FAQ](https://sideloadly.io/faq).

For help, send Windows/iOS versions, kit SHA256, tool version, failing step and
exact **redacted** error. Remove Apple Account email, device UDID, tokens, codes
and profile details. Do not send raw signing/device logs.
