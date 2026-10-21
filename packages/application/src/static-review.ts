/** Static review hosting contains no API. This guard makes that boundary explicit before auth/network. */
export function assertStaticReviewApiAddress(
  baseUrl: string,
  staticBrowser: boolean,
  currentOrigin?: string,
): void {
  if (!staticBrowser) return;
  let candidate: URL;
  try {
    candidate = new URL(baseUrl.trim());
  } catch {
    throw new Error(
      "This static review link has no connected API. Paste the separate absolute HTTP(S) service address.",
    );
  }
  if (
    !["http:", "https:"].includes(candidate.protocol) ||
    candidate.username ||
    candidate.password ||
    candidate.search ||
    candidate.hash
  )
    throw new Error(
      "Paste a separate HTTP(S) API address without credentials, query or fragment.",
    );
  if (!currentOrigin || candidate.origin === new URL(currentOrigin).origin)
    throw new Error(
      "This address is the static review host, which has no API. Use the separately supplied service address or temporary full-API review link.",
    );
}
