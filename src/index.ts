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

    // Painel HTML5 Avançado com Sistema de Luz/Sombra Dinâmico, Tela de Carregamento e Persistência Automática via IndexedDB
    const htmlDashboard = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <title>NWS - Node.js Web Services</title>
    <style>
        :root {
            --mouse-x: 50%;
            --mouse-y: 50%;
            --light-intensity: 0.12;
        }
        body { 
            font-family: system-ui, -apple-system, sans-serif; 
            max-width: 680px; 
            margin: 40px auto; 
            padding: 20px; 
            background: #060913; 
            color: #f8fafc; 
            overflow-x: hidden;
            position: relative;
        }

        /* Sistema de Iluminação e Sombra Dinâmica em Tempo Real baseada no Cursor */
        body::before {
            content: '';
            position: fixed;
            top: 0; left: 0; width: 100vw; height: 100vh;
            background: radial-gradient(900px circle at var(--mouse-x) var(--mouse-y), rgba(56, 189, 248, var(--light-intensity)), rgba(2, 6, 23, 0.95) 75%);
            z-index: -2;
            pointer-events: none;
            transition: background 0.1s ease-out;
        }

        /* Grade de Ambiente Profunda */
        body::after {
            content: '';
            position: fixed;
            top: 0; left: 0; width: 100vw; height: 100vh;
            background-image: linear-gradient(rgba(255,255,255,0.015) 1px, transparent 1px),
                              linear-gradient(90deg, rgba(255,255,255,0.015) 1px, transparent 1px);
            background-size: 40px 40px;
            z-index: -1;
            pointer-events: none;
        }

        /* Tela de Carregamento Ultra Realista com Transição Fluida */
        #loadingScreen {
            position: fixed;
            top: 0; left: 0; width: 100vw; height: 100vh;
            background: #020617;
            display: flex;
            flex-direction: column;
            justify-content: center;
            align-items: center;
            z-index: 9999;
            transition: opacity 0.8s cubic-bezier(0.4, 0, 0.2, 1), visibility 0.8s;
        }
        #loadingScreen.fade-out {
            opacity: 0;
            visibility: hidden;
        }
        .loader-logo {
            width: 140px;
            height: 140px;
            animation: floatLogo 3s ease-in-out infinite, pulseGlow 2s ease-in-out infinite alternate;
            filter: drop-shadow(0 25px 35px rgba(14, 165, 233, 0.5));
        }
        .loader-bar-container {
            width: 240px;
            height: 4px;
            background: #1e293b;
            border-radius: 4px;
            margin-top: 30px;
            overflow: hidden;
            position: relative;
            box-shadow: inset 0 1px 2px rgba(0,0,0,0.8);
        }
        .loader-bar {
            position: absolute;
            top: 0; left: 0; height: 100%;
            width: 0%;
            background: linear-gradient(90deg, #38bdf8, #f97316);
            border-radius: 4px;
            animation: loadProgress 1.4s cubic-bezier(0.65, 0, 0.35, 1) forwards;
        }
        .loader-text {
            margin-top: 16px;
            font-size: 13px;
            font-weight: 700;
            color: #94a3b8;
            letter-spacing: 3px;
            text-transform: uppercase;
        }

        @keyframes floatLogo {
            0%, 100% { transform: translateY(0px) rotate(0deg); }
            50% { transform: translateY(-12px) rotate(1.5deg); }
        }
        @keyframes pulseGlow {
            0% { filter: drop-shadow(0 10px 20px rgba(56, 189, 248, 0.3)); }
            100% { filter: drop-shadow(0 30px 45px rgba(249, 115, 22, 0.5)); }
        }
        @keyframes loadProgress {
            0% { width: 0%; }
            40% { width: 65% ; }
            100% { width: 100%; }
        }

        /* Estrutura do Painel com Sombras Dinâmicas baseadas na Luz do Mouse */
        .header-container { text-align: center; margin-bottom: 35px; }
        .logo-icon { 
            width: 110px; height: 110px; margin: 0 auto 14px auto; 
            filter: drop-shadow(0 15px 30px rgba(0,0,0,0.7));
            transition: transform 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
        }
        .logo-icon:hover { transform: scale(1.1) rotate(-3deg); }

        .card { 
            background: linear-gradient(145deg, rgba(30, 41, 59, 0.85), rgba(15, 23, 42, 0.95)); 
            backdrop-filter: blur(12px);
            padding: 26px; 
            border-radius: 18px; 
            box-shadow: 0 15px 35px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.1); 
            margin-bottom: 26px; 
            border: 1px solid rgba(51, 65, 85, 0.8); 
            transition: transform 0.3s ease, border-color 0.3s ease, box-shadow 0.3s ease;
        }
        .card:hover {
            transform: translateY(-4px);
            border-color: #38bdf8;
            box-shadow: 0 25px 50px rgba(0,0,0,0.8), 0 0 25px rgba(56, 189, 248, 0.2);
        }

        input, textarea { 
            width: 100%; padding: 13px; margin: 8px 0 16px 0; 
            background: rgba(9, 13, 22, 0.8); border: 1px solid #334155; color: #fff; 
            border-radius: 9px; box-sizing: border-box; 
            transition: border-color 0.2s, box-shadow 0.2s, background 0.2s;
        }
        input:focus, textarea:focus {
            outline: none;
            border-color: #38bdf8;
            background: rgba(9, 13, 22, 0.95);
            box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.25);
        }
        textarea { height: 105px; font-family: monospace; resize: vertical; }

        button { 
            background: linear-gradient(135deg, #3b82f6, #1d4ed8); 
            color: white; border: none; padding: 12px 24px; border-radius: 9px; 
            cursor: pointer; font-weight: bold; margin-right: 8px; 
            box-shadow: 0 4px 15px rgba(59, 130, 246, 0.4);
            transition: all 0.25s ease; 
        }
        button:hover { 
            background: linear-gradient(135deg, #2563eb, #1e40af); 
            transform: translateY(-2px);
            box-shadow: 0 6px 20px rgba(59, 130, 246, 0.6);
        }
        button:active { transform: translateY(0); }

        .link-box { margin-top: 15px; word-break: break-all; }
        h3 { margin-top: 0; color: #38bdf8; font-size: 1.2rem; }
        .status-badge { display: inline-block; padding: 4px 10px; background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.3); border-radius: 20px; font-size: 12px; font-weight: 600; margin-bottom: 15px; }
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
        <div class="loader-text">Inicializando NWS Engine...</div>
    </div>

    <div class="header-container">
        <!-- Ícone do NWS Integrado no Painel com Sombramento e Luz Realista -->
        <div class="logo-icon">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="100%" height="100%">
              <defs>
                <linearGradient id="appBg" x1="0%" y1="0%" x2="0%" y2="100%">
                  <stop offset="0%" stop-color="#1e293b"/>
                  <stop offset="50%" stop-color="#0f172a"/>
                  <stop offset="100%" stop-color="#020617"/>
                </linearGradient>
                <linearGradient id="mLight" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stop-color="#38bdf8"/>
                  <stop offset="40%" stop-color="#0284c7"/>
                  <stop offset="100%" stop-color="#0369a1"/>
                </linearGradient>
                <linearGradient id="mDark" x1="100%" y1="0%" x2="0%" y2="100%">
                  <stop offset="0%" stop-color="#0f172a"/>
                  <stop offset="100%" stop-color="#020617"/>
                </linearGradient>
                <linearGradient id="snowGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stop-color="#ffffff"/>
                  <stop offset="60%" stop-color="#e2e8f0"/>
                  <stop offset="100%" stop-color="#94a3b8"/>
                </linearGradient>
                <linearGradient id="swift3D" x1="0%" y1="0%" x2="100%" y2="80%">
                  <stop offset="0%" stop-color="#ffb74d"/>
                  <stop offset="25%" stop-color="#f97316"/>
                  <stop offset="70%" stop-color="#ea580c"/>
                  <stop offset="100%" stop-color="#9a3412"/>
                </linearGradient>
                <linearGradient id="gloss" x1="0%" y1="0%" x2="0%" y2="100%">
                  <stop offset="0%" stop-color="#ffffff" stop-opacity="0.65"/>
                  <stop offset="50%" stop-color="#ffffff" stop-opacity="0.1"/>
                  <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
                </linearGradient>
                <filter id="deepShadow" x="-30%" y="-30%" width="160%" height="160%">
                  <feDropShadow dx="0" dy="24" stdDeviation="18" flood-color="#000000" flood-opacity="0.85"/>
                  <feDropShadow dx="0" dy="6" stdDeviation="6" flood-color="#000000" flood-opacity="0.5"/>
                </filter>
                <filter id="ambientLight" x="-50%" y="-50%" width="200%" height="200%">
                  <feGaussianBlur stdDeviation="45" result="blur"/>
                </filter>
              </defs>
              <rect width="512" height="512" rx="115" ry="115" fill="url(#appBg)"/>
              <rect x="3" y="3" width="506" height="506" rx="112" ry="112" fill="none" stroke="#ffffff" stroke-width="2" opacity="0.12"/>
              <circle cx="256" cy="220" r="140" fill="#0ea5e9" opacity="0.15" filter="url(#ambientLight)"/>
              <g filter="url(#deepShadow)">
                <g transform="translate(0, 12)">
                  <polygon points="256,90 130,310 256,310" fill="url(#mLight)"/>
                  <polygon points="256,90 256,310 382,310" fill="url(#mDark)"/>
                  <line x1="256" y1="90" x2="256" y2="310" stroke="#7dd3fc" stroke-width="3" opacity="0.6"/>
                  <path d="M256,90 L200,185 L230,195 L256,165 L282,195 L312,185 Z" fill="url(#snowGrad)"/>
                  <path d="M256,90 L256,165 L282,195 L312,185 Z" fill="#64748b" opacity="0.4"/>
                </g>
                <g transform="translate(256, 175) scale(1.4)">
                  <path d="M 0,-38 C 34,-56 82,-63 118,-52 C 76,-26 38,-10 0,14 C -38,-10 -76,-26 -118,-52 C -82,-63 -34,-56 0,-38 Z" fill="url(#swift3D)"/>
                  <path d="M 0,-38 C 28,-52 68,-58 96,-48 C 62,-26 30,-12 0,6 C -30,-12 -62,-26 -96,-48 C -68,-58 -28,-52 0,-38 Z" fill="url(#gloss)"/>
                  <path d="M 0,-38 C 15,-46 45,-50 65,-44 C 35,-26 15,-15 0,2 C -15,-15 -35,-26 -65,-44 C -45,-50 -15,-46 0,-38 Z" fill="#ffffff" opacity="0.3"/>
                </g>
              </g>
              <g transform="translate(0, 20)">
                <text x="256" y="395" font-family="system-ui, -apple-system, 'SF Pro Display', Roboto, sans-serif" font-size="52" font-weight="900" fill="#ffffff" text-anchor="middle" letter-spacing="8">NWS</text>
                <text x="256" y="425" font-family="system-ui, -apple-system, 'SF Pro Text', Roboto, sans-serif" font-size="13" font-weight="700" fill="#38bdf8" text-anchor="middle" letter-spacing="4">NODE.JS WEB SERVICES</text>
              </g>
            </svg>
        </div>
        <h1>Node.js Web Services (NWS)</h1>
        <div id="loginStatusBadge" class="status-badge" style="display: none;">Sessão Autenticada via IndexedDB</div>
    </div>
    
    <div class="card">
        <h3>1. Credenciais (Conta NWS)</h3>
        <label>Username:</label>
        <input type="text" id="username" placeholder="Seu usuário">
        
        <label>Senha (SHA-512):</label>
        <input type="password" id="password" placeholder="Sua senha">
        
        <button onclick="registrar()">Criar Conta</button>
        <button onclick="fazerLoginSalvar()" style="background: #10b981;">Entrar e Salvar (IndexedDB)</button>
        <button onclick="limparSessaoDB()" style="background: #ef4444;">Esquecer Sessão</button>
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
        // Iluminação Dinâmica em Tempo Real baseada na posição exata do cursor
        window.addEventListener('mousemove', (e) => {
            const x = (e.clientX / window.innerWidth) * 100;
            const y = (e.clientY / window.innerHeight) * 100;
            document.documentElement.style.setProperty('--mouse-x', x + '%');
            document.documentElement.style.setProperty('--mouse-y', y + '%');
        });

        // Configuração e Gerenciamento do IndexedDB para Autenticação Automática
        const dbName = 'NWSSecureStorage';
        const storeName = 'authStore';
        let db;

        function abrirIndexedDB() {
            return new Promise((resolve, reject) => {
                const request = indexedDB.open(dbName, 1);
                request.onerror = () => reject(request.error);
                request.onsuccess = () => {
                    db = request.result;
                    resolve(db);
                };
                request.onupgradeneeded = (event) => {
                    const database = event.target.result;
                    if (!database.objectStoreNames.contains(storeName)) {
                        database.createObjectStore(storeName);
                    }
                };
            });
        }

        async function salvarNoIndexedDB(username, password) {
            await abrirIndexedDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction(storeName, 'readwrite');
                const store = transaction.objectStore(storeName);
                store.put({ username, password }, 'credentials');
                transaction.oncomplete = () => resolve(true);
                transaction.onerror = () => reject(transaction.error);
            });
        }

        async function lerDoIndexedDB() {
            try {
                await abrirIndexedDB();
                return new Promise((resolve, reject) => {
                    const transaction = db.transaction(storeName, 'readonly');
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
                await abrirIndexedDB();
                const transaction = db.transaction(storeName, 'readwrite');
                const store = transaction.objectStore(storeName);
                store.delete('credentials');
                document.getElementById('username').value = '';
                document.getElementById('password').value = '';
                document.getElementById('loginStatusBadge').style.display = 'none';
                document.getElementById('authMsg').innerText = "Sessão removida do IndexedDB.";
            } catch (e) {
                console.error(e);
            }
        }

        // Executar auto-login e controle da tela de carregamento na inicialização
        window.addEventListener('load', async () => {
            try {
                const savedCreds = await lerDoIndexedDB();
                if (savedCreds && savedCreds.username && savedCreds.password) {
                    document.getElementById('username').value = savedCreds.username;
                    document.getElementById('password').value = savedCreds.password;
                    
                    // Validação automática da sessão no backend do NWS
                    const res = await fetch('/api/login', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ username: savedCreds.username, password: savedCreds.password })
                    });
                    
                    if (res.ok) {
                        document.getElementById('loginStatusBadge').style.display = 'inline-block';
                        document.getElementById('authMsg').innerText = "Login automático realizado com sucesso via IndexedDB!";
                    }
                }
            } catch (e) {
                console.error("Erro no auto-login:", e);
            }

            // Ocultar Tela de Carregamento suavemente
            setTimeout(() => {
                const loader = document.getElementById('loadingScreen');
                loader.classList.add('fade-out');
                setTimeout(() => loader.remove(), 800);
            }, 1200);
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
                document.getElementById('loginStatusBadge').style.display = 'inline-block';
                document.getElementById('authMsg').innerText = "Login bem-sucedido e credenciais salvas no IndexedDB com sucesso!";
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
