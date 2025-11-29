// server.js - Backend completo Start.Prev
const express = require('express');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// ==================== CONFIGURAÇÕES ====================

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'seu-secret-aqui-mude-em-producao';

// Configuração PostgreSQL
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'startprev_chat',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

// Configuração Bitrix24
const BITRIX_WEBHOOK = process.env.BITRIX_WEBHOOK || 'https://seu-dominio.bitrix24.com.br/rest/1/seu-webhook/';

// Configuração Claude API
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || '';

// ==================== MIDDLEWARES ====================

app.use(cors());
app.use(express.json());

// Middleware de autenticação
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Token não fornecido' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Token inválido' });
    }
    req.user = user;
    next();
  });
};

// ==================== ROTAS DE AUTENTICAÇÃO ====================

// Cadastro
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { name, email, phone, password } = req.body;

    // Validações
    if (!name || !email || !phone || !password) {
      return res.status(400).json({ error: 'Todos os campos são obrigatórios' });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: 'Senha deve ter no mínimo 8 caracteres' });
    }

    // Verificar se usuário já existe
    const existingUser = await pool.query(
      'SELECT id FROM users WHERE email = $1',
      [email]
    );

    if (existingUser.rows.length > 0) {
      return res.status(400).json({ error: 'Email já cadastrado' });
    }

    // Hash da senha
    const hashedPassword = await bcrypt.hash(password, 10);

    // Criar usuário
    const result = await pool.query(
      'INSERT INTO users (name, email, phone, password, created_at) VALUES ($1, $2, $3, $4, NOW()) RETURNING id, name, email, phone',
      [name, email, phone, hashedPassword]
    );

    const user = result.rows[0];

    // Sincronizar com Bitrix24
    await syncUserToBitrix(user);

    // Gerar token JWT
    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });

    res.status(201).json({
      message: 'Usuário criado com sucesso',
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone
      }
    });
  } catch (error) {
    console.error('Erro no cadastro:', error);
    res.status(500).json({ error: 'Erro ao criar usuário' });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email e senha são obrigatórios' });
    }

    // Buscar usuário
    const result = await pool.query(
      'SELECT * FROM users WHERE email = $1',
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Email ou senha incorretos' });
    }

    const user = result.rows[0];

    // Verificar senha
    const validPassword = await bcrypt.compare(password, user.password);

    if (!validPassword) {
      return res.status(401).json({ error: 'Email ou senha incorretos' });
    }

    // Gerar token JWT
    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });

    res.json({
      message: 'Login realizado com sucesso',
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        photo: user.photo
      }
    });
  } catch (error) {
    console.error('Erro no login:', error);
    res.status(500).json({ error: 'Erro ao fazer login' });
  }
});

// Login com Google
app.post('/api/auth/google', async (req, res) => {
  try {
    const { googleToken, name, email, photo } = req.body;

    // Buscar ou criar usuário
    let result = await pool.query(
      'SELECT * FROM users WHERE email = $1',
      [email]
    );

    let user;

    if (result.rows.length === 0) {
      // Criar novo usuário
      result = await pool.query(
        'INSERT INTO users (name, email, photo, created_at) VALUES ($1, $2, $3, NOW()) RETURNING *',
        [name, email, photo]
      );
      user = result.rows[0];
      
      // Sincronizar com Bitrix24
      await syncUserToBitrix(user);
    } else {
      user = result.rows[0];
    }

    // Gerar token JWT
    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });

    res.json({
      message: 'Login com Google realizado com sucesso',
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        photo: user.photo
      }
    });
  } catch (error) {
    console.error('Erro no login Google:', error);
    res.status(500).json({ error: 'Erro ao fazer login com Google' });
  }
});

// ==================== ROTAS DE USUÁRIO ====================

// Obter perfil do usuário
app.get('/api/user/profile', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, email, phone, photo FROM users WHERE id = $1',
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    res.json({ user: result.rows[0] });
  } catch (error) {
    console.error('Erro ao buscar perfil:', error);
    res.status(500).json({ error: 'Erro ao buscar perfil' });
  }
});

