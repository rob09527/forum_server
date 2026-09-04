/**
 * 上传/图片存储的**分区规范**(单一事实来源)。
 *
 * 为什么需要这个文件(见 docs/交接-NodeLoc导入-进度快照-20260903.md §11.5):
 * 此前两套落盘规则并存且各写字面量 —— 用户上传走 `public/uploads/{YYYYMMDD}/`
 * (`services/upload/upload.service.ts`),导入图片走 `public/uploads/nodeloc/`
 * (`services/import/import-config.ts` 的 `IMPORT_UPLOAD_SUBDIR`)。
 * 没有成文约定,新增用途只能各自 `path.join` 一个新目录,且目录名泄露了内容来源。
 * 按后端准则第 ⑩ 条(禁止硬编码),分区名集中在此,所有落盘方从这里取。
 *
 * 三条**不可打破**的既有约束(都是踩过坑换来的,改动前先读 §5):
 * 1. **落库只写相对路径**(`/uploads/...`),完整 URL 由 API 层用 `UPLOAD_BASE_URL` 拼接
 *    —— 换域名/换环境时不裂图;
 * 2. **静态目录不加 `nosniff`** —— 历史文件里 `.png` 实际混着 JPEG/GIF/WebP/AVIF,
 *    靠浏览器嗅探才能正常显示;
 * 3. **头像与正文图分区不同**,因为二者的取图频率限制不同(头像一屏几十张,
 *    正文图一屏几张),限流要分桶,见 `config:limits`。
 *
 * ⛔ **前端有一份手工镜像:`client/app/constants/upload.ts`**(只镜像用户可直传的
 * `posts`/`avatars` 两个)。client 与 server 是两个独立 TS 工程、无 workspace 依赖,
 * 前端 import 不到本文件,所以只能复制。**改这里的分区名字面量必须同步改那边**;
 * 漂移的表现是上传成功但落库被白名单拒,报错指向落库、病根在分区,隔两层极难归因。
 */

/** URL 与磁盘共用的上传根段(磁盘根目录是 `server/public` + 本段) */
export const UPLOAD_URL_ROOT = '/uploads'

/**
 * 顶层分区语义。**分区名不得包含任何可关联到内容来源的词**
 * (用户明确要求产品不出现来源痕迹;`nodeloc` 正是因此被 `legacy` 取代)。
 */
export const UploadPartition = {
  /**
   * 所有头像:用户自定义上传 + 历史迁入的影子用户头像,**统一在此分区**。
   * 用户决策(§13 决定 3):「影子头像和用户上传的头像放在一个文件夹下面统一管理」。
   * 不再按来源分家,也不进日期子目录 —— 头像是低频覆盖写,按日期分目录只会产生孤儿。
   */
  AVATARS: 'avatars',
  /** 用户在站内发帖/评论时上传的正文图。子目录按 `YYYYMMDD` 分片,防单目录文件数爆炸 */
  POSTS: 'posts',
  /** 历史迁入内容携带的正文图(一次性落盘,不再增长)。子目录无分片 */
  LEGACY: 'legacy',
  /** 运营素材(公告图/广告位/称号徽章等),由后台上传 */
  SYSTEM: 'system',
} as const

/** 分区名的联合类型 */
export type UploadPartitionName = (typeof UploadPartition)[keyof typeof UploadPartition]

/**
 * 拼出**落库用的相对路径**。
 *
 * @param partition 顶层分区
 * @param segments 分区内的路径段(如 `['20260904', 'abc.webp']` 或 `['u123.webp']`);
 *                 调用方需自己保证段内不含 `/` 与 `..`(本函数不做穿越校验,
 *                 穿越防护在各 service 的删除/读取路径上,见 `upload.service.ts`)
 * @returns 形如 `/uploads/posts/20260904/abc.webp`
 */
export function uploadRelativePath(
  partition: UploadPartitionName,
  ...segments: string[]
): string {
  return [UPLOAD_URL_ROOT, partition, ...segments].join('/')
}

/**
 * 判定一个落库相对路径是否位于指定分区内。
 * 用于头像白名单校验(§9.2:必须是预置头像路径 **或** `avatars/` 分区内的上传路径,
 * 禁止「任意字符串直存」—— 那等于开放任意外链注入到所有用户的头像位)。
 */
export function isInPartition(relativePath: string, partition: UploadPartitionName): boolean {
  return relativePath.startsWith(`${UPLOAD_URL_ROOT}/${partition}/`)
}
