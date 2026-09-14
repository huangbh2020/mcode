/**
 * Stand-in for the `electron` module in the headless smoke. Only `app` is
 * referenced by the store modules; `getPath("userData")` reads the temp dir
 * from SMOKE_USER_DATA so the smoke never touches the real profile.
 */
export const app = {
  getPath(name: string): string {
    if (name === "userData") {
      const dir = process.env.SMOKE_USER_DATA;
      if (!dir) throw new Error("SMOKE_USER_DATA is not set");
      return dir;
    }
    throw new Error(`stub-electron: getPath(${name}) is not supported`);
  },
};

export default { app };
