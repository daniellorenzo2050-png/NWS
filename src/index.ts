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
        `SELECT * VALUES users WHERE username = ? AND password_hash = ?`
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

    // Painel HTML5 Embutido com o Novo Estilo Enterprise (AWS)
    const htmlDashboard = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <title>Console de Gerenciamento - NWS (Node.js Web Services)</title>
    <style>
        /* Estilo Enterprise Inspirado na AWS */
        :root {
            --bg-app: #0e131f;       /* Fundo Principal (Cinza Muito Escuro) */
            --bg-nav: #172a32;       /* Barra Lateral (Grafite) */
            --bg-card: #1e293b;      /* Cartões de Serviço (Cinza Médio) */
            --text-main: #f8fafc;    /* Texto Principal (Branco Suave) */
            --text-muted: #94a3b8;   /* Texto Secundário (Cinza Azulado) */
            --accent-blue: #38bdf8;  /* Azul Acentuado (Links, Status) */
            --accent-orange: #f97316;/* Laranja Acentuado (Deploy, CTAs) */
            --border-color: #334155; /* Bordas */
            --mouse-x: 50%;
            --mouse-y: 50%;
        }
        body { 
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            margin: 0; padding: 0; 
            background: var(--bg-app); 
            color: var(--text-main); 
            overflow-x: hidden;
            position: relative;
            min-height: 100vh;
            display: flex;
        }
        /* Efeito de Luz Sutil Dinâmico (Estilo AWS Console) */
        body::before {
            content: '';
            position: fixed;
            top: 0; left: 0; width: 100vw; height: 100vh;
            background: radial-gradient(1000px circle at var(--mouse-x) var(--mouse-y), rgba(56, 189, 248, 0.05), transparent 60%);
            z-index: -2; pointer-events: none;
        }

        /* Tela de Carregamento Imersiva */
        #loadingScreen {
            position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
            background: var(--bg-app);
            display: flex; flex-direction: column; justify-content: center; align-items: center;
            z-index: 10000; transition: opacity 0.8s ease, visibility 0.8s;
        }
        #loadingScreen.fade-out { opacity: 0; visibility: hidden; }
        .loader-logo {
            width: 110px; height: 110px;
            animation: floatLogo 3s ease-in-out infinite, pulseGlow 2s ease-in-out infinite alternate;
            filter: drop-shadow(0 20px 30px rgba(14, 165, 233, 0.3));
        }
        .loader-bar-container {
            width: 200px; height: 3px; background: var(--bg-nav); border-radius: 2px; margin-top: 25px; overflow: hidden;
        }
        .loader-bar {
            height: 100%; background: linear-gradient(90deg, var(--accent-blue), var(--accent-orange));
            animation: loadProgress 1.4s cubic-bezier(0.65, 0, 0.35, 1) forwards;
        }
        @keyframes floatLogo {
            0%, 100% { transform: translateY(0px) rotate(0deg); }
            50% { transform: translateY(-8px) rotate(0.5deg); }
        }
        @keyframes pulseGlow {
            0% { filter: drop-shadow(0 10px 15px rgba(56, 189, 248, 0.1)); }
            100% { filter: drop-shadow(0 20px 25px rgba(249, 115, 22, 0.3)); }
        }
        @keyframes loadProgress { 0% { width: 0%; } 100% { width: 100%; } }

        /* Barra Lateral Esquerda (Estilo AWS) */
        .sidebar {
            width: 260px; background: var(--bg-nav); 
            display: flex; flex-direction: column; 
            border-right: 1px solid var(--border-color);
            padding-top: 20px; flex-shrink: 0;
        }
        .sidebar-header { padding: 0 20px 20px 20px; display: flex; align-items: center; border-bottom: 1px solid var(--border-color); }
        .logo-icon-sidebar { width: 36px; height: 36px; margin-right: 10px; filter: drop-shadow(0 2px 5px rgba(0,0,0,0.3)); }
        .sidebar-title { font-size: 1.1rem; font-weight: 700; color: var(--accent-blue); }
        .sidebar-nav-section { padding: 20px; }
        .nav-section-title { font-size: 0.75rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 15px; }
        .nav-link {
            color: var(--text-main); text-decoration: none; font-size: 0.9rem; 
            display: block; padding: 8px 0; transition: color 0.2s;
        }
        .nav-link:hover { color: var(--accent-blue); }

        /* Área Principal de Conteúdo */
        .main-content { flex-grow: 1; display: flex; flex-direction: column; overflow-y: auto; }
        .top-bar {
            background: var(--bg-app); border-bottom: 1px solid var(--border-color);
            padding: 15px 30px; display: flex; justify-content: space-between; align-items: center;
            position: sticky; top: 0; z-index: 100;
        }
        .breadcrumb { font-size: 0.85rem; color: var(--text-muted); }
        .user-menu { font-size: 0.85rem; color: var(--text-muted); display: flex; align-items: center; gap: 15px; }
        .status-dot { display: inline-block; width: 8px; height: 8px; background: var(--accent-blue); border-radius: 50%; margin-right: 6px; }
        
        .content-wrapper { padding: 30px; }
        .page-header { margin-bottom: 30px; border-bottom: 1px solid var(--border-color); padding-bottom: 15px; }
        .page-title { font-size: 1.5rem; font-weight: 700; margin: 0; }
        .page-subtitle { font-size: 1rem; color: var(--text-muted); margin-top: 5px; }

        /* Grid de Widgets (Substituindo Cartões Simples) */
        .widget-grid {
            display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 20px;
        }
        .widget {
            background: var(--bg-card); padding: 20px; border-radius: 8px;
            border: 1px solid var(--border-color);
        }
        .widget-title { font-size: 0.9rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 10px; }
        .widget-value { font-size: 1.8rem; font-weight: 600; color: var(--accent-blue); }
        .widget-action-list { list-style: none; padding: 0; margin: 0; }
        .widget-action-item { margin-top: 10px; }
        .widget-action-link { color: var(--accent-blue); text-decoration: none; font-size: 0.9rem; }
        .widget-action-link:hover { text-decoration: underline; }

        /* Formulários Estilizados */
        .form-group { margin-bottom: 15px; }
        .form-label { display: block; font-size: 0.9rem; color: var(--text-muted); margin-bottom: 5px; }
        
        input, textarea { 
            width: 100%; padding: 12px; margin: 8px 0; 
            background: rgba(9, 13, 22, 0.8); border: 1px solid var(--border-color); color: #fff; 
            border-radius: 6px; box-sizing: border-box; 
            transition: border-color 0.2s;
        }
        input:focus, textarea:focus { outline: none; border-color: var(--accent-blue); }
        textarea { height: 100px; font-family: monospace; resize: vertical; }

        button { 
            background: linear-gradient(135deg, #3b82f6, #1d4ed8); 
            color: white; border: none; padding: 10px 20px; border-radius: 6px; 
            cursor: pointer; font-weight: bold; margin-right: 8px; 
            box-shadow: 0 4px 12px rgba(59, 130, 246, 0.3);
            transition: all 0.2s ease; 
        }
        button:hover { 
            background: linear-gradient(135deg, #2563eb, #1e40af); 
            transform: translateY(-1px);
        }

        /* Notificações e Mensagens */
        #authMsg, #dbMsg { font-size: 0.9rem; margin-top: 10px; color: var(--accent-orange); }
        #resultadoDeploy { font-size: 0.9rem; margin-top: 10px; color: var(--accent-blue); }
        .status-badge { display: inline-block; padding: 4px 10px; background: rgba(56, 189, 248, 0.1); color: var(--accent-blue); border: 1px solid rgba(56, 189, 248, 0.3); border-radius: 20px; font-size: 12px; font-weight: 600; margin-bottom: 15px; }
    </style>
</head>
<body>
    <!-- Tela de Carregamento Imersiva -->
    <div id="loadingScreen">
        <div class="loader-logo">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="100%" height="100%">
              <defs>
                <linearGradient id="lBg" x1="0%" y1="0%" x2="0%" y2="100%">
                  <stop offset="0%" stop-color="#1e293b"/><stop offset="100%" stop-color="#020617"/>
                </linearGradient>
                <linearGradient id="lL" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stop-color="#38bdf8"/><stop offset="100%" stop-color="#0369a1"/>
                </linearGradient>
                <linearGradient id="lD" x1="100%" y1="0%" x2="0%" y2="100%">
                  <stop offset="0%" stop-color="#0f172a"/><stop offset="100%" stop-color="#020617"/>
                </linearGradient>
                <linearGradient id="lS" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stop-color="#ffffff"/><stop offset="100%" stop-color="#94a3b8"/>
                </linearGradient>
                <linearGradient id="lSw" x1="0%" y1="0%" x2="100%" y2="80%">
                  <stop offset="0%" stop-color="#ffb74d"/><stop offset="100%" stop-color="#ea580c"/>
                </linearGradient>
              </defs>
              <rect width="512" height="512" rx="115" fill="url(#lBg)"/>
              <polygon points="256,90 130,310 256,310" fill="url(#lL)"/>
              <polygon points="256,90 256,310 382,310" fill="url(#lD)"/>
              <path d="M256,90 L200,185 L256,165 L312,185 Z" fill="url(#lS)"/>
              <path d="M 0,-38 C 34,-56 82,-63 118,-52 C 76,-26 38,-10 0,14 C -38,-10 -76,-26 -118,-52 C -82,-63 -34,-56 0,-38 Z" fill="url(#lSw)" transform="translate(256, 175) scale(1.4)"/>
            </svg>
        </div>
        <div class="loader-bar-container"><div class="loader-bar"></div></div>
        <div class="loader-text">Inicializando Console NWS...</div>
    </div>

    <!-- Barra Lateral (Estilo AWS) -->
    <nav class="sidebar">
        <div class="sidebar-header">
            <div class="logo-icon-sidebar">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="100%" height="100%">
                  <defs>
                    <linearGradient id="sBg" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stop-color="#1e293b"/><stop offset="100%" stop-color="#020617"/></linearGradient>
                    <linearGradient id="sL" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#38bdf8"/><stop offset="100%" stop-color="#0369a1"/></linearGradient>
                    <linearGradient id="sD" x1="100%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stop-color="#0f172a"/><stop offset="100%" stop-color="#020617"/></linearGradient>
                    <linearGradient id="sSw" x1="0%" y1="0%" x2="100%" y2="80%"><stop offset="0%" stop-color="#ffb74d"/><stop offset="100%" stop-color="#ea580c"/></linearGradient>
                  </defs>
                  <rect width="512" height="512" rx="115" fill="url(#sBg)"/>
                  <polygon points="256,90 130,310 256,310" fill="url(#sL)"/><polygon points="256,90 256,310 382,310" fill="url(#sD)"/>
                  <path d="M 0,-38 C 34,-56 82,-63 118,-52 C 76,-26 38,-10 0,14 C -38,-10 -76,-26 -118,-52 C -82,-63 -34,-56 0,-38 Z" fill="url(#sSw)" transform="translate(256, 175) scale(1.4)"/>
                </svg>
            </div>
            <span class="sidebar-title">NWS Console</span>
        </div>
        <div class="sidebar-nav-section">
            <div class="nav-section-title">Serviços</div>
            <a href="#" class="nav-link">Dashboard</a>
            <a href="#" class="nav-link">Computação (Sites KV)</a>
            <a href="#" class="nav-link">Armazenamento (NWSKV)</a>
            <a href="#" class="nav-link">Banco de Dados (D1)</a>
        </div>
        <div class="sidebar-nav-section">
            <div class="nav-section-title">Rede</div>
            <a href="#" class="nav-link">Rotas Dinâmicas</a>
            <a href="#" class="nav-link">CDN NWS</a>
        </div>
    </nav>

    <!-- Área Principal -->
    <main class="main-content">
        <header class="top-bar">
            <div class="breadcrumb">NWS Console > Dashboard</div>
            <div class="user-menu">
                <span class="status-badge" id="autoLoginBadge" style="display: none;">Autenticado (IndexedDB)</span>
                <span><span class="status-dot"></span>NWS_Global</span>
                <span>Conta RATTEW</span>
            </div>
        </header>

        <div class="content-wrapper">
            <div class="page-header">
                <h1 class="page-title">Dashboard de Serviços</h1>
                <p class="page-subtitle">Visão geral e acesso rápido aos recursos do Node.js Web Services</p>
            </div>

            <div class="widget-grid">
                <!-- Widget de Conta -->
                <div class="widget">
                    <div class="widget-title">Sessão e Segurança</div>
                    <div class="form-group">
                        <label class="form-label">Username:</label>
                        <input type="text" id="username" placeholder="Seu usuário NWS">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Senha (SHA-512):</label>
                        <input type="password" id="password" placeholder="Sua senha">
                    </div>
                    <button onclick="registrar()">Criar Conta</button>
                    <button onclick="fazerLoginSalvar()" style="background: linear-gradient(135deg, #10b981, #059669); box-shadow: 0 4px 12px rgba(16, 185, 129, 0.3);">Entrar e Salvar DB</button>
                    <button onclick="limparSessaoDB()" style="background: linear-gradient(135deg, #ef4444, #dc2626); box-shadow: 0 4px 12px rgba(239, 68, 68, 0.3);">Limpar DB</button>
                    <p id="authMsg"></p>
                </div>

                <!-- Widget de Computação -->
                <div class="widget">
                    <div class="widget-title">Deploy de Sites (Computação)</div>
                    <div class="form-group">
                        <label class="form-label">Nome do Projeto:</label>
                        <input type="text" id="siteName" placeholder="Ex: Meu Portfolio">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Código HTML Bruto:</label>
                        <textarea id="siteHtml" placeholder="<h1>Olá do NWS Enterprise!</h1>"></textarea>
                    </div>
                    <button onclick="fazerDeploy()">OK (Deploy Instantâneo)</button>
                    <div class="link-box" id="resultadoDeploy"></div>
                </div>

                <!-- Widget de Banco de Dados -->
                <div class="widget">
                    <div class="widget-title">Banco de Dados (nwsuserdatabases)</div>
                    <div class="form-group">
                        <label class="form-label">Nome do Banco:</label>
                        <input type="text" id="dbName" placeholder="Ex: meu_banco_dados">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Schema (SQL):</label>
                        <textarea id="dbSchema" placeholder="CREATE TABLE produtos (id INT, nome TEXT);"></textarea>
                    </div>
                    <button onclick="criarBanco()">Criar Banco no D1</button>
                    <p id="dbMsg"></p>
                </div>
            </div>
        </div>
    </main>

    <script>
        // Efeito de Iluminação Dinâmica (Estilo AWS Console)
        window.addEventListener('mousemove', (e) => {
            const x = (e.clientX / window.innerWidth) * 100;
            const y = (e.clientY / window.innerHeight) * 100;
            document.documentElement.style.setProperty('--mouse-x', x + '%');
            document.documentElement.style.setProperty('--mouse-y', y + '%');
        });

        // Gerenciamento do IndexedDB para Autenticação Persistente
        const indexedDBName = 'NWSSecureStorage';
        const storeName = 'authStore';
        let secureDB;

        async function initIndexedDB() {
            return new Promise((resolve, reject) => {
                const request = indexedDB.open(indexedDBName, 1);
                request.onerror = () => reject(request.error);
                request.onsuccess = () => {
                    secureDB = request.result;
                    resolve(secureDB);
                };
                request.onupgradeneeded = (event) => {
                    const db = event.target.result;
                    if (!db.objectStoreNames.contains(storeName)) {
                        db.createObjectStore(storeName);
                    }
                };
            });
        }

        async function salvarNoIndexedDB(username, password) {
            await initIndexedDB();
            return new Promise((resolve, reject) => {
                const transaction = secureDB.transaction(storeName, 'readwrite');
                const store = transaction.objectStore(storeName);
                store.put({ username, password }, 'credentials');
                transaction.oncomplete = () => resolve(true);
                transaction.onerror = () => reject(transaction.error);
            });
        }

        async function lerDoIndexedDB() {
            try {
                await initIndexedDB();
                return new Promise((resolve, reject) => {
                    const transaction = secureDB.transaction(storeName, 'readonly');
                    const store = transaction.objectStore(storeName);
                    const request = store.get('credentials');
                    request.onsuccess = () => resolve(request.result);
                    request.onerror = () => reject(request.error);
                });
            } catch (e) {
                return null;
            }
        }

        async function limparSessaoDB() {
            try {
                await initIndexedDB();
                const transaction = secureDB.transaction(storeName, 'readwrite');
                const store = transaction.objectStore(storeName);
                store.delete('credentials');
                document.getElementById('username').value = '';
                document.getElementById('password').value = '';
                document.getElementById('autoLoginBadge').style.display = 'none';
                document.getElementById('authMsg').innerText = "Sessão removida do IndexedDB.";
            } catch (e) {
                console.error(e);
            }
        }

        // Executar auto-login e controle da tela de carregamento na inicialização
        window.addEventListener('load', async () => {
            // Suavizar saída da tela de carregamento
            setTimeout(() => {
                const loader = document.getElementById('loadingScreen');
                loader.classList.add('fade-out');
                setTimeout(() => loader.remove(), 800);
            }, 1000);

            try {
                const savedCreds = await lerDoIndexedDB();
                if (savedCreds && savedCreds.username && savedCreds.password) {
                    document.getElementById('username').value = savedCreds.username;
                    document.getElementById('password').value = savedCreds.password;
                    
                    // Validação automática da sessão no backend
                    const res = await fetch('/api/login', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ username: savedCreds.username, password: savedCreds.password })
                    });
                    
                    if (res.ok) {
                        document.getElementById('autoLoginBadge').style.display = 'inline-block';
                        document.getElementById('authMsg').innerText = "Login automático realizado com sucesso via IndexedDB!";
                    }
                }
            } catch (e) {
                console.error("Erro no auto-login:", e);
            }
        });

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

        async function fazerLoginSalvar() {
            const username = document.getElementById('username').value;
            const password = document.getElementById('password').value;
            
            const res = await fetch('/api/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            const data = await res.json();
            
            if (res.ok) {
                await salvarNoIndexedDB(username, password);
                document.getElementById('autoLoginBadge').style.display = 'inline-block';
                document.getElementById('authMsg').innerText = "Login bem-sucedido e credenciais salvas no IndexedDB!";
            } else {
                document.getElementById('authMsg').innerText = data.erro;
            }
        }

        async function fazerDeploy() {
            const savedCreds = await lerDoIndexedDB();
            const username = document.getElementById('username').value || (savedCreds ? savedCreds.username : '');
            const password = document.getElementById('password').value || (savedCreds ? savedCreds.password : '');
            const nome = document.getElementById('siteName').value;
            const html = document.getElementById('siteHtml').value;
            const resBox = document.getElementById('resultadoDeploy');

            resBox.innerText = "Fazendo deploy no NWSD1 e NWSKV Enterprise...";

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
            const savedCreds = await lerDoIndexedDB();
            const username = document.getElementById('username').value || (savedCreds ? savedCreds.username : '');
            const password = document.getElementById('password').value || (savedCreds ? savedCreds.password : '');
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
