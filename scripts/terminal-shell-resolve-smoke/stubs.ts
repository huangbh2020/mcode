/**
 * Stubs for the runtime deps of terminal/shellResolve.ts that the smoke must
 * not pull in (the real logger reaches into electron). One module, aliased to
 * each specifier — see run.sh. `warnings` captures the resolver's warn lines so
 * main.ts can prove the "configured value not found" case is reported instead
 * of being swallowed.
 */
export const warnings: string[] = [];

function record(...args: unknown[]): void {
  warnings.push(args.map((a) => String(a)).join(" "));
}

export const log = {
  info: (..._args: unknown[]): void => {},
  warn: record,
  error: record,
  debug: (..._args: unknown[]): void => {},
};
