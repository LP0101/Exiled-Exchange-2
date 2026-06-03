// Cheap stdout debug logger gated on the EE2_DEBUG env var. Diagnostic
// console.log calls scattered through the Wayland integration are wrapped
// with debug() so they're silent by default and easy to flip back on
// without rebuilding (just relaunch with `EE2_DEBUG=1 npm run dev`).
export const DEBUG = !!process.env.EE2_DEBUG;

export function debug(...args: unknown[]): void {
  if (DEBUG) console.log(...args);
}