// Atualizar perfil
app.put('/api/user/profile', authenticateToken, async (req, res) => {
  try {
    const { name, email, phone } = req.body;

    const result = await pool.query(
      'UPDATE users SET name = $1, email = $2, phone = $3 WHERE id = $4 RETURNING id, name, email, phone, photo',
      [name, email, phone, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    // Atualizar no Bitrix24
    await updateUserInBitrix(result.rows[0]);

    res.json({
      message: 'Perfil atualizado com sucesso',
      user: result.rows[0]
    });
  } catch (error) {
    console.error('Erro ao atualizar perfil:', error);
    res.status(500).json({ error: 'Erro ao atualizar perfil' });
  }
});

// ==================== ROTAS DE CONVERSAS ====================

// Listar conversas do usuário
app.get('/api/conversations', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.*, 
        (SELECT text FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message,
        (SELECT created_at FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message_time,
        (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id AND sender = 'bot' AND read = false) as unread_count
       FROM conversations c
       WHERE c.user_id = $1
       ORDER BY last_message_time DESC`,
      [req.user.id]
    );

    res.json({ conversations: result.rows });
  } catch (error) {
    console.error('Erro ao buscar conversas:', error);
    res.status(500).json({ error: 'Erro ao buscar conversas' });
  }
});

// Criar nova conversa
app.post('/api/conversations', authenticateToken, async (req, res) => {
  try {
    const { title } = req.body;

    const result = await pool.query(
      'INSERT INTO conversations (user_id, title, created_at) VALUES ($1, $2, NOW()) RETURNING *',
      [req.user.id, title || 'Nova Conversa']
    );

    res.status(201).json({ conversation: result.rows[0] });
  } catch (error) {
    console.error('Erro ao criar conversa:', error);
    res.status(500).json({ error: 'Erro ao criar conversa' });
  }
});

// ==================== ROTAS DE MENSAGENS ====================

// Obter mensagens de uma conversa
app.get('/api/conversations/:id/messages', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    // Verificar se conversa pertence ao usuário
    const convResult = await pool.query(
      'SELECT * FROM conversations WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );

    if (convResult.rows.length === 0) {
      return res.status(404).json({ error: 'Conversa não encontrada' });
    }

    // Buscar mensagens
    const result = await pool.query(
      'SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC',
      [id]
    );

    // Marcar mensagens como lidas
    await pool.query(
      'UPDATE messages SET read = true WHERE conversation_id = $1 AND sender = $2',
      [id, 'bot']
    );

    res.json({ messages: result.rows });
  } catch (error) {
    console.error('Erro ao buscar mensagens:', error);
    res.status(500).json({ error: 'Erro ao buscar mensagens' });
  }
});

// Enviar mensagem
app.post('/api/conversations/:id/messages', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { text } = req.body;

    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'Mensagem não pode estar vazia' });
    }

    // Verificar se conversa pertence ao usuário
    const convResult = await pool.query(
      'SELECT * FROM conversations WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );

    if (convResult.rows.length === 0) {
      return res.status(404).json({ error: 'Conversa não encontrada' });
    }

    // Salvar mensagem do usuário
    const userMessage = await pool.query(
      'INSERT INTO messages (conversation_id, sender, text, created_at) VALUES ($1, $2, $3, NOW()) RETURNING *',
      [id, 'user', text]
    );

    // Emitir via WebSocket
    io.to(`conversation-${id}`).emit('new_message', userMessage.rows[0]);

    // Processar com Claude API
    const botResponse = await processWithClaude(text, req.user.id, id);

    // Salvar resposta do bot
    const botMessage = await pool.query(
      'INSERT INTO messages (conversation_id, sender, text, sentiment, created_at) VALUES ($1, $2, $3, $4, NOW()) RETURNING *',
      [id, 'bot', botResponse.text, botResponse.sentiment]
    );

    // Emitir resposta via WebSocket
    io.to(`conversation-${id}`).emit('new_message', botMessage.rows[0]);

    // Salvar no Bitrix24
    await saveMessageToBitrix(req.user.id, text, botResponse.text);

    res.status(201).json({
      userMessage: userMessage.rows[0],
      botMessage: botMessage.rows[0]
    });
  } catch (error) {
    console.error('Erro ao enviar mensagem:', error);
    res.status(500).json({ error: 'Erro ao enviar mensagem' });
  }
});

// ==================== INTEGRAÇÃO CLAUDE API ====================

async function processWithClaude(message, userId, conversationId) {
  try {
    // Buscar histórico da conversa
    const historyResult = await pool.query(
      'SELECT sender, text FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 10',
      [conversationId]
    );

    const history = historyResult.rows.reverse();

    // Buscar dados do usuário
    const userResult = await pool.query(
      'SELECT name, email FROM users WHERE id = $1',
      [userId]
    );
    const user = userResult.rows[0];

    // Construir contexto
    let context = `Você é um assistente de atendimento da Start.Prev, empresa do Grupo Start.Prev que oferece produtos e serviços de previdência e maternidade.\n\n`;
    context += `Cliente: ${user.name} (${user.email})\n\n`;
    context += `Histórico recente:\n`;
    history.forEach(msg => {
      context += `${msg.sender === 'user' ? 'Cliente' : 'Assistente'}: ${msg.text}\n`;
    });
    context += `\nMensagem atual do cliente: "${message}"\n\n`;
    context += `Responda de forma empática, profissional e objetiva (máximo 3 parágrafos).`;

    // Chamar Claude API
    const response = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [
        { role: 'user', content: context }
      ]
    }, {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01'
      }
    });

    const botText = response.data.content[0].text;

    // Analisar sentimento
    const sentiment = analyzeSentiment(message);

    return {
      text: botText,
      sentiment: sentiment
    };
  } catch (error) {
    console.error('Erro ao processar com Claude:', error);
    return {
      text: 'Desculpe, tive um problema ao processar sua mensagem. Pode tentar novamente?',
      sentiment: 'neutral'
    };
  }
}

function analyzeSentiment(text) {
  const negativeWords = ['problema', 'ruim', 'péssimo', 'horrível', 'não funciona', 'reclamação', 'frustrado'];
  const urgentWords = ['urgente', 'rápido', 'agora', 'imediato', 'emergência'];
  
  const lowerText = text.toLowerCase();
  
  if (negativeWords.some(word => lowerText.includes(word))) {
    return 'negative';
  }
  if (urgentWords.some(word => lowerText.includes(word))) {
    return 'urgent';
  }
  return 'neutral';
}

// ==================== INTEGRAÇÃO BITRIX24 ====================

async function syncUserToBitrix(user) {
  try {
    const response = await axios.post(`${BITRIX_WEBHOOK}crm.contact.add.json`, {
      fields: {
        NAME: user.name,
        EMAIL: [{ VALUE: user.email, VALUE_TYPE: 'WORK' }],
        PHONE: user.phone ? [{ VALUE: user.phone, VALUE_TYPE: 'WORK' }] : [],
        SOURCE_ID: 'APP_CHAT'
      }
    });

    if (response.data.result) {
      // Salvar ID do Bitrix no banco
      await pool.query(
        'UPDATE users SET bitrix_id = $1 WHERE id = $2',
        [response.data.result, user.id]
      );
    }

    return response.data;
  } catch (error) {
    console.error('Erro ao sincronizar usuário com Bitrix:', error);
  }
}

async function updateUserInBitrix(user) {
  try {
    const result = await pool.query(
      'SELECT bitrix_id FROM users WHERE id = $1',
      [user.id]
    );

    if (result.rows[0]?.bitrix_id) {
      await axios.post(`${BITRIX_WEBHOOK}crm.contact.update.json`, {
        id: result.rows[0].bitrix_id,
        fields: {
          NAME: user.name,
          EMAIL: [{ VALUE: user.email, VALUE_TYPE: 'WORK' }],
          PHONE: user.phone ? [{ VALUE: user.phone, VALUE_TYPE: 'WORK' }] : []
        }
      });
    }
  } catch (error) {
    console.error('Erro ao atualizar usuário no Bitrix:', error);
  }
}

async function saveMessageToBitrix(userId, userMessage, botMessage) {
  try {
    const result = await pool.query(
      'SELECT bitrix_id, name FROM users WHERE id = $1',
      [userId]
    );

    if (result.rows[0]?.bitrix_id) {
      await axios.post(`${BITRIX_WEBHOOK}crm.activity.add.json`, {
        fields: {
          OWNER_TYPE_ID: 3, // Contact
          OWNER_ID: result.rows[0].bitrix_id,
          TYPE_ID: 4, // Call/Message
          SUBJECT: 'Atendimento via App',
          DESCRIPTION: `Cliente: ${userMessage}\n\nAssistente: ${botMessage}`,
          COMPLETED: 'Y',
          DIRECTION: 2 // Incoming
        }
      });
    }
  } catch (error) {
    console.error('Erro ao salvar mensagem no Bitrix:', error);
  }
}

// ==================== WEBSOCKET ====================

io.on('connection', (socket) => {
  console.log('Cliente conectado:', socket.id);

  // Autenticar via token
  socket.on('authenticate', async (token) => {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      socket.userId = decoded.id;
      socket.emit('authenticated', { success: true });
    } catch (error) {
      socket.emit('authenticated', { success: false, error: 'Token inválido' });
    }
  });

  // Entrar em uma conversa
  socket.on('join_conversation', (conversationId) => {
    socket.join(`conversation-${conversationId}`);
    console.log(`Usuário ${socket.userId} entrou na conversa ${conversationId}`);
  });

  // Sair de uma conversa
  socket.on('leave_conversation', (conversationId) => {
    socket.leave(`conversation-${conversationId}`);
    console.log(`Usuário ${socket.userId} saiu da conversa ${conversationId}`);
  });

  // Indicador de digitação
  socket.on('typing', (conversationId) => {
    socket.to(`conversation-${conversationId}`).emit('user_typing', { userId: socket.userId });
  });

  socket.on('disconnect', () => {
    console.log('Cliente desconectado:', socket.id);
  });
});

// ==================== SERVIDOR ====================

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

server.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
});

// Tratamento de erros não capturados
process.on('unhandledRejection', (err) => {
  console.error('Erro não tratado:', err);
});