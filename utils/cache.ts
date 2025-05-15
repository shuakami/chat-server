/* ==============================================================
 * utils/cache.ts   ——  轻量级 LRU + TTL 缓存
 * ============================================================== */
export class LRUCache<K, V> {
    private map = new Map<K, { value: V; expires: number }>();
  
    /**
     * @param maxEntries  最大条目数，超限后按 LRU 淘汰
     * @param ttlMs       单条目存活时间（毫秒）
     */
    constructor(
      private readonly maxEntries: number = 50_000,
      private readonly ttlMs: number = 5 * 60_000 // 5 min
    ) {}
  
    /** 读取（若过期则自动删除并返回 undefined） */
    get(key: K): V | undefined {
      const record = this.map.get(key);
      if (!record) return undefined;
  
      if (Date.now() > record.expires) {
        this.map.delete(key);
        return undefined;
      }
  
      // 触发 LRU：把键移到 Map 尾部
      this.map.delete(key);
      this.map.set(key, record);
      return record.value;
    }
  
    /** 写入，自动执行 LRU 淘汰 */
    set(key: K, value: V): void {
      if (this.map.has(key)) this.map.delete(key); // 覆盖需刷新顺序
      this.map.set(key, { value, expires: Date.now() + this.ttlMs });
  
      // LRU 淘汰
      if (this.map.size > this.maxEntries) {
        const oldestKey = this.map.keys().next().value as K;
        this.map.delete(oldestKey);
      }
    }
  
    /** 手动删除 */
    delete(key: K): void {
      this.map.delete(key);
    }
  
    /** 当前条目数 */
    size(): number {
      return this.map.size;
    }
  }
  