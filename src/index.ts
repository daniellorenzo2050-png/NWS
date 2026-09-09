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
  const { username, password } = await request.clone().json() as any;
  if (!username || !password) return false;
  
  const password_hash = await hashPassword(password);
  const user = await env.NWSD1.prepare(
    `SELECT * FROM users WHERE username = ? AND password_hash = ?`
  ).bind(username, password_hash).first();
  
  return !!user;
}


// --- Durable Object: LogHub ---
// Gerencia conexões WebSocket e retransmite logs em tempo real

export class LogHub extends DurableObject {
  private sessions: Set<WebSocket>;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.sessions = new Set();
  }

  // Tratamento de requisições HTTP para o Durable Object
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Rota para publicar logs (chamada pelo Worker principal)
    if (url.pathname === "/publish") {
      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }
      const logData = await request.json();
      this.broadcastLog(logData);
      return new Response("OK");
    }

    // Rota para conexão WebSocket (chamada pelo Painel HTML)
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

  // Gerencia uma nova sessão WebSocket
  private async handleSession(ws: WebSocket) {
    ws.accept();
    this.sessions.add(ws);

    // Remove a sessão quando a conexão é fechada ou ocorre erro
    const closeHandler = () => {
      this.sessions.delete(ws);
    };
    ws.addEventListener("close", closeHandler);
    ws.addEventListener("error", closeHandler);
  }

  // Transmite a mensagem de log para todas as sessões WebSocket conectadas
  private broadcastLog(logData: any) {
    const message = JSON.stringify({ type: 'log', data: logData });
    for (const ws of this.sessions) {
      try {
        ws.send(message);
      } catch (e) {
        // Se falhar, remove a sessão (provavelmente conexão quebrada)
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

    // --- Rotas de API ---

    // Rota para conexão WebSocket de logs (Painel -> DO)
    if (path === '/api/logs-ws') {
      const id = env.LOG_HUB.idFromName("global_log_hub");
      const stub = env.LOG_HUB.get(id);
      return stub.fetch(new Request("https://loghub.nws/ws", {
        headers: request.headers
      }));
    }

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

    // Rota API: Login (Valida credenciais e retorna sucesso)
    if (path === '/api/login' && request.method === 'POST') {
      if (await validarAuth(request, env)) {
        return Response.json({ sucesso: true, mensagem: 'Login bem-sucedido!' });
      } else {
        return Response.json({ erro: 'Credenciais inválidas.' }, { status: 401 });
      }
    }

    // Rota API: Listar Sites Existentes (Metadados do NWSD1)
    if (path === '/api/get-sites' && request.method === 'POST') {
      if (!await validarAuth(request, env)) {
        return Response.json({ erro: 'Não autorizado.' }, { status: 401 });
      }
      const sites = await env.NWSD1.prepare(`SELECT * FROM sites`).all();
      return Response.json({ sucesso: true, sites: sites.results });
    }

    // Rota API: Fazer Deploy de Novo Site (D1 + KV)
    if (path === '/api/deploy' && request.method === 'POST') {
      const body = await request.clone().json() as any;
      if (!body.username || !body.password || !body.nome || !body.html) {
        return Response.json({ erro: 'Dados incompletos para deploy.' }, { status: 400 });
      }

      if (!await validarAuth(request, env)) {
        return Response.json({ erro: 'Autenticação falhou.' }, { status: 401 });
      }

      const siteUuid = crypto.randomUUID();

      // Salva o HTML bruto no NWSKV
      await env.NWSKV.put(`site:${siteUuid}`, body.html);

      // Registra os metadados na tabela sites do NWSD1
      await env.NWSD1.prepare(
        `INSERT INTO sites (uuid, username, nome) VALUES (?, ?, ?)`
      ).bind(siteUuid, body.username, body.nome).run();

      return Response.json({
        sucesso: true,
        uuid: siteUuid,
        // Altere a URL base conforme o deploy do seu Worker
        url: `https://nws-enterprise-panel.rattew.workers.dev/${siteUuid}`
      });
    }

    // Rota API: Editar HTML de Site Existente (NWSKV)
    if (path === '/api/edit-site' && request.method === 'POST') {
      const body = await request.clone().json() as any;
      if (!body.uuid || !body.html) {
        return Response.json({ erro: 'UUID e HTML são obrigatórios.' }, { status: 400 });
      }

      if (!await validarAuth(request, env)) {
        return Response.json({ erro: 'Autenticação falhou.' }, { status: 401 });
      }

      // Atualiza apenas o conteúdo no KV
      await env.NWSKV.put(`site:${body.uuid}`, body.html);

      return Response.json({ sucesso: true, mensagem: 'HTML do site atualizado com sucesso!' });
    }

    // Rota API: Remover Site do Ar Permanentemente (D1 + KV)
    if (path === '/api/delete-site' && request.method === 'POST') {
      const body = await request.clone().json() as any;
      if (!body.uuid) {
        return Response.json({ erro: 'UUID é obrigatório.' }, { status: 400 });
      }

      if (!await validarAuth(request, env)) {
        return Response.json({ erro: 'Autenticação falhou.' }, { status: 401 });
      }

      // Remove do KV
      await env.NWSKV.delete(`site:${body.uuid}`);
      // Remove do D1
      await env.NWSD1.prepare(`DELETE FROM sites WHERE uuid = ?`).bind(body.uuid).run();

      return Response.json({ sucesso: true, mensagem: 'Site removido com sucesso de verdade.' });
    }

    // Rota API: Criar banco de dados personalizado (nwsuserdatabases no NWSD1)
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

    // Rota dinâmica para servir os sites hospedados via UUID e gerar logs HTTP
    if (path.length > 1 && !path.startsWith('/api/')) {
      const siteUuid = path.slice(1);
      
      // Captura dados para o log HTTP antes de tentar buscar o site
      const logData: LogMessage = {
        type: 'log',
        timestamp: new Date().toISOString(),
        method: request.method,
        url: request.url,
        status: 0, // Será atualizado
        ip: request.headers.get("cf-connecting-ip") || "Unknown",
        userAgent: request.headers.get("user-agent") || "Unknown"
      };

      // Tenta buscar metadados do site no NWSD1
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
        // Busca conteúdo HTML bruto no NWSKV
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

      // Atualiza o status na mensagem de log
      logData.status = finalResponse.status;

      // Envia o log para o Durable Object LOG_HUB (fire-and-forget usando ctx.waitUntil)
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
    // Painel HTML5 Avançado com Sistema de Luz/Sombra Dinâmico, Tela de Carregamento Imersiva, Logs em Tempo Real e Persistência Automática via IndexedDB

    const htmlDashboard = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <title>Console de Gerenciamento Enterprise - NWS (Node.js Web Services)</title>
    <style>
        /* Estilo Enterprise Inspirado na AWS */
        :root {
            --bg-app: #0e131f;       /* Fundo Principal (Cinza Muito Escuro) */
            --bg-nav: #172a32;       /* Barra Lateral (Grafite) */
            --bg-card: #1e293b;      /* Cartões de Serviço (Cinza Médio) */
            --text-main: #f8fafc;    /* Texto Principal (Branco Suave) */
            --text-muted: #94a3b8;   /* Texto Secundário (Cinza Azulado) */
            --accent-blue: #38bdf8;  /* Azul Acentuado (Links, Status) */
            --accent-orange: #f97316;/* Laranja Acentuado (CTAs, Destaques) */
            --border-color: #334155; /* Bordas e Divisores */
            --success-green: #10b981;/* Verde de Sucesso */
            --error-red: #ef4444;    /* Vermelho de Erro */
            
            --mouse-x: 50%;
            --mouse-y: 50%;
        }
        body { 
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            margin: 0; padding: 0; 
            background: var(--bg-app); 
            color: var(--text-main); 
            overflow: hidden; /* Controlado pelo main-content */
            position: relative;
            min-height: 100vh;
            display: flex;
        }
        
        /* Sistema de Iluminação e Sombra Dinâmica Enterprise em Tempo Real */
        body::before {
            content: '';
            position: fixed;
            top: 0; left: 0; width: 100vw; height: 100vh;
            background: radial-gradient(1200px circle at var(--mouse-x) var(--mouse-y), rgba(56, 189, 248, 0.06), rgba(2, 6, 23, 0.98) 80%);
            z-index: -2;
            pointer-events: none;
            transition: background 0.1s ease-out;
        }

        /* Tela de Carregamento Imersiva de Alta Tecnologia */
        #loadingScreen {
            position: fixed;
            top: 0; left: 0; width: 100vw; height: 100vh;
            background: #020617;
            display: flex;
            flex-direction: column;
            justify-content: center;
            align-items: center;
            z-index: 10000;
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
            background: linear-gradient(90deg, var(--accent-blue), var(--accent-orange));
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

        /* --- Estrutura Principal do Painel --- */

        /* Barra Lateral (Sidebar) Estilo AWS */
        .sidebar {
            width: 260px;
            background: var(--bg-nav);
            display: flex;
            flex-direction: column;
            border-right: 1px solid var(--border-color);
            padding-top: 20px;
            flex-shrink: 0;
            z-index: 10;
        }
        .sidebar-header {
            padding: 0 20px 20px 20px;
            display: flex;
            align-items: center;
            border-bottom: 1px solid var(--border-color);
        }
        .logo-icon-sidebar {
            width: 36px;
            height: 36px;
            margin-right: 10px;
            filter: drop-shadow(0 2px 5px rgba(0,0,0,0.3));
        }
        .sidebar-title {
            font-size: 1.1rem;
            font-weight: 700;
            color: var(--accent-blue);
        }
        .sidebar-nav-section {
            padding: 20px;
        }
        .nav-section-title {
            font-size: 0.75rem;
            color: var(--text-muted);
            text-transform: uppercase;
            letter-spacing: 1px;
            margin-bottom: 15px;
        }
        .nav-link {
            color: var(--text-main);
            text-decoration: none;
            font-size: 0.9rem;
            display: block;
            padding: 8px 0;
            transition: color 0.2s;
        }
        .nav-link:hover {
            color: var(--accent-blue);
        }
        .nav-link.active {
            color: var(--accent-blue);
            font-weight: 600;
        }

        /* Área de Conteúdo Principal */
        .main-content {
            flex-grow: 1;
            display: flex;
            flex-direction: column;
            overflow-y: auto;
        }

        /* Barra Superior (Top Bar) */
        .top-bar {
            background: var(--bg-app);
            border-bottom: 1px solid var(--border-color);
            padding: 15px 30px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            position: sticky;
            top: 0;
            z-index: 100;
        }
        .breadcrumb {
            font-size: 0.85rem;
            color: var(--text-muted);
        }
        .breadcrumb span {
            color: var(--accent-blue);
            font-weight: 600;
        }
        .user-menu {
            font-size: 0.85rem;
            color: var(--text-muted);
            display: flex;
            align-items: center;
            gap: 15px;
        }
        .status-dot {
            display: inline-block;
            width: 8px;
            height: 8px;
            background: var(--accent-blue);
            border-radius: 50%;
            margin-right: 6px;
        }
        
        /* Envoltório de Conteúdo da Página */
        .content-wrapper {
            padding: 30px;
        }
        .page-header {
            margin-bottom: 30px;
            border-bottom: 1px solid var(--border-color);
            padding-bottom: 15px;
        }
        .page-title {
            font-size: 1.5rem;
            font-weight: 700;
            margin: 0;
        }
        .page-subtitle {
            font-size: 1rem;
            color: var(--text-muted);
            margin-top: 5px;
        }

        /* Grid de Widgets Enterprise */
        .widget-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
            gap: 25px;
        }
        .widget {
            background: linear-gradient(145deg, rgba(30, 41, 59, 0.9), rgba(15, 23, 42, 0.98)); 
            backdrop-filter: blur(10px);
            padding: 24px;
            border-radius: 12px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.05);
            border: 1px solid rgba(51, 65, 85, 0.8);
            transition: transform 0.3s ease, border-color 0.3s ease, box-shadow 0.3s ease;
        }
        .widget:hover {
            transform: translateY(-3px);
            border-color: var(--accent-blue);
            box-shadow: 0 20px 45px rgba(0,0,0,0.8), 0 0 20px rgba(56, 189, 248, 0.15);
        }
        .widget-title {
            font-size: 0.9rem;
            color: var(--text-muted);
            text-transform: uppercase;
            letter-spacing: 0.5px;
            margin-bottom: 15px;
            border-bottom: 1px solid var(--border-color);
            padding-bottom: 8px;
        }

        /* Tabela de Sites Existentes */
        .sites-table-container {
            margin-top: 15px;
            overflow-x: auto;
        }
        .sites-table {
            width: 100%;
            border-collapse: collapse;
            font-size: 0.85rem;
            color: var(--text-main);
        }
        .sites-table th, .sites-table td {
            text-align: left;
            padding: 10px;
            border-bottom: 1px solid var(--border-color);
        }
        .sites-table th {
            color: var(--text-muted);
            text-transform: uppercase;
            font-size: 0.75rem;
            letter-spacing: 1px;
        }
        .sites-table tr:hover td {
            background-color: rgba(56, 189, 248, 0.05);
        }
        .site-url-link {
            color: var(--accent-blue);
            text-decoration: none;
        }
        .site-url-link:hover {
            text-decoration: underline;
        }
        .action-btn-group {
            display: flex;
            gap: 5px;
        }

        /* --- Console de Logs HTTP em Tempo Real (wss://) --- */
        .logs-widget {
            grid-column: 1 / -1; /* Ocupa toda a largura */
            display: flex;
            flex-direction: column;
            height: 400px;
        }
        .logs-controls {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 10px;
        }
        .logs-status {
            font-size: 0.8rem;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .ws-status-dot {
            width: 10px; height: 10px;
            border-radius: 50%;
            background-color: var(--error-red); /* Padrão: desconectado */
        }
        .ws-status-dot.connected { background-color: var(--success-green); }
        .ws-status-dot.connecting { background-color: var(--accent-orange); animation: pulseStatus 1s infinite alternate; }
        
        @keyframes pulseStatus { 0% { opacity: 0.5; } 100% { opacity: 1; } }

        .logs-console {
            flex-grow: 1;
            background-color: rgba(9, 13, 22, 0.95);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            padding: 15px;
            overflow-y: auto;
            font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
            font-size: 0.8rem;
            color: #d1d5db;
            box-shadow: inset 0 2px 5px rgba(0,0,0,0.5);
            line-height: 1.4;
        }
        .log-line {
            margin-bottom: 4px;
            white-space: pre-wrap;
            word-break: break-all;
            border-bottom: 1px solid rgba(255,255,255,0.03);
            padding-bottom: 2px;
        }
        .log-ts { color: var(--text-muted); }
        .log-method { font-weight: 700; color: #fff; }
        .log-method.GET { color: var(--accent-blue); }
        .log-method.POST { color: var(--success-green); }
        .log-url { color: #d1d5db; }
        .log-status { font-weight: 700; }
        .log-status.200 { color: var(--success-green); }
        .log-status.404 { color: var(--error-red); }
        .log-status.500 { color: #f59e0b; }
        .log-ip { color: #94a3b8; }

        /* --- Modal de Edição de HTML --- */
        .modal {
            display: none; /* Escondido por padrão */
            position: fixed;
            top: 0; left: 0; width: 100vw; height: 100vh;
            background-color: rgba(0,0,0,0.7);
            backdrop-filter: blur(5px);
            z-index: 2000;
            justify-content: center;
            align-items: center;
        }
        .modal.open { display: flex; }
        .modal-content {
            background: var(--bg-card);
            width: 90%;
            max-width: 800px;
            max-height: 90%;
            border-radius: 12px;
            border: 1px solid var(--border-color);
            box-shadow: 0 25px 50px rgba(0,0,0,0.8);
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }
        .modal-header {
            padding: 15px 20px;
            border-bottom: 1px solid var(--border-color);
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .modal-title { font-size: 1.1rem; font-weight: 700; color: var(--accent-blue); margin: 0; }
        .close-modal {
            background: none; border: none; color: var(--text-muted);
            font-size: 1.5rem; cursor: pointer; padding: 0;
        }
        .close-modal:hover { color: var(--error-red); }
        .modal-body {
            padding: 20px;
            flex-grow: 1;
            display: flex;
            flex-direction: column;
        }
        .html-editor {
            flex-grow: 1;
            height: 400px;
            width: 100%;
            background: #090d16;
            color: #e0e6ed;
            border: 1px solid var(--border-color);
            border-radius: 8px;
            padding: 15px;
            font-family: 'SFMono-Regular', Consolas, monospace;
            font-size: 0.85rem;
            resize: none;
            line-height: 1.5;
        }
        .modal-footer {
            padding: 15px 20px;
            border-top: 1px solid var(--border-color);
            display: flex;
            justify-content: flex-end;
            gap: 10px;
        }

        /* --- Elementos de Formulário Enterprise --- */
        .form-group { margin-bottom: 16px; }
        .form-label {
            display: block;
            font-size: 0.9rem;
            color: var(--text-muted);
            margin-bottom: 6px;
        }
        input, textarea { 
            width: 100%; padding: 12px; margin: 0; 
            background: rgba(9, 13, 22, 0.8); border: 1px solid #334155; color: #fff; 
            border-radius: 8px; box-sizing: border-box; 
            transition: border-color 0.2s, box-shadow 0.2s;
            font-size: 0.9rem;
        }
        input:focus, textarea:focus {
            outline: none;
            border-color: var(--accent-blue);
            box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.25);
        }
        textarea.deploy-html { height: 120px; font-family: monospace; resize: vertical; }

        /* Botões Enterprise */
        button { 
            background: linear-gradient(135deg, #3b82f6, #1d4ed8); 
            color: white; border: none; padding: 10px 20px; border-radius: 8px; 
            cursor: pointer; font-weight: 600; font-size: 0.9rem; margin-right: 8px; 
            box-shadow: 0 4px 15px rgba(59, 130, 246, 0.4);
            transition: all 0.25s ease; 
            display: inline-flex; align-items: center; gap: 8px;
        }
        button:hover { 
            background: linear-gradient(135deg, #2563eb, #1e40af); 
            transform: translateY(-2px);
            box-shadow: 0 6px 20px rgba(59, 130, 246, 0.6);
        }
        button:active { transform: translateY(0); }
        button:disabled { background: #475569; box-shadow: none; cursor: not-allowed; opacity: 0.7; }

        button.btn-secondary { background: linear-gradient(135deg, #475569, #1e293b); box-shadow: 0 4px 12px rgba(0,0,0,0.3); }
        button.btn-secondary:hover { background: linear-gradient(135deg, #334155, #111827); border-color: #475569; }

        button.btn-success { background: linear-gradient(135deg, var(--success-green), #059669); box-shadow: 0 4px 12px rgba(16, 185, 129, 0.4); }
        button.btn-success:hover { background: linear-gradient(135deg, #059669, #047857); box-shadow: 0 6px 18px rgba(16, 185, 129, 0.6); }

        button.btn-danger { background: linear-gradient(135deg, var(--error-red), #dc2626); box-shadow: 0 4px 12px rgba(239, 68, 68, 0.4); }
        button.btn-danger:hover { background: linear-gradient(135deg, #dc2626, #b91c1c); box-shadow: 0 6px 18px rgba(239, 68, 68, 0.6); }
        
        button.btn-sm { padding: 6px 12px; font-size: 0.8rem; border-radius: 6px; }

        .link-box { margin-top: 15px; word-break: break-all; }
        .status-badge { display: inline-block; padding: 4px 10px; background: rgba(56, 189, 248, 0.15); color: var(--accent-blue); border: 1px solid rgba(56, 189, 248, 0.3); border-radius: 20px; font-size: 12px; font-weight: 600; margin-bottom: 15px; }
    </style>
</head>
<body>
    <!-- Tela de Carregamento Imersiva -->
    <div id="loadingScreen">
        <div class="loader-logo">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="100%" height="100%">
              <defs>
                <linearGradient id="lBg" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stop-color="#1e293b"/><stop offset="100%" stop-color="#020617"/></linearGradient>
                <linearGradient id="lL" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#38bdf8"/><stop offset="100%" stop-color="#0369a1"/></linearGradient>
                <linearGradient id="lD" x1="100%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stop-color="#0f172a"/><stop offset="100%" stop-color="#020617"/></linearGradient>
                <linearGradient id="lS" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#ffffff"/><stop offset="100%" stop-color="#94a3b8"/></linearGradient>
                <linearGradient id="lSw" x1="0%" y1="0%" x2="100%" y2="80%"><stop offset="0%" stop-color="#ffb74d"/><stop offset="100%" stop-color="#ea580c"/></linearGradient>
              </defs>
              <rect width="512" height="512" rx="115" fill="url(#lBg)"/>
              <polygon points="256,90 130,310 256,310" fill="url(#lL)"/><polygon points="256,90 256,310 382,310" fill="url(#lD)"/>
              <path d="M256,90 L200,185 L256,165 L312,185 Z" fill="url(#lS)"/>
              <path d="M 0,-38 C 34,-56 82,-63 118,-52 C 76,-26 38,-10 0,14 C -38,-10 -76,-26 -118,-52 C -82,-63 -34,-56 0,-38 Z" fill="url(#lSw)" transform="translate(256, 175) scale(1.4)"/>
            </svg>
        </div>
        <div class="loader-bar-container"><div class="loader-bar"></div></div>
        <div class="loader-text">Inicializando NWS Engine...</div>
    </div>

    <!-- Barra Lateral (Sidebar) -->
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
            <div class="nav-section-title">Serviços Principais</div>
            <a href="#" class="nav-link active">Dashboard</a>
            <a href="#" class="nav-link">Computação KV (Sites)</a>
            <a href="#" class="nav-link">Armazenamento (NWSKV)</a>
            <a href="#" class="nav-link">Banco de Dados (D1)</a>
        </div>
        <div class="sidebar-nav-section">
            <div class="nav-section-title">Gerenciamento</div>
            <a href="#" class="nav-link">Monitoramento</a>
            <a href="#" class="nav-link">Segurança e IAM</a>
            <a href="#" class="nav-link">Faturamento</a>
        </div>
    </nav>

    <!-- Área Principal de Conteúdo -->
    <main class="main-content">
        <header class="top-bar">
            <div class="breadcrumb">NWS Console > <span>Dashboard</span></div>
            <div class="user-menu">
                <div class="status-badge" id="autoLoginBadge" style="display: none;">Sessão Autenticada via IndexedDB</div>
                <span><span class="status-dot"></span>NWS_Global</span>
                <span>Conta RATTEW</span>
                <span>arn:nws:iam::global:user/Rattew</span>
            </div>
        </header>

        <div class="content-wrapper">
            <div class="page-header">
                <h1 class="page-title">Dashboard de Serviços</h1>
                <p class="page-subtitle">Visão geral e acesso rápido aos recursos do Node.js Web Services Enterprise.</p>
            </div>

            <div class="widget-grid">
                
                <!-- Widget: Logs HTTP em Tempo Real (wss://) -->
                <div class="widget logs-widget">
                    <div class="widget-title">Logs HTTP em Tempo Real de Verdade (via WebSocket)</div>
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
                        <div class="log-line text-muted">Aguardando conexão WebSocket... Clique em 'Conectar' para iniciar o monitoramento de logs em tempo real de verdade.</div>
                    </div>
                </div>

                <!-- Widget: Credenciais e Segurança -->
                <div class="widget">
                    <div class="widget-title">1. Autenticação e Segurança da Conta</div>
                    <div class="form-group">
                        <label class="form-label">Username NWS:</label>
                        <input type="text" id="username" placeholder="Seu ID de usuário">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Senha (SHA-512):</label>
                        <input type="password" id="password" placeholder="Sua chave de acesso">
                    </div>
                    <div style="margin-top: 15px;">
                        <button onclick="registrar()" class="btn-secondary">Criar Conta IAM</button>
                        <button onclick="fazerLoginSalvar()" class="btn-success">Entrar e Salvar DB</button>
                        <button onclick="limparSessaoDB()" class="btn-danger btn-sm">Esquecer Sessão</button>
                    </div>
                    <p id="authMsg"></p>
                </div>

                <!-- Widget: Computação e Sites Hospedados -->
                <div class="widget deploy-widget">
                    <div class="widget-title">2. Computação KV (Deploy de Sites Estáticos)</div>
                    <div class="form-group">
                        <label class="form-label">Nome do Site:</label>
                        <input type="text" id="siteName" placeholder="Ex: Meu Portfolio Profissional">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Código HTML Bruto:</label>
                        <textarea id="siteHtml" class="deploy-html" placeholder="<h1>Olá do NWS Enterprise Global!</h1>"></textarea>
                    </div>
                    <button onclick="fazerDeploy()" id="btnDeploy">OK (Deploy Instantâneo)</button>
                    <div class="link-box" id="resultadoDeploy"></div>
                </div>

                <!-- Widget: Gerenciador de Sites Existentes -->
                <div class="widget existing-sites-widget">
                    <div class="widget-title">Gerenciador de Sites NWS de Verdade (Editar / Remover)</div>
                    <button onclick="carregarSitesExistentes()" class="btn-sm btn-secondary">Atualizar Lista de Sites</button>
                    <div class="sites-table-container" id="sitesTableContainer">
                        <p class="text-muted" style="font-size: 0.9rem; text-align: center; margin-top: 20px;">Clique em 'Atualizar Lista' para carregar os sites hospedados de verdade.</p>
                    </div>
                </div>

                <!-- Widget: Banco de Dados -->
                <div class="widget">
                    <div class="widget-title">3. Banco de Dados D1 (nwsuserdatabases)</div>
                    <div class="form-group">
                        <label class="form-label">Nome do Banco:</label>
                        <input type="text" id="dbName" placeholder="Ex: meu_banco_producao">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Definição do Schema (SQL):</label>
                        <textarea id="dbSchema" placeholder="CREATE TABLE clientes (id INT, nome TEXT, email TEXT);"></textarea>
                    </div>
                    <button onclick="criarBanco()">Criar Banco no NWSD1</button>
                    <p id="dbMsg"></p>
                </div>

            </div>
        </div>
    </main>

    <!-- --- Modais --- -->

    <!-- Modal de Edição de HTML de Verdade -->
    <div class="modal" id="editHtmlModal">
        <div class="modal-content">
            <header class="modal-header">
                <h2 class="modal-title" id="editModalTitle">Editar HTML do Site</h2>
                <button onclick="fecharModalEdicao()" class="close-modal">&times;</button>
            </header>
            <div class="modal-body">
                <input type="hidden" id="editSiteUuid">
                <textarea class="html-editor" id="htmlEditorArea" spellcheck="false"></textarea>
            </div>
            <footer class="modal-footer">
                <button onclick="fecharModalEdicao()" class="btn-secondary btn-sm">Cancelar</button>
                <button onclick="salvarAlteracoesHTML()" class="btn-success btn-sm" id="btnSalvarEdicao">Salvar Alterações (NWSKV)</button>
            </footer>
        </div>
    </div>

    <script>
        // --- Configurações e Estado Global ---
        const API_URL = ''; // URL base relativa para APIs
        
        // Estado do WebSocket de Logs
        let wsLogs = null;
        let reconectarWsInterval = null;

        // Efeito de Iluminação Dinâmica Enterprise baseada na posição exata do cursor
        window.addEventListener('mousemove', (e) => {
            const x = (e.clientX / window.innerWidth) * 100;
            const y = (e.clientY / window.innerHeight) * 100;
            document.documentElement.style.setProperty('--mouse-x', x + '%');
            document.documentElement.style.setProperty('--mouse-y', y + '%');
        });

        // --- Gerenciamento do IndexedDB para Autenticação Persistente Automática ---
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
                document.getElementById('authMsg').innerText = "Sessão removida do IndexedDB de verdade.";
                document.getElementById('authMsg').style.color = 'var(--accent-blue)';
            } catch (e) { console.error(e); }
        }

        // Helper para obter credenciais atuais (dos campos ou do DB)
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


        // --- Inicialização e Controle da Tela de Carregamento ---
        window.addEventListener('load', async () => {
            // Executar auto-login silencioso via IndexedDB
            try {
                const savedCreds = await lerDoIndexedDB();
                if (savedCreds && savedCreds.username && savedCreds.password) {
                    document.getElementById('username').value = savedCreds.username;
                    document.getElementById('password').value = savedCreds.password;
                    
                    // Validação silenciosa no backend
                    const res = await fetch(\`\${API_URL}/api/login\`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ username: savedCreds.username, password: savedCreds.password })
                    });
                    
                    if (res.ok) {
                        document.getElementById('autoLoginBadge').style.display = 'inline-block';
                        // Carrega sites existentes automaticamente se logado
                        carregarSitesExistentes();
                        // Conecta logs automaticamente
                        conectarWebSocketLogs();
                    }
                }
            } catch (e) { console.error("Erro no auto-login silencioso:", e); }

            // Ocultar Tela de Carregamento Enterprise suavemente após o carregamento inicial
            setTimeout(() => {
                const loader = document.getElementById('loadingScreen');
                loader.classList.add('fade-out');
                setTimeout(() => loader.remove(), 800);
            }, 1000);
        });


        // --- Funções de Autenticação das APIs NWS ---

        async function registrar() {
            const username = document.getElementById('username').value;
            const password = document.getElementById('password').value;
            const msgEl = document.getElementById('authMsg');
            
            if (!username || !password) { msgEl.innerText = "Username e senha obrigatórios."; return; }

            try {
                const res = await fetch(\`\${API_URL}/api/register\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password })
                });
                const data = await res.json();
                msgEl.innerText = data.sucesso ? data.mensagem : \`Erro: \${data.erro}\`;
                msgEl.style.color = data.sucesso ? 'var(--success-green)' : 'var(--error-red)';
            } catch (e) { msgEl.innerText = "Erro na requisição de registro."; msgEl.style.color = 'var(--error-red)'; }
        }

        async function fazerLoginSalvar() {
            const username = document.getElementById('username').value;
            const password = document.getElementById('password').value;
            const msgEl = document.getElementById('authMsg');
            
            if (!username || !password) { msgEl.innerText = "Username e senha obrigatórios."; return; }

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
                    msgEl.innerText = "Login bem-sucedido de verdade! Credenciais salvas no IndexedDB.";
                    msgEl.style.color = 'var(--success-green)';
                    carregarSitesExistentes(); // Atualiza lista de sites
                    conectarWebSocketLogs(); // Conecta logs
                } else {
                    msgEl.innerText = \`Erro: \${data.erro}\`;
                    msgEl.style.color = 'var(--error-red)';
                }
            } catch (e) { msgEl.innerText = "Erro na requisição de login."; msgEl.style.color = 'var(--error-red)'; }
        }


        // --- Funções de Computação (Deploy e Gerenciamento de Sites) ---

        async function fazerDeploy() {
            const creds = await obterCredenciais();
            if (!creds) { alert("Autenticação necessária. Faça login primeiro."); return; }

            const nome = document.getElementById('siteName').value;
            const html = document.getElementById('siteHtml').value;
            const btn = document.getElementById('btnDeploy');
            const resBox = document.getElementById('resultadoDeploy');

            if (!nome || !html) { alert("Nome do site e HTML são obrigatórios."); return; }

            btn.disabled = true;
            btn.innerText = "Fazendo Deploy de Verdade...";
            resBox.innerText = "Comunicando com NWSD1 e NWSKV Enterprise...";
            resBox.style.color = 'var(--accent-orange)';

            try {
                const res = await fetch(\`\${API_URL}/api/deploy\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ...creds, nome, html })
                });
                const data = await res.json();
                
                if (res.ok) {
                    resBox.innerHTML = \`Deploy concluído de verdade! Acesse instantaneamente: <a href="\${data.url}" target="_blank" class="site-url-link">\${data.url}</a>\`;
                    resBox.style.color = 'var(--success-green)';
                    document.getElementById('siteName').value = '';
                    document.getElementById('siteHtml').value = '';
                    carregarSitesExistentes(); // Atualiza a lista automaticamente
                } else {
                    resBox.innerText = \`Erro no Deploy: \${data.erro}\`;
                    resBox.style.color = 'var(--error-red)';
                }
            } catch (e) { resBox.innerText = "Erro crítico na requisição de deploy."; resBox.style.color = 'var(--error-red)'; }
            finally { btn.disabled = false; btn.innerText = "OK (Deploy Instantâneo)"; }
        }

        // Carrega lista de sites do backend de verdade
        async function carregarSitesExistentes() {
            const creds = await obterCredenciais();
            const container = document.getElementById('sitesTableContainer');
            
            if (!creds) { container.innerHTML = '<p class="text-muted" style="font-size: 0.9rem; text-align: center;">Faça login para gerenciar sites existentes de verdade.</p>'; return; }

            container.innerHTML = '<p class="text-muted" style="text-align:center;">Consultando metadados no NWSD1...</p>';

            try {
                const res = await fetch(\`\${API_URL}/api/get-sites\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(creds)
                });
                const data = await res.json();

                if (res.ok && data.sites && data.sites.length > 0) {
                    let tableHtml = \`
                        <table class="sites-table">
                            <thead>
                                <tr>
                                    <th>Nome do Site</th>
                                    <th>UUID (ID KV)</th>
                                    <th>Link Global</th>
                                    <th>Ações de Verdade</th>
                                </tr>
                            </thead>
                            <tbody>
                    \`;
                    
                    data.sites.forEach(site => {
                        // Constrói a URL de acesso baseada no UUID
                        const siteUrl = \`\${window.location.origin}/\${site.uuid}\`;
                        tableHtml += \`
                            <tr>
                                <td><strong>\${site.nome}</strong></td>
                                <td class="text-muted">\${site.uuid}</td>
                                <td><a href="\${siteUrl}" target="_blank" class="site-url-link">Acessar</a></td>
                                <td class="action-btn-group">
                                    <button onclick="abrirModalEdicao('\${site.uuid}', '\${site.nome}')" class="btn-sm btn-secondary">Editar HTML</button>
                                    <button onclick="removerSiteDeVerdade('\${site.uuid}', '\${site.nome}')" class="btn-sm btn-danger">Remover</button>
                                </td>
                            </tr>
                        \`;
                    });
                    
                    tableHtml += '</tbody></table>';
                    container.innerHTML = tableHtml;
                } else if (res.ok) {
                    container.innerHTML = '<p class="text-muted" style="font-size: 0.9rem; text-align: center; margin-top: 20px;">Nenhum site hospedado de verdade nesta conta NWS.</p>';
                } else {
                    container.innerHTML = \`<p class="text-muted" style="text-align:center; color: var(--error-red);">Erro ao carregar sites do NWSD1: \${data.erro}</p>\`;
                }
            } catch (e) { container.innerHTML = '<p class="text-muted" style="text-align:center; color: var(--error-red);">Erro crítico na requisição de listagem de sites.</p>'; }
        }

        // Função para remover site do ar de verdade permanentemente
        async function removerSiteDeVerdade(uuid, nome) {
            const creds = await obterCredenciais();
            if (!creds) { alert("Sessão expirada. Faça login novamente."); return; }

            if (!confirm(\`TEM CERTEZA DE VERDADE?\\n\\nIsso removerá o site '\${nome}' permanentemente do NWSKV e os metadados do NWSD1.\\n\\nEsta ação NÃO PODE ser desfeita.\`)) {
                return;
            }

            try {
                const res = await fetch(\`\${API_URL}/api/delete-site\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ...creds, uuid })
                });
                const data = await res.json();
                
                if (res.ok) {
                    alert(\`Sucesso de Verdade:\\n\\n\${data.mensagem}\`);
                    carregarSitesExistentes(); // Atualiza a lista automaticamente
                } else {
                    alert(\`Erro ao remover site de verdade:\\n\\n\${data.erro}\`);
                }
            } catch (e) { alert("Erro crítico na requisição de remoção de site."); }
        }


        // --- Funções de Edição de HTML de Verdade (NWSKV) ---

        // Abre o modal de edição e carrega o HTML atual de verdade
        async function abrirModalEdicao(uuid, nome) {
            const creds = await obterCredenciais();
            if (!creds) { alert("Sessão expirada. Faça login novamente."); fecharModalEdicao(); return; }

            const modal = document.getElementById('editHtmlModal');
            const titleEl = document.getElementById('editModalTitle');
            const editor = document.getElementById('htmlEditorArea');
            const uuidInput = document.getElementById('editSiteUuid');
            const btnSalvar = document.getElementById('btnSalvarEdicao');

            titleEl.innerText = \`Editando HTML de Verdade: \${nome}\`;
            uuidInput.value = uuid;
            editor.value = "Carregando conteúdo real do NWSKV Enterprise...";
            editor.disabled = true;
            btnSalvar.disabled = true;
            
            modal.classList.add('open');

            try {
                // Requisição GET simples para obter o conteúdo HTML atual de verdade
                const res = await fetch(\`\${API_URL}/\${uuid}\`);
                if (res.ok) {
                    const htmlContent = await res.text();
                    editor.value = htmlContent;
                    editor.disabled = false;
                    btnSalvar.disabled = false;
                } else {
                    editor.value = "Erro ao carregar conteúdo real do site hospedado.";
                }
            } catch (e) { editor.value = "Erro crítico ao tentar buscar conteúdo real do NWSKV."; }
        }

        function fecharModalEdicao() {
            document.getElementById('editHtmlModal').classList.remove('open');
            // Limpa o editor para próxima edição
            document.getElementById('htmlEditorArea').value = '';
        }

        // Salva as alterações HTML no NWSKV de verdade
        async function salvarAlteracoesHTML() {
            const creds = await obterCredenciais();
            if (!creds) { alert("Sessão expirada. Faça login novamente."); fecharModalEdicao(); return; }

            const uuid = document.getElementById('editSiteUuid').value;
            const html = document.getElementById('htmlEditorArea').value;
            const btn = document.getElementById('btnSalvarEdicao');

            if (!confirm("Confirmar salvamento de alterações de HTML de verdade no NWSKV Enterprise?")) { return; }

            btn.disabled = true;
            btn.innerText = "Salvando no NWSKV de Verdade...";

            try {
                const res = await fetch(\`\${API_URL}/api/edit-site\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ...creds, uuid, html })
                });
                const data = await res.json();
                
                if (res.ok) {
                    alert(\`Sucesso de Verdade:\\n\\n\${data.mensagem}\`);
                    fecharModalEdicao();
                    carregarSitesExistentes(); // Atualiza lista para refletir mudanças se necessário
                } else {
                    alert(\`Erro ao salvar HTML real:\\n\\n\${data.erro}\`);
                    btn.disabled = false;
                    btn.innerText = "Salvar Alterações (NWSKV)";
                }
            } catch (e) { alert("Erro crítico na requisição de salvamento de HTML."); btn.disabled = false; btn.innerText = "Salvar Alterações (NWSKV)"; }
        }


        // --- Funções do Console de Logs HTTP em Tempo Real via wss:// de Verdade ---

        function atualizarUIWebSocket(status) {
            const dot = document.getElementById('wsStatusDot');
            const text = document.getElementById('wsStatusText');
            const btnConectar = document.getElementById('btnConectarLogs');
            const btnDesconectar = document.getElementById('btnDesconectarLogs');

            dot.className = 'ws-status-dot'; // Reseta classes
            btnConectar.disabled = true;
            btnDesconectar.disabled = true;

            switch(status) {
                case 'conectado':
                    dot.classList.add('connected');
                    text.innerText = 'Conectado (wss://) - Logs HTTP em Tempo Real de Verdade';
                    text.style.color = 'var(--success-green)';
                    btnDesconectar.disabled = false;
                    break;
                case 'conectando':
                    dot.classList.add('connecting');
                    text.innerText = 'Conectando ao LogHub Enterprise...';
                    text.style.color = 'var(--accent-orange)';
                    break;
                case 'desconectado':
                default:
                    // dot padrão vermelho
                    text.innerText = 'Desconectado - Logs HTTP Parados de Verdade';
                    text.style.color = 'var(--error-red)';
                    btnConectar.disabled = false;
                    break;
            }
        }

        // Conecta ao WebSocket de logs de verdade
        async function conectarWebSocketLogs() {
            if (wsLogs && wsLogs.readyState === WebSocket.OPEN) { return; } // Já conectado
            if (!await obterCredenciais()) { alert("Faça login IAM para acessar logs HTTP de verdade em tempo real."); return; }

            desconectarWebSocketLogs(); // Garante limpeza anterior

            const consoleEl = document.getElementById('logsConsole');
            consoleEl.innerHTML += \`<div class="log-line text-muted">> Iniciando conexão wss:// de verdade...</div>\`;
            scrollConsoleParaBaixo();
            
            atualizarUIWebSocket('conectando');

            // Determina protocolo WS baseado no protocolo HTTP atual (seguro ou não)
            const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            // Constrói URL completa para a API do WebSocket
            const wsUrl = \`\${wsProtocol}//\${window.location.host}/api/logs-ws\`;

            wsLogs = new WebSocket(wsUrl);

            wsLogs.onopen = () => {
                atualizarUIWebSocket('conectado');
                consoleEl.innerHTML += \`<div class="log-line" style="color: var(--success-green);">>> Conexão WebSocket de Logs Estabelecida de Verdade com NWS LogHub Enterprise.</div>\`;
                scrollConsoleParaBaixo();
                // Limpa tentativas de reconexão automática se houver
                if (reconectarWsInterval) { clearInterval(reconectarWsInterval); reconectarWsInterval = null; }
            };

            wsLogs.onmessage = (event) => {
                try {
                    const message = JSON.parse(event.data);
                    if (message.type === 'log' && message.data) {
                        adicionarLogNoConsole(message.data);
                    }
                } catch (e) { console.error("Erro ao processar mensagem WebSocket real:", e); }
            };

            wsLogs.onclose = (event) => {
                atualizarUIWebSocket('desconectado');
                // Se não foi fechado intencionalmente, agenda reconexão automática
                if (!reconectarWsInterval && event.code !== 1000) {
                    consoleEl.innerHTML += \`<div class="log-line text-muted">> Conexão real wss:// fechada inesperadamente. Tentando reconectar automaticamente de verdade em 5 segundos...</div>\`;
                    reconectarWsInterval = setInterval(conectarWebSocketLogs, 5000);
                } else if (event.code === 1000) {
                     consoleEl.innerHTML += \`<div class="log-line text-muted">>> Conexão WebSocket de logs fechada intencionalmente pelo operador de verdade.</div>\`;
                } else {
                     consoleEl.innerHTML += \`<div class="log-line text-muted">> Conexão real wss:// fechada. Aguardando reconexão automática já agendada...</div>\`;
                }
                scrollConsoleParaBaixo();
                wsLogs = null;
            };

            wsLogs.onerror = (error) => {
                // Erros de conexão geralmente geram um evento onclose em seguida, então logamos apenas erro genérico
                consoleEl.innerHTML += \`<div class="log-line" style="color: var(--error-red);">> Erro crítico na conexão wss:// de logs reais. Consulte console do navegador.</div>\`;
                scrollConsoleParaBaixo();
                atualizarUIWebSocket('desconectado');
            };
        }

        // Desconecta intencionalmente do WebSocket de logs reais
        function desconectarWebSocketLogs() {
             // Limpa tentativas de reconexão automática se houver
            if (reconectarWsInterval) { clearInterval(reconectarWsInterval); reconectarWsInterval = null; }
            
            if (wsLogs) {
                // Fecha conexão intencionalmente com código 1000 (Normal Closure)
                wsLogs.close(1000); 
                wsLogs = null;
            }
            atualizarUIWebSocket('desconectado');
        }

        // Adiciona uma linha de log formatada de verdade no console UI
        function adicionarLogNoConsole(log) {
            const consoleEl = document.getElementById('logsConsole');
            
            // Cria elemento de linha de log formatado
            const logLine = document.createElement('div');
            logLine.className = 'log-line';
            
            // Formata timestamp (apenas horário local)
            const date = new Date(log.timestamp);
            const timeStr = date.toLocaleTimeString('pt-BR');
            
            // Determina classe CSS baseada no status HTTP real
            let statusClass = 'log-status';
            if (log.status >= 200 && log.status < 300) statusClass += ' 200';
            else if (log.status === 404) statusClass += ' 404';
            else if (log.status >= 500) statusClass += ' 500';

            // Monta HTML da linha de log HTTP formatado de verdade
            logLine.innerHTML = \`
                <span class="log-ts">[\${timeStr}]</span> 
                <span class="log-method \${log.method}">\${log.method}</span> 
                <span class="log-url">\${log.url}</span> 
                -> 
                <span class="\${statusClass}">\${log.status}</span> 
                <span class="log-ip">(\${log.ip})</span>
            \`;
            
            consoleEl.appendChild(logLine);
            scrollConsoleParaBaixo();
        }

        function scrollConsoleParaBaixo() {
            const consoleEl = document.getElementById('logsConsole');
            // Mantém console rolado para o final automaticamente de verdade
            consoleEl.scrollTop = consoleEl.scrollHeight;
        }

        function limparLogsConsole() {
            document.getElementById('logsConsole').innerHTML = \`<div class="log-line text-muted">> Console de logs reais limpo pelo operador. wss:// ativo: \${wsLogs && wsLogs.readyState === WebSocket.OPEN ? 'Sim' : 'Não'}.</div>\`;
        }
    </script>
</body>
</html>`;

    return new Response(htmlDashboard, {
      headers: { 'Content-Type': 'text/html;charset=UTF-8' }
    });
  },
};
