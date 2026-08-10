import { fastify } from './app.js'
import { config } from './config.js'

const start = async () => {
  try {
    await fastify.listen({ port: config.PORT, host: config.HOST })
    console.log(`Server running at http://localhost:${config.PORT}`)
  } catch (err) {
    fastify.log.error(err)
    process.exit(1)
  }
}

start()
