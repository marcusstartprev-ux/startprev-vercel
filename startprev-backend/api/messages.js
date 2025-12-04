const pool = require('./db');
const { authenticateToken } = require('./auth-middleware');
const { processWithClaude } = require('./claude-integration');
const { saveMessageToBitrix } = require('./bitrix-integration');

async function runMiddleware(req, res, fn) {
  return new Promise((resolve, reject) => {
    fn(req, res, (result) => {
      if (result instanceof Error) {
        return reject(result);
      }
      return resolve(result);
    });
  });
}

module.exports = async (req, res) => {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    // Authenticate user
    await runMiddleware(req, res, authenticateToken);

    // Get conversation ID from query parameter
    const conversationId = req.query.conversationId;

    if (!conversationId) {
      return res.status(400).json({ error: 'conversationId é obrigatório' });
    }

    // Verify conversation belongs to user
    const convResult = await pool.query(
      'SELECT * FROM conversations WHERE id = $1 AND user_id = $2',
      [conversationId, req.user.id]
    );

    if (convResult.rows.length === 0) {
      return res.status(404).json({ error: 'Conversa não encontrada' });
    }

    if (req.method === 'GET') {
      // Get conversation messages
      const result = await pool.query(
        'SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC',
        [conversationId]
      );

      // Mark messages as read
      await pool.query(
        'UPDATE messages SET read = true WHERE conversation_id = $1 AND sender = $2',
        [conversationId, 'bot']
      );

      return res.json({ messages: result.rows });
    }

    if (req.method === 'POST') {
      // Send message
      const { text } = req.body;

      if (!text || !text.trim()) {
        return res.status(400).json({ error: 'Mensagem não pode estar vazia' });
      }

      // Save user message
      const userMessage = await pool.query(
        'INSERT INTO messages (conversation_id, sender, text, created_at) VALUES ($1, $2, $3, NOW()) RETURNING *',
        [conversationId, 'user', text]
      );

      // Process with Claude API
      const botResponse = await processWithClaude(text, req.user.id, conversationId);

      // Save bot response
      const botMessage = await pool.query(
        'INSERT INTO messages (conversation_id, sender, text, sentiment, created_at) VALUES ($1, $2, $3, $4, NOW()) RETURNING *',
        [conversationId, 'bot', botResponse.text, botResponse.sentiment]
      );

      // Save to Bitrix24
      await saveMessageToBitrix(req.user.id, text, botResponse.text);

      return res.status(201).json({
        userMessage: userMessage.rows[0],
        botMessage: botMessage.rows[0]
      });
    }

    return res.status(405).json({ error: 'Método não permitido' });
  } catch (error) {
    console.error('Erro ao processar mensagens:', error);
    res.status(500).json({ error: 'Erro ao processar mensagens' });
  }
};
