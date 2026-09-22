/** Records every renderer push so the smoke can assert on emissions. The
 *  real one needs the Electron BrowserWindow. */
export const sent: { channel: string; args: unknown[] }[] = [];

export function sendToRenderer(channel: string, ...args: unknown[]): void {
  sent.push({ channel, args });
}

export const __resetSent = (): void => {
  sent.length = 0;
};
