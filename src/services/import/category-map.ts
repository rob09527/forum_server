import { fetchNodelocJson } from './nodeloc-client.js'
import {
  EXCLUDED_CATEGORY_IDS,
  TOP_CATEGORY_MAP,
  FINE_CATEGORY_MAP,
  FALLBACK_CATEGORY_SLUG,
} from './import-config.js'
import type { DiscourseCategory } from './nodeloc-types.js'

/**
 * NodeLoc 分类解析:site.json 分类树(183 个,12 顶级)→ 本地 categories.slug。
 * 规则(计划阶段 1):
 * 1. 命中排除清单(自身或任一祖先)→ 整帖跳过
 * 2. FINE_CATEGORY_MAP 精细覆盖优先(AI 内容归入本站原生垂直分类)
 * 3. 否则沿 parent 链上溯到顶级分类,套 TOP_CATEGORY_MAP;遗漏兜底 general
 * 4. 子分类名作为 tag 保留(「子分类进 tags」决策)
 */

/** site.json 响应里用到的片段 */
interface SiteResponse {
  categories: DiscourseCategory[]
}

/** 分类 id → 节点(懒加载,进程内一次) */
let categoryById: Map<number, DiscourseCategory> | null = null

/** 加载并缓存 NodeLoc 分类树;拿不到 site.json 视为致命错误(没有树就无法归类) */
async function loadCategories(): Promise<Map<number, DiscourseCategory>> {
  if (categoryById) return categoryById
  const site = await fetchNodelocJson<SiteResponse>('/site.json')
  if (!site?.categories?.length) {
    throw new Error('[import] site.json 分类树拉取失败,无法进行分类映射')
  }
  categoryById = new Map(site.categories.map((c) => [c.id, c]))
  return categoryById
}

/** 分类解析结果 */
export interface CategoryResolution {
  /** 是否命中排除清单(含祖先),true 时整帖跳过 */
  excluded: boolean
  /** 本地分类 slug */
  slug: string
  /** 子分类名(顶级分类本身则为 null),用作 tag */
  subcategoryName: string | null
}

/** 解析一个 NodeLoc category_id;未知 id(新增分类未进树)按兜底分类、不排除 */
export async function resolveCategory(categoryId: number): Promise<CategoryResolution> {
  const byId = await loadCategories()

  // 沿 parent 链收集祖先(含自身),同时找顶级
  const chain: DiscourseCategory[] = []
  let node = byId.get(categoryId)
  for (let guard = 0; node && guard < 10; guard++) {
    chain.push(node)
    if (EXCLUDED_CATEGORY_IDS.has(node.id)) {
      return { excluded: true, slug: FALLBACK_CATEGORY_SLUG, subcategoryName: null }
    }
    node = node.parent_category_id ? byId.get(node.parent_category_id) : undefined
  }

  const self = chain[0]
  const top = chain[chain.length - 1]
  const subcategoryName = self && self !== top ? self.name : null

  // 精细覆盖:自身或任一祖先命中(靠前的更具体,优先)
  for (const c of chain) {
    const fine = FINE_CATEGORY_MAP[c.id]
    if (fine) return { excluded: false, slug: fine, subcategoryName }
  }

  const slug = (top && TOP_CATEGORY_MAP[top.id]) ?? FALLBACK_CATEGORY_SLUG
  return { excluded: false, slug, subcategoryName }
}
