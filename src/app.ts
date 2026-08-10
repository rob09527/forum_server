import Fastify from 'fastify'
import cors from '@fastify/cors'
import cookie from '@fastify/cookie'
import { config } from './config.js'

export const fastify = Fastify({ logger: true })

// --- Plugins ---
await fastify.register(cors, {
  origin: ['http://localhost:3000'], // Nuxt dev server
  credentials: true,
})

await fastify.register(cookie)

// --- Health check ---
fastify.get('/api/health', async () => {
  return { status: 'ok', timestamp: new Date().toISOString() }
})

// --- Error handler ---
fastify.setErrorHandler((error, _request, reply) => {
  fastify.log.error(error)
  reply.status(error.statusCode || 500).send({
    success: false,
    error: {
      code: error.code || 'INTERNAL_ERROR',
      message: error.message || 'Internal Server Error',
    },
  })
})
