import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { ChatTurn } from "./types";

const execFileAsync = promisify(execFile);

export interface ContinueInOllamaResult {
  chatId: string;
  launchedTarget: "desktop-app" | "terminal-cli";
  dbPath?: string;
}

export function getOllamaDbPath(): string {
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(localAppData, "Ollama", "db.sqlite");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Ollama", "db.sqlite");
  }
  return path.join(os.homedir(), ".ollama", "db.sqlite");
}

function formatSqliteUtcTimestamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}

function makeChatTitle(turns: ChatTurn[]): string {
  const firstUser = turns.find((t) => t.role === "user")?.content || "Raycast 对话";
  const singleLine = firstUser.replace(/\s+/g, " ").trim();
  return singleLine.length > 48 ? `${singleLine.slice(0, 48)}...` : singleLine;
}

const BASE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    thinking TEXT NOT NULL DEFAULT '',
    stream BOOLEAN NOT NULL DEFAULT 0,
    model_name TEXT,
    model_cloud BOOLEAN,
    model_ollama_host BOOLEAN,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    thinking_time_start TIMESTAMP,
    thinking_time_end TIMESTAMP,
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id);
`;

interface PersistPayload {
  dbPath: string;
  chatId: string;
  title: string;
  model: string;
  turns: Array<{
    role: string;
    content: string;
    thinking: string;
    createdAtSql: string;
  }>;
  chatCreatedAtSql: string;
}

/**
 * Primary persistence path using Node.js built-in `node:sqlite` (WAL-safe native SQLite).
 */
function tryWriteWithNodeSqlite(payload: PersistPayload): boolean {
  try {
    const req = createRequire(__filename);
    const sqliteMod = req("node:sqlite") as {
      DatabaseSync: new (p: string) => {
        exec: (sql: string) => void;
        prepare: (sql: string) => {
          all: (...args: unknown[]) => Array<Record<string, unknown>>;
          run: (...args: unknown[]) => unknown;
        };
        close: () => void;
      };
    };

    fs.mkdirSync(path.dirname(payload.dbPath), { recursive: true });
    const db = new sqliteMod.DatabaseSync(payload.dbPath);

    try {
      db.exec("PRAGMA busy_timeout = 3000;");
      db.exec("PRAGMA foreign_keys = ON;");
      db.exec(BASE_SCHEMA_SQL);

      const chatCols = new Set(
        db
          .prepare("PRAGMA table_info(chats)")
          .all()
          .map((r) => String(r.name))
      );
      const msgCols = new Set(
        db
          .prepare("PRAGMA table_info(messages)")
          .all()
          .map((r) => String(r.name))
      );

      db.exec("BEGIN IMMEDIATE TRANSACTION;");
      try {
        // Upsert chat session
        const chatInsertCols = ["id", "title"];
        const chatValues: unknown[] = [payload.chatId, payload.title];
        if (chatCols.has("created_at")) {
          chatInsertCols.push("created_at");
          chatValues.push(payload.chatCreatedAtSql);
        }
        const chatPlaceholders = chatInsertCols.map(() => "?").join(", ");
        db.prepare(
          `INSERT OR REPLACE INTO chats (${chatInsertCols.join(", ")}) VALUES (${chatPlaceholders})`
        ).run(...chatValues);

        // Clear previous rows if updating an already-synced chatId
        db.prepare("DELETE FROM messages WHERE chat_id = ?").run(payload.chatId);

        for (const turn of payload.turns) {
          const cols: string[] = ["chat_id", "role", "content"];
          const vals: unknown[] = [payload.chatId, turn.role, turn.content];

          if (msgCols.has("thinking")) {
            cols.push("thinking");
            vals.push(turn.thinking || "");
          }
          if (msgCols.has("stream")) {
            cols.push("stream");
            vals.push(0);
          }
          if (msgCols.has("model_name")) {
            cols.push("model_name");
            vals.push(turn.role === "assistant" ? payload.model : "");
          }
          if (msgCols.has("created_at")) {
            cols.push("created_at");
            vals.push(turn.createdAtSql);
          }
          if (msgCols.has("updated_at")) {
            cols.push("updated_at");
            vals.push(turn.createdAtSql);
          }

          const ph = cols.map(() => "?").join(", ");
          db.prepare(`INSERT INTO messages (${cols.join(", ")}) VALUES (${ph})`).run(...vals);
        }

        db.exec("COMMIT;");
      } catch (txErr) {
        try {
          db.exec("ROLLBACK;");
        } catch {
          // ignore
        }
        throw txErr;
      }
    } finally {
      db.close();
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Fallback persistence path via Python's built-in `sqlite3` standard library module
 * in case an older Node runtime does not expose `node:sqlite`.
 */
async function tryWriteWithPythonSqlite(payload: PersistPayload): Promise<boolean> {
  const pyScript = `
