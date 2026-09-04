import type { FastifyInstance } from 'fastify'
import { sendSuccess } from '../utils/response.js'
import { authenticate } from '../middleware/auth.middleware.js'
import { saveImage, parseUploadPartition } from '../services/upload/upload.service.js'
import { AppError } from '../utils/errors.js'
import { ErrorCode } from '../constants/error-codes.js'

/**
 * 图片上传路由。
 * 前端编辑器点图片按钮 → multipart 上传 → 返回完整 URL → 插入 Markdown；
 * 头像页同样走这里（`?partition=avatars`），拿到 `path` 再去 `PUT /api/user/me/avatar` 落库。
 *
 * `partition` 决定落哪个分区（`posts` 正文图 / `avatars` 头像，**缺省 `posts`**，
 * 所以现有发帖/评论配图调用方一个字都不用改）。
 *
 * 为什么参数走 **query 而不是 multipart 字段**：`@fastify/multipart` 的 `request.file()`
 * 是流式解析，`data.fields` 只包含**排在 file 之前**已经流过的部分 —— 字段顺序由浏览器
 * 拼 FormData 的顺序决定，前端把 `append('file')` 写在前面就静默读不到，退化成默认分区，
 * 且没有任何运行时信号。query 与 body 解析顺序无关，恒定可读，故只支持 query 一种传法
 * （不做「query 优先 + 字段兜底」的双通道：两条入口意味着两份行为，出错时更难定位）。
 *
 * ⛔ 该值**不做任何路径拼接**，只交给 `parseUploadPartition()` 查白名单换成常量，见其注释。
 */
export async function uploadRoutes(fastify: FastifyInstance): Promise<void> {
  /** POST /api/upload — 上传图片（需登录，multipart field: file；可选 query `partition`） */
  fastify.post<{ Querystring: { partition?: string } }>(
    '/api/upload',
    { preHandler: [authenticate] },
    async (request, reply) => {
      // authenticate 已确保 request.user 存在
      const user = request.user!

      // 分区白名单校验放在读文件**之前**：非法分区不该先花代价把文件读进内存
      const partition = parseUploadPartition(request.query.partition)

      // multipart 解析：field 名为 file
      const data = await request.file()
      if (!data) {
        throw new AppError('请选择文件', 400, ErrorCode.UPLOAD_NO_FILE)
      }

      // 读取文件内容到内存（受 UPLOAD_MAX_FILE_SIZE 限制，安全范围内）
      const buffer = await data.toBuffer()

      const result = await saveImage(user.id, buffer, data.mimetype, partition)

      // 返回完整 URL + 相对路径，前端把 path 插进 Markdown（头像则拿 path 去 PUT /api/user/me/avatar）
      sendSuccess(reply, { url: result.url, path: result.path }, 201)
    },
  )
}
