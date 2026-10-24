# Keep LongBall in Codex: local Windows review

21 October 2026. The native iPhone/Android application, shared domain logic and F01–F28 scope remain in this repository. No Sites deployment is needed to develop or review it.

## Why the cloud preview could not open

The implementation chat executes in a Linux cloud workspace. The desktop browser executes on the user's Windows computer. `localhost` is different on those machines. This cloud environment exposes no supported inbound preview/port-forwarding capability, and opening a URL in the Codex browser does not create one. A cloud-only HTTP 200 does not prove that the user can open that URL.

The desktop has a local project named LongBall at `C:\Users\charl\Documents\GPT_CODEX\LongBall`. Project metadata currently reports that folder is not a Git repository; its contents have not been inspected from this cloud chat. Do not overwrite it to transfer this work.

## Transfer the current work

`python3 scripts/package-local.py` creates `.local/longball-local-codex.zip` with the committed source, an offline Git history bundle, the tested browser export and a local Codex continuation prompt. It excludes credentials, local journals, dependencies, SDKs and caches. Its manifest identifies the exact source revision and export hashes. The export must already exist; run `pnpm build:web` when application inputs change.

Extract into a **new empty folder**, then open the included `LongBall` folder as a local project in Codex on Windows. Start work in the **local execution environment**, rather than attaching this cloud environment. Paste the included `Codex-local-prompt.txt` so the local agent can inspect installed tools, preserve the source and get the preview running on that computer. This cloud chat cannot execute commands in the Windows folder.

The prebuilt browser needs no Node/pnpm install if Python is available. From the extracted `LongBall` folder, in a Windows terminal:

```powershell
py -m http.server 4173 --bind 127.0.0.1 --directory apps/mobile/dist-web
```

Leave that terminal running and open `http://127.0.0.1:4173/` in the browser on the same computer. If `py` is absent, the local Codex agent must inspect available Python/Node runtimes and establish the server before claiming the preview works. No administrator port reservation, cloud tunnel or paid service is needed for a loopback server.

The snapshot's source folder has no `.git` directory. To restore the exact development branch/history instead, clone the adjacent bundle into another new empty folder:

```powershell
git clone -b dev/longball-m0-journey .\longball-history.bundle .\LongBall-With-History
```

The ignored prebuilt export is included in the snapshot folder, not in the Git history. Rebuild it or copy only that export into the restored clone. Do not overwrite a working tree or discard an unsynchronised rehearsal.

## Later sharing and children's access

Local review does not provide an internet link. A lasting fictional browser review is already available at [GitHub Pages](https://charlieomnipoint.github.io/LongBall/), while development continues in Codex; current publication evidence is in [review.md](review.md). Native testing/distribution remains a separate iPhone/Android path. The static review alone gives each browser its own fictional rehearsal; it does not create shared team accounts, accepted match sync or production access controls.

Sites is unsuitable for the planned child-facing LongBall service under [ChatGPT Sites Terms section 2.5(d)](https://openai.com/policies/chatgpt-sites-terms/) (updated 23 July 2026; checked 21 October): a Site and its content must not “target or be designed for children under 13 or the applicable age of digital consent.” Public anonymous access or household account sharing does not remove that restriction. This is separate from OpenAI account age requirements.

Codex is the adult developer's tool. LongBall's players would use the app's own accounts and permissions. An independently operated U10 app still needs the agreed privacy, recovery, safeguarding and competition-sharing arrangements. [ICO guidance](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/childrens-information/children-and-the-uk-gdpr/how-do-the-lawful-bases-apply-to-children-s-personal-information/#consent) distinguishes the UK age-13 consent rule for directly offered information-society services relying on consent from a blanket prohibition on apps for younger children. No lawful basis, parental-verification method or live-data approval is selected by this local review.
