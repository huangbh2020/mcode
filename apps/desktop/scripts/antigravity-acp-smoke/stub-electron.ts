import { tmpdir } from "node:os";

export const app = {
  isPackaged: false,
  getPath: () => tmpdir(),
};

export const shell = {
  openExternal: (): Promise<void> => Promise.resolve(),
};