import json, os, sqlite3, sys

data = json.loads(sys.stdin.read())
db_path = data["dbPath"]
os.makedirs(os.path.dirname(db_path), exist_ok=True)

conn = sqlite3.connect(db_path, timeout=3.0)
try:
    cur = conn.cursor()
    cur.execute("PRAGMA foreign_keys = ON;")
    cur.executescript(${JSON.stringify(BASE_SCHEMA_SQL)})

    cur.execute("PRAGMA table_info(chats)")
    chat_cols = {row[1] for row in cur.fetchall()}
    cur.execute("PRAGMA table_info(messages)")
    msg_cols = {row[1] for row in cur.fetchall()}

    c_cols = ["id", "title"]
    c_vals = [data["chatId"], data["title"]]
    if "created_at" in chat_cols:
        c_cols.append("created_at")
        c_vals.append(data["chatCreatedAtSql"])
    cur.execute(
        f"INSERT OR REPLACE INTO chats ({', '.join(c_cols)}) VALUES ({', '.join(['?']*len(c_cols))})",
        c_vals,
    )
    cur.execute("DELETE FROM messages WHERE chat_id = ?", (data["chatId"],))

    for t in data["turns"]:
        m_cols = ["chat_id", "role", "content"]
        m_vals = [data["chatId"], t["role"], t["content"]]
        if "thinking" in msg_cols:
            m_cols.append("thinking")
            m_vals.append(t.get("thinking") or "")
        if "stream" in msg_cols:
            m_cols.append("stream")
            m_vals.append(0)
        if "model_name" in msg_cols:
            m_cols.append("model_name")
            m_vals.append(data["model"] if t["role"] == "assistant" else "")
        if "created_at" in msg_cols:
            m_cols.append("created_at")
            m_vals.append(t["createdAtSql"])
        if "updated_at" in msg_cols:
            m_cols.append("updated_at")
            m_vals.append(t["createdAtSql"])
        cur.execute(
            f"INSERT INTO messages ({', '.join(m_cols)}) VALUES ({', '.join(['?']*len(m_cols))})",
            m_vals,
        )
    conn.commit()
finally:
    conn.close()
