/**
 * pdf.js bootstrap for the editor's PDF preview pane.
 *
 * Three packaging constraints shape this module:
 *
 * 1. **Worker.** pdf.js parses off-thread; the worker entry must be produced
 *    by the bundler (same rule as monacoSetup.ts). Vite's `?worker` import
 *    compiles `pdf.worker.min.mjs` into a dedicated chunk and hands us a
 *    constructor. We deliberately do NOT use `GlobalWorkerOptions.workerPort`:
 *    that static port is shared across documents, and `loadingTask.destroy()`
 *    terminates its worker unconditionally — a shared port would let closing
 *    one PDF tab kill another tab's live document. A per-document
 *    `new PDFWorker({ port: new PdfjsWorker() })` scopes termination to the
 *    document being closed.
 *
 * 2. **Auxiliary assets (CJK CMaps / standard fonts / wasm) over IPC.** The
 *    production renderer is a file:// page — `fetch()` of ANY local resource
 *    is impossible there, so pdf.js's default `DOMBinaryDataFactory` (which
 *    fetches `cMapUrl`/`standardFontDataUrl`/`wasmUrl` over HTTP) cannot work.
 *    `useWorkerFetch: false` + a custom `BinaryDataFactory` reroutes every
 *    asset read through the `file:readPdfjsAsset` IPC channel, which main
 *    serves from the installed pdfjs-dist package (dev node_modules or the
 *    asar — identical code path). Without the CMaps, CJK PDFs render with
 *    missing glyphs, so this is not optional for our users.
 *
 * 3. **Lazy everything.** This module (and with it the ~1MB pdf.js main
 *    library) lives in the PdfPreviewPane chunk, which FileEditor loads via
 *    React.lazy — nothing pdf-related loads until a PDF is actually opened.
 */
import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import PdfjsWorker from "pdfjs-dist/build/pdf.worker.min.mjs?worker";
import { api } from "./api.js";

/** Thrown by {@link loadPdfDocument} for password-protected PDFs. The pane
 *  shows a dedicated "encrypted" card (with an open-externally button)
 *  instead of the generic corruption error. */
export class PdfEncryptedError extends Error {
  constructor() {
    super("pdf is password-protected");
    this.name = "PdfEncryptedError";
  }
}

/** pdf.js `fetch({ kind })` uses the DocumentInitParameters key names, not our
 *  IPC enum — map them. */
const FACTORY_KIND_TO_ASSET: Record<string, "cmap" | "font" | "wasm"> = {
  cMapUrl: "cmap",
  standardFontDataUrl: "font",
  wasmUrl: "wasm",
};

/** BinaryDataFactory serving pdf.js's bundled assets via the readPdfjsAsset
 *  IPC. pdf.js instantiates this itself (`new BinaryDataFactory({cMapUrl,
 *  standardFontDataUrl, wasmUrl})` — the base URLs must be non-empty strings
 *  or its fetch throws before delegating; ours are placeholders it never
 *  reads). Duck-typed: DocumentInitParameters declares the option as
 *  `object`, and pdf.js only calls `.fetch({kind, filename})` on it. */
class IpcBinaryDataFactory {
  constructor(_baseUrl: { cMapUrl?: string; standardFontDataUrl?: string; wasmUrl?: string }) {
    // Placeholder base URLs arrive here and are intentionally dropped — our
    // fetch() resolves everything over IPC, never by URL.
  }

  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    const assetKind = FACTORY_KIND_TO_ASSET[kind];
    if (!assetKind) throw new Error(`pdf.js asked for an unknown asset kind: ${kind}`);
    const { data } = await api.file.readPdfjsAsset({ kind: assetKind, name: filename });
    if (!data) throw new Error(`pdf.js asset unavailable: ${filename}`);
    return base64ToBytes(data);
  }
}

/** base64 → bytes without Node's Buffer (renderer side). */
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Handle returned by {@link loadPdfDocument}. `destroy` tears down the
 *  document AND its dedicated worker (per-document port — see header note 1);
 *  call it on pane unmount / file switch. */
export interface PdfDocumentHandle {
  doc: PDFDocumentProxy;
  destroy: () => Promise<void>;
}

/** The generated d.ts mis-declares PDFWorker's public constructor parameter as
 *  `port?: null` (build/pdf.mjs accepts and caches a real Worker port — the
 *  static `#workerPorts` WeakMap exists precisely for it). Narrow to the real
 *  shape so per-document workers typecheck. */
type PdfWorkerCtorWithPort = new (params: { port: Worker }) => InstanceType<typeof pdfjsLib.PDFWorker>;
const PDFWorkerWithPort = pdfjsLib.PDFWorker as unknown as PdfWorkerCtorWithPort;

/** Load and parse a PDF from disk via the guarded `file:readBinary` IPC
 *  (project-root containment enforced in main). PDFs are read whole — like
 *  the image preview's data URLs; PDFs large enough to matter (100MB+) are
 *  vanishingly rare next to the video files that motivated the streaming
 *  app-resource:// protocol. */
export async function loadPdfDocument(filePath: string): Promise<PdfDocumentHandle> {
  const { dataUrl } = await api.file.readBinary({ filePath });
  const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  if (!dataUrl || !b64) throw new Error(`PDF read failed (guard refused or file missing): ${filePath}`);

  const worker = new PDFWorkerWithPort({ port: new PdfjsWorker() });
  const task = pdfjsLib.getDocument({
    data: base64ToBytes(b64),
    worker,
    // Placeholder base URLs: required non-empty or pdf.js's factory plumbing
    // rejects before calling ours; the IPC factory ignores them.
    cMapUrl: "ipc://pdfjs/",
    cMapPacked: true,
    standardFontDataUrl: "ipc://pdfjs/",
    wasmUrl: "ipc://pdfjs/",
    // Keep asset reads on the main thread (→ our IPC factory); the worker
    // cannot fetch ipc:// URLs either.
    useWorkerFetch: false,
    BinaryDataFactory: IpcBinaryDataFactory,
  });

  // onPassword must call back with a password or destroy the task — merely
  // ignoring it leaves task.promise pending forever. We never prompt (v1) so
  // destroy immediately and surface PdfEncryptedError from the rejected promise.
  task.onPassword = () => {
    void task.destroy();
  };
  try {
    const doc = await task.promise;
    return { doc, destroy: () => task.destroy() };
  } catch (err) {
    // Path 1: our onPassword handler destroyed the task ("Worker was
    //   destroyed during onPassword callback").
    // Path 2: pdf.js rejects with PasswordException directly.
    const msg = err instanceof Error ? err.message : String(err);
    if (task.destroyed || msg.includes("onPassword") || err instanceof pdfjsLib.PasswordException) {
      throw new PdfEncryptedError();
    }
    throw err;
  }
}
