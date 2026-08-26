import type { FastifyReply } from 'fastify'

/**
 * 实时推送（SSE）统一连接枢纽。
 *
 * 与历史「通知专用」实现不同，本模块是所有实时事件的唯一出口：
 * - 通知（notification）：点赞/评论/关注/系统群发等，由 notification.service 推送。
 * - 私信（dm）：新消息 / 未读变化，由 message.service 推送。
 *
 * 进程内连接注册表：userId → 该用户的活跃 SSE 连接集合。
 * 当前单实例部署，进程内 Map 足够；将来多实例时改为 Redis pub/sub
 * （channel `realtime:{userId}`），本模块接口保持不变，调用方无需改动。
 *
 * 同一用户可能开多个标签页 → Set 存多个 reply，push 时全部写入。
 */

/** 实时事件类型。新增事件（如群聊 group_dm、系统广播 broadcast）在此扩展。 */
export type RealtimeEvent = 'notification' | 'dm'

/** 用户 SSE 连接注册表 */
const connections = new Map<number, Set<FastifyReply>>()

/** 注册一条 SSE 连接（路由建立流时调用） */
export function registerUserConnection(userId: number, reply: FastifyReply): void {
  let set = connections.get(userId)
  if (!set) {
    set = new Set()
    connections.set(userId, set)
  }
  set.add(reply)
}

/** 移除一条 SSE 连接（连接关闭时调用，避免连接泄漏） */
export function unregisterUserConnection(userId: number, reply: FastifyReply): void {
  const set = connections.get(userId)
  if (!set) return
  set.delete(reply)
  if (set.size === 0) {
    connections.delete(userId)
  }
}

/**
 * 向某用户的所有活跃连接写一帧事件。返回是否有连接成功收到（供调用方决定兜底提示）。
 * event 为 SSE 事件名（客户端 EventSource 的 addEventListener(event) 据此分发）。
 */
export function pushToUser(
  userId: number,
  event: RealtimeEvent,
  payload: Record<string, unknown>,
): boolean {
  const set = connections.get(userId)
  if (!set || set.size === 0) return false
  return writeToConnections(set, event, payload)
}

/**
 * 向所有在线用户推送（系统通知群发等场景）。
 * 只遍历在线连接注册表，不依赖接收者 ID 数组，O(在线连接数) 而非 O(接收者总数)。
 * 返回成功送达的用户数（离线用户不计）。
 */
export function pushToAllOnline(event: RealtimeEvent, payload: Record<string, unknown>): number {
  let deliveredUsers = 0
  for (const set of connections.values()) {
    if (set.size > 0 && writeToConnections(set, event, payload)) {
      deliveredUsers++
    }
  }
  return deliveredUsers
}

/** 向一组连接写一帧事件（共享序列化与失败忽略逻辑） */
function writeToConnections(
  set: Set<FastifyReply>,
  event: RealtimeEvent,
  payload: Record<string, unknown>,
): boolean {
  const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
  let delivered = false
  for (const reply of set) {
    // 连接可能已死但 close 事件未及时触发，写失败即忽略（close 处理器会清理）
    if (!reply.raw.writableEnded) {
      try {
        reply.raw.write(data)
        delivered = true
      } catch {
        // 写失败忽略，等 close 清理
      }
    }
  }
  return delivered
}
