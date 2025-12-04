const { Pool } = require('pg');

// Configuração PostgreSQL - todas as variáveis são obrigatórias
const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

// Validar que todas as variáveis obrigatórias estão configuradas
if (!process.env.DB_HOST || !process.env.DB_NAME || !process.env.DB_USER || !process.env.DB_PASSWORD) {
  throw new Error('Database environment variables (DB_HOST, DB_NAME, DB_USER, DB_PASSWORD) are required');
}

module.exports = pool;
