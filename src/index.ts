import { DurableObject } from "cloudflare:workers";

// --- Interfaces e Tipos ---

export interface Env {
  NWSD1: D1Database;
  NWSKV: KVNamespace;
  LOG_HUB: DurableObjectNamespace<LogHub>;
}

// Estrutura de uma mensagem de log HTTP
interface LogMessage {
  type: 'log';
  timestamp: string;
  method: string;
  url: string;
  status: number;
  ip: string;
  userAgent: string;
}

// --- Funções Utilitárias ---

// Função para gerar hash SHA-512 nativo
async function hashPassword(password: string): Promise<string> {
  const msgBuffer = new TextEncoder().encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-512', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// Helper para validar autenticação nas APIs
async function validarAuth(request: Request, env: Env): Promise<boolean> {
  try {
    const body = await request.clone().json() as any;
    if (!body || !body.username || !body.password) return false;

    const password_hash = await hashPassword(body.password);
    const user = await env.NWSD1.prepare(
      `SELECT * FROM users WHERE username = ? AND password_hash = ?`
    ).bind(body.username, password_hash).first();

    return !!user;
  } catch (e) {
    return false;
  }
}

// --- Durable Object: LogHub ---

export class LogHub extends DurableObject {
  private sessions: Set<WebSocket>;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.sessions = new Set();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/publish") {
      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }
      const logData = await request.json();
      this.broadcastLog(logData);
      return new Response("OK");
    }

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected Upgrade: websocket", { status: 426 });
      }

      const [client, server] = Object.values(new WebSocketPair());
      await this.handleSession(server);

      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response("Not found", { status: 404 });
  }

  private async handleSession(ws: WebSocket) {
    ws.accept();
    this.sessions.add(ws);

    const closeHandler = () => {
      this.sessions.delete(ws);
    };
    ws.addEventListener("close", closeHandler);
    ws.addEventListener("error", closeHandler);
  }

  private broadcastLog(logData: any) {
    const message = JSON.stringify({ type: 'log', data: logData });
    for (const ws of this.sessions) {
      try {
        ws.send(message);
      } catch (e) {
        this.sessions.delete(ws);
      }
    }
  }
}