`;

  const candidates = process.platform === "win32" ? ["python", "python3"] : ["python3", "python"];

  for (const bin of candidates) {
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(bin, ["-c", pyScript], {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
        let stderr = "";
        child.stderr.on("data", (d) => (stderr += String(d)));
        child.on("error", reject);
        child.on("close", (code) => {
          if (code === 0) resolve();
          else reject(new Error(stderr || `exit ${code}`));
        });
        child.stdin.write(JSON.stringify(payload));
        child.stdin.end();
      });
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

function findWindowsOllamaApp(customPath?: string): string | null {
  const candidates = [
    customPath?.trim(),
    path.join(process.env.LOCALAPPDATA || "", "Programs", "Ollama", "ollama app.exe"),
    path.join(os.homedir(), "AppData", "Local", "Programs", "Ollama", "ollama app.exe"),
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Ollama", "ollama app.exe"),
  ].filter(Boolean) as string[];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function findMacOllamaApp(customPath?: string): string | null {
  const candidates = [
    customPath?.trim(),
    "/Applications/Ollama.app",
    path.join(os.homedir(), "Applications", "Ollama.app"),
  ].filter(Boolean) as string[];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function launchOllamaGuiOrCli(
  model: string,
  customAppPath?: string
): Promise<"desktop-app" | "terminal-cli"> {
  if (process.platform === "win32") {
    const appExe = findWindowsOllamaApp(customAppPath);
    if (appExe) {
      const child = spawn(appExe, [], {
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      });
      child.unref();

      // Also nudge foreground focus for single-instance Ollama window
      const psExe = path.join(
        process.env.SystemRoot || "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe"
      );
      const focusCmd = `Start-Sleep -Milliseconds 350; $ws = New-Object -ComObject WScript.Shell; [void]$ws.AppActivate('Ollama')`;
      const focusProc = spawn(psExe, ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", focusCmd], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      focusProc.unref();
      return "desktop-app";
    }

    // Fallback: open terminal with `ollama run <model>`
    const safeModel = model.replace(/[^a-zA-Z0-9._:/-]/g, "");
    const cmd = spawn("cmd.exe", ["/c", "start", "", "cmd.exe", "/k", `ollama run ${safeModel}`], {
      detached: true,
      stdio: "ignore",
    });
    cmd.unref();
    return "terminal-cli";
  }

  if (process.platform === "darwin") {
    const appBundle = findMacOllamaApp(customAppPath);
    if (appBundle) {
      await execFileAsync("/usr/bin/open", ["-a", appBundle]);
      return "desktop-app";
    }

    // Fallback: launch Terminal.app running `ollama run <model>`
    const safeModel = model.replace(/[^a-zA-Z0-9._:/-]/g, "");
    const appleScript = `tell application "Terminal"
  activate
  do script "ollama run ${safeModel}"
end tell`;
    await execFileAsync("/usr/bin/osascript", ["-e", appleScript]);
    return "terminal-cli";
  }

  throw new Error(`当前平台 (${process.platform}) 暂不支持自动唤起 Ollama 桌面客户端`);
}

export async function persistChatToOllamaDb(params: {
  turns: ChatTurn[];
  model: string;
  existingChatId?: string;
  customDbPath?: string;
}): Promise<{ chatId: string; dbPath: string; persisted: boolean }> {
  const visibleTurns = params.turns.filter((t) => t.role === "user" || t.role === "assistant");
  if (visibleTurns.length === 0) {
    throw new Error("当前还没有可同步的对话内容");
  }

  const chatId = params.existingChatId || randomUUID();
  const dbPath = params.customDbPath || getOllamaDbPath();
  const nowMs = Date.now();

  const payload: PersistPayload = {
    dbPath,
    chatId,
    title: makeChatTitle(visibleTurns),
    model: params.model.trim(),
    chatCreatedAtSql: formatSqliteUtcTimestamp(nowMs),
    turns: visibleTurns.map((t, idx) => ({
      role: t.role,
      content: t.content,
      thinking: t.thinking || "",
      createdAtSql: formatSqliteUtcTimestamp(nowMs - (visibleTurns.length - idx) * 1000),
    })),
  };

  let persisted = tryWriteWithNodeSqlite(payload);
  if (!persisted) {
    persisted = await tryWriteWithPythonSqlite(payload);
  }

  return { chatId, dbPath, persisted };
}

/**
 * Persists the current conversation turns into Ollama Desktop App's SQLite database
 * (`db.sqlite`) and launches/focuses the Ollama Desktop App window so the user can
 * seamlessly continue the conversation inside Ollama.
 */
export async function saveAndOpenInOllama(params: {
  turns: ChatTurn[];
  model: string;
  existingChatId?: string;
  customAppPath?: string;
}): Promise<ContinueInOllamaResult> {
  const { chatId, dbPath, persisted } = await persistChatToOllamaDb({
    turns: params.turns,
    model: params.model,
    existingChatId: params.existingChatId,
  });

  const launchedTarget = await launchOllamaGuiOrCli(params.model, params.customAppPath);

  if (!persisted && launchedTarget === "desktop-app") {
    throw new Error("已唤起 Ollama，但未能写入本地会话数据库 db.sqlite（缺少 SQLite 运行支持）");
  }

  return {
    chatId,
    launchedTarget,
    dbPath: persisted ? dbPath : undefined,
  };
}
