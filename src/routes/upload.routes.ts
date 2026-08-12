import type { FastifyInstance } from 'fastify'
import { sendSuccess } from '../utils/response.js'
import { authenticate } from '../middleware/auth.middleware.js'
import { saveImage } from '../services/upload/upload.service.js'
import { AppError } from '../utils/errors.js'
import { ErrorCode } from '../constants/error-codes.js'

/**
 * 图片上传路由。
 * 前端编辑器点图片按钮 → multipart 上传 → 返回完整 URL → 插入 Markdown。
 */
export async function uploadRoutes(fastify: FastifyInstance): Promise<void> {
  /** POST /api/upload — 上传图片（需登录，multipart field: file） */
  fastify.post('/api/upload', { preHandler: [authenticate] }, async (request, reply) => {
    // authenticate 已确保 request.user 存在
    const user = request.user!

    // multipart 解析：field 名为 file
    const data = await request.file()
    if (!data) {
      throw new AppError('请选择文件', 400, ErrorCode.UPLOAD_NO_FILE)
    }

    // 读取文件内容到内存（受 UPLOAD_MAX_FILE_SIZE 限制，安全范围内）
    const buffer = await data.toBuffer()

    const result = await saveImage(user.id, buffer, data.mimetype)

    // 返回完整 URL + 相对路径，前端把 path 插进 Markdown
    sendSuccess(reply, { url: result.url, path: result.path }, 201)
  })
}
