// The Android app's own surface, when the page is running inside it: a
// JavaScript interface the Kotlin shell adds to the WebView (MainActivity's
// NativeBridge). Absent in a browser, which is how every caller knows to
// fall back. Results come back as window events, since a Java interface
// cannot return a promise.

export interface NativeHost {
  /** Opens the device's code scanner; answers with an 'r3-scan' event whose
   *  detail is `{ text }` or `{ text: null, error? }`. */
  scanPairingCode(): void
  /** Whether the page is showing the player: the app keeps the screen on
   *  and lets the video under the page show through. */
  setPlayerActive(active: boolean): void
}

declare global {
  interface Window {
    R3Android?: NativeHost
  }
}

export function nativeHost(): NativeHost | null {
  return window.R3Android ?? null
}
