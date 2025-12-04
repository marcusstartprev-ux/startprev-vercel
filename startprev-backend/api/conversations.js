const pool = require('./db');
const { authenticateToken } = require('./auth-middleware');

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

    if (req.method === 'GET') {
      // List user conversations
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

      return res.json({ conversations: result.rows });
    }

    if (req.method === 'POST') {
      // Create new conversation
      const { title } = req.body;

      const result = await pool.query(
        'INSERT INTO conversations (user_id, title, created_at) VALUES ($1, $2, NOW()) RETURNING *',
        [req.user.id, title || 'Nova Conversa']
      );

      return res.status(201).json({ conversation: result.rows[0] });
    }

    return res.status(405).json({ error: 'Método não permitido' });
  } catch (error) {
    console.error('Erro ao processar conversas:', error);
    res.status(500).json({ error: 'Erro ao processar conversas' });
  }
};
