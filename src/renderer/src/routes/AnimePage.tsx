import { CategoryPage } from '@renderer/components/category/CategoryPage'
import { ANIME_CONFIG } from '@renderer/lib/mediaHub/categoryConfig'

export default function AnimePage() {
  return <CategoryPage config={ANIME_CONFIG} />
}
