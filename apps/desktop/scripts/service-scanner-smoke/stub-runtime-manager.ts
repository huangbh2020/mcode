/** Configurable RuntimeManager stub: the smoke seeds `byProvider` with the
 *  fake CLI session binding before running the scanner. */
export const stubState = {
  byProvider: new Map<string, string>(),
  running: [] as string[],
};

export const runtimeManager = {
  findSessionIdByProviderId(sid: string): string | null {
    return stubState.byProvider.get(sid) ?? null;
  },
  runningSessionIds(): string[] {
    return [...stubState.running];
  },
};
