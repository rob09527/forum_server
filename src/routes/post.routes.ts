import type { FastifyInstance, FastifyRequest } from 'fastify'
import { sendSuccess } from '../utils/response.js'
import { authenticate, optionalAuth } from '../middleware/auth.middleware.js'
import { ValidationError } from '../utils/errors.js'
import {
  createPost,
  getPostById,
  listPosts,
  updatePost,
  deletePost,
  getHotPosts,
} from '../services/post/post.service.js'
import { likePost, unlikePost } from '../services/like/like.service.js'
import type { UserPublic } from '../services/auth/auth.service.js'

/** 当前登录用户（authenticate/optionalAuth 挂载后非空） */
function requireUser(request: FastifyRequest): UserPublic {
  if (!request.user) {
    throw new ValidationError('请先登录')
  }
  return request.user
}

/**
 * 帖子相关路由。
 * 路由只做三件事：校验参数 → 调用 service → 返回响应。
 */
export async function postRoutes(fastify: FastifyInstance): Promise<void> {
  /** GET /api/posts — 帖子列表（可选登录，登录后可用于判断点赞态） */
  fastify.get('/api/posts', { preHandler: [optionalAuth] }, async (request, reply) => {
    const query = request.query as {
      category?: string
      /** 按标签过滤（TEXT[] 包含该标签） */
      tag?: string
      sort?: 'latest' | 'hot'
      page?: number
      pageSize?: number
    }

    const result = await listPosts({
      category: query.category,
      tag: query.tag,
      sort: query.sort,
      page: query.page ? Number(query.page) : undefined,
      pageSize: query.pageSize ? Number(query.pageSize) : undefined,
    })

    sendSuccess(reply, result)
  })

  /** GET /api/posts/hot — 首页热门帖子 Top 10（侧边栏用） */
  fastify.get('/api/posts/hot', async (_request, reply) => {
    const hotPosts = await getHotPosts(10)
    sendSuccess(reply, hotPosts)
  })

  /** GET /api/posts/:id — 帖子详情（可选登录，登录用户计入浏览量去重） */
  fastify.get('/api/posts/:id', { preHandler: [optionalAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const post = await getPostById(Number(id), request.user?.id)
    sendSuccess(reply, post)
  })

  /** POST /api/posts — 发帖 */
  fastify.post('/api/posts', { preHandler: [authenticate] }, async (request, reply) => {
    const user = requireUser(request)
    const body = request.body as {
      title: string
      content: string
      category: string
      tags?: string[]
    }

    const post = await createPost(
      {
        title: body.title,
        content: body.content,
        category: body.category,
        tags: body.tags,
      },
      user.id,
    )

    sendSuccess(reply, post, 201)
  })

  /** PATCH /api/posts/:id — 编辑帖子（仅作者） */
  fastify.patch('/api/posts/:id', { preHandler: [authenticate] }, async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const body = request.body as { title?: string; content?: string; tags?: string[] }

    const post = await updatePost(Number(id), body, user.id)
    sendSuccess(reply, post)
  })

  /** DELETE /api/posts/:id — 删除帖子（作者或 admin，级联删评论/点赞 + 清理图片） */
  fastify.delete('/api/posts/:id', { preHandler: [authenticate] }, async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }

    await deletePost(Number(id), user)
    sendSuccess(reply, null)
  })

  /** POST /api/posts/:id/like — 点赞帖子 */
  fastify.post('/api/posts/:id/like', { preHandler: [authenticate] }, async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }

    const likeCount = await likePost(Number(id), user.id)
    sendSuccess(reply, { likeCount })
  })

  /** DELETE /api/posts/:id/like — 取消点赞帖子 */
  fastify.delete('/api/posts/:id/like', { preHandler: [authenticate] }, async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }

    const likeCount = await unlikePost(Number(id), user.id)
    sendSuccess(reply, { likeCount })
  })
}
