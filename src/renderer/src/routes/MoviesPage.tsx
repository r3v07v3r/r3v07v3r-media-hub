import { LibraryPage } from '@renderer/components/category/AnimeLibraryPage'
import { MOVIES_CONFIG } from '@renderer/lib/mediaHub/categoryConfig'

export default function MoviesPage() {
  return <LibraryPage config={MOVIES_CONFIG} />
}
