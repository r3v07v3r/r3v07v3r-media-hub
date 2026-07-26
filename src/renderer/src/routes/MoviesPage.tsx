import { CategoryPage } from '@renderer/components/category/CategoryPage'
import { MOVIES_CONFIG } from '@renderer/lib/mediaHub/categoryConfig'

export default function MoviesPage() {
  return <CategoryPage config={MOVIES_CONFIG} />
}
