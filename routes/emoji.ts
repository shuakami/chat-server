import { FastifyInstance } from 'fastify'
import { emojiData, Emoji } from '../data/emoji/emoji_storage'

// 内存缓存
const cache = new Map<string, { data: any; timestamp: number }>()
const CACHE_TTL = 3600 * 1000 // 1小时，毫秒为单位

// 缓存管理
function getCache(key: string) {
  const item = cache.get(key)
  if (!item) return null
  
  if (Date.now() - item.timestamp > CACHE_TTL) {
    cache.delete(key)
    return null
  }
  
  return item.data
}

function setCache(key: string, data: any) {
  cache.set(key, {
    data,
    timestamp: Date.now()
  })
}

export default async function (fastify: FastifyInstance) {
  // 获取所有emoji
  fastify.get('/api/emoji', async (request, reply) => {
    try {
      const cached = getCache('emoji_all')
      if (cached) {
        return reply.send(cached)
      }

      setCache('emoji_all', emojiData)
      return reply.send(emojiData)
    } catch (error) {
      reply.code(500).send({ error: 'Internal Server Error' })
    }
  })

  // 获取指定ID的emoji
  fastify.get('/api/emoji/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    
    try {
      const cacheKey = `emoji_${id}`
      const cached = getCache(cacheKey)
      if (cached) {
        return reply.send(cached)
      }

      const emoji = emojiData.emojis[id]
      if (!emoji) {
        return reply.code(404).send({ error: 'Emoji not found' })
      }

      setCache(cacheKey, emoji)
      return reply.send(emoji)
    } catch (error) {
      reply.code(500).send({ error: 'Internal Server Error' })
    }
  })

  // 搜索emoji
  fastify.get('/api/emoji/search', async (request, reply) => {
    const { keyword } = request.query as { keyword: string }
    if (!keyword) {
      return reply.code(400).send({ error: 'Query parameter is required' })
    }
    
    try {
      const cacheKey = `emoji_search_${keyword}`
      const cached = getCache(cacheKey)
      if (cached) {
        return reply.send(cached)
      }

      const results = Object.entries(emojiData.emojis)
        .filter(([_, emoji]) => 
          emoji.summary.toLowerCase().includes(keyword.toLowerCase())
        )
        .reduce((acc: Record<string, Emoji>, [id, emoji]) => {
          acc[id] = emoji
          return acc
        }, {})

      setCache(cacheKey, results)
      return reply.send(results)
    } catch (error) {
      reply.code(500).send({ error: 'Internal Server Error' })
    }
  })

  // 获取分页emoji列表
  fastify.get('/api/emoji/page/:page', async (request, reply) => {
    const { page } = request.params as { page: string }
    const pageSize = 20
    const pageNum = parseInt(page) || 1
    
    try {
      const cacheKey = `emoji_page_${pageNum}`
      const cached = getCache(cacheKey)
      if (cached) {
        return reply.send(cached)
      }

      const entries = Object.entries(emojiData.emojis)
      const total = entries.length
      const totalPages = Math.ceil(total / pageSize)
      
      const start = (pageNum - 1) * pageSize
      const end = start + pageSize
      
      const results = entries
        .slice(start, end)
        .reduce((acc: Record<string, Emoji>, [id, emoji]) => {
          acc[id] = emoji
          return acc
        }, {})

      const response = {
        data: results,
        pagination: {
          current: pageNum,
          total: totalPages,
          hasMore: pageNum < totalPages
        }
      }

      setCache(cacheKey, response)
      return reply.send(response)
    } catch (error) {
      reply.code(500).send({ error: 'Internal Server Error' })
    }
  })
} 