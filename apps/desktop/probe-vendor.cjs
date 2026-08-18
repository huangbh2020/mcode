/* Temporary probe: Pi model values + custom model config entries. */
const fs = require("fs");
const path = require("path");
const initSqlJs = require("sql.js");

async function main() {
  const dbPath = path.join(process.env.APPDATA, "@mcode", "desktop", "claude-gui.db");
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(dbPath));

  const res = db.exec(
    "SELECT s.provider_id, s.model, s.custom_model_id, s.usage_history FROM sessions s WHERE s.usage_history IS NOT NULL",
  );
  const piModels = new Set();
  const customIds = new Set();
  if (res.length) {
    for (const row of res[0].values) {
      if (row[0] === "pi-sdk") {
        let h = [];
        try { h = JSON.parse(row[3]); } catch { continue; }
        for (const r of h) if (r.model) piModels.add(r.model);
      } else if (row[2]) customIds.add(row[2]);
    }
  }
  console.log("=== pi-sdk model values ===", [...piModels].join(" | "));

  const mres = db.exec("SELECT value FROM settings WHERE key = 'customModels'");
  const cfgByVendor = {};
  if (mres.length) {
    let arr = [];
    try { arr = JSON.parse(mres[0].values[0][0]); } catch {}
    console.log("\n=== customModels configs:", arr.length);
    for (const c of arr) {
      const inUse = customIds.has(c.id) ? " [IN USE]" : "";
      console.log(" ", c.id, "name=" + c.name, "baseUrl=" + c.baseUrl, "protocol=" + (c.protocol || "anthropic"), inUse);
      console.log("    roles:", Object.keys(c.roles || {}).map((k) => `${k}->${c.roles[k].requestModel}`).join(", "));
    }
  } else {
    console.log("\n(no customModels setting row)");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });