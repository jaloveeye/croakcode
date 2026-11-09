// node:sqlite는 Node 22.5+와 Bun 양쪽에 내장돼 있어 sqlite3 CLI 없이 DB를 읽을 수 있다.
import { DatabaseSync } from "node:sqlite";

export function queryOne(file, sql, ...params) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(sql).get(...params);
  } finally {
    db.close();
  }
}
