{
  -- schema.sql - Banco de dados completo Start.Prev

-- ==================== TABELA DE USUÁRIOS ====================

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  phone VARCHAR(20),
  password VARCHAR(255), -- NULL para login com Google
  photo TEXT,
  bitrix_id INTEGER, -- ID no Bitrix24
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Índices para otimização
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_bitrix_id ON users(bitrix_id);

-- ==================== TABELA DE CONVERSAS ====================

CREATE TABLE IF NOT EXISTS conversations (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(255) DEFAULT 'Nova Conversa',
  status VARCHAR(50) DEFAULT 'active', -- active, archived, closed
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Índices para otimização
CREATE INDEX idx_conversations_user_id ON conversations(user_id);
CREATE INDEX idx_conversations_status ON conversations(status);

-- ==================== TABELA DE MENSAGENS ====================

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender VARCHAR(10) NOT NULL, -- 'user' ou 'bot'
  text TEXT NOT NULL,
  sentiment VARCHAR(20), -- neutral, negative, urgent
  read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Índices para otimização
CREATE INDEX idx_messages_conversation_id ON messages(conversation_id);
CREATE INDEX idx_messages_created_at ON messages(created_at);
CREATE INDEX idx_messages_sender ON messages(sender);

-- ==================== TABELA DE NOTIFICAÇÕES ====================

CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  message TEXT NOT NULL,
  type VARCHAR(50) DEFAULT 'info', -- info, success, warning, error
  read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Índices para otimização
CREATE INDEX idx_notifications_user_id ON notifications(user_id);
CREATE INDEX idx_notifications_read ON notifications(read);

-- ==================== TABELA DE LOGS ====================

CREATE TABLE IF NOT EXISTS activity_logs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(100) NOT NULL, -- login, logout, message_sent, etc
  details JSONB,
  ip_address VARCHAR(45),
  user_agent TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Índices para otimização
CREATE INDEX idx_logs_user_id ON activity_logs(user_id);
CREATE INDEX idx_logs_action ON activity_logs(action);
CREATE INDEX idx_logs_created_at ON activity_logs(created_at);

-- ==================== TABELA DE CONFIGURAÇÕES ====================

CREATE TABLE IF NOT EXISTS user_settings (
  id SERIAL PRIMARY KEY,
  user_id INTEGER UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notifications_enabled BOOLEAN DEFAULT TRUE,
  email_notifications BOOLEAN DEFAULT TRUE,
  push_notifications BOOLEAN DEFAULT TRUE,
  language VARCHAR(10) DEFAULT 'pt-BR',
  theme VARCHAR(20) DEFAULT 'light', -- light, dark, auto
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Índice para otimização
CREATE INDEX idx_user_settings_user_id ON user_settings(user_id);

-- ==================== TABELA DE TOKENS PUSH ====================

CREATE TABLE IF NOT EXISTS push_tokens (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  device_type VARCHAR(20) NOT NULL, -- ios, android, web
  device_name VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_used_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, token)
);

-- Índices para otimização
CREATE INDEX idx_push_tokens_user_id ON push_tokens(user_id);
CREATE INDEX idx_push_tokens_token ON push_tokens(token);

-- ==================== TRIGGERS ====================

-- Atualizar updated_at automaticamente
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_conversations_updated_at BEFORE UPDATE ON conversations
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_user_settings_updated_at BEFORE UPDATE ON user_settings
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ==================== VIEWS ÚTEIS ====================

-- View de conversas com última mensagem
CREATE OR REPLACE VIEW conversations_with_last_message AS
SELECT 
  c.*,
  m.text as last_message,
  m.created_at as last_message_time,
  m.sender as last_message_sender,
  (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id AND sender = 'bot' AND read = false) as unread_count
FROM conversations c
LEFT JOIN LATERAL (
  SELECT text, created_at, sender
  FROM messages
  WHERE conversation_id = c.id
  ORDER BY created_at DESC
  LIMIT 1
) m ON true
ORDER BY last_message_time DESC NULLS LAST;

-- View de estatísticas de usuário
CREATE OR REPLACE VIEW user_statistics AS
SELECT 
  u.id,
  u.name,
  u.email,
  COUNT(DISTINCT c.id) as total_conversations,
  COUNT(m.id) as total_messages,
  COUNT(CASE WHEN m.sender = 'user' THEN 1 END) as messages_sent,
  COUNT(CASE WHEN m.sender = 'bot' THEN 1 END) as messages_received,
  MAX(m.created_at) as last_activity
FROM users u
LEFT JOIN conversations c ON c.user_id = u.id
LEFT JOIN messages m ON m.conversation_id = c.id
GROUP BY u.id, u.name, u.email;

-- ==================== DADOS INICIAIS (OPCIONAL) ====================

-- Inserir configurações padrão para novos usuários (via trigger)
CREATE OR REPLACE FUNCTION create_default_user_settings()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO user_settings (user_id)
    VALUES (NEW.id);
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER create_user_settings_on_signup
    AFTER INSERT ON users
    FOR EACH ROW EXECUTE FUNCTION create_default_user_settings();

-- ==================== FUNÇÕES ÚTEIS ====================

-- Limpar mensagens antigas (executar periodicamente)
CREATE OR REPLACE FUNCTION cleanup_old_messages(days_to_keep INTEGER DEFAULT 90)
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM messages 
    WHERE created_at < CURRENT_TIMESTAMP - (days_to_keep || ' days')::INTERVAL;
    
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ language 'plpgsql';

-- Obter estatísticas de conversa
CREATE OR REPLACE FUNCTION get_conversation_stats(conv_id INTEGER)
RETURNS TABLE (
    total_messages BIGINT,
    user_messages BIGINT,
    bot_messages BIGINT,
    avg_response_time INTERVAL,
    last_activity TIMESTAMP
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        COUNT(*)::BIGINT,
        COUNT(CASE WHEN sender = 'user' THEN 1 END)::BIGINT,
        COUNT(CASE WHEN sender = 'bot' THEN 1 END)::BIGINT,
        AVG(CASE 
            WHEN sender = 'bot' THEN 
                created_at - LAG(created_at) OVER (ORDER BY created_at)
            END)::INTERVAL,
        MAX(created_at)
    FROM messages
    WHERE conversation_id = conv_id;
END;
$$ language 'plpgsql';

-- ==================== COMENTÁRIOS ====================

COMMENT ON TABLE users IS 'Tabela de usuários do sistema';
COMMENT ON TABLE conversations IS 'Conversas entre usuários e IA';
COMMENT ON TABLE messages IS 'Mensagens trocadas nas conversas';
COMMENT ON TABLE notifications IS 'Notificações push e in-app';
COMMENT ON TABLE activity_logs IS 'Logs de atividades do sistema';
COMMENT ON TABLE user_settings IS 'Configurações personalizadas de cada usuário';
COMMENT ON TABLE push_tokens IS 'Tokens para notificações push';

COMMENT ON COLUMN messages.sentiment IS 'Análise de sentimento: neutral, negative, urgent';
COMMENT ON COLUMN users.bitrix_id IS 'ID do contato no Bitrix24 CRM';