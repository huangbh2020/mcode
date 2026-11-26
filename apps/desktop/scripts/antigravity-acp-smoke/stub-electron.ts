import { tmpdir } from "node:os";

export const app = {
  isPackaged: false,
  getPath: () => tmpdir(),
};

export const shell = {
  openExternal: (): Promise<void> => Promise.resolve(),
};

export const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: (s: string) => Buffer.from(s, "utf8"),
  decryptString: (b: Buffer) => b.toString("utf8"),
};
