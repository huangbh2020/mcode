/**
 * In-memory stand-in for `@main/lib/imageArtifacts.js` in the headless smoke
 * (shell reveal scope). The real module touches fs (content-addressed cache
 * files); the smoke only needs to observe that the bytes passed through.
 */
const revealed: string[] = [];

export function getRevealedDataUrls(): readonly string[] {
  return revealed;
}

export async function revealImageInFolder(dataUrl: string): Promise<boolean> {
  revealed.push(dataUrl);
  return true;
}
