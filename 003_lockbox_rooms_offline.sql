-- Offline-capable Lockbox rooms architecture
-- Keeps legacy pairwise lockboxes tables; adds room-based model

CREATE TABLE IF NOT EXISTS lockbox_rooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  room_code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  access_secret_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed','archived')),
  credentials_version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_lockbox_rooms_owner ON lockbox_rooms(owner_id);
CREATE INDEX IF NOT EXISTS idx_lockbox_rooms_code ON lockbox_rooms(room_code);

CREATE TABLE IF NOT EXISTS lockbox_room_participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES lockbox_rooms(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  revoked_by UUID REFERENCES users(id) ON DELETE SET NULL,
  last_auth_sync_at TIMESTAMPTZ,
  UNIQUE(room_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_lockbox_room_part_user ON lockbox_room_participants(user_id);
CREATE INDEX IF NOT EXISTS idx_lockbox_room_part_room ON lockbox_room_participants(room_id);

CREATE TABLE IF NOT EXISTS lockbox_room_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES lockbox_rooms(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_message_id TEXT NOT NULL,
  body TEXT NOT NULL,
  message_type TEXT NOT NULL DEFAULT 'text',
  sync_status TEXT NOT NULL DEFAULT 'synced'
    CHECK (sync_status IN ('draft','pending_offline','syncing','synced','delivered','read','failed')),
  is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  synchronized_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ,
  UNIQUE(room_id, client_message_id)
);
CREATE INDEX IF NOT EXISTS idx_lockbox_room_msg_room ON lockbox_room_messages(room_id, created_at);
CREATE INDEX IF NOT EXISTS idx_lockbox_room_msg_sender ON lockbox_room_messages(sender_id);

CREATE TABLE IF NOT EXISTS lockbox_room_message_reads (
  message_id UUID NOT NULL REFERENCES lockbox_room_messages(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (message_id, user_id)
);

CREATE TABLE IF NOT EXISTS lockbox_room_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID REFERENCES lockbox_rooms(id) ON DELETE SET NULL,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT,
  meta JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS lockbox_sync_cursors (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  room_id UUID NOT NULL REFERENCES lockbox_rooms(id) ON DELETE CASCADE,
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, room_id)
);
