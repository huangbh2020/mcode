/**
 * Mobile bundle entry. Mounts <App/> and wires Tailwind styles. The bundle is
 * served same-origin by the desktop's MobileHttpServer; it boots straight into
 * either the pairing flow (no saved token) or the chat shell (paired).
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles.css";

const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
