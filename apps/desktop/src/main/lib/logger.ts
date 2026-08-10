/** Minimal tagged logger for the main process. Writes to a file under the
 * user data dir so logs survive even when DevTools is closed. P0/P1 debug aid. */
import { app } from "electron";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

let logFile: string | null = null;

function getLogFile(): string {
  if (logFile) return logFile;
  const dir = join(app.getPath("userData"), "logs");
  mkdirSync(dir, { recursive: true });
  logFile = join(dir, "main.log");
  return logFile;
}

function write(level: string, msg: string): void {
  const line = `${new Date().toISOString()} [${level}] ${msg}\n`;
  // stderr 管道可能已断(EPIPE —— 父进程 turbo/electron-vite 关闭了读端)。
  // 这里一旦抛出,uncaughtException handler 会调 log.error() 再次写 stderr,
  // 递归到栈溢出(0xC0000409 STATUS_STACK_BUFFER_OVERRUN)。吞掉 —— 文件 sink
  // 才是持久记录。
  try {
    process.stderr.write(line);
  } catch {
    // best-effort; if stderr is broken, the file sink below still records it
  }
  try {
    appendFileSync(getLogFile(), line);
  } catch {
    // best-effort; if the log file can't be written, stderr still gets it
  }
}

export const log = {
  info: (msg: string) => write("INFO", msg),
  warn: (msg: string) => write("WARN", msg),
  error: (msg: string) => write("ERROR", msg),
};
