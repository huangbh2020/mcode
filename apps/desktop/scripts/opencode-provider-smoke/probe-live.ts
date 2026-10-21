/**
 * One-off live probe against the REAL local opencode v2 server: spawn via the
 * same handshake as opencodeServerManager, then print the RAW result shapes
 * of the SDK v2 client calls the provider relies on (model list, integration
 * list, session create). Run with `bash scripts/opencode-provider-smoke/probe-live.sh`.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { resolveOpenCodeCliPath } from "@main/providers/opencode-sdk/opencodeBinaryResolve.js";
import { buildOpenCodeServerConfig } from "@main/providers/opencode-sdk/opencodeServerManager.js";
import { listOpenCodeModels, openCodeAuthStatus } from "@main/providers/opencode-sdk/opencodeModels.js";

const LISTENING_RE = /server listening on (https?:\/\/\S+)/;

async function main() {
  const cli = resolveOpenCodeCliPath(true);
  console.log("cli path:", cli);
  if (!cli) throw new Error("opencode CLI not found");

  const srv = createServer();
  srv.unref();
  const port = await new Promise<number>((resolve) => {
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as { port: number };
      srv.close(() => resolve(addr.port));
    });
  });
  const password = randomBytes(16).toString("base64url");
  console.log("spawning on port", port);

  const child = spawn(cli, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    env: {
      ...(process.env as Record<string, string>),
      OPENCODE_SERVER_PASSWORD: password,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(buildOpenCodeServerConfig()),
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const baseUrl = await new Promise<string>((resolve, reject) => {
    let buf = "";
    const t = setTimeout(() => reject(new Error("no listening line")), 20000);
    child.stdout!.on("data", (c: Buffer) => {
      buf += c.toString();
      const m = LISTENING_RE.exec(buf);
      if (m) {
        clearTimeout(t);
        resolve(m[1].replace(/\/+$/, ""));
      }
    });
    child.stderr!.on("data", (c: Buffer) => console.log("[stderr]", c.toString().trim()));
    child.on("exit", (code) => reject(new Error(`server exited ${code}: ${buf.slice(-300)}`)));
  });
  console.log("listening at", baseUrl);

  const client = createOpencodeClient({
    baseUrl,
    headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
  });

  console.log("\n===== v2.model.list raw =====");
  const models = await client.v2.model.list();
  console.log("ok:", (models as { ok?: boolean }).ok);
  console.log("typeof .data:", typeof (models as { data?: unknown }).data, Array.isArray((models as { data?: unknown }).data));
  console.log(JSON.stringify((models as { data?: unknown }).data, null, 1).slice(0, 700));

  console.log("\n===== v2.integration.list raw =====");
  const integrations = await client.v2.integration.list();
  const idata = (integrations as { data?: unknown }).data;
  console.log("typeof .data:", typeof idata, Array.isArray(idata));
  console.log(JSON.stringify(idata, null, 1).slice(0, 500));

  console.log("\n===== v2.session.create raw =====");
  const created = await client.v2.session.create({
    location: { directory: process.cwd() },
  });
  const cdata = (created as { data?: unknown }).data;
  console.log("typeof .data:", typeof cdata);
  console.log(JSON.stringify(cdata, null, 1).slice(0, 400));

  child.kill();

  console.log("\n===== PRODUCTION listOpenCodeModels() =====");
  const list = await listOpenCodeModels();
  console.log("model count:", list.models.length, "| loggedIn:", list.loggedIn);
  console.log("first 3:", JSON.stringify(list.models.slice(0, 3), null, 1));

  console.log("\n===== PRODUCTION openCodeAuthStatus() =====");
  const status = await openCodeAuthStatus();
  console.log(
    "installed:", status.installed,
    "| integrations:", status.integrations.length,
    "| connected:", status.integrations.filter((i) => i.connected).map((i) => i.id).join(",") || "(none)",
    "| error:", status.error ?? "(none)",
  );

  process.exit(0);
}

main().catch((err) => {
  console.error("PROBE FAILED:", err);
  process.exit(1);
});
