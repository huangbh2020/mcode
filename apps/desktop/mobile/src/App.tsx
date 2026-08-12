/**
 * App — top-level shell for the mobile bundle.
 *
 * Decides which screen to show based on pairing state + the SSE connection:
 *  - Not paired (and not mid-pair) → <PairingScreen/>
 *  - Paired                       → <ChatScreen/> (subscribes to events)
 *
 * The pairing nonce is read from the `?nonce=` query param the QR code baked
 * in, so the user lands directly on the verification-code entry after scanning.
 */
import { useEffect, useState } from "react";
import { mobileApi } from "./lib/mobileApi.js";
import { PairingScreen } from "./screens/PairingScreen.js";
import { ChatScreen } from "./screens/ChatScreen.js";

export function App() {
  // Start in whatever the saved auth state implies. Paired → chat; else pair.
  const [paired, setPaired] = useState<boolean>(() => mobileApi.isPaired());

  // If the token is revoked server-side (401), mobileApi clears auth and we
  // flip back to the pairing screen. Re-check on a custom event the api shim
  // could dispatch; simplest: poll isPaired on window focus.
  useEffect(() => {
    const onFocus = () => setPaired(mobileApi.isPaired());
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  // Allow a child to force the pairing screen (e.g. a "disconnect" button).
  const handleDisconnect = () => {
    mobileApi.clearAuth();
    setPaired(false);
  };
  // Allow PairingScreen to flip into the chat once pairing succeeds.
  const handlePaired = () => setPaired(true);

  if (!paired) {
    return <PairingScreen onPaired={handlePaired} />;
  }
  return <ChatScreen onDisconnect={handleDisconnect} />;
}
