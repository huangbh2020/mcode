/** Store stub for the browser-portal smoke: records every
 *  suppressBrowserView() call so the watcher's counter discipline (exactly
 *  one hold while popups are open, one release when they close) can be
 *  asserted. Wired via esbuild --alias in run.sh. */
export const suppressCalls: boolean[] = [];

export const useSessionStore = {
  getState: () => ({
    suppressBrowserView: (suppressed: boolean) => {
      suppressCalls.push(suppressed);
    },
  }),
};
