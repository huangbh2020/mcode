/**
 * Programmable stub for @renderer/lib/api.js — the smoke drives
 * `file.search` and `terminal.resolvePath` responses (and failures) through
 * globals set per assertion block. Anything left un-steered resolves empty.
 */
type ResolveInput = { projectPath: string; path: string };
type SearchInput = { projectPath: string; query: string; limit: number };
type SearchFile = { name: string; path: string; relativePath: string };

const gs = globalThis as {
  __STUB_TERMINAL_RESOLVE__?: (
    input: ResolveInput,
  ) => Promise<{ path: string | null; candidates: string[] }>;
  __STUB_FILE_SEARCH__?: (input: SearchInput) => Promise<{ files: SearchFile[] }>;
};

export const api = {
  file: {
    search: (input: SearchInput): Promise<{ files: SearchFile[] }> =>
      gs.__STUB_FILE_SEARCH__ ? gs.__STUB_FILE_SEARCH__(input) : Promise.resolve({ files: [] }),
  },
  terminal: {
    resolvePath: (
      input: ResolveInput,
    ): Promise<{ path: string | null; candidates: string[] }> =>
      gs.__STUB_TERMINAL_RESOLVE__
        ? gs.__STUB_TERMINAL_RESOLVE__(input)
        : Promise.resolve({ path: null, candidates: [] }),
  },
};
