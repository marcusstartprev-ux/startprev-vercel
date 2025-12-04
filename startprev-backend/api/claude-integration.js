const axios = require('axios');
const pool = require('./db');

const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || '';

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

module.exports = {
  processWithClaude,
  analyzeSentiment
};
