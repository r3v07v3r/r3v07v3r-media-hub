import { CategoryPage } from '@renderer/components/category/CategoryPage'
import { SERIES_CONFIG } from '@renderer/lib/mediaHub/categoryConfig'

export default function SeriesPage() {
  return <CategoryPage config={SERIES_CONFIG} />
}
