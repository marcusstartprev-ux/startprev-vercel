const pool = require('./db');
const { authenticateToken } = require('./auth-middleware');
const { updateUserInBitrix } = require('./bitrix-integration');
const { runMiddleware } = require('./utils');

module.exports = async (req, res) => {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    // Authenticate user
    await runMiddleware(req, res, authenticateToken);

    if (req.method === 'GET') {
      // Get user profile
      const result = await pool.query(
        'SELECT id, name, email, phone, photo FROM users WHERE id = $1',
        [req.user.id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Usuário não encontrado' });
      }

      return res.json({ user: result.rows[0] });
    }

    if (req.method === 'PUT') {
      // Update user profile
      const { name, email, phone } = req.body;

      const result = await pool.query(
        'UPDATE users SET name = $1, email = $2, phone = $3 WHERE id = $4 RETURNING id, name, email, phone, photo',
        [name, email, phone, req.user.id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Usuário não encontrado' });
      }

      // Update in Bitrix24
      await updateUserInBitrix(result.rows[0]);

      return res.json({
        message: 'Perfil atualizado com sucesso',
        user: result.rows[0]
      });
    }

    return res.status(405).json({ error: 'Método não permitido' });
  } catch (error) {
    console.error('Erro ao processar perfil:', error);
    res.status(500).json({ error: 'Erro ao processar perfil' });
  }
};
