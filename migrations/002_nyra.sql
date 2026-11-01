CREATE TABLE nyra_documents(owner TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, document_id TEXT, title TEXT NOT NULL, content TEXT NOT NULL, core TEXT NOT NULL, synced_at TEXT NOT NULL, last_error TEXT);
CREATE TABLE nyra_profiles(owner TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT 'Nyra', persona TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 0);
CREATE VIRTUAL TABLE nyra_passages USING fts5(source_id UNINDEXED, section UNINDEXED, ordinal UNINDEXED, content, tokenize='unicode61');
