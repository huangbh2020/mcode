// electron stub — GitHubClient.ts imports `shell` for the OAuth device
// flow (shell.openExternal), which no scenario here reaches; the import
// chain just has to load without electron. Bundling the real package fails
// at init under plain node (its CJS entry does `require("fs")`).
export const shell = {
  openExternal: (_url: string): Promise<void> => Promise.resolve(),
};
