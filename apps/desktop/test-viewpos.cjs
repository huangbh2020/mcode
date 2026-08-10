// Verify: view physical bounds = small (400x700), but emulated viewport =
// 1920x1080 with viewPosition offset — does the view show a "scroll window"
// onto the full-size page? And what does capturePage return?
const { app, WebContentsView, BrowserWindow } = require("electron");

app.disableHardwareAcceleration();

async function probe(label, params, viewBounds) {
  const win = new BrowserWindow({ width: 800, height: 900, show: true });
  const view = new WebContentsView({
    webPreferences: { sandbox: true, contextIsolation: true },
  });
  win.contentView.addChildView(view);
  view.setBounds(viewBounds);
  const wc = view.webContents;
  // Simple page: four corner markers so we can tell which part is visible.
  // No single quotes anywhere (data URL encoding keeps them literal).
  const html = "<meta name=viewport content=width=device-width,initial-scale=1>" +
    "<body style=margin:0;font:24px+sans-serif>" +
    "<div style=position:fixed;left:0;top:0;background:red;width:300px;height:100px>TOP-LEFT</div>" +
    "<div style=position:fixed;right:0;top:0;background:green;width:300px;height:100px>TOP-RIGHT</div>" +
    "<div style=position:fixed;left:0;bottom:0;background:blue;width:300px;height:100px>BOTTOM-LEFT</div>" +
    "<div style=position:fixed;right:0;bottom:0;background:yellow;width:300px;height:100px>BOTTOM-RIGHT</div>" +
    "</body>";
  try {
    await wc.loadURL("data:text/html," + encodeURIComponent(html));
    await new Promise((r) => setTimeout(r, 300));
    wc.enableDeviceEmulation(params);
    await new Promise((r) => setTimeout(r, 400));
    const info = await wc.executeJavaScript(`({
      innerW: window.innerWidth,
      innerH: window.innerHeight,
      clientW: document.documentElement.clientWidth,
      screenW: window.screen.width,
    })`);
    const img = await wc.capturePage();
    const png = img.toPNG();
    console.log(`\n[${label}]`);
    console.log(`  viewBounds=${JSON.stringify(viewBounds)} viewPosition=${JSON.stringify(params.viewPosition)}`);
    console.log(`  inner=${info.innerW}x${info.innerH} clientW=${info.clientW} screenW=${info.screenW}`);
    console.log(`  capturePage=${img.getSize().width}x${img.getSize().height} pngBytes=${png.length}`);
  } catch (e) {
    console.log(`\n[${label}] ERROR: ${e.message}`);
  }
  try { wc.close(); } catch {}
  try { win.destroy(); } catch {}
}

app.whenReady().then(async () => {
  // A: view 400x700, viewport 1920x1080, viewPosition (0,0) — top-left of page
  await probe("A: small view, full viewport, pos(0,0)", {
    screenPosition: "mobile",
    screenSize: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    viewSize: { width: 1920, height: 1080 },
    viewPosition: { x: 0, y: 0 },
    scale: 1,
  }, { x: 100, y: 100, width: 400, height: 700 });

  // B: same but viewPosition (-200, -100) — scrolled window (fixed simple page)
  await probe("B: small view, full viewport, pos(-200,-100)", {
    screenPosition: "mobile",
    screenSize: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    viewSize: { width: 1920, height: 1080 },
    viewPosition: { x: -200, y: -100 },
    scale: 1,
  }, { x: 100, y: 100, width: 400, height: 700 });

  // C: full-size view 1920x1080 (screenshot mode) — capturePage full page?
  await probe("C: FULL view 1920x1080, viewport 1920x1080 (screenshot mode)", {
    screenPosition: "mobile",
    screenSize: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    viewSize: { width: 1920, height: 1080 },
    viewPosition: { x: 0, y: 0 },
    scale: 1,
  }, { x: 0, y: 0, width: 1920, height: 1080 });

  app.exit(0);
});
