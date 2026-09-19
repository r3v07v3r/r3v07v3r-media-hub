// `koffi` is the FFI the desktop app uses to reach user32.dll and embed mpv's
// window inside its own (media-hub/win32.ts). A headless backend embeds
// nothing, and the native addon cannot be bundled in any case — so the import
// resolves here, and anything that actually tries to load a library is told
// plainly that it should not have got this far.

const koffi = {
  load(name: string): never {
    throw new Error(`koffi.load('${name}'): there is no window embedding in a headless backend.`)
  },
  struct(): never {
    throw new Error('koffi.struct: there is no window embedding in a headless backend.')
  }
}

export default koffi
