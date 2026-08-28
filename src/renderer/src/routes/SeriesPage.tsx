import { LibraryPage } from '@renderer/components/category/AnimeLibraryPage'
import { SERIES_CONFIG } from '@renderer/lib/mediaHub/categoryConfig'

export default function SeriesPage() {
  return <LibraryPage config={SERIES_CONFIG} />
}
