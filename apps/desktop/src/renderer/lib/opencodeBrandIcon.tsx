/**
 * OpenCode brand mark — transcribed from opencode.ai's favicon.svg
 * (© opencode; monochrome currentColor adaptation, same posture as
 * OpenAIBrandIcon / AntigravityBrandIcon — interoperable identification).
 *
 * The official mark is a white square ring with the lower half of its hole
 * filled (a terminal-cursor block) on a near-black square. The background
 * square is dropped (the app renders brand glyphs in theme colors; the
 * stream-sidebar dot carries the identity at card scale) and the ring +
 * cursor block are merged into one evenodd path: ring (1) → hole (0) →
 * block (1). ViewBox is cropped to the mark's bounds
 * (official 512-space content x 128-384 / y 96-416).
 */
export function OpenCodeBrandIcon({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 256 320"
      width={size}
      height={size}
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path fillRule="evenodd" d="M256 320H0V0H256V320ZM192 64H64V256H192V64ZM64 128H192V256H64V128Z" />
    </svg>
  );
}