// --- Worker Principal ---

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Inicialização das tabelas no NWSD1
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

    // --- Rotas de API ---

    if (path === '/api/logs-ws') {
      const id = env.LOG_HUB.idFromName("global_log_hub");
      const stub = env.LOG_HUB.get(id);
      return stub.fetch(new Request("https://loghub.nws/ws", {
        headers: request.headers
      }));
    }

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

    if (path === '/api/login' && request.method === 'POST') {
      if (await validarAuth(request, env)) {
        return Response.json({ sucesso: true, mensagem: 'Login bem-sucedido!' });
      } else {
        return Response.json({ erro: 'Credenciais inválidas.' }, { status: 401 });
      }
    }

    if (path === '/api/get-sites' && request.method === 'POST') {
      try {
        const body = await request.clone().json() as any;
        if (!await validarAuth(request, env)) {
          return Response.json({ erro: 'Não autorizado.' }, { status: 401 });
        }
        const sites = await env.NWSD1.prepare(
          `SELECT * FROM sites WHERE username = ?`
        ).bind(body.username).all();

        return Response.json({ sucesso: true, sites: sites.results });
      } catch (e: any) {
        return Response.json({ erro: 'Falha ao processar requisição de sites.' }, { status: 500 });
      }
    }

    if (path === '/api/deploy' && request.method === 'POST') {
      const body = await request.clone().json() as any;
      if (!body.username || !body.password || !body.nome || !body.html) {
        return Response.json({ erro: 'Dados incompletos para deploy.' }, { status: 400 });
      }

      if (!await validarAuth(request, env)) {
        return Response.json({ erro: 'Autenticação falhou.' }, { status: 401 });
      }

      const siteUuid = crypto.randomUUID();

      await env.NWSKV.put(`site:${siteUuid}`, body.html);

      await env.NWSD1.prepare(
        `INSERT INTO sites (uuid, username, nome) VALUES (?, ?, ?)`
      ).bind(siteUuid, body.username, body.nome).run();

      return Response.json({
        sucesso: true,
        uuid: siteUuid,
        url: `${url.origin}/${siteUuid}`
      });
    }

    if (path === '/api/edit-site' && request.method === 'POST') {
      const body = await request.clone().json() as any;
      if (!body.uuid || !body.html) {
        return Response.json({ erro: 'UUID e HTML são obrigatórios.' }, { status: 400 });
      }

      if (!await validarAuth(request, env)) {
        return Response.json({ erro: 'Autenticação falhou.' }, { status: 401 });
      }

      await env.NWSKV.put(`site:${body.uuid}`, body.html);

      return Response.json({ sucesso: true, mensagem: 'HTML do site atualizado com sucesso!' });
    }

    if (path === '/api/delete-site' && request.method === 'POST') {
      const body = await request.clone().json() as any;
      if (!body.uuid) {
        return Response.json({ erro: 'UUID é obrigatório.' }, { status: 400 });
      }

      if (!await validarAuth(request, env)) {
        return Response.json({ erro: 'Autenticação falhou.' }, { status: 401 });
      }

      await env.NWSKV.delete(`site:${body.uuid}`);
      await env.NWSD1.prepare(`DELETE FROM sites WHERE uuid = ?`).bind(body.uuid).run();

      return Response.json({ sucesso: true, mensagem: 'Site removido com sucesso de verdade.' });
    }

    if (path === '/api/createdb' && request.method === 'POST') {
      const body = await request.clone().json() as any;
      if (!body.username || !body.password || !body.db_name) {
        return Response.json({ erro: 'Dados incompletos para criar o banco de dados.' }, { status: 400 });
      }

      if (!await validarAuth(request, env)) {
        return Response.json({ erro: 'Autenticação falhou.' }, { status: 401 });
      }

      const dbId = crypto.randomUUID();

      await env.NWSD1.prepare(
        `INSERT INTO nwsuserdatabases (db_id, username, db_name, schema_definition) VALUES (?, ?, ?, ?)`
      ).bind(dbId, body.username, body.db_name, body.schema_definition || '').run();

      return Response.json({
        sucesso: true,
        db_id: dbId,
        mensagem: 'Banco de dados registrado na tabela nwsuserdatabases com sucesso!'
      });
    }

    // --- Tratamento de Solicitações de Sites Hospedados ---

    if (path.length > 1 && !path.startsWith('/api/')) {
      const siteUuid = path.slice(1);

      const logData: LogMessage = {
        type: 'log',
        timestamp: new Date().toISOString(),
        method: request.method,
        url: request.url,
        status: 0,
        ip: request.headers.get("cf-connecting-ip") || "Unknown",
        userAgent: request.headers.get("user-agent") || "Unknown"
      };

      const siteInfo = await env.NWSD1.prepare(
        `SELECT * FROM sites WHERE uuid = ?`
      ).bind(siteUuid).first();

      let finalResponse: Response;

      if (!siteInfo) {
        finalResponse = new Response('<h1>404 - Site não encontrado no NWS Enterprise</h1>', {
          status: 404,
          headers: { 'Content-Type': 'text/html;charset=UTF-8' }
        });
      } else {
        const htmlContent = await env.NWSKV.get(`site:${siteUuid}`);
        if (!htmlContent) {
          finalResponse = new Response('<h1>404 - Conteúdo do site não localizado no NWSKV</h1>', {
            status: 404,
            headers: { 'Content-Type': 'text/html;charset=UTF-8' }
          });
        } else {
          finalResponse = new Response(htmlContent, {
            status: 200,
            headers: { 'Content-Type': 'text/html;charset=UTF-8' }
          });
        }
      }

      logData.status = finalResponse.status;

      const logHubId = env.LOG_HUB.idFromName("global_log_hub");
      const logHubStub = env.LOG_HUB.get(logHubId);

      ctx.waitUntil(logHubStub.fetch("https://loghub.nws/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(logData)
      }));

      return finalResponse;
    }

    // --- Servir o Painel HTML Enterprise ---

    const htmlDashboard = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <title>Console de Gerenciamento Enterprise - NWS</title>
    <style>
        :root {
            --bg-app: #0e131f;
            --bg-nav: #172a32;
            --bg-card: #1e293b;
            --text-main: #f8fafc;
            --text-muted: #94a3b8;
            --accent-blue: #38bdf8;
            --accent-orange: #f97316;
            --border-color: #334155;
            --success-green: #10b981;
            --error-red: #ef4444;
            --mouse-x: 50%;
            --mouse-y: 50%;
        }
        body { 
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            margin: 0; padding: 0; 
            background: var(--bg-app); 
            color: var(--text-main); 
            overflow: hidden;
            position: relative;
            min-height: 100vh;
            display: flex;
        }
        body::before {
            content: '';
            position: fixed;
            top: 0; left: 0; width: 100vw; height: 100vh;
            background: radial-gradient(1200px circle at var(--mouse-x) var(--mouse-y), rgba(56, 189, 248, 0.06), rgba(2, 6, 23, 0.98) 80%);
            z-index: -2;
            pointer-events: none;
        }
        #loadingScreen {
            position: fixed;
            top: 0; left: 0; width: 100vw; height: 100vh;
            background: #020617;
            display: flex; flex-direction: column; justify-content: center; align-items: center;
            z-index: 10000;
            transition: opacity 0.8s, visibility 0.8s;
        }
        #loadingScreen.fade-out { opacity: 0; visibility: hidden; }
        .loader-logo { width: 140px; height: 140px; animation: floatLogo 3s infinite; }
        .loader-bar-container { width: 240px; height: 4px; background: #1e293b; border-radius: 4px; margin-top: 30px; overflow: hidden; }
        .loader-bar { height: 100%; width: 0%; background: linear-gradient(90deg, var(--accent-blue), var(--accent-orange)); animation: loadProgress 1.4s forwards; }
        .loader-text { margin-top: 16px; font-size: 13px; font-weight: 700; color: #94a3b8; letter-spacing: 3px; }

        @keyframes floatLogo { 0%, 100% { transform: translateY(0px); } 50% { transform: translateY(-12px); } }
        @keyframes loadProgress { 0% { width: 0%; } 100% { width: 100%; } }

        .sidebar { width: 260px; background: var(--bg-nav); display: flex; flex-direction: column; border-right: 1px solid var(--border-color); padding-top: 20px; flex-shrink: 0; }
        .sidebar-header { padding: 0 20px 20px; display: flex; align-items: center; border-bottom: 1px solid var(--border-color); }
        .logo-icon-sidebar { width: 36px; height: 36px; margin-right: 10px; }
        .sidebar-title { font-size: 1.1rem; font-weight: 700; color: var(--accent-blue); }
        .sidebar-nav-section { padding: 20px; }
        .nav-section-title { font-size: 0.75rem; color: var(--text-muted); text-transform: uppercase; margin-bottom: 15px; }
        .nav-link { color: var(--text-main); text-decoration: none; font-size: 0.9rem; display: block; padding: 8px 0; }
        .nav-link.active { color: var(--accent-blue); font-weight: 600; }

        .main-content { flex-grow: 1; display: flex; flex-direction: column; overflow-y: auto; }
        .top-bar { background: var(--bg-app); border-bottom: 1px solid var(--border-color); padding: 15px 30px; display: flex; justify-content: space-between; align-items: center; }
        .breadcrumb { font-size: 0.85rem; color: var(--text-muted); }
        .breadcrumb span { color: var(--accent-blue); font-weight: 600; }
        .user-menu { font-size: 0.85rem; color: var(--text-muted); display: flex; align-items: center; gap: 15px; }
        .status-dot { display: inline-block; width: 8px; height: 8px; background: var(--accent-blue); border-radius: 50%; margin-right: 6px; }

        .content-wrapper { padding: 30px; }
        .page-header { margin-bottom: 30px; border-bottom: 1px solid var(--border-color); padding-bottom: 15px; }
        .page-title { font-size: 1.5rem; font-weight: 700; margin: 0; }
        .page-subtitle { font-size: 1rem; color: var(--text-muted); margin-top: 5px; }

        .widget-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 25px; }
        .widget { background: linear-gradient(145deg, rgba(30, 41, 59, 0.9), rgba(15, 23, 42, 0.98)); padding: 24px; border-radius: 12px; border: 1px solid rgba(51, 65, 85, 0.8); }
        .widget-title { font-size: 0.9rem; color: var(--text-muted); text-transform: uppercase; margin-bottom: 15px; border-bottom: 1px solid var(--border-color); padding-bottom: 8px; }

        .sites-table-container { margin-top: 15px; overflow-x: auto; }
        .sites-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; color: var(--text-main); }
        .sites-table th, .sites-table td { text-align: left; padding: 10px; border-bottom: 1px solid var(--border-color); }
        .sites-table th { color: var(--text-muted); text-transform: uppercase; font-size: 0.75rem; }
        .site-url-link { color: var(--accent-blue); text-decoration: none; }
        .action-btn-group { display: flex; gap: 5px; }

        .logs-widget { grid-column: 1 / -1; display: flex; flex-direction: column; height: 400px; }
        .logs-controls { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
        .logs-status { font-size: 0.8rem; display: flex; align-items: center; gap: 8px; }
        .ws-status-dot { width: 10px; height: 10px; border-radius: 50%; background-color: var(--error-red); }
        .ws-status-dot.connected { background-color: var(--success-green); }

        .logs-console { flex-grow: 1; background-color: rgba(9, 13, 22, 0.95); border: 1px solid var(--border-color); border-radius: 8px; padding: 15px; overflow-y: auto; font-family: monospace; font-size: 0.8rem; color: #d1d5db; }
        .log-line { margin-bottom: 4px; white-space: pre-wrap; word-break: break-all; }
        .log-method.GET { color: var(--accent-blue); }
        .log-method.POST { color: var(--success-green); }
        .log-status.200 { color: var(--success-green); }
        .log-status.404 { color: var(--error-red); }

        .modal { display: none; position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background-color: rgba(0,0,0,0.7); z-index: 2000; justify-content: center; align-items: center; }
        .modal.open { display: flex; }
        .modal-content { background: var(--bg-card); width: 90%; max-width: 800px; max-height: 90%; border-radius: 12px; border: 1px solid var(--border-color); display: flex; flex-direction: column; }
        .modal-header { padding: 15px 20px; border-bottom: 1px solid var(--border-color); display: flex; justify-content: space-between; align-items: center; }
        .close-modal { background: none; border: none; color: var(--text-muted); font-size: 1.5rem; cursor: pointer; }
        .modal-body { padding: 20px; flex-grow: 1; display: flex; flex-direction: column; }
        .html-editor { flex-grow: 1; height: 400px; width: 100%; background: #090d16; color: #e0e6ed; border: 1px solid var(--border-color); border-radius: 8px; padding: 15px; font-family: monospace; font-size: 0.85rem; }
        .modal-footer { padding: 15px 20px; border-top: 1px solid var(--border-color); display: flex; justify-content: flex-end; gap: 10px; }

        .form-group { margin-bottom: 16px; }
        .form-label { display: block; font-size: 0.9rem; color: var(--text-muted); margin-bottom: 6px; }
        input, textarea { width: 100%; padding: 12px; background: rgba(9, 13, 22, 0.8); border: 1px solid #334155; color: #fff; border-radius: 8px; box-sizing: border-box; font-size: 0.9rem; }
        textarea.deploy-html { height: 120px; font-family: monospace; }

        button { background: linear-gradient(135deg, #3b82f6, #1d4ed8); color: white; border: none; padding: 10px 20px; border-radius: 8px; cursor: pointer; font-weight: 600; font-size: 0.9rem; margin-right: 8px; }
        button.btn-secondary { background: linear-gradient(135deg, #475569, #1e293b); }
        button.btn-success { background: linear-gradient(135deg, var(--success-green), #059669); }
        button.btn-danger { background: linear-gradient(135deg, var(--error-red), #dc2626); }
        button.btn-sm { padding: 6px 12px; font-size: 0.8rem; border-radius: 6px; }

        .link-box { margin-top: 15px; word-break: break-all; }
        .status-badge { display: inline-block; padding: 4px 10px; background: rgba(56, 189, 248, 0.15); color: var(--accent-blue); border: 1px solid rgba(56, 189, 248, 0.3); border-radius: 20px; font-size: 12px; font-weight: 600; }
    </style>
</head>
<body>
    <div id="loadingScreen">
        <div class="loader-logo">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="100%" height="100%">
              <rect width="512" height="512" rx="115" fill="#1e293b"/>
              <polygon points="256,90 130,310 256,310" fill="#38bdf8"/>
              <polygon points="256,90 256,310 382,310" fill="#0f172a"/>
            </svg>
        </div>
        <div class="loader-bar-container"><div class="loader-bar"></div></div>
        <div class="loader-text">Inicializando NWS Engine...</div>
    </div>

    <nav class="sidebar">
        <div class="sidebar-header">
            <span class="sidebar-title">NWS Console</span>
        </div>
        <div class="sidebar-nav-section">
            <div class="nav-section-title">Serviços Principais</div>
            <a href="#" class="nav-link active">Dashboard</a>
            <a href="#" class="nav-link">Computação KV (Sites)</a>
            <a href="#" class="nav-link">Banco de Dados (D1)</a>
        </div>
    </nav>

    <main class="main-content">
        <header class="top-bar">
            <div class="breadcrumb">NWS Console > <span>Dashboard</span></div>
            <div class="user-menu">
                <div class="status-badge" id="autoLoginBadge" style="display: none;">Autenticado via IndexedDB</div>
                <span><span class="status-dot"></span>NWS_Global</span>
            </div>
        </header>

        <div class="content-wrapper">
            <div class="page-header">
                <h1 class="page-title">Dashboard de Serviços</h1>
                <p class="page-subtitle">Gerenciamento completo do Node.js Web Services.</p>
            </div>

            <div class="widget-grid">
                <div class="widget logs-widget">
                    <div class="widget-title">Logs HTTP em Tempo Real (via WebSocket)</div>
                    <div class="logs-controls">
                        <div class="logs-status">
                            <span class="ws-status-dot" id="wsStatusDot"></span>
                            <span id="wsStatusText">Desconectado</span>
                        </div>
                        <div>
                            <button onclick="conectarWebSocketLogs()" class="btn-sm btn-success" id="btnConectarLogs">Conectar</button>
                            <button onclick="desconectarWebSocketLogs()" class="btn-sm btn-secondary" id="btnDesconectarLogs" disabled>Desconectar</button>
                            <button onclick="limparLogsConsole()" class="btn-sm btn-secondary">Limpar</button>
                        </div>
                    </div>
                    <div class="logs-console" id="logsConsole">
                        <div class="log-line text-muted">Aguardando conexão WebSocket...</div>
                    </div>
                </div>

                <div class="widget">
                    <div class="widget-title">1. Autenticação e Segurança</div>
                    <div class="form-group">
                        <label class="form-label">Username NWS:</label>
                        <input type="text" id="username" placeholder="Usuário">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Senha:</label>
                        <input type="password" id="password" placeholder="Senha">
                    </div>
                    <div>
                        <button onclick="registrar()" class="btn-secondary">Criar Conta</button>
                        <button onclick="fazerLoginSalvar()" class="btn-success">Entrar</button>
                        <button onclick="limparSessaoDB()" class="btn-danger btn-sm">Sair</button>
                    </div>
                    <p id="authMsg"></p>
                </div>

                <div class="widget deploy-widget">
                    <div class="widget-title">2. Deploy de Site (KV)</div>
                    <div class="form-group">
                        <label class="form-label">Nome do Site:</label>
                        <input type="text" id="siteName" placeholder="Ex: Meu Site">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Código HTML:</label>
                        <textarea id="siteHtml" class="deploy-html" placeholder="<h1>Olá Mundo</h1>"></textarea>
                    </div>
                    <button onclick="fazerDeploy()" id="btnDeploy">Deploy Instantâneo</button>
                    <div class="link-box" id="resultadoDeploy"></div>
                </div>

                <div class="widget existing-sites-widget">
                    <div class="widget-title">Gerenciador de Sites Hospedados</div>
                    <button onclick="carregarSitesExistentes()" class="btn-sm btn-secondary">Atualizar Lista de Sites</button>
                    <div class="sites-table-container" id="sitesTableContainer">
                        <p class="text-muted" style="font-size: 0.9rem; text-align: center; margin-top: 20px;">Clique para carregar os sites hospedados.</p>
                    </div>
                </div>

                <div class="widget">
                    <div class="widget-title">3. Banco de Dados D1</div>
                    <div class="form-group">
                        <label class="form-label">Nome do Banco:</label>
                        <input type="text" id="dbName" placeholder="Ex: meu_banco">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Schema (SQL):</label>
                        <textarea id="dbSchema" placeholder="CREATE TABLE clientes (id INT, nome TEXT);"></textarea>
                    </div>
                    <button onclick="criarBanco()">Criar Banco</button>
                    <p id="dbMsg"></p>
                </div>
            </div>
        </div>
    </main>

    <div class="modal" id="editHtmlModal">
        <div class="modal-content">
            <header class="modal-header">
                <h2 class="modal-title" id="editModalTitle">Editar HTML</h2>
                <button onclick="fecharModalEdicao()" class="close-modal">&times;</button>
            </header>
            <div class="modal-body">
                <input type="hidden" id="editSiteUuid">
                <textarea class="html-editor" id="htmlEditorArea" spellcheck="false"></textarea>
            </div>
            <footer class="modal-footer">
                <button onclick="fecharModalEdicao()" class="btn-secondary btn-sm">Cancelar</button>
                <button onclick="salvarAlteracoesHTML()" class="btn-success btn-sm" id="btnSalvarEdicao">Salvar (NWSKV)</button>
            </footer>
        </div>
    </div>

    <script>
        const API_URL = '';
        let wsLogs = null;
        let reconectarWsInterval = null;

        window.addEventListener('mousemove', (e) => {
            const x = (e.clientX / window.innerWidth) * 100;
            const y = (e.clientY / window.innerHeight) * 100;
            document.documentElement.style.setProperty('--mouse-x', x + '%');
            document.documentElement.style.setProperty('--mouse-y', y + '%');
        });

        const dbName = 'NWSSecureStorage';
        const storeName = 'authStore';
        let db;

        function abrirIndexedDB() {
            return new Promise((resolve, reject) => {
                const request = indexedDB.open(dbName, 1);
                request.onerror = () => reject(request.error);
                request.onsuccess = () => { db = request.result; resolve(db); };
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
            } catch (e) { return null; }
        }

        async function limparSessaoDB() {
            try {
                await abrirIndexedDB();
                const transaction = db.transaction(storeName, 'readwrite');
                const store = transaction.objectStore(storeName);
                store.delete('credentials');
                document.getElementById('username').value = '';
                document.getElementById('password').value = '';
                document.getElementById('autoLoginBadge').style.display = 'none';
                document.getElementById('authMsg').innerText = "Sessão encerrada.";
            } catch (e) { console.error(e); }
        }

        async function obterCredenciais() {
            const userField = document.getElementById('username').value;
            const passField = document.getElementById('password').value;
            
            if (userField && passField) {
                return { username: userField, password: passField };
            }
            
            const saved = await lerDoIndexedDB();
            if (saved && saved.username && saved.password) {
                return { username: saved.username, password: saved.password };
            }
            
            return null;
        }

        window.addEventListener('load', async () => {
            try {
                const savedCreds = await lerDoIndexedDB();
                if (savedCreds && savedCreds.username && savedCreds.password) {
                    document.getElementById('username').value = savedCreds.username;
                    document.getElementById('password').value = savedCreds.password;
                    
                    const res = await fetch(\`\${API_URL}/api/login\`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ username: savedCreds.username, password: savedCreds.password })
                    });
                    
                    if (res.ok) {
                        document.getElementById('autoLoginBadge').style.display = 'inline-block';
                        carregarSitesExistentes();
                        conectarWebSocketLogs();
                    }
                }
            } catch (e) { console.error(e); }

            setTimeout(() => {
                const loader = document.getElementById('loadingScreen');
                if (loader) {
                    loader.classList.add('fade-out');
                    setTimeout(() => loader.remove(), 800);
                }
            }, 800);
        });

        async function registrar() {
            const username = document.getElementById('username').value;
            const password = document.getElementById('password').value;
            const msgEl = document.getElementById('authMsg');
            
            if (!username || !password) { msgEl.innerText = "Campos obrigatórios."; return; }

            try {
                const res = await fetch(\`\${API_URL}/api/register\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password })
                });
                const data = await res.json();
                msgEl.innerText = data.sucesso ? data.mensagem : \`Erro: \${data.erro}\`;
            } catch (e) { msgEl.innerText = "Erro na requisição."; }
        }

        async function fazerLoginSalvar() {
            const username = document.getElementById('username').value;
            const password = document.getElementById('password').value;
            const msgEl = document.getElementById('authMsg');
            
            if (!username || !password) { msgEl.innerText = "Campos obrigatórios."; return; }

            try {
                const res = await fetch(\`\${API_URL}/api/login\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password })
                });
                const data = await res.json();
                
                if (res.ok) {
                    await salvarNoIndexedDB(username, password);
                    document.getElementById('autoLoginBadge').style.display = 'inline-block';
                    msgEl.innerText = "Login com sucesso!";
                    carregarSitesExistentes();
                    conectarWebSocketLogs();
                } else {
                    msgEl.innerText = \`Erro: \${data.erro}\`;
                }
            } catch (e) { msgEl.innerText = "Erro no login."; }
        }

        async function fazerDeploy() {
            const creds = await obterCredenciais();
            if (!creds) { alert("Faça login primeiro."); return; }

            const nome = document.getElementById('siteName').value;
            const html = document.getElementById('siteHtml').value;
            const btn = document.getElementById('btnDeploy');
            const resBox = document.getElementById('resultadoDeploy');

            if (!nome || !html) { alert("Preencha todos os campos."); return; }

            btn.disabled = true;

            try {
                const res = await fetch(\`\${API_URL}/api/deploy\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ...creds, nome, html })
                });
                const data = await res.json();
                
                if (res.ok) {
                    resBox.innerHTML = \`Deploy com sucesso: <a href="\${data.url}" target="_blank" class="site-url-link">\${data.url}</a>\`;
                    document.getElementById('siteName').value = '';
                    document.getElementById('siteHtml').value = '';
                    carregarSitesExistentes();
                } else {
                    resBox.innerText = \`Erro: \${data.erro}\`;
                }
            } catch (e) { resBox.innerText = "Erro no deploy."; }
            finally { btn.disabled = false; }
        }

        async function carregarSitesExistentes() {
            const creds = await obterCredenciais();
            const container = document.getElementById('sitesTableContainer');
            
            if (!creds || !creds.username || !creds.password) { 
                container.innerHTML = '<p class="text-muted" style="text-align: center;">Faça login para gerenciar os sites.</p>'; 
                return; 
            }

            container.innerHTML = '<p class="text-muted" style="text-align:center;">Buscando sites...</p>';

            try {
                const res = await fetch(\`\${API_URL}/api/get-sites\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        username: creds.username,
                        password: creds.password
                    })
                });
                const data = await res.json();

                if (res.ok && data.sites && data.sites.length > 0) {
                    let tableHtml = \`
                        <table class="sites-table">
                            <thead>
                                <tr>
                                    <th>Nome</th>
                                    <th>UUID</th>
                                    <th>Link</th>
                                    <th>Ações</th>
                                </tr>
                            </thead>
                            <tbody>
                    \`;
                    
                    data.sites.forEach(site => {
                        const siteUrl = \`\${window.location.origin}/\${site.uuid}\`;
                        tableHtml += \`
                            <tr>
                                <td><strong>\${site.nome}</strong></td>
                                <td class="text-muted">\${site.uuid}</td>
                                <td><a href="\${siteUrl}" target="_blank" class="site-url-link">Acessar</a></td>
                                <td class="action-btn-group">
                                    <button onclick="abrirModalEdicao('\${site.uuid}', '\${site.nome}')" class="btn-sm btn-secondary">Editar</button>
                                    <button onclick="removerSiteDeVerdade('\${site.uuid}', '\${site.nome}')" class="btn-sm btn-danger">Excluir</button>
                                </td>
                            </tr>
                        \`;
                    });
                    
                    tableHtml += '</tbody></table>';
                    container.innerHTML = tableHtml;
                } else if (res.ok) {
                    container.innerHTML = '<p class="text-muted" style="text-align: center;">Nenhum site encontrado.</p>';
                } else {
                    container.innerHTML = \`<p style="text-align:center; color: var(--error-red);">Erro ao carregar sites: \${data.erro || 'Erro desconhecido'}</p>\`;
                }
            } catch (e) { 
                container.innerHTML = '<p style="text-align:center; color: var(--error-red);">Erro crítico na requisição de listagem de sites.</p>'; 
            }
        }

        async function removerSiteDeVerdade(uuid, nome) {
            const creds = await obterCredenciais();
            if (!creds) { alert("Sessão expirada."); return; }

            if (!confirm(\`Deseja excluir permanentemente o site "\${nome}"?\`)) return;

            try {
                const res = await fetch(\`\${API_URL}/api/delete-site\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username: creds.username, password: creds.password, uuid })
                });
                const data = await res.json();
                
                if (res.ok) {
                    alert(data.mensagem);
                    carregarSitesExistentes();
                } else {
                    alert(\`Erro: \${data.erro}\`);
                }
            } catch (e) { alert("Erro ao remover site."); }
        }

        async function abrirModalEdicao(uuid, nome) {
            const creds = await obterCredenciais();
            if (!creds) { alert("Sessão expirada."); return; }

            const modal = document.getElementById('editHtmlModal');
            const titleEl = document.getElementById('editModalTitle');
            const editor = document.getElementById('htmlEditorArea');
            const uuidInput = document.getElementById('editSiteUuid');
            const btnSalvar = document.getElementById('btnSalvarEdicao');

            titleEl.innerText = \`Editar HTML: \${nome}\`;
            uuidInput.value = uuid;
            editor.value = "Carregando...";
            editor.disabled = true;
            btnSalvar.disabled = true;
            
            modal.classList.add('open');

            try {
                const res = await fetch(\`\${API_URL}/\${uuid}\`);
                if (res.ok) {
                    editor.value = await res.text();
                    editor.disabled = false;
                    btnSalvar.disabled = false;
                } else {
                    editor.value = "Erro ao carregar conteúdo.";
                }
            } catch (e) { editor.value = "Erro ao carregar conteúdo."; }
        }

        function fecharModalEdicao() {
            document.getElementById('editHtmlModal').classList.remove('open');
            document.getElementById('htmlEditorArea').value = '';
        }

        async function salvarAlteracoesHTML() {
            const creds = await obterCredenciais();
            if (!creds) { alert("Sessão expirada."); fecharModalEdicao(); return; }

            const uuid = document.getElementById('editSiteUuid').value;
            const html = document.getElementById('htmlEditorArea').value;
            const btn = document.getElementById('btnSalvarEdicao');

            btn.disabled = true;

            try {
                const res = await fetch(\`\${API_URL}/api/edit-site\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username: creds.username, password: creds.password, uuid, html })
                });
                const data = await res.json();
                
                if (res.ok) {
                    alert(data.mensagem);
                    fecharModalEdicao();
                    carregarSitesExistentes();
                } else {
                    alert(\`Erro: \${data.erro}\`);
                    btn.disabled = false;
                }
            } catch (e) { alert("Erro ao salvar."); btn.disabled = false; }
        }

        async function criarBanco() {
            const creds = await obterCredenciais();
            if (!creds) { alert("Faça login primeiro."); return; }

            const db_name = document.getElementById('dbName').value;
            const schema_definition = document.getElementById('dbSchema').value;
            const msgEl = document.getElementById('dbMsg');

            if (!db_name) { msgEl.innerText = "Nome do banco é obrigatório."; return; }

            try {
                const res = await fetch(\`\${API_URL}/api/createdb\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ...creds, db_name, schema_definition })
                });
                const data = await res.json();
                
                if (res.ok) {
                    msgEl.innerText = data.mensagem;
                    document.getElementById('dbName').value = '';
                    document.getElementById('dbSchema').value = '';
                } else {
                    msgEl.innerText = \`Erro: \${data.erro}\`;
                }
            } catch (e) { msgEl.innerText = "Erro ao criar banco."; }
        }

        function atualizarUIWebSocket(status) {
            const dot = document.getElementById('wsStatusDot');
            const text = document.getElementById('wsStatusText');
            const btnConectar = document.getElementById('btnConectarLogs');
            const btnDesconectar = document.getElementById('btnDesconectarLogs');

            dot.className = 'ws-status-dot';
            btnConectar.disabled = true;
            btnDesconectar.disabled = true;

            if (status === 'conectado') {
                dot.classList.add('connected');
                text.innerText = 'Conectado (wss://)';
                btnDesconectar.disabled = false;
            } else {
                text.innerText = 'Desconectado';
                btnConectar.disabled = false;
            }
        }

        async function conectarWebSocketLogs() {
            if (wsLogs && wsLogs.readyState === WebSocket.OPEN) return;
            if (!await obterCredenciais()) return;

            desconectarWebSocketLogs();

            const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const wsUrl = \`\${wsProtocol}//\${window.location.host}/api/logs-ws\`;

            wsLogs = new WebSocket(wsUrl);

            wsLogs.onopen = () => {
                atualizarUIWebSocket('conectado');
                if (reconectarWsInterval) { clearInterval(reconectarWsInterval); reconectarWsInterval = null; }
            };

            wsLogs.onmessage = (event) => {
                try {
                    const message = JSON.parse(event.data);
                    if (message.type === 'log' && message.data) {
                        adicionarLogNoConsole(message.data);
                    }
                } catch (e) {}
            };

            wsLogs.onclose = () => {
                atualizarUIWebSocket('desconectado');
                wsLogs = null;
            };

            wsLogs.onerror = () => {
                atualizarUIWebSocket('desconectado');
            };
        }

        function desconectarWebSocketLogs() {
            if (reconectarWsInterval) { clearInterval(reconectarWsInterval); reconectarWsInterval = null; }
            if (wsLogs) {
                wsLogs.close(1000);
                wsLogs = null;
            }
            atualizarUIWebSocket('desconectado');
        }

        function adicionarLogNoConsole(log) {
            const consoleEl = document.getElementById('logsConsole');
            const logLine = document.createElement('div');
            logLine.className = 'log-line';
            
            const date = new Date(log.timestamp);
            const timeStr = date.toLocaleTimeString('pt-BR');
            
            logLine.innerHTML = \`
                <span>[\${timeStr}]</span> 
                <span class="log-method \${log.method}">\${log.method}</span> 
                <span>\${log.url}</span> -> 
                <span class="log-status \${log.status}">\${log.status}</span> 
                <span>(\${log.ip})</span>
            \`;
            
            consoleEl.appendChild(logLine);
            consoleEl.scrollTop = consoleEl.scrollHeight;
        }

        function limparLogsConsole() {
            document.getElementById('logsConsole').innerHTML = '<div class="log-line text-muted">Console limpo.</div>';
        }
    </script>
</body>
</html>`;

    return new Response(htmlDashboard, {
      headers: { 'Content-Type': 'text/html;charset=UTF-8' }
    });
  },
};
