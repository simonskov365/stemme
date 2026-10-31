CREATE TABLE conversations(id TEXT PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL, memory_enabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE turns(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, owner TEXT NOT NULL, request_key TEXT NOT NULL, fingerprint TEXT NOT NULL, response_id TEXT NOT NULL, status TEXT NOT NULL, speech_status TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(owner,conversation_id,request_key));
CREATE TABLE messages(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE, owner TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT, turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE, type TEXT NOT NULL, data TEXT NOT NULL);
CREATE INDEX events_turn ON events(turn_id,seq);
CREATE INDEX messages_conversation ON messages(conversation_id, created_at, id);
CREATE TABLE memories(id TEXT PRIMARY KEY, owner TEXT NOT NULL, content TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE summaries(conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE, content TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE tool_actions(id TEXT PRIMARY KEY, owner TEXT NOT NULL, request_key TEXT NOT NULL, fingerprint TEXT NOT NULL, name TEXT NOT NULL, args TEXT NOT NULL, approved INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, result TEXT, created_at TEXT NOT NULL, UNIQUE(owner,request_key));
