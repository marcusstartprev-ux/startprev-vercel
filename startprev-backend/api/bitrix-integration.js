const axios = require('axios');
const pool = require('./db');

const BITRIX_WEBHOOK = process.env.BITRIX_WEBHOOK;

async function syncUserToBitrix(user) {
  if (!BITRIX_WEBHOOK) {
    console.warn('BITRIX_WEBHOOK not configured, skipping Bitrix sync');
    return;
  }

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
  if (!BITRIX_WEBHOOK) {
    console.warn('BITRIX_WEBHOOK not configured, skipping Bitrix update');
    return;
  }

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
  if (!BITRIX_WEBHOOK) {
    console.warn('BITRIX_WEBHOOK not configured, skipping Bitrix message save');
    return;
  }

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

module.exports = {
  syncUserToBitrix,
  updateUserInBitrix,
  saveMessageToBitrix
};
