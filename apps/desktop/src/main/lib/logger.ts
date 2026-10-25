/** Minimal tagged logger for the main process. Writes to a file under the
 * user data dir so logs survive even when DevTools is closed. P0/P1 debug aid. */
import { app } from "electron";
import { appendFile, appendFileSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const MAX_LOG_BYTES = 10 * 1024 * 1024; // 10 MB cap per log file
const FLUSH_INTERVAL_MS = 50; // Batch disk writes to keep the event loop responsive

let logDir: string | null = null;
let logFile: string | null = null;
let oldLogFile: string | null = null;

function ensureLogPaths(): { file: string; oldFile: string } {
  if (logFile && oldLogFile) return { file: logFile, oldFile: oldLogFile };
  try {
    logDir = join(app.getPath("userData"), "logs");
  } catch {
    logDir = join(process.cwd(), ".logs");
  }
  mkdirSync(logDir, { recursive: true });
  logFile = join(logDir, "main.log");
  oldLogFile = join(logDir, "main.old.log");
  return { file: logFile, oldFile: oldLogFile };
}

function rotateIfNeeded(filePath: string, oldPath: string): void {
  try {
    const st = statSync(filePath);
    if (st.size >= MAX_LOG_BYTES) {
      try {
        rmSync(oldPath, { force: true });
      } catch {
        /* ignore */
      }
      renameSync(filePath, oldPath);
    }
  } catch {
    // File may not exist yet; normal
  }
}

let queue: string[] = [];
let flushTimer: NodeJS.Timeout | null = null;
let isFlushing = false;

function scheduleFlush(): void {
  if (flushTimer !== null || isFlushing) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushAsync();
  }, FLUSH_INTERVAL_MS);
  flushTimer.unref();
}

function flushAsync(): void {
  if (queue.length === 0 || isFlushing) return;
  isFlushing = true;
  const chunk = queue.join("");
  queue = [];

  const { file, oldFile } = ensureLogPaths();
  rotateIfNeeded(file, oldFile);

  appendFile(file, chunk, (err) => {
    isFlushing = false;
    if (err) {
      try {
        process.stderr.write(`[logger] disk append failed: ${err.message}\n`);
      } catch {
        /* ignore */
      }
    }
    if (queue.length > 0) {
      scheduleFlush();
    }
  });
}

/** Synchronous flush on process exit or uncaught errors. */
function flushSync(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (queue.length === 0) return;
  const chunk = queue.join("");
  queue = [];
  try {
    const { file, oldFile } = ensureLogPaths();
    rotateIfNeeded(file, oldFile);
    appendFileSync(file, chunk);
  } catch {
    /* best-effort */
  }
}

if (typeof process !== "undefined") {
  process.once("exit", flushSync);
  process.once("beforeExit", flushSync);
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
  queue.push(line);
  scheduleFlush();
}

export const log = {
  info: (msg: string) => write("INFO", msg),
  warn: (msg: string) => write("WARN", msg),
  error: (msg: string) => write("ERROR", msg),
  flushSync,
};
