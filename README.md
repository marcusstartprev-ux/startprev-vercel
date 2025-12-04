# Start Prev - Backend Vercel Deployment

Este repositório contém dois backends para o projeto Start Prev:

## 1. API Principal (Auditoria INSS)
- **Localização**: `/api/startprev.js`
- **Endpoint**: `/api/startprev`
- **Descrição**: API serverless para processamento de PDFs do INSS e cálculo de honorários usando OpenAI e Supabase

## 2. Backend de Chat (startprev-backend)
- **Localização**: `/startprev-backend/api/`
- **Endpoints**:
  - `POST /api/auth/signup` - Cadastro de usuários
  - `POST /api/auth/login` - Login de usuários
  - `GET /api/user/profile` - Obter perfil do usuário (autenticado)
  - `PUT /api/user/profile` - Atualizar perfil do usuário (autenticado)
  - `GET /api/conversations` - Listar conversas do usuário (autenticado)
  - `POST /api/conversations` - Criar nova conversa (autenticado)
  - `GET /api/messages?conversationId=X` - Obter mensagens de uma conversa (autenticado)
  - `POST /api/messages?conversationId=X` - Enviar mensagem (autenticado)
  - `GET /health` - Health check

## Configuração do Vercel

O arquivo `vercel.json` está configurado para:
- Fazer deploy de ambos os backends como serverless functions
- Rotear requisições para os endpoints apropriados
- Servir o arquivo `index.html` na raiz

## Variáveis de Ambiente

### Para API Principal (startprev.js):
- `OPENAI_API_KEY` - Chave da API OpenAI
- `SUPABASE_URL` - URL do projeto Supabase
- `SUPABASE_SERVICE_ROLE_KEY` - Chave de serviço do Supabase

### Para Backend de Chat (startprev-backend):
- `DB_HOST` - Host do PostgreSQL
- `DB_PORT` - Porta do PostgreSQL (padrão: 5432)
- `DB_NAME` - Nome do banco de dados
- `DB_USER` - Usuário do banco de dados
- `DB_PASSWORD` - Senha do banco de dados
- `JWT_SECRET` - Chave secreta para JWT
- `BITRIX_WEBHOOK` - URL do webhook do Bitrix24
- `CLAUDE_API_KEY` - Chave da API Claude (Anthropic)

## Limitações do Vercel

### WebSockets
⚠️ **IMPORTANTE**: O código original em `server.js` usa Socket.IO para comunicação em tempo real, mas **WebSockets não são suportados em serverless functions do Vercel**.

As funções serverless foram criadas sem suporte a WebSocket. Para funcionalidade em tempo real, considere:

1. **Polling**: O frontend pode fazer requisições periódicas ao endpoint de mensagens
2. **Vercel Edge Functions**: Usar Server-Sent Events (SSE) para updates unidirecionais
3. **Serviço externo**: Hospedar o WebSocket em outro serviço (Railway, Render, etc.)
4. **Pusher/Ably**: Usar um serviço de WebSocket gerenciado

## Deploy

1. Conecte este repositório ao Vercel
2. Configure as variáveis de ambiente no painel do Vercel
3. O deploy será automático a cada push

## Estrutura de Arquivos

```
.
├── api/
│   └── startprev.js          # API de auditoria INSS
├── startprev-backend/
│   ├── api/                  # Serverless functions do backend de chat
│   │   ├── auth-middleware.js
│   │   ├── bitrix-integration.js
│   │   ├── claude-integration.js
│   │   ├── conversations.js
│   │   ├── db.js
│   │   ├── health.js
│   │   ├── login.js
│   │   ├── messages.js
│   │   ├── profile.js
│   │   └── signup.js
│   ├── package.json          # Dependências do backend
│   ├── schema.sql            # Schema do banco de dados
│   └── server.js             # Código original Express (não usado no Vercel)
├── index.html                # Frontend da aplicação
├── package.json              # Dependências raiz
└── vercel.json               # Configuração do Vercel
```

## Banco de Dados

Execute o script `startprev-backend/schema.sql` no seu PostgreSQL para criar as tabelas necessárias.

## Desenvolvimento Local

Para testar localmente:

```bash
# Instalar dependências
npm install
cd startprev-backend && npm install

# Configurar variáveis de ambiente em .env
# Usar Vercel CLI para simular ambiente
vercel dev
```

## Suporte

Para dúvidas ou problemas, entre em contato com a equipe de desenvolvimento.
