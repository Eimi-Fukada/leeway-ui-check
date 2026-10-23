import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
export class Store {
  readonly db: Database.Database;
  /**
   * 打开本地 SQLite，启用 WAL/外键和忙等待，并创建当前任务、队列和证据索引表。
   */
  constructor(root: string) {
    mkdirSync(root, { recursive: true });
    this.db = new Database(path.join(root, 'harness.sqlite'));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS profiles(id TEXT PRIMARY KEY,hash TEXT NOT NULL UNIQUE,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY,sha256 TEXT NOT NULL,path TEXT NOT NULL,media_type TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reference_versions(id TEXT PRIMARY KEY,artifact_id TEXT NOT NULL REFERENCES artifacts(id),sha256 TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,state TEXT NOT NULL,config TEXT NOT NULL,profile_id TEXT NOT NULL REFERENCES profiles(id),reference_id TEXT NOT NULL REFERENCES reference_versions(id),reference_artifact TEXT NOT NULL REFERENCES artifacts(id),reference_hash TEXT NOT NULL,created_at INTEGER NOT NULL,started_at INTEGER,iterations INTEGER NOT NULL DEFAULT 0,best_candidate TEXT,latest_candidate TEXT,cancellation_requested_at INTEGER,final_candidate TEXT);
      CREATE TABLE IF NOT EXISTS regions(id TEXT NOT NULL,task_id TEXT NOT NULL REFERENCES tasks(id),json TEXT NOT NULL,PRIMARY KEY(task_id,id));
      CREATE TABLE IF NOT EXISTS candidates(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),state TEXT NOT NULL,target_url TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS evaluations(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),candidate_id TEXT NOT NULL REFERENCES candidates(id),request_id TEXT NOT NULL,state TEXT NOT NULL,report TEXT,error TEXT,created_at INTEGER NOT NULL,UNIQUE(task_id,request_id));
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_evaluation ON evaluations(task_id) WHERE state IN ('queued','capturing','comparing','testing');
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,evaluation_id TEXT UNIQUE NOT NULL REFERENCES evaluations(id),dedupe_key TEXT UNIQUE NOT NULL,state TEXT NOT NULL,lease_until INTEGER,fence_token INTEGER NOT NULL DEFAULT 0,attempt INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS issues(id TEXT NOT NULL,evaluation_id TEXT NOT NULL REFERENCES evaluations(id),json TEXT NOT NULL,PRIMARY KEY(evaluation_id,id));

      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT NOT NULL REFERENCES tasks(id),kind TEXT NOT NULL,json TEXT NOT NULL,created_at INTEGER NOT NULL);
    `);
  }
  /**
   * 执行参数化查询并返回第一行；查不到时返回 undefined。
   */
  get<T = Record<string, any>>(sql: string, ...args: unknown[]) {
    return this.db.prepare(sql).get(...args) as T | undefined;
  }
  /**
   * 执行参数化查询并返回全部记录。
   */
  all<T = Record<string, any>>(sql: string, ...args: unknown[]) {
    return this.db.prepare(sql).all(...args) as T[];
  }
  /**
   * 执行写入语句，返回影响行数等 SQLite 执行信息。
   */
  run(sql: string, ...args: unknown[]) {
    return this.db.prepare(sql).run(...args);
  }
  /**
   * 以立即事务执行同步操作，保证并发队列领取与任务状态更新的原子性。
   */
  transaction<T>(fn: () => T) {
    return this.db.transaction(fn).immediate();
  }
  /**
   * 追加任务事件及 JSON 数据，形成可追溯的操作记录。
   */
  event(task: string, kind: string, data: unknown) {
    this.run(
      'INSERT INTO events(task_id,kind,json,created_at) VALUES(?,?,?,?)',
      task,
      kind,
      JSON.stringify(data),
      Date.now(),
    );
  }
  /**
   * 释放 SQLite 连接。
   */
  close() {
    this.db.close();
  }
}
