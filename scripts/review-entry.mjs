/** Exact pinned discovery endpoint with only its bounded public cache-busting key. */
export const REVIEW_STATUS_REQUEST = /^https:\/\/raw\.githubusercontent\.com\/CharlieOmniPoint\/LongBall\/preview\/longball-m0\/preview-status\.json\?reviewCheck=\d{1,16}-\d{1,9}$(?![\s\S])/;

/** Select the fictional account explicitly whenever the entry screen is shown. */
export async function enterFictionalReview(page, role = 'manager', destination = 'local') {
  const welcome = page.getByTestId('welcome-review');
  await welcome.or(page.getByTestId('prepare-match')).first().waitFor();
  if (!await welcome.isVisible()) return false;
  await welcome.click();
  await page.getByTestId(`review-entry-${role}`).click();
  await page.getByTestId(`review-open-${destination}`).click();
  return true;
}

/** A dual-role account must choose its verified team/season/role before use. */
export async function selectWorkspaceContext(page, role = 'manager', {
  teamId = 'synthetic-roma-u10',
  seasonId = 'synthetic-season-2026-27',
  playerId = role === 'player' ? 'synthetic-player-01' : 'none',
} = {}) {
  const choices = page.getByTestId('workspace-context-choices');
  const ready = page.getByTestId('workspace-context-ready');
  await choices.or(ready).first().waitFor();
  if (await choices.isVisible()) {
    await page.getByTestId(`workspace-context-${role}-${teamId}-${seasonId}-${playerId}`).click();
  }
  await ready.waitFor();
}

export async function changeWorkspaceContext(page, role, scope) {
  await page.getByTestId('workspace-change-context').click();
  await page.getByTestId('workspace-context-choices').waitFor();
  await selectWorkspaceContext(page, role, scope);
}

/** Follow the same compact primary/More navigation as a phone reviewer. */
export async function openWorkspaceTab(page, tab) {
  await page.getByTestId('workspace-context-ready').waitFor();
  const target = page.getByTestId(`workspace-tab-${tab}`);
  if (!await target.isVisible()) {
    const more = page.getByTestId('workspace-tab-more');
    if (await more.isVisible()) await more.click();
    else if (tab === 'settings') {
      await page.getByTestId('workspace-tab-clubs').click();
      await page.getByRole('button', { name: 'Edit club and team configuration', exact: true }).click();
      return;
    }
  }
  await target.click();
}

