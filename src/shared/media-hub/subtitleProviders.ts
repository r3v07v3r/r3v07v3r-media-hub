import type { SubtitleProvider } from './types'

/** The name a subtitle provider is shown under: in the Subtitles menu's
 *  rows and in the "Added English subtitles from …" note. One place, so a
 *  provider added later cannot be left reading as another one somewhere. */
export function subtitleProviderName(provider: SubtitleProvider): string {
  switch (provider) {
    case 'subtitledb':
      return 'SubtitleDB'
    case 'subdl':
      return 'SubDL'
    default:
      return 'OpenSubtitles'
  }
}
