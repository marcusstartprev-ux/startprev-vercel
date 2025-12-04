# Guia de Deploy - Start Prev Vercel

## 📋 Resumo

Este projeto agora está configurado para fazer deploy de **duas APIs** no Vercel:

1. **API de Auditoria INSS** (`/api/startprev`) - Já existente
2. **API de Chat** (novos endpoints `/api/auth/*`, `/api/user/*`, etc.)

## 🚀 Como fazer o Deploy

### 1. Configurar o Projeto no Vercel

1. Faça login em [vercel.com](https://vercel.com)
2. Clique em "Add New Project"
3. Importe este repositório do GitHub
4. O Vercel detectará automaticamente o `vercel.json`

### 2. Configurar Variáveis de Ambiente

No painel do Vercel, vá em **Settings > Environment Variables** e adicione:

#### Para a API de Auditoria (existente):
```
OPENAI_API_KEY=sk-...
SUPABASE_URL=https://...
SUPABASE_SERVICE_ROLE_KEY=...
```

#### Para a API de Chat (nova):
```
DB_HOST=seu-host-postgresql
DB_PORT=5432
DB_NAME=startprev_chat
DB_USER=seu-usuario
DB_PASSWORD=sua-senha
JWT_SECRET=sua-chave-secreta-aleatoria-muito-longa
BITRIX_WEBHOOK=https://seu-dominio.bitrix24.com.br/rest/1/webhook/
CLAUDE_API_KEY=sk-ant-...
```

**IMPORTANTE:** Todas as variáveis marcadas como obrigatórias devem ser configuradas:
- `JWT_SECRET` é **obrigatório** (use uma string longa e aleatória)
- `BITRIX_WEBHOOK` e `CLAUDE_API_KEY` são opcionais (se não configurados, as funcionalidades relacionadas serão desabilitadas graciosamente)

### 3. Configurar o Banco de Dados

Execute o script SQL em `startprev-backend/schema.sql` no seu PostgreSQL:

```bash
psql -h seu-host -U seu-usuario -d startprev_chat -f startprev-backend/schema.sql
```

### 4. Deploy Automático

Após configurar as variáveis de ambiente, o Vercel fará o deploy automaticamente a cada push no branch principal.

## 🔗 Endpoints Disponíveis

### API de Auditoria (existente)
- `POST /api/startprev` - Processar PDFs do INSS

### API de Chat (nova)
- `POST /api/auth/signup` - Cadastro de usuários
- `POST /api/auth/login` - Login
- `GET /api/user/profile` - Obter perfil (autenticado)
- `PUT /api/user/profile` - Atualizar perfil (autenticado)
- `GET /api/conversations` - Listar conversas (autenticado)
- `POST /api/conversations` - Criar conversa (autenticado)
- `GET /api/messages?conversationId=X` - Obter mensagens (autenticado)
- `POST /api/messages?conversationId=X` - Enviar mensagem (autenticado)
- `GET /health` - Health check

## 🔒 Autenticação

Os endpoints marcados como "autenticado" requerem um header:

```
Authorization: Bearer <token-jwt>
```

O token é obtido nos endpoints de login/signup.

## ⚠️ Limitações Importantes

### WebSockets
O arquivo `startprev-backend/server.js` usa Socket.IO para comunicação em tempo real, mas **WebSockets não funcionam em serverless functions do Vercel**.

**Alternativas:**
1. **Polling**: Fazer requisições periódicas ao endpoint `/api/messages`
2. **Server-Sent Events (SSE)**: Usar Vercel Edge Functions
3. **Serviço Externo**: Hospedar WebSocket em Railway/Render
4. **Pusher/Ably**: Usar serviço de WebSocket gerenciado

### Conexões de Banco de Dados
Serverless functions têm limitações de conexões. Use um pool de conexões com limite baixo ou considere usar Supabase/PlanetScale que são otimizados para serverless.

## 🧪 Testar Localmente

```bash
# Instalar Vercel CLI
npm i -g vercel

# Instalar dependências
npm install
cd startprev-backend && npm install && cd ..

# Criar arquivo .env local com as variáveis
# Rodar em modo dev
vercel dev
```

## 📁 Estrutura de Arquivos

```
.
├── api/
│   └── startprev.js          # API de auditoria INSS
├── startprev-backend/
│   ├── api/                  # Serverless functions (NOVO)
│   │   ├── signup.js
│   │   ├── login.js
│   │   ├── profile.js
│   │   ├── conversations.js
│   │   ├── messages.js
│   │   ├── health.js
│   │   ├── db.js
│   │   ├── auth-middleware.js
│   │   ├── bitrix-integration.js
│   │   └── claude-integration.js
│   ├── package.json
│   ├── schema.sql
│   └── server.js             # Original Express (não usado)
├── index.html
├── package.json
├── vercel.json               # Configuração Vercel (NOVO)
├── .vercelignore             # Arquivos ignorados (NOVO)
└── README.md                 # Documentação técnica (NOVO)
```

## 🛠️ Manutenção

### Adicionar Novo Endpoint
1. Crie um arquivo em `startprev-backend/api/nome-endpoint.js`
2. Adicione a rota em `vercel.json`
3. Faça commit e push - deploy automático

### Atualizar Dependências
1. Edite `startprev-backend/package.json`
2. Teste localmente com `vercel dev`
3. Commit e push

## 📞 Suporte

Para dúvidas ou problemas:
1. Verifique os logs no painel do Vercel
2. Verifique as variáveis de ambiente
3. Teste localmente com `vercel dev`

## ✅ Checklist Pós-Deploy

- [ ] Todas as variáveis de ambiente configuradas
- [ ] Banco de dados criado e schema executado
- [ ] Deploy bem-sucedido no Vercel
- [ ] Endpoint `/health` retorna status OK
- [ ] Teste de cadastro de usuário funcionando
- [ ] Teste de login funcionando
- [ ] Integração com Bitrix24 (se configurado)
- [ ] Integração com Claude (se configurado)
