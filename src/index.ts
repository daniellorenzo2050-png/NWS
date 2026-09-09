export interface Env {
  NWSD1: D1Database;
  NWSKV: KVNamespace;
}

// Função para gerar hash SHA-512 nativo no Cloudflare Workers
async function hashPassword(password: string): Promise<string> {
  const msgBuffer = new TextEncoder().encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-512', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Inicialização das tabelas no NWSD1 (users, sites, nwsuserdatabases)
    await env.NWSD1.prepare(`
      CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY, 
        password_hash TEXT
      )
    `).run();

    await env.NWSD1.prepare(`
      CREATE TABLE IF NOT EXISTS sites (
        uuid TEXT PRIMARY KEY, 
        username TEXT, 
        nome TEXT
      )
    `).run();

    await env.NWSD1.prepare(`
      CREATE TABLE IF NOT EXISTS nwsuserdatabases (
        db_id TEXT PRIMARY KEY,
        username TEXT,
        db_name TEXT,
        schema_definition TEXT
      )
    `).run();

    // Rota API: Registrar Usuário
    if (path === '/api/register' && request.method === 'POST') {
      try {
        const { username, password } = await request.json() as any;
        if (!username || !password) {
          return Response.json({ erro: 'Usuário e senha são obrigatórios.' }, { status: 400 });
        }
        const password_hash = await hashPassword(password);
        
        await env.NWSD1.prepare(
          `INSERT INTO users (username, password_hash) VALUES (?, ?)`
        ).bind(username, password_hash).run();

        return Response.json({ sucesso: true, mensagem: 'Conta criada com sucesso!' });
      } catch (e: any) {
        return Response.json({ erro: 'Usuário já existe ou erro interno.' }, { status: 400 });
      }
    }

    // Rota API: Login
    if (path === '/api/login' && request.method === 'POST') {
      const { username, password } = await request.json() as any;
      const password_hash = await hashPassword(password);

      const user = await env.NWSD1.prepare(
        `SELECT * FROM users WHERE username = ? AND password_hash = ?`
      ).bind(username, password_hash).first();

      if (!user) {
        return Response.json({ erro: 'Credenciais inválidas.' }, { status: 401 });
      }

      return Response.json({ sucesso: true, mensagem: 'Login bem-sucedido!' });
    }

    // Rota API: Fazer Deploy de Site (HTML armazenado no NWSKV)
    if (path === '/api/deploy' && request.method === 'POST') {
      const { username, password, nome, html } = await request.json() as any;
      if (!username || !password || !nome || !html) {
        return Response.json({ erro: 'Dados incompletos para deploy.' }, { status: 400 });
      }

      const password_hash = await hashPassword(password);
      const user = await env.NWSD1.prepare(
        `SELECT * FROM users WHERE username = ? AND password_hash = ?`
      ).bind(username, password_hash).first();

      if (!user) {
        return Response.json({ erro: 'Autenticação falhou.' }, { status: 401 });
      }

      const siteUuid = crypto.randomUUID();

      // Salva o HTML bruto no NWSKV
      await env.NWSKV.put(`site:${siteUuid}`, html);

      // Registra os metadados na tabela sites do NWSD1
      await env.NWSD1.prepare(
        `INSERT INTO sites (uuid, username, nome) VALUES (?, ?, ?)`
      ).bind(siteUuid, username, nome).run();

      return Response.json({
        sucesso: true,
        uuid: siteUuid,
        url: `https://nws.rattew.workers.dev/${siteUuid}`
      });
    }

    // Rota API: Criar banco de dados personalizado na tabela nwsuserdatabases
    if (path === '/api/createdb' && request.method === 'POST') {
      const { username, password, db_name, schema_definition } = await request.json() as any;
      if (!username || !password || !db_name) {
        return Response.json({ erro: 'Dados incompletos para criar o banco de dados.' }, { status: 400 });
      }

      const password_hash = await hashPassword(password);
      const user = await env.NWSD1.prepare(
        `SELECT * FROM users WHERE username = ? AND password_hash = ?`
      ).bind(username, password_hash).first();

      if (!user) {
        return Response.json({ erro: 'Autenticação falhou.' }, { status: 401 });
      }

      const dbId = crypto.randomUUID();

      await env.NWSD1.prepare(
        `INSERT INTO nwsuserdatabases (db_id, username, db_name, schema_definition) VALUES (?, ?, ?, ?)`
      ).bind(dbId, username, db_name, schema_definition || '').run();

      return Response.json({
        sucesso: true,
        db_id: dbId,
        mensagem: 'Banco de dados registrado na tabela nwsuserdatabases com sucesso!'
      });
    }

    // Rota dinâmica para servir os sites hospedados via UUID (lendo do NWSKV)
    if (path.length > 1 && !path.startsWith('/api/')) {
      const siteUuid = path.slice(1);
      const siteInfo = await env.NWSD1.prepare(
        `SELECT * FROM sites WHERE uuid = ?`
      ).bind(siteUuid).first();

      if (!siteInfo) {
        return new Response('<h1>404 - Site não encontrado no NWS</h1>', {
          status: 404,
          headers: { 'Content-Type': 'text/html;charset=UTF-8' }
        });
      }

      const htmlContent = await env.NWSKV.get(`site:${siteUuid}`);
      if (!htmlContent) {
        return new Response('<h1>404 - Conteúdo do site não localizado no NWSKV</h1>', {
          status: 404,
          headers: { 'Content-Type': 'text/html;charset=UTF-8' }
        });
      }

      return new Response(htmlContent, {
        headers: { 'Content-Type': 'text/html;charset=UTF-8' }
      });
    }

    // Painel HTML5 Embutido
    const htmlDashboard = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <title>NWS - Node.js Web Services</title>
    <style>
        body { font-family: system-ui, sans-serif; max-width: 650px; margin: 40px auto; padding: 20px; background: #0f172a; color: #f8fafc; }
        .card { background: #1e293b; padding: 20px; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.3); margin-bottom: 20px; }
        input, textarea { width: 100%; padding: 10px; margin: 8px 0 16px 0; background: #0f172a; border: 1px solid #334155; color: #fff; border-radius: 4px; box-sizing: border-box; }
        textarea { height: 100px; font-family: monospace; }
        button { background: #3b82f6; color: white; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; font-weight: bold; margin-right: 5px; }
        button:hover { background: #2563eb; }
        .link-box { margin-top: 15px; word-break: break-all; }
    </style>
</head>
<body>
    <h1>Node.js Web Services (NWS)</h1>
    
    <div class="card">
        <h3>1. Credenciais (Conta NWS)</h3>
        <label>Username:</label>
        <input type="text" id="username" placeholder="Seu usuário">
        
        <label>Senha (SHA-512):</label>
        <input type="password" id="password" placeholder="Sua senha">
        
        <button onclick="registrar()">Criar Conta</button>
        <button onclick="salvarSessao()" style="background: #10b981;">Salvar Credenciais</button>
        <p id="authMsg"></p>
    </div>

    <div class="card">
        <h3>2. Deploy de Site Estático (NWSKV)</h3>
        <label>Nome do Site:</label>
        <input type="text" id="siteName" placeholder="Meu Portfólio">
        
        <label>Código HTML Bruto:</label>
        <textarea id="siteHtml" placeholder="<h1>Olá do NWS!</h1>"></textarea>
        
        <button onclick="fazerDeploy()">OK (Deploy Automático)</button>
        <div class="link-box" id="resultadoDeploy"></div>
    </div>

    <div class="card">
        <h3>3. Criar Banco de Dados (nwsuserdatabases no NWSD1)</h3>
        <label>Nome do Banco:</label>
        <input type="text" id="dbName" placeholder="meu_banco_custom">
        
        <label>Definição do Schema (SQL):</label>
        <textarea id="dbSchema" placeholder="CREATE TABLE produtos (id INT, nome TEXT);"></textarea>
        
        <button onclick="criarBanco()">Criar Banco no NWSD1</button>
        <p id="dbMsg"></p>
    </div>

    <script>
        function salvarSessao() {
            localStorage.setItem('nws_user', document.getElementById('username').value);
            localStorage.setItem('nws_pass', document.getElementById('password').value);
            document.getElementById('authMsg').innerText = "Credenciais salvas localmente!";
        }

        async function registrar() {
            const username = document.getElementById('username').value;
            const password = document.getElementById('password').value;
            const res = await fetch('/api/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            const data = await res.json();
            document.getElementById('authMsg').innerText = data.sucesso || data.erro;
        }

        async function fazerDeploy() {
            const username = document.getElementById('username').value || localStorage.getItem('nws_user');
            const password = document.getElementById('password').value || localStorage.getItem('nws_pass');
            const nome = document.getElementById('siteName').value;
            const html = document.getElementById('siteHtml').value;
            const resBox = document.getElementById('resultadoDeploy');

            resBox.innerText = "Fazendo deploy no NWSD1 e NWSKV...";

            const res = await fetch('/api/deploy', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password, nome, html })
            });
            const data = await res.json();
            if (res.ok) {
                resBox.innerHTML = \`Deploy concluído! Acesse: <a href="\${data.url}" target="_blank" style="color: #60a5fa;">\${data.url}</a>\`;
            } else {
                resBox.innerText = \`Erro: \${data.erro}\`;
            }
        }

        async function criarBanco() {
            const username = document.getElementById('username').value || localStorage.getItem('nws_user');
            const password = document.getElementById('password').value || localStorage.getItem('nws_pass');
            const db_name = document.getElementById('dbName').value;
            const schema_definition = document.getElementById('dbSchema').value;
            const msgBox = document.getElementById('dbMsg');

            const res = await fetch('/api/createdb', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password, db_name, schema_definition })
            });
            const data = await res.json();
            msgBox.innerText = data.sucesso ? data.mensagem : data.erro;
        }
    </script>
</body>
</html>`;

    return new Response(htmlDashboard, {
      headers: { 'Content-Type': 'text/html;charset=UTF-8' }
    });
  },
};
