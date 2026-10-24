import assert from "node:assert/strict";

// These selectors stamp each response afresh; compare the permitted report data
// while retaining every revision, visibility and business-field assertion.
const reportEvidence = (report) => {
  const stable = { ...report };
  delete stable.generatedAt;
  return stable;
};

/**
 * Real-HTTP assertions for a prepared, current player workspace. The caller owns
 * browser/API setup and passes GET callbacks bound to that same verified account.
 * This helper never seeds state or invents a competition/sharing approval.
 *
 * await runConnectedCommunityChecks({ page, readCommunity: () => getOwnDto(),
 *   readOfficialRecords: () => getOwnRecordsDto() });
 */
export async function runConnectedCommunityChecks({
  page,
  readCommunity,
  readOfficialRecords,
  matchId,
  photoId,
  capture,
}) {
  const commands = [],
    checks = [];
  const observe = (request) => {
    if (request.method() !== "POST" || !/\/community\?/.test(request.url()))
      return;
    const command = request.postDataJSON()?.command;
    if (
      command &&
      ["ballot.cast", "concern.submitted", "uploader.hidden"].includes(
        command.type,
      )
    )
      commands.push(command);
  };
  const poll = async (read, accepts, label) => {
    const until = Date.now() + 45_000;
    do {
      const value = await read();
      if (accepts(value)) return value;
      await new Promise((resolve) => setTimeout(resolve, 500));
    } while (Date.now() < until);
    assert.fail(label);
  };
  const ownMatch = (dto, id) => dto.matches.find((match) => match.id === id);
  const count = (type) =>
    commands.filter((command) => command.type === type).length;
  const settled = async () => {
    await poll(
      () =>
        page
          .getByRole("button", { name: "Refresh service views", exact: true })
          .isEnabled(),
      Boolean,
      "The service receipt and scoped refresh must settle",
    );
    await page.getByTestId("workspace-community").waitFor();
  };
  const openPhoto = async (photo) => {
    await page.getByTestId(`album-game-${photo.matchId}`).click();
    await page.getByTestId(`album-photo-${photo.id}`).click();
    await page.getByTestId("album-photo-viewer").waitFor();
  };
  page.on("request", observe);
  try {
    await page.getByTestId("workspace-community").waitFor();
    let dto = await readCommunity();
    assert(dto.allowed, "Prepared player must have current allowed scope");
    const match = dto.matches.find(
      (item) =>
        (!matchId || item.id === matchId) &&
        item.mayVote &&
        item.candidates.length >= 2,
    );
    assert(
      match,
      "Prepare a genuinely permitted player ballot with at least two eligible teammates; this helper does not approve a withheld sharing policy",
    );
    const candidateA = match.candidates.find(
        (candidate) => candidate.id !== match.ownChoice,
      ),
      candidateB = match.candidates.find(
        (candidate) => candidate.id !== candidateA.id,
      );
    assert(candidateA && candidateB, "Two distinct teammates are required");
    if (match.ownChoice)
      await page.getByTestId(`community-change-vote-${match.id}`).click();
    const ballot = page.getByTestId(`connected-ballot-${match.id}`);
    await ballot
      .getByTestId(`community-vote-option-${match.id}-${candidateA.id}`)
      .click();
    let unchanged = await readCommunity();
    assert(
      ownMatch(unchanged, match.id).ownChoice === match.ownChoice,
      "Selecting a candidate must not change the recorded vote",
    );
    assert.equal(
      count("ballot.cast"),
      0,
      "A selection is a local draft, with no ballot POST",
    );
    await ballot.getByTestId(`community-confirm-vote-${match.id}`).click();
    await poll(
      readCommunity,
      (value) => ownMatch(value, match.id)?.ownChoice === candidateA.id,
      "First choice needs actual service acknowledgement",
    );
    await settled();
    assert.equal(count("ballot.cast"), 1);
    await page.getByTestId(`community-change-vote-${match.id}`).click();
    await page
      .getByTestId(`community-vote-option-${match.id}-${candidateB.id}`)
      .click();
    unchanged = await readCommunity();
    assert(
      ownMatch(unchanged, match.id).ownChoice === candidateA.id,
      "Change vote keeps the old choice until explicitly confirmed",
    );
    assert.equal(count("ballot.cast"), 1);
    await page.getByTestId(`community-confirm-vote-${match.id}`).click();
    await poll(
      readCommunity,
      (value) => ownMatch(value, match.id)?.ownChoice === candidateB.id,
      "Replacement choice needs actual service acknowledgement",
    );
    await settled();
    assert.equal(count("ballot.cast"), 2);
    checks.push(
      "Candidate selection is a draft; Confirm vote and Confirm changed vote are separate service commands",
    );

    dto = await readCommunity();
    const photo = dto.gallery.find((item) => !photoId || item.id === photoId);
    assert(
      photo,
      "Prepare a currently permitted published photo; unpublished/withheld content is never substituted",
    );
    const previousConcerns = new Set(dto.ownConcerns.map((item) => item.id));
    await openPhoto(photo);
    await page.getByTestId(`community-report-photo-${photo.id}`).click();
    assert.equal(
      count("concern.submitted"),
      0,
      "Opening a report form has no service side effect",
    );
    await page
      .getByLabel("Concern explanation", { exact: true })
      .fill("Fictional privacy concern. No personal details.");
    await page.getByTestId("community-submit-concern").click();
    dto = await poll(
      readCommunity,
      (value) =>
        value.ownConcerns.some(
          (item) =>
            !previousConcerns.has(item.id) && item.targetType === "photo",
        ),
      "Photo report reference must be acknowledged by the service",
    );
    await settled();
    const photoReport = dto.ownConcerns.find(
      (item) => !previousConcerns.has(item.id) && item.targetType === "photo",
    );
    assert(
      commands.find((command) => command.type === "concern.submitted")
        ?.targetId === photo.id,
      "Report photo binds the permitted exact photo target",
    );
    await page.getByTestId(`community-own-concern-${photoReport.id}`).waitFor();
    assert(
      !("reporterAccountId" in photoReport),
      "Own concern DTO does not disclose reporter identity to an uploader",
    );
    await openPhoto(photo);
    await page.getByTestId(`community-report-uploader-${photo.id}`).click();
    await page.getByTestId("community-concern-category-other").click();
    await page
      .getByLabel("Concern explanation", { exact: true })
      .fill("Fictional uploader concern. No personal details.");
    await page.getByTestId("community-submit-concern").click();
    dto = await poll(
      readCommunity,
      (value) =>
        value.ownConcerns.some(
          (item) =>
            !previousConcerns.has(item.id) && item.targetType === "uploader",
        ),
      "Uploader report requires its separate service reference",
    );
    await settled();
    const uploaderReport = dto.ownConcerns.find(
      (item) =>
        !previousConcerns.has(item.id) && item.targetType === "uploader",
    );
    const sentReports = commands.filter(
      (command) => command.type === "concern.submitted",
    );
    assert(
      sentReports.length === 2 &&
        sentReports[1].targetType === "uploader" &&
        sentReports[1].targetId === photo.uploaderAccountId,
      "Uploader report uses its independent permitted uploader target",
    );
    await page
      .getByTestId(`community-own-concern-${uploaderReport.id}`)
      .waitFor();
    checks.push(
      "Photo and uploader reports use distinct targets and expose only own reference/status",
    );

    const officialBefore = readOfficialRecords
      ? await readOfficialRecords()
      : null;
    await openPhoto(photo);
    const hide = page.getByTestId(`community-hide-uploader-${photo.id}`);
    assert(
      await hide.count(),
      "Use a photo from a different uploader for the gallery-only hide proof",
    );
    await hide.click();
    dto = await readCommunity();
    assert(
      !dto.hiddenUploaders.some((item) => item.id === photo.uploaderAccountId),
      "Opening hide review must not hide anything",
    );
    assert.equal(count("uploader.hidden"), 0);
    await page.getByTestId("community-cancel-hide-uploader").click();
    assert.equal(
      count("uploader.hidden"),
      0,
      "Cancel keeps the gallery unchanged",
    );
    await hide.click();
    await page.getByTestId("community-confirm-hide-uploader").click();
    dto = await poll(
      readCommunity,
      (value) =>
        value.hiddenUploaders.some(
          (item) => item.id === photo.uploaderAccountId,
        ),
      "Only explicit gallery-scope confirmation hides an uploader",
    );
    await settled();
    assert(
      !dto.gallery.some(
        (item) => item.uploaderAccountId === photo.uploaderAccountId,
      ),
      "Hidden uploader photos leave only this account's filtered gallery",
    );
    if (officialBefore) {
      const after = await readOfficialRecords();
      assert.deepEqual(
        reportEvidence(after.results),
        reportEvidence(officialBefore.results),
        "Gallery hide leaves official results available",
      );
      assert.deepEqual(
        reportEvidence(after.participation),
        reportEvidence(officialBefore.participation),
        "Gallery hide does not change permitted participation records",
      );
    }
    checks.push(
      "Gallery-only hide requires confirmation, Cancel is inert, and official records retain their separate permissions",
    );
    if (capture) await capture("connected-community-reports-hidden");
    const uploader = dto.hiddenUploaders.find(
      (item) => item.id === photo.uploaderAccountId,
    );
    await page
      .getByRole("button", {
        name: `Show ${uploader.label} again`,
        exact: true,
      })
      .click();
    dto = await poll(
      readCommunity,
      (value) => value.gallery.some((item) => item.id === photo.id),
      "Existing hidden-uploader settings restore the permitted gallery",
    );
    await settled();
    assert(
      dto.ownConcerns.some((item) => item.id === photoReport.id) &&
        dto.ownConcerns.some((item) => item.id === uploaderReport.id),
      "Report references remain visible after hide/unhide",
    );
    checks.push(
      "Restore uploader returns the permitted photo while preserving own report references",
    );
    return {
      checks,
      ballotPosts: count("ballot.cast"),
      reportTypes: sentReports.map((command) => command.targetType),
      ownReportReferences: [photoReport.id, uploaderReport.id],
      hidePosts: count("uploader.hidden"),
      privateChoicesRecordedInEvidence: false,
    };
  } finally {
    page.off("request", observe);
  }
}
