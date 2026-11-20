// SGC Desbravadores MSC — aplicação (PWA). Fase 1.
'use strict';

const TIPOS = ['Desbravador', 'Líder', 'Conselheiro', 'Instrutor', 'Director', 'Director associado', 'Secretário', 'Tesoureiro', 'Capelão'];
const CLASSE_IDADE = [[10, 'Amigo'], [11, 'Companheiro'], [12, 'Pesquisador'], [13, 'Pioneiro'], [14, 'Excursionista'], [15, 'Guia']];
const LEITURAS = new Set(['provas', 'plano', 'inspecoes', 'mapaClubes', 'delegados', 'emRisco', 'notificacoes', 'fichaMembro', 'classificacao', 'comunicados', 'transferencias', 'solicitacoes', 'relatorio', 'estadoRelatorios', 'trimestral', 'movimentos', 'resumoFinancas', 'pagamentos', 'eventos', 'inscricoesEvento', 'resumoEvento', 'fichaClube', 'inicio', 'painel', 'membros', 'utilizadores', 'requisitos', 'classes', 'cartaoClasse', 'especialidades', 'actividades', 'actividade', 'criterios', 'ranking']);
const FILA = new Set(['guardarActividade']);
// Sem rede, estes ecrãs mostram a última versão guardada mesmo que os filtros/datas sejam outros.
const ULTIMO = new Set(['inicio', 'painel', 'notificacoes', 'comunicados', 'classificacao', 'requisitos', 'eventos', 'solicitacoes', 'transferencias']);
const PARAM_M = new URLSearchParams(location.search).get('m');
const S = { token: ler('sgc_token'), eu: null, regioes: [], clubes: [], clube_id: ler('sgc_clube'), aba: new URLSearchParams(location.search).get('aba') || 'painel', instalar: null, offline: false };

/* ---------- utilitários ---------- */
function ler(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function gravar(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} }
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const opts = (lista, sel, vazio) => (vazio !== undefined ? `<option value="">${esc(vazio)}</option>` : '') +
  lista.map(o => { const [v, t] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(v)}"${String(v) === String(sel ?? '') ? ' selected' : ''}>${esc(t)}</option>`; }).join('');
const nomeRegiao = (id) => (S.regioes.find(r => r.id === id) || {}).nome || '—';
const nomeClube = (id) => (S.clubes.find(c => c.id === id) || {}).nome || '—';
function idade(d) { if (!d) return null; const n = new Date(d), h = new Date(); let a = h.getFullYear() - n.getFullYear(); if (h < new Date(h.getFullYear(), n.getMonth(), n.getDate())) a--; return a; }
function classeIdade(a) { if (a == null) return ''; let c = ''; for (const [i, n] of CLASSE_IDADE) if (a >= i) c = n; return a >= 10 ? c : ''; }
function iniciais(n) { return String(n || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0]).join('').toUpperCase(); }

function aviso(msg, erro) {
  const t = document.createElement('div'); t.className = 'toast' + (erro ? ' erro' : ''); t.textContent = msg;
  document.body.appendChild(t); setTimeout(() => t.remove(), erro ? 4500 : 2500);
}

async function api(accao, p = {}) {
  const chave = 'sgc_c_' + accao + '_' + (accao === 'inicio' ? '' : JSON.stringify(p));
  let r;
  try {
    const res = await fetch('/api', { method: 'POST', headers: { 'content-type': 'application/json', ...(S.token ? { authorization: 'Bearer ' + S.token } : {}) },
      body: JSON.stringify({ accao, p }) });
    r = await res.json();
    if (S.offline) { S.offline = false; marcarOffline(); }
  } catch (e) {
    if (LEITURAS.has(accao)) {
      const c = ler(chave) || (ULTIMO.has(accao) ? ler('sgc_cu_' + accao) : null);
      if (c) { S.offline = true; marcarOffline(); return JSON.parse(c); }
    }
    if (FILA.has(accao) && !p._fila) { porNaFila(accao, p); S.offline = true; marcarOffline(); return { _fila: true }; }
    throw new Error('Sem ligação à internet.');
  }
  if (!r.ok) {
    if (r.sessao === false) { sairLocal(); throw new Error(r.erro); }
    throw new Error(r.erro || 'Erro.');
  }
  if (LEITURAS.has(accao)) { const j = JSON.stringify(r.dados); gravar(chave, j); if (ULTIMO.has(accao)) gravar('sgc_cu_' + accao, j); }
  return r.dados;
}
function marcarOffline() {
  const b = $('#offline'); if (!b) return;
  const n = fila().length;
  b.hidden = !S.offline && !n;
  b.textContent = (S.offline ? 'Sem ligação — a mostrar os últimos dados guardados.' : '') + (n ? ` ${n} registo(s) por enviar.` : '');
}
/* Fila de registos feitos sem rede (presenças). Envia-se sozinha quando a rede volta. */
function fila() { try { return JSON.parse(ler('sgc_fila') || '[]'); } catch (e) { return []; } }
function porNaFila(accao, p) { const f = fila().filter(x => !(x.accao === accao && x.p.registo && p.registo && x.p.registo.id === p.registo.id)); f.push({ accao, p }); gravar('sgc_fila', JSON.stringify(f)); }
let aEnviar = false;
async function enviarFila() {
  if (aEnviar || !S.token || !navigator.onLine) return; const f = fila(); if (!f.length) return;
  aEnviar = true; let enviados = 0;
  try {
    for (const it of f) {
      try { await api(it.accao, Object.assign({}, it.p, { _fila: 1 })); }
      catch (e) { if (/ligação/.test(e.message)) break; aviso('Registo não enviado: ' + e.message, true); }
      gravar('sgc_fila', JSON.stringify(fila().slice(1))); enviados++;
    }
  } finally { aEnviar = false; marcarOffline(); }
  if (enviados) { aviso(enviados + ' registo(s) enviados.'); if (S.aba === 'presencas') abrir('presencas'); }
}
window.addEventListener('online', enviarFila);
setInterval(enviarFila, 60000);

function modal(html, aoAbrir) {
  const m = document.createElement('div'); m.className = 'modal';
  m.innerHTML = `<div class="caixa">${html}</div>`;
  m.addEventListener('click', e => { if (e.target === m) m.remove(); });
  document.body.appendChild(m);
  $$('[data-fechar]', m).forEach(b => b.onclick = () => m.remove());
  if (aoAbrir) aoAbrir(m);
  return m;
}
function lerForm(el) {
  const o = {};
  $$('[name]', el).forEach(i => { o[i.name] = i.type === 'checkbox' ? (i.checked ? 1 : 0) : i.value.trim(); });
  return o;
}
async function ocupado(btn, fn) {
  btn.disabled = true;
  try { await fn(); } catch (e) { aviso(e.message, true); } finally { btn.disabled = false; }
}

/* ---------- ícones ---------- */
const IC = {
  painel: '<path d="M3 13h8V3H3zM13 21h8V11h-8zM3 21h8v-6H3zM13 3v6h8V3z"/>',
  membros: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  clube: '<path d="M3 21h18M5 21V8l7-5 7 5v13"/><path d="M9 21v-6h6v6"/>',
  admin: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-2.82 1.17V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-2.82-1.17l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 3 13.1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.17-2.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9.9 3V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 2.82 1.17l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 21 9.9V10a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  presencas: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  classes: '<circle cx="12" cy="8" r="6"/><path d="M15.48 12.89L17 22l-5-3-5 3 1.52-9.11"/>',
  merito: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
  relatorio: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h8M8 9h2"/>',
  financas: '<rect x="2" y="6" width="20" height="13" rx="2"/><path d="M2 10h20M6 15h4"/>',
  eventos: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  comunicados: '<path d="M3 11l18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
  pedidos: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  sino: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
  agenda: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/><path d="M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01"/>',
  escala: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/>',
  ajuda: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  conta: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/>'
};
const ABAS = [['painel', 'Painel'], ['comunicados', 'Avisos'], ['agenda', 'Agenda'], ['membros', 'Membros'], ['presencas', 'Presenças'], ['classes', 'Classes'], ['provas', 'Provas'], ['merito', 'Mérito'], ['relatorio', 'Relatório'], ['financas', 'Finanças'], ['eventos', 'Eventos'], ['pedidos', 'Pedidos'], ['escala', 'Escala'], ['clube', 'Clube'], ['admin', 'Gestão'], ['ajuda', 'Ajuda'], ['conta', 'Conta / Sair']];

/* ---------- arranque ---------- */
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); S.instalar = e; });
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));

async function arrancar() {
  if (location.search) history.replaceState(null, '', '/');
  if (S.token) idbSet('token', S.token);
  if (S.token) {
    try { await carregarInicio(); return montar(); } catch (e) { if (!S.token) return ecraLogin(e.message); return ecraLogin(e.message); }
  }
  try { const est = await api('estado'); return est.instalado ? ecraLogin() : ecraInstalar(); }
  catch (e) { $('#app').innerHTML = `<div class="entrada"><div class="card"><h1>SGC MSC</h1><p>${esc(e.message)}</p><button class="btn" onclick="location.reload()">Tentar de novo</button></div></div>`; }
}
async function carregarInicio() {
  const d = await api('inicio');
  S.eu = d.eu; S.regioes = d.regioes; S.clubes = d.clubes;
  if (S.eu.papel === 'DIRECTOR') S.clube_id = S.eu.clube_id;
  if (!S.clubes.some(c => c.id === S.clube_id)) S.clube_id = S.clubes[0] ? S.clubes[0].id : null;
  gravar('sgc_clube', S.clube_id);
}
function sairLocal() { S.token = null; gravar('sgc_token', null); idbSet('token', null); }
async function terminarSessao() {
  try { await api('sair'); } catch (e) {}
  sairLocal(); clearTimeout(sinoT); if (navigator.clearAppBadge) navigator.clearAppBadge().catch(() => {});
  $$('.menuU,.notifP,.modal').forEach(x => x.remove()); ecraLogin(); aviso('Sessão terminada.');
}
function abrirMenuConta() {
  const ex = $('.menuU'); if (ex) { ex.remove(); return; }
  const papel = { MSC: 'Missão (MSC)', REGIONAL: 'Regional · ' + nomeRegiao(S.eu.regiao_id), DIRECTOR: 'Director · ' + nomeClube(S.eu.clube_id) }[S.eu.papel];
  const mn = document.createElement('div'); mn.className = 'menuU';
  mn.innerHTML = `<div class="mu-c"><div class="avt g">${esc(iniciais(S.eu.nome))}</div><div><b>${esc(S.eu.nome)}</b><small>${esc(S.eu.email)}</small><small>${esc(papel)}</small></div></div>
    <button id="muConta">A minha conta e palavra-passe</button><button id="muSair" class="sair">Terminar sessão</button>`;
  document.body.appendChild(mn);
  const fora = (e) => { if (!mn.contains(e.target) && !e.target.closest('#avt')) { mn.remove(); document.removeEventListener('click', fora, true); } };
  setTimeout(() => document.addEventListener('click', fora, true), 0);
  $('#muConta', mn).onclick = () => { mn.remove(); abrir('conta'); };
  $('#muSair', mn).onclick = terminarSessao;
}

function ecraEntrada(titulo, sub, campos, botao, accao) {
  $('#app').innerHTML = `<div class="entrada"><form class="card" autocomplete="on">
    <img class="logo" src="/icons/logo.png" alt="Missão Sul de Luanda e Cabinda"><h1>${titulo}</h1><p>${sub}</p>${campos}
    <button class="btn" type="submit">${botao}</button></form></div>`;
  const f = $('.entrada form');
  f.onsubmit = (e) => { e.preventDefault(); ocupado($('button', f), async () => {
    const d = await api(accao, lerForm(f)); S.token = d.token; gravar('sgc_token', d.token); idbSet('token', d.token); await carregarInicio(); montar();
  }); };
}
function ecraLogin(msg) {
  if (PARAM_M && !msg) msg = 'Cartão de membro do SGC: entre com a sua conta para ver a ficha.';
  ecraEntrada('SGC Desbravadores', 'Missão Sul de Luanda e Cabinda',
    `<label>Email</label><input name="email" type="email" autocomplete="username" required>
     <label>Palavra-passe</label><input name="senha" type="password" autocomplete="current-password" required>`, 'Entrar', 'login');
  const a = document.createElement('button'); a.type = 'button'; a.className = 'link'; a.textContent = 'Esqueci a palavra-passe';
  $('.entrada form').appendChild(a); a.onclick = esqueciSenha;
  if (msg) aviso(msg, !msg.startsWith('Cartão de membro'));
}
function ecraInstalar() {
  ecraEntrada('Instalar o SGC', 'Crie a conta do administrador da Missão. Só é pedido uma vez.',
    `<label>Nome</label><input name="nome" required>
     <label>Email</label><input name="email" type="email" autocomplete="username" required>
     <label>Palavra-passe (mínimo 8 caracteres)</label><input name="senha" type="password" minlength="8" autocomplete="new-password" required>`,
    'Criar administrador', 'instalar');
}

/* ---------- estrutura ---------- */
function abasVisiveis() { return ABAS.filter(([k]) => !['admin', 'escala'].includes(k) || S.eu.papel !== 'DIRECTOR'); }
function montar() {
  const escolheClube = S.eu.papel !== 'DIRECTOR' && S.clubes.length > 0;
  $('#app').innerHTML = `<header><img class="hlogo" src="/icons/logo.png" alt=""><h1>SGC MSC</h1><span class="esp"></span>
      ${escolheClube ? `<select id="selClube">${opts(S.clubes.map(c => [c.id, c.nome]), S.clube_id)}</select>` : `<span class="hclube">${esc(nomeClube(S.clube_id))}</span>`}
      <button class="sino" id="sino" aria-label="Notificações"><svg viewBox="0 0 24 24">${IC.sino}</svg><span class="b" id="sinoN" hidden></span></button>
      <button class="bsair" id="bsair" title="Terminar sessão / mudar de conta"><svg viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/></svg><span>Sair</span></button>
    </header><div id="offline" class="offline" hidden>Sem ligação — a mostrar os últimos dados guardados.</div>
    <main id="main"></main><div id="tip" hidden></div>
    <nav>${abasVisiveis().map(([k, t]) => `<button data-aba="${k}"><span class="ic"><svg viewBox="0 0 24 24">${IC[k]}</svg></span>${t}</button>`).join('')}</nav>`;
  if (escolheClube) $('#selClube').onchange = (e) => { S.clube_id = e.target.value; gravar('sgc_clube', S.clube_id); if (S.aba === 'painel') { S.pClube = S.clube_id; S.pReg = ''; } abrir(S.aba); };
  $$('nav button').forEach(b => b.onclick = () => abrir(b.dataset.aba));
  ligarSwipe();
  marcarOffline();
  $('#sino').onclick = abrirSino;
  $('#bsair').onclick = () => { if (confirm(`Terminar a sessão de ${S.eu.nome}?\nDepois pode entrar com outra conta.`)) terminarSessao(); };
  abrir(S.aba);
  enviarFila();
  actualizarSino();
  if (PARAM_M && !S.mVisto) { S.mVisto = true; verFicha(PARAM_M).catch(e => aviso(e.message === 'Sem permissão para esta acção.' ? 'Este cartão é de um clube que a sua conta não pode ver.' : e.message, true)); }
}
function abrir(aba, dir) {
  S.aba = aba;
  $$('nav button').forEach(b => b.classList.toggle('on', b.dataset.aba === aba));
  const on = $('nav button.on'); if (on) on.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  const mm = $('#main'); if (mm && dir) { mm.classList.remove('desl-e', 'desl-d'); void mm.offsetWidth; mm.classList.add(dir > 0 ? 'desl-e' : 'desl-d'); }
  const m = $('#main'); m.innerHTML = '<div class="vazio">A carregar…</div>'; window.scrollTo(0, 0);
  ({ provas: vProvas, agenda: vAgenda, escala: vEscala, ajuda: vAjuda, comunicados: vComunicados, pedidos: vPedidos, painel: vPainel, membros: vMembros, presencas: vPresencas, classes: vClasses, merito: vMerito, relatorio: vRelatorio, financas: vFinancas, eventos: vEventos, clube: vClube, admin: vAdmin, conta: vConta })[aba](m).catch(e => { m.innerHTML = `<div class="card vazio">${esc(e.message)}</div>`; });
}

/* ---------- painel (dashboard) ---------- */
const COR = { s1: '#2a78d6', s2: '#eb6834', seq: ['#86b6ef', '#3987e5', '#1c5cab', '#0d366b'], ouro: '#d4a017', azul: '#1f3a5f' };
const fmtN = (n) => (Number(n) || 0).toLocaleString('pt-PT');
// Tooltip único, partilhado por todos os gráficos (elementos com data-tip).
document.addEventListener('pointerover', (e) => { const el = e.target.closest && e.target.closest('[data-tip]'); const t = $('#tip'); if (!t) return; if (el) { t.innerHTML = el.dataset.tip; t.hidden = false; } else t.hidden = true; });
document.addEventListener('pointermove', (e) => { const t = $('#tip'); if (t && !t.hidden) { t.style.left = Math.min(e.clientX + 12, innerWidth - t.offsetWidth - 8) + 'px'; t.style.top = (e.clientY - t.offsetHeight - 12) + 'px'; } });

function gDonut(partes, centro, sub) {
  const tot = partes.reduce((a, x) => a + x.v, 0) || 1; let ang = -90; const R = 52, r = 36, cx = 70, cy = 70;
  const pt = (a, rad) => [cx + rad * Math.cos(a * Math.PI / 180), cy + rad * Math.sin(a * Math.PI / 180)];
  const arcs = partes.filter(x => x.v > 0).map(x => {
    const da = Math.min(359.99, x.v / tot * 360), gap = partes.filter(y => y.v > 0).length > 1 ? 1.2 : 0; const a0 = ang + gap / 2, a1 = ang + da - gap / 2; ang += da;
    const [x0, y0] = pt(a0, R), [x1, y1] = pt(a1, R), [x2, y2] = pt(a1, r), [x3, y3] = pt(a0, r), big = a1 - a0 > 180 ? 1 : 0;
    return `<path d="M${x0},${y0} A${R},${R} 0 ${big} 1 ${x1},${y1} L${x2},${y2} A${r},${r} 0 ${big} 0 ${x3},${y3}Z" fill="${x.c}" data-tip="<b>${esc(x.l)}</b><br>${fmtN(x.v)} (${Math.round(x.v / tot * 100)}%)"/>`;
  }).join('');
  return `<div class="donut"><svg viewBox="0 0 140 140" role="img"><circle class="trilho" cx="70" cy="70" r="44" fill="none" stroke="#edf0f4" stroke-width="16"/>${arcs}
    <text x="70" y="70" text-anchor="middle" class="dn-v">${centro}</text><text x="70" y="88" text-anchor="middle" class="dn-l">${sub}</text></svg>
    <div class="leg">${partes.map(x => `<span><i style="background:${x.c}"></i>${esc(x.l)} <b>${fmtN(x.v)}</b></span>`).join('')}</div></div>`;
}
function gBarrasV(dados, cor, sufixo = '') {
  const max = Math.max(1, ...dados.map(d => d.v)), W = 320, H = 150, B = 22, bw = Math.min(34, (W - 10) / dados.length - 8);
  const passo = (W - 10) / dados.length;
  return `<svg viewBox="0 0 ${W} ${H + B}" class="gr" role="img"><line x1="0" x2="${W}" y1="${H}" y2="${H}" class="eixo"/>
    ${dados.map((d, i) => { const h = d.v / max * (H - 22), x = 5 + i * passo + (passo - bw) / 2, y = H - h;
      return `<g data-tip="<b>${esc(d.l)}</b><br>${fmtN(d.v)}${sufixo}"><rect x="${5 + i * passo}" y="0" width="${passo}" height="${H}" fill="transparent"/>
        ${d.v ? `<path d="M${x},${H} V${y + 4} Q${x},${y} ${x + 4},${y} H${x + bw - 4} Q${x + bw},${y} ${x + bw},${y + 4} V${H}Z" fill="${cor}"/>` : ''}
        <text x="${x + bw / 2}" y="${y - 6}" text-anchor="middle" class="vl">${d.v ? fmtN(d.v) : ''}</text>
        <text x="${x + bw / 2}" y="${H + 15}" text-anchor="middle" class="tk">${esc(d.l)}</text></g>`; }).join('')}</svg>`;
}
function gLinha(pontos) {
  const W = 320, H = 140, T = 12, B = 22, L = 30, n = pontos.length;
  if (!n) return '<div class="vazio">Sem actividades nos últimos meses.</div>';
  const x = (i) => L + (n === 1 ? (W - L) / 2 : i * (W - L - 10) / (n - 1)), y = (v) => T + (100 - v) / 100 * (H - T);
  const val = pontos.map((p, i) => p.v == null ? null : [x(i), y(p.v)]).filter(Boolean);
  const linha = val.map((q, i) => (i ? 'L' : 'M') + q.join(',')).join(' ');
  const area = val.length > 1 ? `${linha} L${val[val.length - 1][0]},${H} L${val[0][0]},${H}Z` : '';
  return `<svg viewBox="0 0 ${W} ${H + B}" class="gr" role="img">
    ${[0, 50, 100].map(v => `<line x1="${L}" x2="${W}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" class="tk">${v}%</text>`).join('')}
    <line x1="${L}" x2="${W}" y1="${y(75)}" y2="${y(75)}" class="meta"/><text x="${L + 4}" y="${y(75) - 4}" class="tk">meta 75%</text>
    ${area ? `<path d="${area}" fill="${COR.s1}" opacity=".12"/>` : ''}<path d="${linha}" fill="none" stroke="${COR.s1}" stroke-width="2"/>
    ${pontos.map((p, i) => `<g data-tip="<b>${esc(p.l)}</b><br>Assiduidade ${p.v == null ? '—' : p.v + '%'}<br>${p.a} actividade(s)">
      <rect x="${x(i) - (W - L) / n / 2}" y="0" width="${(W - L) / n}" height="${H}" fill="transparent"/>
      ${p.v == null ? '' : `<circle cx="${x(i)}" cy="${y(p.v)}" r="4.5" fill="${COR.s1}" stroke="#fff" stroke-width="2"/>`}
      <text x="${x(i)}" y="${H + 15}" text-anchor="middle" class="tk">${esc(p.l)}</text></g>`).join('')}</svg>`;
}
function gAnel(pct, cor) {
  const C = 2 * Math.PI * 30, v = pct == null ? 0 : Math.max(0, Math.min(100, pct));
  return `<svg viewBox="0 0 76 76" class="anel"><circle class="trilho" cx="38" cy="38" r="30" fill="none" stroke="#edf0f4" stroke-width="8"/>
    ${v > 0 ? `<circle cx="38" cy="38" r="30" fill="none" stroke="${cor}" stroke-width="8" stroke-linecap="round" stroke-dasharray="${C * v / 100} ${C}" transform="rotate(-90 38 38)"/>` : ''}
    <text x="38" y="43" text-anchor="middle">${pct == null ? '—' : v + '%'}</text></svg>`;
}
function gEmpilhadas(linhas, ordem, cores) {
  const max = Math.max(1, ...linhas.map(l => ordem.reduce((a, k) => a + (l.v[k] || 0), 0)));
  return `<div class="emp">${linhas.map(l => { const tot = ordem.reduce((a, k) => a + (l.v[k] || 0), 0);
    return `<div class="emp-l"><span class="emp-n">${esc(l.l)}</span><div class="emp-b" style="width:${tot / max * 100}%">${ordem.map((k, i) => l.v[k]
      ? `<i style="flex:${l.v[k]};background:${cores[i]}" data-tip="<b>${esc(l.l)}</b><br>${esc(k)}: ${l.v[k]}"></i>` : '').join('')}</div><b class="emp-t">${tot || ''}</b></div>`; }).join('')}
    <div class="leg">${ordem.map((k, i) => `<span><i style="background:${cores[i]}"></i>${esc(k)}</span>`).join('')}</div></div>`;
}
function gBarrasH(dados, cor, sufixo = '') {
  const max = Math.max(1, ...dados.map(d => d.v));
  return `<div class="hb">${dados.map(d => `<div class="hb-l" data-tip="<b>${esc(d.l)}</b><br>${fmtN(d.v)}${sufixo}"><span>${esc(d.l)}</span>
    <div class="hb-t"><i style="width:${d.v / max * 100}%;background:${cor}"></i></div><b>${fmtN(d.v)}${sufixo}</b></div>`).join('')}</div>`;
}
const delta = (a, b, un = '') => { if (a == null || b == null) return ''; const d = a - b; if (!d) return '<span class="dl">= período anterior</span>';
  return `<span class="dl ${d > 0 ? 'up' : 'dn'}">${d > 0 ? '▲' : '▼'} ${Math.abs(d)}${un} vs período anterior</span>`; };

async function vPainel(m) {
  S.pP = S.pP || 'mes';
  const [de, ate] = S.pP === 'mes' ? [hoje().slice(0, 8) + '01', hoje()] : periodo(S.pP);
  const prm = { de, ate: ate > hoje() ? hoje() : ate };
  if (S.eu.papel === 'DIRECTOR') prm.clube_id = S.eu.clube_id;
  else if (S.pClube) prm.clube_id = S.pClube; else if (S.pReg) prm.regiao_id = S.pReg;
  const d = await api('painel', prm);
  const ambito = prm.clube_id ? nomeClube(prm.clube_id) : prm.regiao_id ? nomeRegiao(prm.regiao_id) : S.eu.papel === 'MSC' ? 'Toda a Missão' : nomeRegiao(S.eu.regiao_id);
  const clubesFiltro = S.clubes.filter(c => !S.pReg || c.regiao_id === S.pReg);
  const mb = d.membros, desb = mb.desbravadores;
  const ESTADOS = ['Inscrito', 'Em curso', 'Concluído', 'Investido'];
  const cls = CLASSES.map(c => ({ l: c, v: Object.fromEntries(ESTADOS.map(e => [e, (d.classes.find(x => x.classe === c && x.estado === e) || {}).n || 0])) }));
  const totCl = d.classes.reduce((a, x) => a + x.n, 0), invest = d.classes.filter(x => x.estado === 'Investido').reduce((a, x) => a + x.n, 0);
  const idades = [[9, '<10'], [10, '10'], [11, '11'], [12, '12'], [13, '13'], [14, '14'], [15, '15'], [16, '16+']].map(([k, l]) => ({ l, v: (d.idades.find(x => String(x.k) === String(k)) || {}).n || 0 }));
  const semData = (d.idades.find(x => x.k === 'Sem data') || {}).n || 0;
  const meses = []; { const f = new Date(prm.ate); for (let i = 5; i >= 0; i--) { const x = new Date(Date.UTC(f.getFullYear(), f.getMonth() - i, 1)); meses.push(x.toISOString().slice(0, 7)); } }
  const serie = meses.map(k => { const x = d.mensal.find(y => y.mes === k) || {}; return { l: MESES[+k.slice(5) - 1].slice(0, 3), v: x.assiduidade ?? null, a: x.actividades || 0 }; });
  const pil = PILARES.map(k => ({ l: k, v: (d.pilares.find(x => x.k === k) || {}).n || 0 }));
  const [ra, rm] = d.periodo.mes_relatorio; const nCl = d.clubes;
  const perTxt = { mes: 'este mês', tri: 'este trimestre', ano: 'este ano' }[S.pP];
  m.innerHTML = `<section class="hero"><div class="hero-t"><div><small>Painel · ${esc(perTxt)}</small><h2>Maranata, ${esc(S.eu.nome.split(' ')[0])}!</h2><p>${esc(ambito)}</p></div>
      ${S.instalar ? '<button class="btn peq" id="btInst">Instalar app</button>' : ''}</div>
    <div class="filtros">${S.eu.papel === 'MSC' ? `<select id="pReg">${opts(S.regioes.map(r => [r.id, r.nome]), S.pReg, 'Todas as regiões')}</select>` : ''}
      ${S.eu.papel !== 'DIRECTOR' ? `<select id="pClube">${opts(clubesFiltro.map(c => [c.id, c.nome]), S.pClube, 'Todos os clubes')}</select>` : ''}
      <select id="pP">${opts([['mes', 'Este mês'], ['tri', 'Este trimestre'], ['ano', 'Este ano']], S.pP)}</select></div>
    <div class="hero-k">
      <div class="hk"><span class="hk-i">${svgI('membros')}</span><b>${fmtN(desb)}</b><small>Desbravadores activos</small><span class="dl">${fmtN(mb.total - desb)} líderes e staff</span></div>
      <div class="hk"><span class="hk-i">${svgI('presencas')}</span><b>${d.assiduidade == null ? '—' : d.assiduidade + '%'}</b><small>Assiduidade</small>${delta(d.assiduidade, d.anterior.assiduidade, ' pp')}</div>
      <div class="hk"><span class="hk-i">${svgI('eventos')}</span><b>${fmtN(d.actividades)}</b><small>Actividades realizadas</small>${delta(d.actividades, d.anterior.actividades)}</div>
      <div class="hk"><span class="hk-i">${svgI('classes')}</span><b>${fmtN(invest)}</b><small>Investidos em ${d.periodo.ano}</small><span class="dl">${fmtN(totCl)} inscritos nas classes</span></div>
    </div></section>
    <div class="dash">
      <div class="card c2"><h3>Assiduidade nos últimos 6 meses</h3>${gLinha(serie)}</div>
      <div class="card"><h3>Desbravadores por sexo</h3>${gDonut([{ l: 'Masculino', v: mb.masculino, c: COR.s1 }, { l: 'Feminino', v: mb.feminino, c: COR.s2 }, ...(desb - mb.masculino - mb.feminino > 0 ? [{ l: 'Sem registo', v: desb - mb.masculino - mb.feminino, c: '#a0aec0' }] : [])], fmtN(desb), 'desbravadores')}</div>
      <div class="card"><h3>Indicadores</h3><div class="aneis">
        <div>${gAnel(mb.total ? Math.round(d.seguro / mb.total * 100) : null, COR.s1)}<small>Com seguro ${d.periodo.ano}</small></div>
        <div>${gAnel(nCl ? Math.round(d.relatorios_enviados / nCl * 100) : null, COR.ouro)}<small>Relatórios de ${MESES[rm - 1].toLowerCase()} enviados</small></div>
        <div>${gAnel(desb ? Math.round((desb - mb.sem_unidade) / desb * 100) : null, '#1baf7a')}<small>Desbravadores com unidade</small></div></div></div>
      <div class="card c2"><h3>Classes ${d.periodo.ano} por estado</h3>${totCl ? gEmpilhadas(cls, ESTADOS, COR.seq) : '<div class="vazio">Ainda sem inscrições nas classes.</div>'}</div>
      <div class="card"><h3>Idades dos desbravadores</h3>${gBarrasV(idades, COR.s1)}${semData ? `<p class="dica">${semData} sem data de nascimento.</p>` : ''}</div>
      <div class="card"><h3>Actividades por pilar · ${esc(perTxt)}</h3>${gBarrasH(pil, COR.azul)}
        <p class="dica">${fmtN(d.missionarias)} actividade(s) missionária(s) · ${fmtN(d.especialidades)} especialidade(s) concluída(s)</p></div>
      ${S.eu.papel === 'MSC' && !prm.regiao_id && !prm.clube_id && d.por_regiao.length > 1 ? `<div class="card"><h3>Membros por região</h3>${gBarrasH(d.por_regiao.map(r => ({ l: nomeRegiao(r.regiao_id), v: r.membros })), COR.s1)}</div>` : ''}
      ${!prm.clube_id ? `<div class="card c3"><div class="barra"><h3>Clubes (${fmtN(nCl)})</h3><span class="dica">Toque num clube para o ver em detalhe</span></div><div class="tw"><table class="tclubes">
        <tr><th>Clube</th>${S.eu.papel === 'MSC' ? '<th>Região</th>' : ''}<th class="n">Membros</th><th class="n">Activ.</th><th>Assiduidade</th><th>Relatório ${MESES[rm - 1].slice(0, 3).toLowerCase()}</th></tr>
        ${d.por_clube.map(c => `<tr class="clic" data-c="${c.id}"><td><b>${esc(c.nome)}</b></td>${S.eu.papel === 'MSC' ? `<td>${esc(nomeRegiao(c.regiao_id))}</td>` : ''}<td class="n">${c.membros}</td><td class="n">${c.actividades}</td>
          <td><div class="mini"><div class="bar"><i style="width:${c.assiduidade || 0}%;background:${c.assiduidade >= 75 ? '#1baf7a' : c.assiduidade >= 50 ? COR.ouro : '#e34948'}"></i></div><span>${c.assiduidade == null ? '—' : c.assiduidade + '%'}</span></div></td>
          <td>${c.relatorio === 'Enviado' ? '<span class="tag ok">✓ Enviado</span>' : c.relatorio ? `<span class="tag">${esc(c.relatorio)}</span>` : '<span class="tag nao">Em falta</span>'}</td></tr>`).join('')}</table></div></div>` : ''}
    </div>`;
  const bi = $('#btInst'); if (bi) bi.onclick = instalarApp;
  if (prm.clube_id) { cartaoAniversarios(m, prm.clube_id); cartaoRisco(m, prm.clube_id); }
  if (pushSuportado() && Notification.permission === 'default' && !ler('sgc_push_nao')) {
    const c = document.createElement('div'); c.className = 'card barra pushb';
    c.innerHTML = '<span style="flex:1">🔔 Receba os avisos no telemóvel, mesmo com a aplicação fechada.</span><button class="btn peq" id="pAct">Activar</button><button class="btn sec peq" id="pNao">Agora não</button>';
    $('.hero', m).after(c);
    $('#pAct', c).onclick = (e) => ocupado(e.target, async () => { await activarPush(); c.remove(); });
    $('#pNao', c).onclick = () => { gravar('sgc_push_nao', '1'); c.remove(); };
  }
  const r = $('#pReg'); if (r) r.onchange = (e) => { S.pReg = e.target.value; S.pClube = ''; abrir('painel'); };
  const c = $('#pClube'); if (c) c.onchange = (e) => { S.pClube = e.target.value; abrir('painel'); };
  $('#pP').onchange = (e) => { S.pP = e.target.value; abrir('painel'); };
  $$('tr[data-c]', m).forEach(tr => tr.onclick = () => { S.pClube = tr.dataset.c; S.clube_id = tr.dataset.c; gravar('sgc_clube', S.clube_id); const sel = $('#selClube'); if (sel) sel.value = S.clube_id; abrir('painel'); });
}
const svgI = (k) => `<svg viewBox="0 0 24 24">${IC[k]}</svg>`;

/* ---------- membros ---------- */
async function vMembros(m) {
  if (!S.clube_id) { m.innerHTML = '<div class="card vazio">Ainda não há clubes. Crie-os em Gestão.</div>'; return; }
  const d = await api('membros', { clube_id: S.clube_id });
  const unid = Object.fromEntries(d.unidades.map(u => [u.id, u.nome]));
  m.innerHTML = `<div class="barra"><h2>Membros</h2><button class="btn sec peq" id="cart">Cartões (PDF)</button><button class="btn sec peq" id="imp">Importar Excel</button><button class="btn" id="novo">+ Novo</button></div>
    <div class="barra"><input type="search" id="q" placeholder="Procurar nome…"><select id="fTipo">${opts(TIPOS, '', 'Todos os tipos')}</select>
      <select id="fAct">${opts([['1', 'Activos'], ['0', 'Inactivos'], ['', 'Todos']], '1')}</select></div>
    <div class="card lista" id="lst"></div>`;
  const desenhar = () => {
    const q = $('#q').value.toLowerCase(), t = $('#fTipo').value, a = $('#fAct').value;
    const l = d.membros.filter(x => (!q || x.nome.toLowerCase().includes(q)) && (!t || x.tipo === t) && (a === '' || String(x.activo) === a));
    $('#lst').innerHTML = l.length ? `<div class="dica" style="margin-bottom:4px">${l.length} membro(s)</div>` + l.map(x => {
      const i = idade(x.data_nasc);
      return `<div class="it${x.activo ? '' : ' inactivo'}" data-id="${x.id}"><div class="av ${x.sexo || ''}">${esc(iniciais(x.nome))}</div>
        <div class="tx"><b>${esc(x.nome)}</b><small>${esc(x.tipo || '—')}${i != null ? ' · ' + i + ' anos' : ''}${x.unidade_id ? ' · ' + esc(unid[x.unidade_id] || '') : ''}${x.cargo ? ' · ' + esc(x.cargo) : ''}</small></div>
        ${x.tipo === 'Desbravador' && classeIdade(i) ? `<span class="tag">${classeIdade(i)}</span>` : ''}</div>`;
    }).join('') : '<div class="vazio">Nenhum membro. Carregue em “+ Novo”.</div>';
    $$('#lst .it').forEach(el => el.onclick = () => verFicha(el.dataset.id, d.unidades));
  };
  ['q', 'fTipo', 'fAct'].forEach(id => $('#' + id).oninput = desenhar);
  $('#novo').onclick = () => formMembro(null, d.unidades);
  $('#imp').onclick = () => importarExcel();
  $('#cart').onclick = (e) => ocupado(e.target, () => pdfCartoes());
  desenhar();
}

function formMembro(x, unidades) {
  x = x || { tipo: 'Desbravador', activo: 1 };
  const md = modal(`<h3>${x.id ? 'Editar membro' : 'Novo membro'}</h3><form class="form">
    <label class="full">Nome completo<input name="nome" value="${esc(x.nome)}" required></label>
    <label>Tipo<select name="tipo">${opts(TIPOS, x.tipo)}</select></label>
    <label>Sexo<select name="sexo">${opts([['M', 'Masculino'], ['F', 'Feminino']], x.sexo, '—')}</select></label>
    <label>Data de nascimento<input name="data_nasc" type="date" value="${esc(x.data_nasc)}"></label>
    <label>Unidade<select name="unidade_id">${opts(unidades.map(u => [u.id, u.nome]), x.unidade_id, 'Sem unidade')}</select></label>
    <label>Cargo<input name="cargo" value="${esc(x.cargo)}" placeholder="Ex.: Capitão, Secretário da unidade"></label>
    <label>Baptizado<select name="baptizado">${opts(['Sim', 'Não'], x.baptizado, '—')}</select></label>
    <label>Contacto<input name="contacto" type="tel" value="${esc(x.contacto)}"></label>
    <label>Data de entrada no clube<input name="data_entrada" type="date" value="${esc(x.data_entrada)}"></label>
    <label>Encarregado de educação<input name="encarregado_nome" value="${esc(x.encarregado_nome)}"></label>
    <label>Contacto do encarregado<input name="encarregado_contacto" type="tel" value="${esc(x.encarregado_contacto)}"></label>
    <label>Autorização dos pais<select name="autorizacao_pais">${opts(['Sim', 'Não'], x.autorizacao_pais, '—')}</select></label>
    <label>Estado<select name="activo">${opts([['1', 'Activo'], ['0', 'Inactivo']], String(x.activo))}</select></label>
    <label class="full">Observações<textarea name="obs" rows="2">${esc(x.obs)}</textarea></label></form>
    <div class="accoes">${x.id ? '<button class="btn del esq" id="apagar">Apagar</button>' : ''}${x.id && x.activo ? '<button class="btn sec" id="transf">Transferir</button>' : ''}<button class="btn sec" data-fechar>Cancelar</button><button class="btn" id="gravar">Guardar</button></div>`);
  const tb = $('#transf', md); if (tb) tb.onclick = () => { md.remove(); formTransferencia(x); };
  $('#gravar', md).onclick = (e) => ocupado(e.target, async () => {
    const r = lerForm($('form', md)); r.id = x.id; r.clube_id = S.clube_id;
    await api('guardarMembro', { registo: r }); md.remove(); aviso('Membro guardado.'); abrir('membros');
  });
  const ap = $('#apagar', md);
  if (ap) ap.onclick = (e) => { if (confirm('Apagar ' + x.nome + '?')) ocupado(e.target, async () => {
    const r = await api('apagarMembro', { id: x.id }); md.remove();
    aviso(r.desactivado ? 'O membro tem histórico; foi marcado como inactivo.' : 'Membro apagado.'); abrir('membros');
  }); };
}

/* ---------- clube ---------- */
async function vClube(m) {
  if (!S.clube_id) { m.innerHTML = '<div class="card vazio">Ainda não há clubes.</div>'; return; }
  const [ini, d] = await Promise.all([api('inicio'), api('membros', { clube_id: S.clube_id })]);
  S.clubes = ini.clubes;
  const c = S.clubes.find(x => x.id === S.clube_id);
  const porUnid = (id) => d.membros.filter(x => x.activo && x.unidade_id === id).length;
  m.innerHTML = `<div class="barra"><h2>${esc(c.nome)}</h2><button class="btn sec peq" id="edClube">Editar</button></div>
    <div class="barra"><button class="btn sec peq" id="pdfFicha">Ficha do clube (PDF)</button><button class="btn sec peq" id="pdfLista">Lista nominal (PDF)</button><button class="btn sec peq" id="geo">📍 Localização no mapa</button></div>
    <div class="card"><table>
      <tr><th>Região</th><td>${esc(nomeRegiao(c.regiao_id))}</td></tr><tr><th>Distrito</th><td>${esc(c.distrito || '—')}</td></tr>
      <tr><th>Igreja</th><td>${esc(c.igreja || '—')}</td></tr><tr><th>Director</th><td>${esc(c.director || '—')}</td></tr>
      <tr><th>Contacto</th><td>${esc(c.contacto || '—')}</td></tr><tr><th>Fundação</th><td>${esc(c.data_fundacao || '—')}</td></tr>
      <tr><th>Membros activos</th><td>${c.membros}</td></tr></table></div>
    <div class="card"><div class="barra"><h3>Unidades</h3><button class="btn peq" id="novaU">+ Unidade</button></div>
      <div class="lista">${d.unidades.length ? d.unidades.map(u => `<div class="it" data-id="${u.id}"><div class="av">${esc(iniciais(u.nome))}</div>
        <div class="tx"><b>${esc(u.nome)}</b><small>${esc(u.sexo || 'Mista')}${u.conselheiro ? ' · Conselheiro: ' + esc(u.conselheiro) : ''}</small></div>
        <span class="tag">${porUnid(u.id)}</span></div>`).join('') : '<div class="vazio">Ainda sem unidades.</div>'}</div></div>`;
  $('#edClube').onclick = () => formClube(c);
  $('#pdfFicha').onclick = (e) => ocupado(e.target, () => pdfClube('ficha'));
  $('#pdfLista').onclick = (e) => ocupado(e.target, () => pdfClube('lista'));
  $('#geo').onclick = (e) => ocupado(e.target, () => definirLocalizacao(c));
  cartaoInspecoesClube(m, c);
  $('#novaU').onclick = () => formUnidade(null);
  $$('.lista .it', m).forEach(el => el.onclick = () => formUnidade(d.unidades.find(u => u.id === el.dataset.id)));
}

function formUnidade(u) {
  u = u || {};
  const md = modal(`<h3>${u.id ? 'Editar unidade' : 'Nova unidade'}</h3><form class="form">
    <label class="full">Nome<input name="nome" value="${esc(u.nome)}" required></label>
    <label>Tipo<select name="sexo">${opts(['Masculina', 'Feminina', 'Mista'], u.sexo, '—')}</select></label>
    <label>Conselheiro<input name="conselheiro" value="${esc(u.conselheiro)}"></label></form>
    <div class="accoes">${u.id ? '<button class="btn del esq" id="apagar">Apagar</button>' : ''}<button class="btn sec" data-fechar>Cancelar</button><button class="btn" id="gravar">Guardar</button></div>`);
  $('#gravar', md).onclick = (e) => ocupado(e.target, async () => {
    const r = lerForm($('form', md)); r.id = u.id; r.clube_id = S.clube_id;
    await api('guardarUnidade', { registo: r }); md.remove(); aviso('Unidade guardada.'); abrir('clube');
  });
  const ap = $('#apagar', md);
  if (ap) ap.onclick = (e) => { if (confirm('Apagar a unidade ' + u.nome + '? Os membros ficam sem unidade.')) ocupado(e.target, async () => {
    await api('apagarUnidade', { id: u.id }); md.remove(); aviso('Unidade apagada.'); abrir('clube');
  }); };
}

function formClube(c) {
  c = c || { activo: 1, regiao_id: S.eu.papel === 'REGIONAL' ? S.eu.regiao_id : '' };
  const podeRegiao = S.eu.papel === 'MSC';
  const md = modal(`<h3>${c.id ? 'Editar clube' : 'Novo clube'}</h3><form class="form">
    <label class="full">Nome do clube<input name="nome" value="${esc(c.nome)}" required></label>
    <label>Região<select name="regiao_id" ${podeRegiao ? '' : 'disabled'}>${opts(S.regioes.map(r => [r.id, r.nome]), c.regiao_id, 'Escolha…')}</select></label>
    <label>Distrito<input name="distrito" value="${esc(c.distrito)}"></label>
    <label>Igreja<input name="igreja" value="${esc(c.igreja)}"></label>
    <label>Director<input name="director" value="${esc(c.director)}"></label>
    <label>Contacto<input name="contacto" type="tel" value="${esc(c.contacto)}"></label>
    <label>Data de fundação<input name="data_fundacao" type="date" value="${esc(c.data_fundacao)}"></label>
    ${S.eu.papel !== 'DIRECTOR' ? `<label>Estado<select name="activo">${opts([['1', 'Activo'], ['0', 'Inactivo']], String(c.activo))}</select></label>` : ''}</form>
    <div class="accoes"><button class="btn sec" data-fechar>Cancelar</button><button class="btn" id="gravar">Guardar</button></div>`);
  $('#gravar', md).onclick = (e) => ocupado(e.target, async () => {
    const r = lerForm($('form', md)); r.id = c.id; if (!podeRegiao) r.regiao_id = c.regiao_id;
    const res = await api('guardarClube', { registo: r }); md.remove(); aviso('Clube guardado.');
    await carregarInicio(); if (!c.id) S.clube_id = res.id; gravar('sgc_clube', S.clube_id); montar();
  });
}

/* ---------- gestão (MSC / Regional) ---------- */
async function vAdmin(m) {
  const us = await api('utilizadores');
  const msc = S.eu.papel === 'MSC';
  m.innerHTML = `<h2>Gestão</h2>
    ${msc ? `<div class="card"><div class="barra"><h3>Regiões (${S.regioes.length})</h3><button class="btn peq" id="novaR">+ Região</button></div>
      <div class="lista">${S.regioes.map(r => `<div class="it" data-r="${r.id}"><div class="av">${esc(r.sigla || iniciais(r.nome))}</div>
        <div class="tx"><b>${esc(r.nome)}</b><small>${S.clubes.filter(c => c.regiao_id === r.id).length} clube(s)${r.activo ? '' : ' · inactiva'}</small></div></div>`).join('') || '<div class="vazio">Comece por criar as regiões.</div>'}</div></div>` : ''}
    <div class="card"><div class="barra"><h3>Clubes (${S.clubes.length})</h3><button class="btn peq" id="novoC">+ Clube</button></div>
      <input type="search" id="qc" placeholder="Procurar clube…" style="margin-bottom:6px"><div class="lista" id="lc"></div></div>
    <div class="card"><div class="barra"><h3>Utilizadores (${us.length})</h3><button class="btn peq" id="novoU">+ Utilizador</button></div>
      <div class="lista">${us.map(u => `<div class="it${u.activo ? '' : ' inactivo'}" data-u="${esc(u.email)}"><div class="av">${esc(iniciais(u.nome))}</div>
        <div class="tx"><b>${esc(u.nome)}</b><small>${esc(u.email)} · ${u.papel === 'MSC' ? 'Missão' : u.papel === 'REGIONAL' ? 'Regional · ' + esc(nomeRegiao(u.regiao_id)) : 'Director · ' + esc(nomeClube(u.clube_id))}</small></div></div>`).join('')}</div></div>`;
  const desClubes = () => {
    const q = $('#qc').value.toLowerCase();
    const l = S.clubes.filter(c => !q || c.nome.toLowerCase().includes(q));
    $('#lc').innerHTML = l.map(c => `<div class="it${c.activo ? '' : ' inactivo'}" data-c="${c.id}"><div class="av">${esc(iniciais(c.nome))}</div>
      <div class="tx"><b>${esc(c.nome)}</b><small>${esc(nomeRegiao(c.regiao_id))}${c.distrito ? ' · ' + esc(c.distrito) : ''}</small></div><span class="tag">${c.membros}</span></div>`).join('')
      || '<div class="vazio">Sem clubes.</div>';
    $$('[data-c]', m).forEach(el => el.onclick = () => formClube(S.clubes.find(c => c.id === el.dataset.c)));
  };
  $('#qc').oninput = desClubes; desClubes();
  if (msc) {
    $('#novaR').onclick = () => formRegiao(null);
    $$('[data-r]', m).forEach(el => el.onclick = () => formRegiao(S.regioes.find(r => r.id === el.dataset.r)));
  }
  $('#novoC').onclick = () => { if (msc && !S.regioes.length) return aviso('Crie primeiro uma região.', true); formClube(null); };
  $('#novoU').onclick = () => formUtilizador(null);
  if (msc) { cartaoCopia(m); cartaoEmail(m); }
  $$('[data-u]', m).forEach(el => el.onclick = () => formUtilizador(us.find(u => u.email === el.dataset.u)));
}

function formRegiao(r) {
  r = r || { activo: 1 };
  const md = modal(`<h3>${r.id ? 'Editar região' : 'Nova região'}</h3><form class="form">
    <label class="full">Nome<input name="nome" value="${esc(r.nome)}" required></label>
    <label>Sigla<input name="sigla" value="${esc(r.sigla)}" maxlength="12"></label>
    <label>Estado<select name="activo">${opts([['1', 'Activa'], ['0', 'Inactiva']], String(r.activo))}</select></label></form>
    <div class="accoes"><button class="btn sec" data-fechar>Cancelar</button><button class="btn" id="gravar">Guardar</button></div>`);
  $('#gravar', md).onclick = (e) => ocupado(e.target, async () => {
    const o = lerForm($('form', md)); o.id = r.id;
    await api('guardarRegiao', { registo: o }); md.remove(); aviso('Região guardada.'); await carregarInicio(); abrir('admin');
  });
}

function formUtilizador(u) {
  const novo = !u; const msc = S.eu.papel === 'MSC';
  u = u || { papel: 'DIRECTOR', activo: 1 };
  const papeis = msc ? [['MSC', 'Missão (MSC)'], ['REGIONAL', 'Regional'], ['DIRECTOR', 'Director de clube']] : [['DIRECTOR', 'Director de clube']];
  const md = modal(`<h3>${novo ? 'Novo utilizador' : 'Editar utilizador'}</h3><form class="form">
    <label class="full">Nome<input name="nome" value="${esc(u.nome)}" required></label>
    <label class="full">Email<input name="email" type="email" value="${esc(u.email)}" ${novo ? '' : 'readonly'} required></label>
    <label>Papel<select name="papel" id="pp">${opts(papeis, u.papel)}</select></label>
    <label id="lr">Região<select name="regiao_id">${opts(S.regioes.map(r => [r.id, r.nome]), u.regiao_id, 'Escolha…')}</select></label>
    <label id="lc2">Clube<select name="clube_id">${opts(S.clubes.map(c => [c.id, c.nome]), u.clube_id, 'Escolha…')}</select></label>
    <label>Estado<select name="activo">${opts([['1', 'Activo'], ['0', 'Inactivo']], String(u.activo))}</select></label>
    <label class="full">${novo ? 'Palavra-passe inicial (mín. 8)' : 'Nova palavra-passe (deixe vazio para manter)'}<input name="senha" type="text" autocomplete="off" ${novo ? 'required' : ''}></label></form>
    <p class="dica">Entregue a palavra-passe à pessoa em privado. Ela pode mudá-la em Conta.</p>
    <div class="accoes"><button class="btn sec" data-fechar>Cancelar</button><button class="btn" id="gravar">Guardar</button></div>`);
  const ver = () => { const p = $('#pp', md).value; $('#lr', md).hidden = p !== 'REGIONAL'; $('#lc2', md).hidden = p !== 'DIRECTOR'; };
  $('#pp', md).onchange = ver; ver();
  $('#gravar', md).onclick = (e) => ocupado(e.target, async () => {
    await api('guardarUtilizador', { registo: lerForm($('form', md)) }); md.remove(); aviso('Utilizador guardado.'); abrir('admin');
  });
}

/* ---------- conta ---------- */
async function vConta(m) {
  const papel = { MSC: 'Missão (MSC)', REGIONAL: 'Regional · ' + nomeRegiao(S.eu.regiao_id), DIRECTOR: 'Director · ' + nomeClube(S.eu.clube_id) }[S.eu.papel];
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.navigator.standalone;
  m.innerHTML = `<h2>Conta</h2><div class="card"><b>${esc(S.eu.nome)}</b><div class="dica">${esc(S.eu.email)}<br>${esc(papel)}</div></div>
    <div class="card"><h3>Aplicação no telemóvel</h3>
      ${S.instalar ? '<button class="btn" id="btInst">Instalar o SGC</button>'
        : ios ? '<p class="dica">No iPhone: toque em <b>Partilhar</b> e depois em <b>Adicionar ao ecrã principal</b>.</p>'
        : matchMedia('(display-mode: standalone)').matches ? '<p class="dica">O SGC já está instalado neste dispositivo.</p>'
        : '<p class="dica">No Android (Chrome): menu <b>⋮</b> → <b>Instalar aplicação</b> ou <b>Adicionar ao ecrã principal</b>.</p>'}</div>
    <div class="card" id="cTema"></div>
    <div class="card" id="cPush"></div>
    <div class="card"><h3>Mudar palavra-passe</h3><form class="form">
      <label class="full">Actual<input name="actual" type="password" autocomplete="current-password"></label>
      <label class="full">Nova (mín. 8)<input name="nova" type="password" autocomplete="new-password"></label></form>
      <div class="accoes"><button class="btn" id="mudar">Mudar</button></div></div>
    <div class="card"><button class="btn del" id="sair" style="width:100%">Terminar sessão</button></div>
    <p class="dica" style="text-align:center">SGC Desbravadores MSC · versão ${esc((ler('sgc_c_inicio_') && JSON.parse(ler('sgc_c_inicio_')).versao) || '')}</p>`;
  const b = $('#btInst'); if (b) b.onclick = instalarApp;
  desenharPush($('#cPush'));
  cartaoTema($('#cTema'));
  $('#mudar').onclick = (e) => ocupado(e.target, async () => {
    await api('mudarSenha', lerForm($('form', m))); aviso('Palavra-passe alterada.'); $$('input', m).forEach(i => i.value = '');
  });
  $('#sair').onclick = terminarSessao;
}
async function instalarApp() {
  if (!S.instalar) return;
  S.instalar.prompt(); await S.instalar.userChoice; S.instalar = null; abrir(S.aba);
}

/* ======================= FASE 2 ======================= */
const CLASSES = ['Amigo', 'Companheiro', 'Pesquisador', 'Pioneiro', 'Excursionista', 'Guia'];
const ESTADOS_CL = ['Inscrito', 'Em curso', 'Concluído', 'Investido'];
const TIPOS_ACT = ['Reunião regular', 'Classe bíblica', 'Actividade missionária', 'Acampamento / Saída', 'Evento', 'Outro'];
const PILARES = ['Espiritual', 'Físico', 'Mental', 'Social'];
const CAT_ESP = ['ADRA', 'Actividades agrícolas', 'Actividades missionárias e comunitárias', 'Actividades profissionais', 'Actividades recreativas',
  'Artes e habilidades manuais', 'Ciência e saúde', 'Estudo da natureza', 'Habilidades domésticas'];
const hoje = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };
const idLocal = () => [...crypto.getRandomValues(new Uint8Array(6))].map(b => b.toString(16).padStart(2, '0')).join('');
const fmtData = (d) => d ? d.split('-').reverse().join('/') : '';
const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const tagEstado = (e) => `<span class="tag ${e === 'Investido' ? 'ok' : e === 'Concluído' ? 'azul' : ''}">${esc(e)}</span>`;
function semClube(m) { if (S.clube_id) return false; m.innerHTML = '<div class="card vazio">Ainda não há clubes. Crie-os em Gestão.</div>'; return true; }

/** Lista de escolha de membros com "todos" e pesquisa. */
function checklist(lista, marcados = [], extra = () => '') {
  return `<div class="chk"><div class="barra"><input type="search" class="chkq" placeholder="Procurar…"><button type="button" class="btn sec peq chkall">Todos</button></div>
    <div class="chkl">${lista.map(x => `<label class="chki"><input type="checkbox" value="${esc(x.id)}" ${marcados.includes(x.id) ? 'checked' : ''}>
      <span>${esc(x.nome)}</span>${extra(x)}</label>`).join('') || '<div class="vazio">Ninguém para escolher.</div>'}</div>
    <div class="dica chkn"></div></div>`;
}
function ligarChecklist(md) {
  const cont = () => { const n = $$('.chkl input:checked', md).length; $('.chkn', md).textContent = n + ' seleccionado(s)'; };
  $('.chkq', md).oninput = (e) => { const q = e.target.value.toLowerCase(); $$('.chki', md).forEach(l => l.hidden = !l.textContent.toLowerCase().includes(q)); };
  $('.chkall', md).onclick = () => { const vis = $$('.chki:not([hidden]) input', md); const todos = vis.every(i => i.checked); vis.forEach(i => i.checked = !todos); cont(); };
  $$('.chkl input', md).forEach(i => i.onchange = cont); cont();
}
const lerChecklist = (md) => $$('.chkl input:checked', md).map(i => i.value);

/* ---------- presenças ---------- */
async function vPresencas(m) {
  if (semClube(m)) return;
  S.vistaPres = S.vistaPres || 'cham';
  const segP = segm([['cham', 'Chamadas'], ['plano', 'Plano anual']], S.vistaPres);
  if (S.vistaPres === 'plano') return vPlano(m, segP);
  S.mes = S.mes || hoje().slice(0, 7);
  const [lista, d] = await Promise.all([api('actividades', { clube_id: S.clube_id, mes: S.mes }), api('membros', { clube_id: S.clube_id })]);
  const pend = fila().filter(x => x.accao === 'guardarActividade' && x.p.registo.clube_id === S.clube_id);
  const ids = new Set(pend.map(x => x.p.registo.id));
  const itens = [...pend.map(x => ({ ...x.p.registo, pendente: true, chamada: x.p.chamada })), ...lista.filter(a => !ids.has(a.id))];
  m.innerHTML = `${segP}<div class="barra"><h2>Presenças</h2><button class="btn" id="nova">+ Chamada</button></div>
    <div class="barra"><input type="month" id="mes" value="${S.mes}"></div>
    <div class="card lista">${itens.map(a => {
      const c = a.pendente ? Object.values(a.chamada || {}) : null;
      const P = c ? c.filter(x => x === 'P').length : a.p || 0, F = c ? c.filter(x => x === 'F').length : a.f || 0, J = c ? c.filter(x => x === 'J').length : a.j || 0;
      const t = P + F + J;
      return `<div class="it" data-id="${a.id}"><div class="av">${a.data.slice(8, 10)}</div>
        <div class="tx"><b>${esc(a.tema || a.tipo)}</b><small>${fmtData(a.data)} · ${esc(a.tipo)}${a.pilar ? ' · ' + esc(a.pilar) : ''}</small>
        <small>P ${P} · F ${F} · J ${J}</small></div>
        ${a.pendente ? '<span class="tag nao">Por enviar</span>' : `<span class="tag ${t && P / t >= .75 ? 'ok' : ''}">${t ? Math.round(P / t * 100) + '%' : '—'}</span>`}</div>`;
    }).join('') || `<div class="vazio">Sem actividades em ${MESES[+S.mes.slice(5) - 1]}. Carregue em “+ Chamada”.</div>`}</div>`;
  $('#mes').onchange = (e) => { S.mes = e.target.value || hoje().slice(0, 7); abrir('presencas'); };
  ligarSeg(m, 'vistaPres', 'presencas');
  $('#nova').onclick = () => formChamada(null, d.membros);
  $$('.lista .it', m).forEach(el => el.onclick = () => formChamada(itens.find(a => a.id === el.dataset.id), d.membros));
}

async function formChamada(a, membros) {
  let chamada = {};
  if (a && a.pendente) chamada = { ...a.chamada };
  else if (a) { const r = await api('actividade', { id: a.id }); a = r.actividade; chamada = r.chamada; }
  const novo = !a; a = a || { id: idLocal(), data: hoje(), tipo: 'Reunião regular' };
  const lista = membros.filter(x => x.activo || chamada[x.id]).sort((x, y) => (x.tipo === 'Desbravador' ? 0 : 1) - (y.tipo === 'Desbravador' ? 0 : 1) || x.nome.localeCompare(y.nome));
  const md = modal(`<h3>${novo ? 'Nova chamada' : 'Chamada'}</h3><form class="form">
    <label>Data<input name="data" type="date" value="${a.data}" required></label>
    <label>Tipo<select name="tipo">${opts(TIPOS_ACT, a.tipo)}</select></label>
    <label>Pilar<select name="pilar">${opts(PILARES, a.pilar, '—')}</select></label>
    <label>Tema<input name="tema" value="${esc(a.tema)}"></label></form>
    <div class="barra" style="margin-top:12px"><b style="flex:1">Chamada</b><button class="btn sec peq" id="lerQR">📷 Ler cartões</button><button class="btn sec peq" id="todosP">Todos presentes</button></div>
    <div class="dica" id="cont"></div>
    <div class="chamada">${lista.map(x => `<div class="lin" data-m="${x.id}"><span>${esc(x.nome)}<small>${esc(x.tipo === 'Desbravador' ? '' : x.tipo || '')}</small></span>
      ${['P', 'F', 'J'].map(e => `<button type="button" class="pfj ${e}${chamada[x.id] === e ? ' on' : ''}" data-e="${e}">${e}</button>`).join('')}</div>`).join('') || '<div class="vazio">Sem membros activos.</div>'}</div>
    <p class="dica">P = presente · F = falta · J = falta justificada. Sem rede, a chamada fica guardada no telemóvel e é enviada depois.</p>
    <div class="accoes">${novo ? '' : '<button class="btn del esq" id="apagar">Apagar</button>'}<button class="btn sec" data-fechar>Cancelar</button><button class="btn" id="gravar">Guardar</button></div>`);
  const cont = () => { const v = Object.values(chamada); $('#cont', md).textContent = `P ${v.filter(x => x === 'P').length} · F ${v.filter(x => x === 'F').length} · J ${v.filter(x => x === 'J').length} · por marcar ${lista.length - v.length}`; };
  $$('.pfj', md).forEach(b => b.onclick = () => {
    const mid = b.closest('.lin').dataset.m;
    chamada[mid] = chamada[mid] === b.dataset.e ? undefined : b.dataset.e; if (!chamada[mid]) delete chamada[mid];
    $$('.pfj', b.parentNode).forEach(o => o.classList.toggle('on', o.dataset.e === chamada[mid])); cont();
  });
  $('#lerQR', md).onclick = () => lerCartoes(lista, (id) => { chamada[id] = 'P'; const l = $(`.lin[data-m="${id}"]`, md); if (l) $$('.pfj', l).forEach(o => o.classList.toggle('on', o.dataset.e === 'P')); cont(); });
  $('#todosP', md).onclick = () => { lista.forEach(x => { if (!chamada[x.id]) chamada[x.id] = 'P'; }); $$('.lin', md).forEach(l => $$('.pfj', l).forEach(o => o.classList.toggle('on', o.dataset.e === chamada[l.dataset.m]))); cont(); };
  cont();
  $('#gravar', md).onclick = (e) => ocupado(e.target, async () => {
    const r = lerForm($('form', md)); r.id = a.id; r.clube_id = S.clube_id;
    if (lista.length && Object.keys(chamada).length < lista.length && !confirm('Há membros por marcar. Guardar mesmo assim?')) return;
    const res = await api('guardarActividade', { registo: r, chamada });
    md.remove(); aviso(res._fila ? 'Sem rede: chamada guardada no telemóvel. Será enviada quando houver ligação.' : 'Chamada guardada.'); abrir('presencas');
  });
  const ap = $('#apagar', md);
  if (ap) ap.onclick = (e) => { if (confirm('Apagar esta actividade e a chamada?')) ocupado(e.target, async () => {
    if (a.pendente) gravar('sgc_fila', JSON.stringify(fila().filter(x => !(x.p.registo && x.p.registo.id === a.id))));
    else await api('apagarActividade', { id: a.id });
    md.remove(); aviso('Actividade apagada.'); abrir('presencas');
  }); };
}

/* ---------- classes e especialidades ---------- */
async function requisitosTodos() { if (!S.req) S.req = await api('requisitos'); return S.req; }

async function vClasses(m) {
  if (semClube(m)) return;
  S.ano = S.ano || new Date().getFullYear(); S.vistaCl = S.vistaCl || 'classes';
  const seg = `<div class="seg"><button data-v="classes" class="${S.vistaCl === 'classes' ? 'on' : ''}">Classes</button><button data-v="esp" class="${S.vistaCl === 'esp' ? 'on' : ''}">Especialidades</button></div>`;
  if (S.vistaCl === 'esp') return vEspecialidades(m, seg);
  const [d, mb] = await Promise.all([api('classes', { clube_id: S.clube_id, ano: S.ano }), api('membros', { clube_id: S.clube_id })]);
  S.filtroCl = S.filtroCl || '';
  const anos = []; for (let y = new Date().getFullYear() + 1; y >= 2024; y--) anos.push(y);
  m.innerHTML = `${seg}<div class="barra"><h2>Classes</h2><select id="ano" style="flex:0 0 auto;min-width:0">${opts(anos, S.ano)}</select><button class="btn sec" id="pass">Passagem de ano</button><button class="btn" id="insc">+ Inscrever</button></div>
    <div class="chips">${['', ...CLASSES].map(c => `<button data-c="${c}" class="${S.filtroCl === c ? 'on' : ''}">${c || 'Todas'} <small>${c ? d.inscricoes.filter(x => x.classe === c).length : d.inscricoes.length}</small></button>`).join('')}</div>
    <div id="grupos"></div>`;
  const desenhar = () => {
    const cls = S.filtroCl ? [S.filtroCl] : CLASSES;
    $('#grupos').innerHTML = cls.map(c => {
      const l = d.inscricoes.filter(x => x.classe === c); if (!l.length && !S.filtroCl) return '';
      const tot = (d.totais[c] || {}).normal || 0;
      return `<div class="card"><div class="barra"><h3>${c} <small class="dica">${l.length}</small></h3>${l.length ? `<button class="btn sec peq" data-turma="${c}">Marcar para a turma</button>` : ''}</div>
        <div class="lista">${l.map(x => `<div class="it" data-id="${x.id}"><div class="av ${x.sexo || ''}">${esc(iniciais(x.nome))}</div>
          <div class="tx"><b>${esc(x.nome)}</b><div class="bar" style="margin:4px 0"><i style="width:${tot ? Math.round(x.feitos / tot * 100) : 0}%"></i></div>
          <small>${x.feitos}/${tot} requisitos${x.feitos_av ? ' · ' + x.feitos_av + ' avançados' : ''}</small></div>${tagEstado(x.estado)}</div>`).join('') || '<div class="vazio">Ninguém inscrito.</div>'}</div></div>`;
    }).join('') || '<div class="card vazio">Ainda não há inscrições neste ano. Carregue em “+ Inscrever”.</div>';
    $$('#grupos .it').forEach(el => el.onclick = () => cartao(d.inscricoes.find(x => x.id === el.dataset.id), d.totais));
    $$('[data-turma]').forEach(b => b.onclick = () => turma(b.dataset.turma, d.inscricoes.filter(x => x.classe === b.dataset.turma)));
  };
  $$('.seg button', m).forEach(b => b.onclick = () => { S.vistaCl = b.dataset.v; abrir('classes'); });
  $$('.chips button', m).forEach(b => b.onclick = () => { S.filtroCl = b.dataset.c; $$('.chips button', m).forEach(o => o.classList.toggle('on', o === b)); desenhar(); });
  $('#ano').onchange = (e) => { S.ano = +e.target.value; abrir('classes'); };
  $('#insc').onclick = () => formInscrever(mb.membros, d.inscricoes);
  $('#pass').onclick = () => formPassagem();
  desenhar();
}

function formInscrever(membros, inscricoes) {
  const ja = new Set(inscricoes.map(x => x.membro_id));
  const lista = membros.filter(x => x.activo && x.tipo === 'Desbravador' && !ja.has(x.id));
  const md = modal(`<h3>Inscrever nas classes de ${S.ano}</h3>
    <label class="dica">Classe<select id="cl">${opts([['', 'Pela idade (sugerida)'], ...CLASSES], '')}</select></label>
    ${checklist(lista, [], x => { const c = classeIdade(S.ano - Number((x.data_nasc || '').slice(0, 4)) || null); return `<span class="tag">${x.data_nasc ? esc(c || 'Abaixo de 10 anos') : 'Sem data de nasc.'}</span>`; })}
    <p class="dica">Só aparecem desbravadores activos ainda não inscritos neste ano. “Pela idade” usa a idade que fazem em ${S.ano}.</p>
    <div class="accoes"><button class="btn sec" data-fechar>Cancelar</button><button class="btn" id="gravar">Inscrever</button></div>`);
  ligarChecklist(md);
  $('#gravar', md).onclick = (e) => ocupado(e.target, async () => {
    const r = await api('inscreverClasses', { clube_id: S.clube_id, ano: S.ano, classe: $('#cl', md).value, membros: lerChecklist(md) });
    md.remove(); aviso(r.inscritos + ' inscrito(s).' + (r.sem_idade.length ? ' Sem classe pela idade: ' + r.sem_idade.join(', ') : ''), !!r.sem_idade.length); abrir('classes');
  });
}

async function cartao(x, totais) {
  const [reqs, c] = await Promise.all([requisitosTodos(), api('cartaoClasse', { id: x.id })]);
  const feitos = new Set(c.feitos.map(f => f.requisito_id));
  const rq = reqs.filter(r => r.classe === x.classe);
  const grupos = []; for (const r of rq) { const k = (r.avancado ? 'Avançado · ' : '') + (r.seccao || 'Geral'); let g = grupos.find(y => y.k === k); if (!g) grupos.push(g = { k, l: [] }); g.l.push(r); }
  const tot = (totais[x.classe] || {}).normal || 0;
  const md = modal(`<h3>${esc(x.nome)}</h3><p class="dica" style="margin-top:-6px">${esc(x.classe)} · ${S.ano} · <span id="prog"></span></p>
    <form class="form"><label>Estado<select name="estado">${opts(ESTADOS_CL, c.classe.estado)}</select></label>
      <label>Data da investidura<input name="data_investidura" type="date" value="${esc(c.classe.data_investidura)}"></label>
      <label class="full">Observações<input name="obs" value="${esc(c.classe.obs)}"></label></form>
    <div class="accoes" style="margin-top:8px"><button class="btn del esq peq" id="apagar">Retirar inscrição</button><button class="btn peq" id="gravar">Guardar estado</button></div>
    ${grupos.map(g => `<h4 class="sec">${esc(g.k)}</h4>${g.l.map(r => `<label class="req"><input type="checkbox" data-r="${r.id}" ${feitos.has(r.id) ? 'checked' : ''}>
      <span><small>${esc(r.codigo)}</small> ${esc(r.descricao)}</span></label>`).join('')}`).join('')}
    <div class="accoes"><button class="btn sec" data-fechar>Fechar</button></div>`);
  const prog = () => { $('#prog', md).textContent = rq.filter(r => !r.avancado && feitos.has(r.id)).length + '/' + tot + ' requisitos'; };
  prog();
  let mudou = false;
  $$('[data-r]', md).forEach(ch => ch.onchange = async () => {
    ch.disabled = true;
    try {
      const r = await api('marcarRequisito', { classe_id: x.id, requisito_id: ch.dataset.r, feito: ch.checked });
      ch.checked ? feitos.add(ch.dataset.r) : feitos.delete(ch.dataset.r); mudou = true; prog();
      $('[name=estado]', md).value = r.estado;
    } catch (e) { ch.checked = !ch.checked; aviso(e.message, true); } finally { ch.disabled = false; }
  });
  const fechar = () => { if (mudou) abrir('classes'); };
  $$('[data-fechar]', md).forEach(b => b.addEventListener('click', fechar));
  md.addEventListener('click', e => { if (e.target === md) fechar(); });
  $('#gravar', md).onclick = (e) => ocupado(e.target, async () => {
    const r = lerForm($('form', md)); r.id = x.id; await api('guardarClasse', { registo: r }); md.remove(); aviso('Estado guardado.'); abrir('classes');
  });
  $('#apagar', md).onclick = (e) => { if (confirm('Retirar ' + x.nome + ' da classe ' + x.classe + '? Os requisitos marcados perdem-se.')) ocupado(e.target, async () => {
    await api('apagarClasse', { id: x.id }); md.remove(); aviso('Inscrição retirada.'); abrir('classes');
  }); };
}

async function turma(classe, inscritos) {
  const reqs = (await requisitosTodos()).filter(r => r.classe === classe);
  const md = modal(`<h3>Marcar requisito · ${esc(classe)}</h3><form class="form">
    <label class="full">Requisito<select id="rq">${opts(reqs.map(r => [r.id, r.codigo + ' — ' + r.descricao.slice(0, 90)]), '', 'Escolha…')}</select></label>
    <label>Data<input type="date" id="dt" value="${hoje()}"></label></form>
    <p class="dica">Escolha quem cumpriu o requisito (por exemplo, numa aula da classe).</p>
    ${checklist(inscritos.map(x => ({ id: x.id, nome: x.nome })))}
    <div class="accoes"><button class="btn sec" data-fechar>Cancelar</button><button class="btn" id="gravar">Marcar</button></div>`);
  ligarChecklist(md);
  $('#gravar', md).onclick = (e) => ocupado(e.target, async () => {
    if (!$('#rq', md).value) throw new Error('Escolha o requisito.');
    const r = await api('marcarRequisitoTurma', { clube_id: S.clube_id, requisito_id: $('#rq', md).value, data: $('#dt', md).value, classes: lerChecklist(md) });
    md.remove(); aviso('Requisito marcado para ' + r.marcados + '.'); abrir('classes');
  });
}

async function vEspecialidades(m, seg) {
  const [l, mb] = await Promise.all([api('especialidades', { clube_id: S.clube_id }), api('membros', { clube_id: S.clube_id })]);
  m.innerHTML = `${seg}<div class="barra"><h2>Especialidades</h2><button class="btn" id="nova">+ Registar</button></div>
    <div class="barra"><input type="search" id="q" placeholder="Procurar nome ou especialidade…"></div><div class="card lista" id="lst"></div>`;
  const des = () => {
    const q = $('#q').value.toLowerCase();
    const f = l.filter(x => !q || (x.nome + ' ' + x.especialidade).toLowerCase().includes(q));
    $('#lst').innerHTML = f.length ? `<div class="dica">${f.length} especialidade(s)</div>` + f.map(x => `<div class="it" data-id="${x.id}"><div class="av">${esc(iniciais(x.especialidade))}</div>
      <div class="tx"><b>${esc(x.especialidade)}</b><small>${esc(x.nome)}${x.data_conclusao ? ' · ' + fmtData(x.data_conclusao) : ' · em curso'}${x.categoria ? ' · ' + esc(x.categoria) : ''}</small></div></div>`).join('')
      : '<div class="vazio">Sem especialidades registadas.</div>';
    $$('#lst .it').forEach(el => el.onclick = () => formEsp(l.find(x => x.id === el.dataset.id), mb.membros, l));
  };
  $$('.seg button', m).forEach(b => b.onclick = () => { S.vistaCl = b.dataset.v; abrir('classes'); });
  $('#q').oninput = des; $('#nova').onclick = () => formEsp(null, mb.membros, l); des();
}

function formEsp(x, membros, todas) {
  const novo = !x; x = x || { data_conclusao: hoje() };
  const nomes = [...new Set(todas.map(e => e.especialidade))].sort();
  const md = modal(`<h3>${novo ? 'Registar especialidade' : esc(x.nome)}</h3><form class="form">
    <label class="full">Especialidade<input name="especialidade" list="dlEsp" value="${esc(x.especialidade)}" required><datalist id="dlEsp">${nomes.map(n => `<option value="${esc(n)}">`).join('')}</datalist></label>
    <label>Categoria<select name="categoria">${opts(CAT_ESP, x.categoria, '—')}</select></label>
    <label>Data de conclusão<input name="data_conclusao" type="date" value="${esc(x.data_conclusao)}"></label>
    <label>Instrutor<input name="instrutor" value="${esc(x.instrutor)}"></label>
    <label>Observações<input name="obs" value="${esc(x.obs)}"></label></form>
    ${novo ? '<p class="dica">Quem concluiu? Pode escolher vários de uma vez.</p>' + checklist(membros.filter(y => y.activo)) : ''}
    <div class="accoes">${novo ? '' : '<button class="btn del esq" id="apagar">Apagar</button>'}<button class="btn sec" data-fechar>Cancelar</button><button class="btn" id="gravar">Guardar</button></div>`);
  if (novo) ligarChecklist(md);
  $('#gravar', md).onclick = (e) => ocupado(e.target, async () => {
    const r = lerForm($('form', md)); r.id = x.id; r.clube_id = S.clube_id; if (novo) r.membros = lerChecklist(md);
    const res = await api('guardarEspecialidade', { registo: r }); md.remove(); aviso(novo ? res.registados + ' registada(s).' : 'Guardado.'); abrir('classes');
  });
  const ap = $('#apagar', md);
  if (ap) ap.onclick = (e) => { if (confirm('Apagar este registo?')) ocupado(e.target, async () => { await api('apagarEspecialidade', { id: x.id }); md.remove(); abrir('classes'); }); };
}

/* ---------- mérito ---------- */
function periodo(k) {
  const d = new Date(), y = d.getFullYear(), mo = d.getMonth();
  const f = (a, b, c) => new Date(Date.UTC(a, b, c)).toISOString().slice(0, 10);
  if (k === 'mes') return [f(y, mo, 1), f(y, mo + 1, 0)];
  if (k === 'tri') { const t = Math.floor(mo / 3) * 3; return [f(y, t, 1), f(y, t + 3, 0)]; }
  return [f(y, 0, 1), f(y, 11, 31)];
}
async function vMerito(m) {
  S.vistaMer = S.vistaMer || 'desb';
  const segM = segm([['desb', 'Desbravadores'], ['clubes', 'Clubes e regiões']], S.vistaMer);
  if (S.vistaMer === 'clubes') return vClassificacao(m, segM);
  if (semClube(m)) return;
  S.per = S.per || 'mes'; if (S.per !== 'pers') [S.de, S.ate] = periodo(S.per);
  const [r, crit] = await Promise.all([api('ranking', { clube_id: S.clube_id, de: S.de, ate: S.ate }), api('criterios', { clube_id: S.clube_id })]);
  const top = r.lista.slice(0, 3); const cores = ['#d4a017', '#a0aec0', '#c0784a'];
  m.innerHTML = `${segM}<div class="barra"><h2>Mérito</h2><button class="btn sec peq" id="crit">Critérios</button><button class="btn" id="lancar">+ Pontos</button></div>
    <div class="barra"><select id="per">${opts([['mes', 'Este mês'], ['tri', 'Este trimestre'], ['ano', 'Este ano'], ['pers', 'Personalizado']], S.per)}</select>
      ${S.per === 'pers' ? `<input type="date" id="de" value="${S.de}"><input type="date" id="ate" value="${S.ate}">` : `<span class="dica">${fmtData(S.de)} a ${fmtData(S.ate)}</span>`}</div>
    ${top.length && top[0].total ? `<div class="podio">${top.map((x, i) => `<div><span class="md" style="background:${cores[i]}">${i + 1}º</span><b>${esc(x.nome.split(' ')[0])}</b><small>${x.total} pts</small></div>`).join('')}</div>` : ''}
    <div class="card"><h3>Classificação</h3>${r.lista.length ? `<div class="tw"><table><tr><th>#</th><th>Desbravador</th><th class="n">Pres.</th><th class="n">Pontos</th></tr>
      ${r.lista.map((x, i) => `<tr class="clic" data-i="${i}"><td>${i + 1}</td><td>${esc(x.nome)}</td><td class="n">${x.presencas}</td><td class="n"><b>${x.total}</b></td></tr>`).join('')}</table></div>`
      : '<div class="vazio">Sem desbravadores activos.</div>'}
      <p class="dica">Presenças, faltas, actividades missionárias e especialidades contam automaticamente. Toque num nome para ver o detalhe.</p></div>
    <div class="card"><h3>Últimos lançamentos</h3><div class="lista">${r.ultimos.map(x => `<div class="it"><div class="av" style="background:${x.pontos > 0 ? '#c6f6d5' : '#fed7d7'}">${x.pontos > 0 ? '+' : ''}${x.pontos}</div>
      <div class="tx"><b>${esc(x.nome)}</b><small>${esc(x.criterio || '')} · ${fmtData(x.data)}${x.obs ? ' · ' + esc(x.obs) : ''}</small></div>
      <button class="btn sec peq" data-del="${x.id}">✕</button></div>`).join('') || '<div class="vazio">Ainda sem lançamentos neste período.</div>'}</div></div>`;
  $('#per').onchange = (e) => { S.per = e.target.value; if (S.per === 'pers' && !S.de) [S.de, S.ate] = periodo('mes'); abrir('merito'); };
  if ($('#de')) ['de', 'ate'].forEach(k => $('#' + k).onchange = (e) => { S[k] = e.target.value; abrir('merito'); });
  $$('tr[data-i]', m).forEach(tr => tr.onclick = () => { const x = r.lista[tr.dataset.i]; const p = x.pontos;
    modal(`<h3>${esc(x.nome)}</h3><table><tr><td>Presenças (${x.presencas})</td><td class="n">${p.presenca}</td></tr><tr><td>Faltas (${x.faltas})</td><td class="n">${p.faltas}</td></tr>
      <tr><td>Actividades missionárias</td><td class="n">${p.missao}</td></tr><tr><td>Especialidades</td><td class="n">${p.especial}</td></tr>
      <tr><td>Lançamentos manuais</td><td class="n">${p.manual}</td></tr><tr><th>Total</th><th class="n">${x.total}</th></tr></table>
      <div class="accoes"><button class="btn" data-fechar>Fechar</button></div>`); });
  $$('[data-del]', m).forEach(b => b.onclick = () => { if (confirm('Apagar este lançamento?')) ocupado(b, async () => { await api('apagarPonto', { id: b.dataset.del }); abrir('merito'); }); });
  $('#lancar').onclick = () => formPontos(crit, r.lista);
  ligarSeg(m, 'vistaMer', 'merito');
  $('#crit').onclick = () => verCriterios(crit);
}

function formPontos(crit, lista) {
  const manuais = crit.filter(c => c.activo && !c.automatico);
  const md = modal(`<h3>Lançar pontos</h3><form class="form">
    <label class="full">Critério<select id="cr">${opts(manuais.map(c => [c.id, `${c.nome} (${c.pontos > 0 ? '+' : ''}${c.pontos})`]), '', 'Escolha…')}</select></label>
    <label>Data<input type="date" id="dt" value="${hoje()}"></label><label>Nota<input id="ob" maxlength="200"></label></form>
    ${checklist(lista.map(x => ({ id: x.id, nome: x.nome })))}
    <div class="accoes"><button class="btn sec" data-fechar>Cancelar</button><button class="btn" id="gravar">Lançar</button></div>`);
  ligarChecklist(md);
  $('#gravar', md).onclick = (e) => ocupado(e.target, async () => {
    if (!$('#cr', md).value) throw new Error('Escolha o critério.');
    const r = await api('lancarPontos', { clube_id: S.clube_id, criterio_id: $('#cr', md).value, data: $('#dt', md).value, obs: $('#ob', md).value, membros: lerChecklist(md) });
    md.remove(); aviso('Pontos lançados a ' + r.lancados + '.'); abrir('merito');
  });
}

function verCriterios(crit) {
  const linha = (c) => `<div class="it${c.activo ? '' : ' inactivo'}" ${c.clube_id ? `data-c="${c.id}"` : ''}><div class="av" style="background:${c.pontos > 0 ? '#c6f6d5' : '#fed7d7'}">${c.pontos > 0 ? '+' : ''}${c.pontos}</div>
    <div class="tx"><b>${esc(c.nome)}</b><small>${esc(c.categoria || '')}${c.automatico ? ' · automático' : ''}</small></div></div>`;
  const md = modal(`<h3>Critérios de mérito</h3>
    <h4 class="sec">Do clube</h4><div class="lista">${crit.filter(c => c.clube_id).map(linha).join('') || '<div class="dica">O clube ainda não tem critérios próprios.</div>'}</div>
    <button class="btn peq" id="novoC" style="margin-top:8px">+ Critério do clube</button>
    <h4 class="sec">Padrão da MSC</h4><div class="lista">${crit.filter(c => !c.clube_id).map(linha).join('')}</div>
    <div class="accoes"><button class="btn" data-fechar>Fechar</button></div>`);
  const form = (c) => {
    c = c || { pontos: 5 };
    const f = modal(`<h3>${c.id ? 'Editar critério' : 'Novo critério do clube'}</h3><form class="form">
      <label class="full">Nome<input name="nome" value="${esc(c.nome)}" required></label>
      <label>Categoria<input name="categoria" value="${esc(c.categoria || 'Clube')}"></label>
      <label>Pontos (negativo = desconto)<input name="pontos" type="number" min="-100" max="100" value="${c.pontos}"></label></form>
      <div class="accoes">${c.id ? '<button class="btn del esq" id="apagar">Apagar</button>' : ''}<button class="btn sec" data-fechar>Cancelar</button><button class="btn" id="gravar">Guardar</button></div>`);
    $('#gravar', f).onclick = (e) => ocupado(e.target, async () => {
      const r = lerForm($('form', f)); r.id = c.id; r.clube_id = S.clube_id; r.pontos = Number(r.pontos);
      await api('guardarCriterio', { registo: r }); f.remove(); md.remove(); aviso('Critério guardado.'); abrir('merito');
    });
    const ap = $('#apagar', f);
    if (ap) ap.onclick = (e) => ocupado(e.target, async () => { const r = await api('apagarCriterio', { id: c.id }); f.remove(); md.remove(); aviso(r.desactivado ? 'Já tinha lançamentos: foi desactivado.' : 'Critério apagado.'); abrir('merito'); });
  };
  $('#novoC', md).onclick = () => form(null);
  $$('[data-c]', md).forEach(el => el.onclick = () => form(crit.find(c => c.id === el.dataset.c)));
}

/* ======================= FASE 3 ======================= */
const CAT_ENT = ['Quotas', 'Seguro', 'Ofertas', 'Doações', 'Vendas e actividades', 'Taxas de eventos', 'Apoio da igreja', 'Outras entradas'];
const CAT_SAI = ['Material', 'Uniformes e insígnias', 'Transporte', 'Alimentação', 'Eventos e camporis', 'Seguro (pago à Missão)', 'Taxas', 'Manutenção', 'Outras saídas'];
const METODOS = ['Numerário', 'Transferência', 'Multicaixa Express', 'Outro'];
const TIPOS_PAG = ['Seguro anual', 'Quota anual', 'Quota mensal', 'Taxa de evento', 'Outro'];
const TIPOS_EV = ['Campori', 'Acampamento', 'Investidura', 'Feira', 'Formação de líderes', 'Desfile', 'Actividade missionária', 'Outro'];
const ESTADOS_EV = ['Inscrições abertas', 'Inscrições fechadas', 'Realizado', 'Cancelado'];
const kz = (v) => (Number(v) || 0).toLocaleString('pt-PT', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' Kz';
const segm = (opcoes, actual) => `<div class="seg">${opcoes.map(([k, t]) => `<button data-v="${k}" class="${actual === k ? 'on' : ''}">${t}</button>`).join('')}</div>`;
function ligarSeg(m, chave, aba) { $$('.seg button', m).forEach(b => b.onclick = () => { S[chave] = b.dataset.v; abrir(aba); }); }
const naoDir = () => S.eu.papel !== 'DIRECTOR';

/* ---------- impressão / PDF ---------- */
/* PDF gerado no próprio telemóvel/computador (pdfmake, guardado em /lib). O conteúdo é escrito em HTML simples
   (grelha, h2, tabela, p, assinaturas) e convertido aqui para o documento PDF. */
let pdfPronto = null;
function carregarScript(src) { return new Promise((ok, falhou) => { const sc = document.createElement('script'); sc.src = src; sc.onload = ok; sc.onerror = () => falhou(new Error('Não foi possível carregar o gerador de PDF.')); document.head.appendChild(sc); }); }
function carregarPDF() {
  if (window.pdfMake && pdfMake.vfs) return Promise.resolve();
  if (!pdfPronto) pdfPronto = carregarScript('/lib/pdfmake.min.js').then(() => carregarScript('/lib/vfs_fonts.js'))
    .then(() => { if (!window.pdfMake || !pdfMake.vfs) throw new Error('Gerador de PDF em falta: confirme que a pasta public/lib foi enviada para o GitHub.'); })
    .catch(e => { pdfPronto = null; throw e; });
  return pdfPronto;
}
let logoPDF = null;
async function logoDataURL() {
  if (logoPDF) return logoPDF;
  const b = await (await fetch('/icons/logo.png')).blob();
  logoPDF = await new Promise(ok => { const r = new FileReader(); r.onload = () => ok(r.result); r.readAsDataURL(b); });
  return logoPDF;
}
function htmlParaPDF(corpo) {
  const raiz = document.createElement('div'); raiz.innerHTML = corpo; const out = [];
  for (const el of raiz.children) {
    if (el.classList.contains('grelha')) {
      const cels = [...el.children].map(d => { const b = d.querySelector('b'); const k = b ? b.textContent : ''; const v = d.textContent.slice(k.length).trim();
        return { stack: [{ text: k, style: 'rot' }, { text: v || '—', style: 'val' }], margin: [0, 0, 0, 6] }; });
      const linhas = []; for (let i = 0; i < cels.length; i += 3) { const l = cels.slice(i, i + 3); while (l.length < 3) l.push(''); linhas.push(l); }
      out.push({ table: { widths: ['*', '*', '*'], body: linhas }, layout: 'noBorders', margin: [0, 2, 0, 6] });
    } else if (el.tagName === 'H2') out.push({ text: el.textContent, style: 'h2' });
    else if (el.tagName === 'TABLE') {
      const rows = [...el.querySelectorAll('tr')];
      const body = rows.map((tr, i) => [...tr.children].map(c => ({ text: c.textContent, style: i === 0 ? 'th' : 'td', alignment: c.classList.contains('n') ? 'right' : 'left' })));
      if (!body.length) continue;
      const nc = body[0].length;
      out.push({ table: { headerRows: 1, dontBreakRows: true, widths: body[0].map((_, i) => i === (nc > 2 ? 1 : 0) ? '*' : 'auto'), body },
        layout: { hLineWidth: () => .5, vLineWidth: () => .5, hLineColor: () => '#c5ccd6', vLineColor: () => '#c5ccd6', fillColor: (r) => r === 0 ? '#eef2f7' : null,
          paddingLeft: () => 4, paddingRight: () => 4, paddingTop: () => 3, paddingBottom: () => 3 }, fontSize: nc > 7 ? 7.5 : 8.5, margin: [0, 0, 0, 8] });
    } else if (el.classList.contains('assin')) {
      out.push({ columns: [...el.children].map(d => ({ stack: [{ canvas: [{ type: 'line', x1: 20, y1: 0, x2: 210, y2: 0, lineWidth: .7 }] }, { text: d.textContent, alignment: 'center', margin: [0, 4, 0, 0], fontSize: 9 }] })), margin: [0, 45, 0, 0] });
    } else if (el.tagName === 'UL' || el.tagName === 'OL') out.push({ [el.tagName === 'UL' ? 'ul' : 'ol']: [...el.children].map(li => li.textContent.trim()), margin: [0, 0, 0, 6] });
    else if (el.tagName === 'H3') out.push({ text: el.textContent, bold: true, fontSize: 10.5, margin: [0, 6, 0, 3] });
    else if (el.textContent.trim()) out.push({ text: el.textContent, margin: [0, 0, 0, 6] });
  }
  return out;
}
async function gerarPDF(titulo, corpo, sub) {
  aviso('A gerar o PDF…');
  await carregarPDF();
  const logo = await logoDataURL();
  const emitido = `SGC Desbravadores MSC · emitido em ${new Date().toLocaleString('pt-PT')} por ${S.eu.nome}`;
  const doc = {
    pageSize: 'A4', pageMargins: [36, 40, 36, 44],
    info: { title: titulo, author: 'SGC Desbravadores MSC' },
    content: [
      { columns: [{ image: logo, width: 56 }, { stack: [{ text: 'Clubes de Desbravadores · Missão Sul de Luanda e Cabinda', fontSize: 9, bold: true, color: '#333' },
        { text: titulo, fontSize: 15, bold: true, color: '#1f3a5f', margin: [0, 2, 0, 0] }, ...(sub ? [{ text: sub, fontSize: 9, color: '#555' }] : [])], margin: [10, 2, 0, 0] }] },
      { canvas: [{ type: 'line', x1: 0, y1: 6, x2: 523, y2: 6, lineWidth: 1.5, lineColor: '#1f3a5f' }], margin: [0, 0, 0, 10] },
      ...htmlParaPDF(corpo)
    ],
    footer: (pag, tot) => ({ columns: [{ text: emitido, fontSize: 7, color: '#777' }, { text: `Página ${pag} de ${tot}`, fontSize: 7, color: '#777', alignment: 'right' }], margin: [36, 12, 36, 0] }),
    styles: { h2: { fontSize: 11.5, bold: true, color: '#1f3a5f', margin: [0, 8, 0, 4] }, th: { bold: true, fontSize: 8 }, td: {}, rot: { fontSize: 7.5, color: '#666', bold: true }, val: { fontSize: 10 } },
    defaultStyle: { fontSize: 9.5 }
  };
  const nome = titulo.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_').slice(0, 80) + '.pdf';
  const blob = await new Promise((ok, falhou) => { try { pdfMake.createPdf(doc).getBlob(ok); } catch (e) { falhou(e); } });
  entregarPDF(blob, nome, titulo);
}
/* Entrega do PDF: botões tocados pela pessoa (os telemóveis só deixam descarregar/partilhar depois de um toque). */
function entregarPDF(blob, nome, titulo) {
  $$('.toast').forEach(t => t.remove());
  const url = URL.createObjectURL(blob);
  const ficheiro = typeof File === 'function' ? new File([blob], nome, { type: 'application/pdf' }) : null;
  const podePart = !!(ficheiro && navigator.canShare && navigator.canShare({ files: [ficheiro] }));
  const md = modal(`<h3>PDF pronto</h3><p class="dica">${esc(nome)} · ${Math.max(1, Math.round(blob.size / 1024))} KB</p>
    <div class="pdfb">${podePart ? '<button class="btn" id="pdfPart">Partilhar (WhatsApp, e-mail…)</button>' : ''}
      <a class="btn${podePart ? ' sec' : ''}" id="pdfDesc" href="${url}" download="${esc(nome)}">Descarregar</a>
      <a class="btn sec" id="pdfAbrir" href="${url}" target="_blank" rel="noopener">Abrir</a></div>
    <div class="accoes"><button class="btn sec" data-fechar>Fechar</button></div>`);
  if (podePart) $('#pdfPart', md).onclick = async () => { try { await navigator.share({ files: [ficheiro], title: titulo }); } catch (e) { if (e.name !== 'AbortError') aviso('Não foi possível partilhar. Use “Descarregar”.', true); } };
  $('#pdfDesc', md).addEventListener('click', () => setTimeout(() => aviso('PDF guardado em Transferências.'), 300));
  const limpar = () => setTimeout(() => URL.revokeObjectURL(url), 60000);
  $$('[data-fechar]', md).forEach(b => b.addEventListener('click', limpar));
}
function imprimir(titulo, corpo, sub) { gerarPDF(titulo, corpo, sub).catch(e => aviso(e.message || 'Não foi possível gerar o PDF.', true)); }
const tabela = (cab, linhas, classes = []) => `<table class="t"><tr>${cab.map((c, i) => `<th class="${classes[i] || ''}">${esc(c)}</th>`).join('')}</tr>
  ${linhas.map(l => `<tr>${l.map((v, i) => `<td class="${classes[i] || ''}">${v}</td>`).join('')}</tr>`).join('')}</table>`;

async function pdfClube(tipo) {
  const d = await api('fichaClube', { clube_id: S.clube_id });
  const c = d.clube; const un = Object.fromEntries(d.unidades.map(u => [u.id, u.nome]));
  const cl = Object.fromEntries(d.classes.map(x => [x.membro_id, x])); const seg = new Set(d.seguro);
  const lin = d.membros.map((x, i) => [i + 1, esc(x.nome), esc(x.tipo || ''), esc(x.sexo || ''), fmtData(x.data_nasc), idade(x.data_nasc) ?? '', esc(un[x.unidade_id] || ''),
    cl[x.id] ? esc(cl[x.id].classe + ' (' + cl[x.id].estado + ')') : '', seg.has(x.id) ? 'Sim' : 'Não']);
  const lista = tabela(['#', 'Nome', 'Tipo', 'Sexo', 'Nascimento', 'Idade', 'Unidade', `Classe ${d.ano}`, 'Seguro'], lin, ['n']);
  if (tipo === 'lista') return imprimir('Lista nominal — ' + c.nome, lista, `${nomeRegiao(c.regiao_id)} · ${d.membros.length} membros activos`);
  const desb = d.membros.filter(x => x.tipo === 'Desbravador');
  imprimir('Ficha do clube — ' + c.nome, `<div class="grelha">
    <div><b>Região</b>${esc(nomeRegiao(c.regiao_id))}</div><div><b>Distrito</b>${esc(c.distrito || '—')}</div><div><b>Igreja</b>${esc(c.igreja || '—')}</div>
    <div><b>Director</b>${esc(c.director || '—')}</div><div><b>Contacto</b>${esc(c.contacto || '—')}</div><div><b>Fundação</b>${fmtData(c.data_fundacao) || '—'}</div>
    <div><b>Desbravadores</b>${desb.length} (${desb.filter(x => x.sexo === 'M').length} M · ${desb.filter(x => x.sexo === 'F').length} F)</div>
    <div><b>Líderes e staff</b>${d.membros.length - desb.length}</div><div><b>Com seguro ${d.ano}</b>${d.membros.filter(x => seg.has(x.id)).length} de ${d.membros.length}</div></div>
    <h2>Unidades</h2>${tabela(['Unidade', 'Tipo', 'Conselheiro', 'Membros'], d.unidades.map(u => [esc(u.nome), esc(u.sexo || ''), esc(u.conselheiro || ''), d.membros.filter(x => x.unidade_id === u.id).length]), ['', '', '', 'n'])}
    <h2>Membros activos</h2>${lista}`);
}

/* ---------- importação Excel ---------- */
let xlsxPronto = null;
function carregarXLSX() {
  if (window.XLSX) return Promise.resolve();
  // Primeiro a versão oficial mais recente (CDN da SheetJS); sem acesso, a cópia guardada no próprio SGC.
  if (!xlsxPronto) xlsxPronto = carregarScript('https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js')
    .catch(() => carregarScript('/lib/xlsx.full.min.js'))
    .then(() => { if (!window.XLSX) throw new Error('Não foi possível carregar o leitor de Excel.'); })
    .catch(e => { xlsxPronto = null; throw e; });
  return xlsxPronto;
}
const COLS_IMP = [['nome', 'Nome'], ['tipo', 'Tipo'], ['sexo', 'Sexo'], ['data_nasc', 'Data de nascimento'], ['unidade', 'Unidade'], ['cargo', 'Cargo'], ['baptizado', 'Baptizado'],
  ['contacto', 'Contacto'], ['encarregado_nome', 'Encarregado de educação'], ['encarregado_contacto', 'Contacto do encarregado'], ['autorizacao_pais', 'Autorização dos pais'], ['data_entrada', 'Data de entrada']];
const ALIAS = { nome: 'nome', 'nome completo': 'nome', tipo: 'tipo', funcao: 'tipo', sexo: 'sexo', genero: 'sexo', 'data de nascimento': 'data_nasc', nascimento: 'data_nasc', data_nasc: 'data_nasc',
  unidade: 'unidade', cargo: 'cargo', baptizado: 'baptizado', contacto: 'contacto', telefone: 'contacto', telemovel: 'contacto', encarregado: 'encarregado_nome',
  'encarregado de educacao': 'encarregado_nome', 'contacto do encarregado': 'encarregado_contacto', 'telefone do encarregado': 'encarregado_contacto',
  'autorizacao dos pais': 'autorizacao_pais', autorizacao: 'autorizacao_pais', 'data de entrada': 'data_entrada' };
const semAcento = (t) => String(t).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
function dataISO(v) {
  if (v == null || v === '') return '';
  if (v instanceof Date && !isNaN(v)) return new Date(v.getTime() - v.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
  if (typeof v === 'number') return new Date(Math.round((v - 25569) * 864e5)).toISOString().slice(0, 10);
  const t = String(v).trim(); let m;
  if ((m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  if ((m = t.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/))) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return t;
}
function normalizar(r) {
  const o = {};
  for (const [k, v] of Object.entries(r)) { const c = ALIAS[semAcento(k)]; if (c) o[c] = v instanceof Date ? v : String(v ?? '').trim(); }
  if (o.sexo) o.sexo = /^f/i.test(o.sexo) ? 'F' : /^m/i.test(o.sexo) ? 'M' : o.sexo;
  for (const k of ['baptizado', 'autorizacao_pais']) if (o[k]) o[k] = /^s/i.test(o[k]) ? 'Sim' : /^n/i.test(o[k]) ? 'Não' : o[k];
  if (o.tipo) { const t = TIPOS.find(x => semAcento(x) === semAcento(o.tipo)); o.tipo = t || o.tipo; } else o.tipo = 'Desbravador';
  for (const k of ['data_nasc', 'data_entrada']) if (o[k] !== undefined) o[k] = dataISO(o[k]);
  return o;
}
function importarExcel() {
  const md = modal(`<h3>Importar membros do Excel</h3>
    <p class="dica">A primeira linha deve ter os títulos das colunas. Só <b>Nome</b> é obrigatório. Datas em DD/MM/AAAA ou formato de data do Excel. Sem coluna Tipo, todos entram como Desbravador.</p>
    <div class="barra"><button class="btn sec peq" id="modelo">Descarregar modelo</button></div>
    <input type="file" id="fx" accept=".xlsx,.xls,.csv"><div id="prev" class="dica" style="margin-top:10px"></div>
    <div class="accoes"><button class="btn sec" data-fechar>Fechar</button><button class="btn" id="ir" disabled>Importar</button></div>`);
  let linhas = [];
  $('#modelo', md).onclick = (e) => ocupado(e.target, async () => {
    await carregarXLSX();
    const ws = XLSX.utils.aoa_to_sheet([COLS_IMP.map(c => c[1]), ['Exemplo Nome Completo', 'Desbravador', 'F', '15/03/2014', 'Gazelas', '', 'Não', '923000000', 'Nome do Encarregado', '924000000', 'Sim', '01/02/2026']]);
    ws['!cols'] = COLS_IMP.map(() => ({ wch: 22 }));
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Membros'); XLSX.writeFile(wb, 'Modelo_membros_SGC.xlsx');
  });
  $('#fx', md).onchange = (e) => ocupado(e.target, async () => {
    const f = e.target.files[0]; if (!f) return;
    await carregarXLSX();
    const wb = XLSX.read(await f.arrayBuffer(), { cellDates: true });
    const bruto = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
    linhas = bruto.map(normalizar).filter(r => Object.values(r).some(v => v));
    const semNome = linhas.filter(r => !r.nome).length;
    $('#prev', md).innerHTML = linhas.length ? `<b>${linhas.length}</b> linha(s) encontradas${semNome ? ` · <span style="color:var(--verm)">${semNome} sem nome (serão rejeitadas)</span>` : ''}.<br>
      Primeiras: ${linhas.slice(0, 3).map(r => esc(r.nome || '?') + (r.data_nasc ? ' (' + esc(r.data_nasc) + ')' : '')).join(', ')}` : 'Não foram encontradas linhas. Confirme a primeira linha de títulos.';
    $('#ir', md).disabled = !linhas.length;
  });
  $('#ir', md).onclick = (e) => ocupado(e.target, async () => {
    let ok = 0; const erros = [];
    for (let i = 0; i < linhas.length; i += 200) {
      $('#prev', md).textContent = `A importar… ${i}/${linhas.length}`;
      const r = await api('importarMembros', { clube_id: S.clube_id, linhas: linhas.slice(i, i + 200), inicio: i });
      ok += r.importados; erros.push(...r.erros);
    }
    $('#prev', md).innerHTML = `<b>${ok}</b> membro(s) importados.` + (erros.length ? `<br><span style="color:var(--verm)">${erros.length} linha(s) com erro:</span><br>` + erros.slice(0, 15).map(x => `Linha ${x.linha}: ${esc(x.erro)}`).join('<br>') : '');
    $('#ir', md).disabled = true; aviso(ok + ' membro(s) importados.');
  });
  $$('[data-fechar]', md).forEach(b => b.addEventListener('click', () => abrir('membros')));
}

/* ---------- relatórios ---------- */
async function vRelatorio(m) {
  if (semClube(m)) return;
  S.vistaRel = S.vistaRel || 'mensal';
  const seg = segm([['mensal', 'Mensal'], ['tri', 'Trimestral'], ...(naoDir() ? [['envios', 'Envios']] : [])], S.vistaRel);
  if (S.vistaRel === 'tri') return vTrimestral(m, seg);
  if (S.vistaRel === 'envios') return vEnvios(m, seg);
  if (!S.mesRel) { const d = new Date(); d.setDate(1); if (new Date().getDate() <= 15) d.setMonth(d.getMonth() - 1); S.mesRel = d.toISOString().slice(0, 7); }
  const [ano, mes] = S.mesRel.split('-').map(Number);
  const d = await api('relatorio', { clube_id: S.clube_id, ano, mes });
  const a = d.auto, mn = d.manual || {}, est = d.registo ? d.registo.estado : 'Por fazer';
  const fechado = est === 'Enviado';
  const sn = (k, t) => `<label>${t}<select name="${k}" ${fechado ? 'disabled' : ''}>${opts(['Sim', 'Não'], mn[k], '—')}</select></label>`;
  m.innerHTML = `${seg}<div class="barra"><h2>Relatório mensal</h2><input type="month" id="mesR" value="${S.mesRel}" style="flex:0 0 auto;width:auto"></div>
    <div class="card"><div class="barra"><h3>${esc(nomeClube(S.clube_id))} · ${MESES[mes - 1]} ${ano}</h3><span class="tag ${fechado ? 'ok' : est === 'Por fazer' ? 'nao' : ''}">${esc(est)}</span></div>
      ${fechado ? `<p class="dica">Enviado em ${new Date(d.registo.enviado_em).toLocaleString('pt-PT')} por ${esc(d.registo.enviado_por)}.</p>` : '<p class="dica">Os números abaixo são calculados a partir das presenças, classes e especialidades. Actualize esses módulos antes de enviar.</p>'}
      <div class="kpis peq">
        ${[['Desbravadores activos', a.activos], ['Líderes e staff', a.lideres], ['Inscritos nas classes', a.inscritos], ['Investidos no mês', a.investidos], ['Actividades', a.actividades],
          ['Assiduidade', a.assiduidade == null ? '—' : a.assiduidade + '%'], ['Actividades missionárias', a.missionarias], ['Encontros de classe bíblica', a.encontros_cb], ['Especialidades concluídas', a.especialidades]]
          .map(([l, v]) => `<div class="kpi"><div class="v">${v}</div><div class="l">${l}</div></div>`).join('')}</div>
      <p class="dica">Pilares: Espiritual ${a.pilar_espiritual} · Físico ${a.pilar_fisico} · Mental ${a.pilar_mental} · Social ${a.pilar_social}</p></div>
    <div class="card"><h3>A preencher pelo clube</h3><form class="form" id="fRel">
      ${sn('classe_biblica_activa', 'Classe bíblica activa?')}<label>Baptismos no mês<input name="baptismos" type="number" min="0" value="${mn.baptismos ?? ''}" ${fechado ? 'disabled' : ''}></label>
      ${sn('calendario_trimestral', 'Tem calendário trimestral?')}${sn('visita', 'Recebeu visita da região/Missão?')}
      <label>Data da visita<input name="data_visita" type="date" value="${esc(mn.data_visita)}" ${fechado ? 'disabled' : ''}></label><label>Quem visitou<input name="visitante" value="${esc(mn.visitante)}" ${fechado ? 'disabled' : ''}></label>
      <label class="full">Destaques do mês<textarea name="destaques" rows="3" ${fechado ? 'disabled' : ''}>${esc(mn.destaques)}</textarea></label>
      <label class="full">Dificuldades / pedidos de apoio<textarea name="dificuldades" rows="3" ${fechado ? 'disabled' : ''}>${esc(mn.dificuldades)}</textarea></label></form>
      <div class="accoes"><button class="btn sec esq" id="pdf">PDF</button><button class="btn wa" id="waR">${IC_WA}</button>
        ${fechado ? (naoDir() ? '<button class="btn del" id="reabrir">Reabrir</button>' : '') : '<button class="btn sec" id="rasc">Guardar rascunho</button><button class="btn" id="enviar">Enviar à região</button>'}</div></div>`;
  $('#mesR').onchange = (e) => { S.mesRel = e.target.value; abrir('relatorio'); };
  ligarSeg(m, 'vistaRel', 'relatorio');
  const g = (enviar) => (e) => ocupado(e.target, async () => {
    if (enviar && !confirm('Depois de enviado, o relatório fica fechado. Enviar?')) return;
    await api('guardarRelatorio', { clube_id: S.clube_id, ano, mes, manual: lerForm($('#fRel')), enviar }); aviso(enviar ? 'Relatório enviado.' : 'Rascunho guardado.'); abrir('relatorio');
  });
  if ($('#rasc')) { $('#rasc').onclick = g(false); $('#enviar').onclick = g(true); }
  if ($('#reabrir')) $('#reabrir').onclick = (e) => { const mot = prompt('Motivo da reabertura:'); if (mot) ocupado(e.target, async () => { await api('reabrirRelatorio', { id: d.registo.id, motivo: mot }); aviso('Relatório reaberto.'); abrir('relatorio'); }); };
  $('#waR').onclick = () => { const f = lerForm($('#fRel'));
    whats(`📊 *Relatório mensal — ${MESES[mes - 1]} ${ano}*\n${nomeClube(S.clube_id)}\n\n👥 Desbravadores activos: ${a.activos}\n✅ Assiduidade: ${a.assiduidade == null ? '—' : a.assiduidade + '%'}\n📅 Actividades: ${a.actividades} (missionárias: ${a.missionarias})\n🎖️ Investidos no mês: ${a.investidos}\n🏅 Especialidades: ${a.especialidades}\n💧 Baptismos: ${f.baptismos || 0}${f.destaques ? '\n\n⭐ ' + f.destaques : ''}\n\nEstado: ${est} · SGC Desbravadores MSC`); };
  $('#pdf').onclick = () => { const f = lerForm($('#fRel'));
    imprimir(`Relatório mensal — ${MESES[mes - 1]} ${ano}`, `<div class="grelha">${[['Clube', esc(nomeClube(S.clube_id))], ['Região', esc(nomeRegiao((S.clubes.find(c => c.id === S.clube_id) || {}).regiao_id))], ['Estado', esc(est)],
      ['Desbravadores activos', a.activos], ['Líderes e staff', a.lideres], ['Inscritos nas classes', a.inscritos], ['Investidos no mês', a.investidos], ['Actividades', a.actividades],
      ['Assiduidade', a.assiduidade == null ? '—' : a.assiduidade + '%'], ['Actividades missionárias', a.missionarias], ['Encontros de classe bíblica', a.encontros_cb], ['Especialidades', a.especialidades],
      ['Pilares (E/F/M/S)', `${a.pilar_espiritual}/${a.pilar_fisico}/${a.pilar_mental}/${a.pilar_social}`], ['Classe bíblica activa', esc(f.classe_biblica_activa || '—')], ['Baptismos', esc(f.baptismos || '0')],
      ['Calendário trimestral', esc(f.calendario_trimestral || '—')], ['Visita', esc((f.visita || '—') + (f.data_visita ? ' · ' + fmtData(f.data_visita) : '') + (f.visitante ? ' · ' + f.visitante : ''))]]
      .map(([k, v]) => `<div><b>${k}</b>${v}</div>`).join('')}</div><h2>Destaques</h2><p>${esc(f.destaques || '—')}</p><h2>Dificuldades</h2><p>${esc(f.dificuldades || '—')}</p>
      <div class="assin"><div>O Director do clube</div><div>O Director regional</div></div>`); };
}

async function vTrimestral(m, seg) {
  const hojeD = new Date(); S.anoT = S.anoT || hojeD.getFullYear(); S.tT = S.tT || Math.max(1, Math.floor(hojeD.getMonth() / 3));
  S.ambT = S.ambT || (S.eu.papel === 'DIRECTOR' ? 'clube' : S.eu.papel === 'REGIONAL' ? 'regiao' : 'missao');
  const ambs = S.eu.papel === 'MSC' ? [['missao', 'Toda a Missão'], ...S.regioes.map(r => ['r:' + r.id, r.nome]), ['clube', 'Clube seleccionado']]
    : S.eu.papel === 'REGIONAL' ? [['regiao', 'A minha região'], ['clube', 'Clube seleccionado']] : [['clube', 'O meu clube']];
  const p = { ano: S.anoT, t: S.tT };
  if (S.ambT === 'clube') p.clube_id = S.clube_id; else if (S.ambT.startsWith('r:')) p.regiao_id = S.ambT.slice(2); else if (S.ambT === 'regiao') p.regiao_id = S.eu.regiao_id;
  const d = await api('trimestral', p); const t = d.totais;
  const titAmb = (ambs.find(a => a[0] === S.ambT) || [, ''])[1].replace('Clube seleccionado', nomeClube(S.clube_id)).replace('O meu clube', nomeClube(S.clube_id)).replace('A minha região', nomeRegiao(S.eu.regiao_id));
  const anos = []; for (let y = hojeD.getFullYear(); y >= 2024; y--) anos.push(y);
  m.innerHTML = `${seg}<h2>Relatório trimestral</h2><div class="barra"><select id="anoT">${opts(anos, S.anoT)}</select><select id="tT">${opts([[1, 'T1 (Jan–Mar)'], [2, 'T2 (Abr–Jun)'], [3, 'T3 (Jul–Set)'], [4, 'T4 (Out–Dez)']], S.tT)}</select>
    <select id="ambT">${opts(ambs, S.ambT)}</select></div>
    <div class="kpis">${[['Clubes', t.clubes], ['Relatórios enviados', `${t.relatorios}/${t.relatorios_esperados}`], ['Clubes com os 3 meses', t.clubes_completos], ['Desbravadores activos', t.activos],
      ['Actividades', t.actividades], ['Assiduidade média', t.assiduidade == null ? '—' : t.assiduidade + '%'], ['Actividades missionárias', t.missionarias], ['Investidos', t.investidos], ['Baptismos', t.baptismos], ['Visitas recebidas', t.visitas]]
      .map(([l, v]) => `<div class="kpi"><div class="v">${v}</div><div class="l">${l}</div></div>`).join('')}</div>
    <div class="card"><div class="barra"><h3>Por clube</h3><button class="btn sec peq" id="pdfT">PDF</button></div><div class="tw" id="tabT"></div>
    <p class="dica">Só contam os relatórios mensais <b>enviados</b>. Activos = último mês enviado.</p></div>`;
  const cab = ['Clube', 'Meses', 'Activos', 'Activ.', 'Assid.', 'Mission.', 'Invest.', 'Baptis.'], cls = ['', 'n', 'n', 'n', 'n', 'n', 'n', 'n'];
  const lin = d.clubes.map(c => [esc(c.nome), `${c.enviados}/3`, c.activos ?? '—', c.actividades, c.assiduidade == null ? '—' : c.assiduidade + '%', c.missionarias, c.investidos, c.baptismos]);
  $('#tabT').innerHTML = tabela(cab, lin, cls);
  ['anoT', 'tT', 'ambT'].forEach(k => $('#' + k).onchange = (e) => { S[k] = k === 'ambT' ? e.target.value : +e.target.value; abrir('relatorio'); });
  ligarSeg(m, 'vistaRel', 'relatorio');
  $('#pdfT').onclick = () => imprimir(`Relatório trimestral T${S.tT} ${S.anoT}`, `<div class="grelha">${[['Âmbito', esc(titAmb)], ['Clubes', t.clubes], ['Relatórios enviados', `${t.relatorios} de ${t.relatorios_esperados}`],
    ['Desbravadores activos', t.activos], ['Líderes', t.lideres], ['Inscritos nas classes', t.inscritos], ['Actividades', t.actividades], ['Assiduidade média', t.assiduidade == null ? '—' : t.assiduidade + '%'],
    ['Actividades missionárias', t.missionarias], ['Encontros de classe bíblica', t.encontros_cb], ['Especialidades', t.especialidades], ['Investidos', t.investidos], ['Baptismos', t.baptismos], ['Visitas', t.visitas]]
    .map(([k, v]) => `<div><b>${k}</b>${v}</div>`).join('')}</div><h2>Por clube</h2>${tabela(cab, lin, cls)}`);
}

async function vEnvios(m, seg) {
  S.anoE = S.anoE || new Date().getFullYear();
  const p = { ano: S.anoE }; if (S.eu.papel === 'MSC' && S.regE) p.regiao_id = S.regE;
  const d = await api('estadoRelatorios', p);
  const simb = (e) => e === 'Enviado' ? '<span class="st ok">✓</span>' : e ? '<span class="st r" title="' + esc(e) + '">R</span>' : '<span class="st">·</span>';
  const mesAct = new Date().getFullYear() === S.anoE ? new Date().getMonth() : 12;
  const env = (c) => Object.values(c.meses).filter(e => e === 'Enviado').length;
  m.innerHTML = `${seg}<h2>Envios de relatórios</h2><div class="barra"><select id="anoE">${opts([new Date().getFullYear(), new Date().getFullYear() - 1], S.anoE)}</select>
    ${S.eu.papel === 'MSC' ? `<select id="regE">${opts(S.regioes.map(r => [r.id, r.nome]), S.regE, 'Todas as regiões')}</select>` : ''}</div>
    <div class="card"><div class="tw"><table class="env"><tr><th>Clube</th>${MESES.map(x => `<th>${x.slice(0, 3)}</th>`).join('')}<th class="n">Total</th></tr>
      ${d.clubes.map(c => `<tr><td>${esc(c.nome)}</td>${MESES.map((_, i) => `<td>${simb(c.meses[i + 1])}</td>`).join('')}<td class="n">${env(c)}/${mesAct}</td></tr>`).join('')}</table></div>
      <p class="dica">✓ enviado · R rascunho ou reaberto · · por fazer. Para ver um relatório, escolha o clube no topo e abra “Mensal”.</p></div>`;
  const tw = $('.tw', m); tw.scrollLeft = tw.scrollWidth;
  $('#anoE').onchange = (e) => { S.anoE = +e.target.value; abrir('relatorio'); };
  if ($('#regE')) $('#regE').onchange = (e) => { S.regE = e.target.value; abrir('relatorio'); };
  ligarSeg(m, 'vistaRel', 'relatorio');
}

/* ---------- finanças ---------- */
async function vFinancas(m) {
  if (semClube(m)) return;
  S.vistaFin = S.vistaFin || 'mov';
  const seg = segm([['mov', 'Movimentos'], ['seg', 'Seguro e taxas'], ...(naoDir() ? [['clubes', 'Clubes']] : [])], S.vistaFin);
  if (S.vistaFin === 'seg') return vSeguro(m, seg);
  if (S.vistaFin === 'clubes') return vFinClubes(m, seg);
  S.perF = S.perF || 'ano'; if (S.perF !== 'pers') [S.deF, S.ateF] = periodo(S.perF);
  const d = await api('movimentos', { clube_id: S.clube_id, de: S.deF, ate: S.ateF });
  m.innerHTML = `${seg}<div class="barra"><h2>Finanças</h2><button class="btn" id="novoMv">+ Movimento</button></div>
    <div class="barra"><select id="perF">${opts([['mes', 'Este mês'], ['tri', 'Este trimestre'], ['ano', 'Este ano'], ['pers', 'Personalizado']], S.perF)}</select>
      ${S.perF === 'pers' ? `<input type="date" id="deF" value="${S.deF}"><input type="date" id="ateF" value="${S.ateF}">` : `<span class="dica">${fmtData(S.deF)} a ${fmtData(S.ateF)}</span>`}</div>
    <div class="kpis"><div class="kpi"><div class="v" style="color:${d.saldo < 0 ? 'var(--verm)' : 'var(--azul)'}">${kz(d.saldo)}</div><div class="l">Saldo actual (desde o início)</div></div>
      <div class="kpi"><div class="v" style="color:var(--verde)">${kz(d.entradas)}</div><div class="l">Entradas no período</div></div>
      <div class="kpi"><div class="v" style="color:var(--verm)">${kz(d.saidas)}</div><div class="l">Saídas no período</div></div></div>
    <div class="card"><div class="barra"><h3>Movimentos</h3><button class="btn sec peq" id="pdfF">PDF</button></div><div class="lista">${d.lista.map(x => `<div class="it${x.estado === 'Anulado' ? ' anul' : ''}" data-id="${x.id}">
      <div class="av" style="background:${x.tipo === 'Entrada' ? '#c6f6d5' : '#fed7d7'}">${x.tipo === 'Entrada' ? '+' : '−'}</div>
      <div class="tx"><b>${esc(x.descricao || x.categoria)}</b><small>${fmtData(x.data)} · ${esc(x.categoria)}${x.membro ? ' · ' + esc(x.membro) : ''}${x.estado === 'Anulado' ? ' · ANULADO' : ''}</small></div>
      <b style="white-space:nowrap;color:${x.tipo === 'Entrada' ? 'var(--verde)' : 'var(--verm)'}">${x.tipo === 'Entrada' ? '' : '−'}${kz(x.valor)}</b></div>`).join('') || '<div class="vazio">Sem movimentos neste período.</div>'}</div></div>`;
  ligarSeg(m, 'vistaFin', 'financas');
  $('#perF').onchange = (e) => { S.perF = e.target.value; if (S.perF === 'pers' && !S.deF) [S.deF, S.ateF] = periodo('mes'); abrir('financas'); };
  if ($('#deF')) ['deF', 'ateF'].forEach(k => $('#' + k).onchange = (e) => { S[k] = e.target.value; abrir('financas'); });
  $('#novoMv').onclick = () => formMovimento();
  $$('.lista .it', m).forEach(el => el.onclick = () => verMovimento(d.lista.find(x => x.id === el.dataset.id)));
  $('#pdfF').onclick = () => imprimir('Extrato financeiro — ' + nomeClube(S.clube_id), `<div class="grelha"><div><b>Período</b>${fmtData(S.deF)} a ${fmtData(S.ateF)}</div><div><b>Entradas</b>${kz(d.entradas)}</div>
    <div><b>Saídas</b>${kz(d.saidas)}</div><div><b>Saldo actual</b>${kz(d.saldo)}</div></div>
    <h2>Por categoria</h2>${tabela(['Tipo', 'Categoria', 'Total'], d.por_categoria.map(x => [x.tipo, esc(x.categoria), kz(x.total)]), ['', '', 'n'])}
    <h2>Movimentos</h2>${tabela(['Data', 'Tipo', 'Categoria', 'Descrição', 'Método', 'Valor', 'Estado'], d.lista.map(x => [fmtData(x.data), x.tipo, esc(x.categoria), esc(x.descricao || ''), esc(x.metodo || ''), kz(x.valor), x.estado]), ['', '', '', '', '', 'n', ''])}
    <div class="assin"><div>O Tesoureiro</div><div>O Director do clube</div></div>`);
}

async function formMovimento() {
  const mb = await api('membros', { clube_id: S.clube_id });
  const md = modal(`<h3>Novo movimento</h3><form class="form">
    <label>Tipo<select name="tipo" id="tp">${opts(['Entrada', 'Saída'], 'Entrada')}</select></label>
    <label>Categoria<select name="categoria" id="ct"></select></label>
    <label>Valor (Kz)<input name="valor" type="number" min="0" step="0.01" inputmode="decimal" required></label>
    <label>Data<input name="data" type="date" value="${hoje()}" max="${hoje()}"></label>
    <label class="full">Descrição<input name="descricao" maxlength="200" placeholder="Ex.: Quotas de Novembro"></label>
    <label>Método<select name="metodo">${opts(METODOS, 'Numerário')}</select></label>
    <label>Referência / recibo<input name="referencia"></label>
    <label class="full">Membro (opcional)<select name="membro_id">${opts(mb.membros.filter(x => x.activo).map(x => [x.id, x.nome]), '', '—')}</select></label></form>
    <p class="dica">Os movimentos não se apagam: se houver um erro, anule-o e registe de novo. A região e a Missão podem consultar.</p>
    <div class="accoes"><button class="btn sec" data-fechar>Cancelar</button><button class="btn" id="gravar">Registar</button></div>`);
  const cats = () => { $('#ct', md).innerHTML = opts($('#tp', md).value === 'Entrada' ? CAT_ENT : CAT_SAI, ''); };
  $('#tp', md).onchange = cats; cats();
  $('#gravar', md).onclick = (e) => ocupado(e.target, async () => {
    const r = lerForm($('form', md)); r.clube_id = S.clube_id; await api('guardarMovimento', { registo: r }); md.remove(); aviso('Movimento registado.'); abrir('financas');
  });
}
function verMovimento(x) {
  const md = modal(`<h3>${x.tipo} · ${kz(x.valor)}</h3><table>
    ${[['Data', fmtData(x.data)], ['Categoria', x.categoria], ['Descrição', x.descricao], ['Método', x.metodo], ['Referência', x.referencia], ['Membro', x.membro], ['Registado por', x.registado_por + ' (' + x.registado_papel + ')'],
      ['Estado', x.estado], ...(x.estado === 'Anulado' ? [['Anulado por', x.anulado_por], ['Motivo', x.motivo_anulacao]] : [])].map(([k, v]) => `<tr><th>${k}</th><td>${esc(v || '—')}</td></tr>`).join('')}</table>
    <div class="accoes">${x.estado === 'Válido' ? '<button class="btn del esq" id="anular">Anular</button>' : ''}<button class="btn" data-fechar>Fechar</button></div>`);
  const b = $('#anular', md);
  if (b) b.onclick = (e) => { const mot = prompt('Motivo da anulação:'); if (mot) ocupado(e.target, async () => { await api('anularMovimento', { id: x.id, motivo: mot }); md.remove(); aviso('Movimento anulado.'); abrir('financas'); }); };
}

async function vSeguro(m, seg) {
  S.anoS = S.anoS || new Date().getFullYear();
  const [pg, mb] = await Promise.all([api('pagamentos', { clube_id: S.clube_id, ano: S.anoS }), api('membros', { clube_id: S.clube_id })]);
  const activos = mb.membros.filter(x => x.activo);
  const comSeg = new Set(pg.filter(x => x.tipo === 'Seguro anual').map(x => x.membro_id));
  const sem = activos.filter(x => !comSeg.has(x.id));
  m.innerHTML = `${seg}<div class="barra"><h2>Seguro e taxas</h2><select id="anoS" style="flex:0 0 auto;width:auto;min-width:0">${opts([new Date().getFullYear() + 1, new Date().getFullYear(), new Date().getFullYear() - 1], S.anoS)}</select><button class="btn" id="novoP">+ Pagamento</button></div>
    <div class="kpis"><div class="kpi"><div class="v">${activos.length - sem.length}/${activos.length}</div><div class="l">Com seguro ${S.anoS}</div></div>
      <div class="kpi"><div class="v">${kz(pg.reduce((a, x) => a + x.valor, 0))}</div><div class="l">Total pago em ${S.anoS}</div></div></div>
    ${sem.length ? `<div class="card"><h3>Sem seguro em ${S.anoS} (${sem.length})</h3><p class="dica">${sem.map(x => esc(x.nome)).join(' · ')}</p></div>` : ''}
    <div class="card"><h3>Pagamentos</h3><div class="lista">${pg.map(x => `<div class="it"><div class="av">${esc(iniciais(x.nome))}</div>
      <div class="tx"><b>${esc(x.nome)}</b><small>${esc(x.tipo)} · ${fmtData(x.data)} · ${kz(x.valor)}${x.recibo ? ' · recibo ' + esc(x.recibo) : ''}</small></div>
      <button class="btn sec peq" data-del="${x.id}">✕</button></div>`).join('') || '<div class="vazio">Sem pagamentos registados.</div>'}</div></div>`;
  ligarSeg(m, 'vistaFin', 'financas');
  $('#anoS').onchange = (e) => { S.anoS = +e.target.value; abrir('financas'); };
  $$('[data-del]', m).forEach(b => b.onclick = () => { if (confirm('Apagar este pagamento? (O movimento financeiro, se existir, deve ser anulado em Movimentos.)')) ocupado(b, async () => { await api('apagarPagamento', { id: b.dataset.del }); abrir('financas'); }); });
  $('#novoP').onclick = () => {
    const md = modal(`<h3>Registar pagamento · ${S.anoS}</h3><form class="form">
      <label>Tipo<select id="tpP">${opts(TIPOS_PAG, 'Seguro anual')}</select></label><label>Valor por membro (Kz)<input id="vlP" type="number" min="0" step="0.01" inputmode="decimal"></label>
      <label>Data<input id="dtP" type="date" value="${hoje()}" max="${hoje()}"></label><label>Recibo<input id="rcP"></label>
      <label>Método<select id="mtP">${opts(METODOS, 'Numerário')}</select></label>
      <label class="full" style="flex-direction:row;align-items:center;gap:8px"><input type="checkbox" id="mvP" checked style="width:20px;height:20px"> Registar também o total como entrada nas Finanças</label></form>
      <div id="chkP"></div><div class="accoes"><button class="btn sec" data-fechar>Cancelar</button><button class="btn" id="gravar">Registar</button></div>`);
    const lista = () => { const sg = $('#tpP', md).value === 'Seguro anual'; $('#chkP', md).innerHTML = checklist(sg ? sem : activos); ligarChecklist(md); };
    $('#tpP', md).onchange = lista; lista();
    $('#gravar', md).onclick = (e) => ocupado(e.target, async () => {
      const r = await api('registarPagamentos', { clube_id: S.clube_id, ano: S.anoS, tipo: $('#tpP', md).value, valor: $('#vlP', md).value, data: $('#dtP', md).value,
        recibo: $('#rcP', md).value, metodo: $('#mtP', md).value, movimento: $('#mvP', md).checked, membros: lerChecklist(md) });
      md.remove(); aviso(r.registados + ' pagamento(s) registados.'); abrir('financas');
    });
  };
}

async function vFinClubes(m, seg) {
  S.anoFC = S.anoFC || new Date().getFullYear();
  const d = await api('resumoFinancas', { ano: S.anoFC });
  const tot = (k) => d.clubes.reduce((a, c) => a + c[k], 0);
  m.innerHTML = `${seg}<div class="barra"><h2>Finanças dos clubes</h2><select id="anoFC" style="flex:0 0 auto;width:auto;min-width:0">${opts([new Date().getFullYear(), new Date().getFullYear() - 1], S.anoFC)}</select></div>
    <div class="kpis"><div class="kpi"><div class="v">${kz(tot('entradas'))}</div><div class="l">Entradas ${S.anoFC}</div></div><div class="kpi"><div class="v">${kz(tot('saidas'))}</div><div class="l">Saídas ${S.anoFC}</div></div>
      <div class="kpi"><div class="v">${kz(tot('saldo'))}</div><div class="l">Saldo somado dos clubes</div></div><div class="kpi"><div class="v">${d.clubes.filter(c => !c.ultimo).length}</div><div class="l">Clubes sem movimentos</div></div></div>
    <div class="card"><div class="tw"><table><tr><th>Clube</th><th class="n">Entradas</th><th class="n">Saídas</th><th class="n">Saldo</th><th>Último</th></tr>
      ${d.clubes.map(c => `<tr class="clic" data-c="${c.id}"><td>${esc(c.nome)}<br><small class="dica">${esc(nomeRegiao(c.regiao_id))}</small></td><td class="n">${kz(c.entradas)}</td><td class="n">${kz(c.saidas)}</td>
        <td class="n" style="color:${c.saldo < 0 ? 'var(--verm)' : ''}">${kz(c.saldo)}</td><td>${fmtData(c.ultimo) || '—'}</td></tr>`).join('')}</table></div>
      <p class="dica">Toque num clube para ver os movimentos.</p></div>`;
  ligarSeg(m, 'vistaFin', 'financas');
  $('#anoFC').onchange = (e) => { S.anoFC = +e.target.value; abrir('financas'); };
  $$('[data-c]', m).forEach(tr => tr.onclick = () => { S.clube_id = tr.dataset.c; gravar('sgc_clube', S.clube_id); const sel = $('#selClube'); if (sel) sel.value = S.clube_id; S.vistaFin = 'mov'; abrir('financas'); });
}

/* ---------- eventos ---------- */
async function vEventos(m) {
  const l = await api('eventos');
  m.innerHTML = `<div class="barra"><h2>Eventos</h2>${naoDir() ? '<button class="btn" id="novoEv">+ Evento</button>' : ''}</div>
    ${l.map(e => `<div class="card ev" data-id="${e.id}"><div class="barra"><h3>${esc(e.nome)}</h3><span class="tag ${e.estado === 'Inscrições abertas' ? 'ok' : e.estado === 'Cancelado' ? 'nao' : ''}">${esc(e.estado)}</span></div>
      <div class="dica">${esc(e.tipo)} · ${fmtData(e.data_inicio)}${e.data_fim !== e.data_inicio ? ' a ' + fmtData(e.data_fim) : ''}${e.local ? ' · ' + esc(e.local) : ''}<br>
      ${e.nivel === 'Missão' ? 'Missão' : esc(nomeRegiao(e.regiao_id))} · Taxa ${kz(e.taxa)} · ${naoDir() ? `${e.inscritos} inscritos de ${e.clubes} clube(s)` : `${e.do_clube} inscritos do clube`}</div></div>`).join('')
      || '<div class="card vazio">Ainda não há eventos.</div>'}`;
  if ($('#novoEv')) $('#novoEv').onclick = () => formEvento(null);
  $$('.ev', m).forEach(el => el.onclick = () => verEvento(l.find(e => e.id === el.dataset.id)));
}
function formEvento(e) {
  e = e || { tipo: 'Campori', nivel: S.eu.papel === 'MSC' ? 'Missão' : 'Região', estado: 'Inscrições abertas', taxa: 0, data_inicio: hoje() };
  const md = modal(`<h3>${e.id ? 'Editar evento' : 'Novo evento'}</h3><form class="form">
    <label class="full">Nome<input name="nome" value="${esc(e.nome)}" required></label>
    <label>Tipo<select name="tipo">${opts(TIPOS_EV, e.tipo)}</select></label>
    ${S.eu.papel === 'MSC' ? `<label>Nível<select name="nivel" id="nv">${opts(['Missão', 'Região'], e.nivel)}</select></label><label id="lrg">Região<select name="regiao_id">${opts(S.regioes.map(r => [r.id, r.nome]), e.regiao_id, 'Escolha…')}</select></label>` : ''}
    <label>Início<input name="data_inicio" type="date" value="${esc(e.data_inicio)}"></label><label>Fim<input name="data_fim" type="date" value="${esc(e.data_fim)}"></label>
    <label>Local<input name="local" value="${esc(e.local)}"></label><label>Taxa por participante (Kz)<input name="taxa" type="number" min="0" value="${e.taxa}"></label>
    <label>Estado<select name="estado">${opts(ESTADOS_EV, e.estado)}</select></label></form>
    <div class="accoes">${e.id ? '<button class="btn del esq" id="apagar">Apagar</button>' : ''}<button class="btn sec" data-fechar>Cancelar</button><button class="btn" id="gravar">Guardar</button></div>`);
  const nv = $('#nv', md); if (nv) { const f = () => $('#lrg', md).hidden = nv.value !== 'Região'; nv.onchange = f; f(); }
  $('#gravar', md).onclick = (ev) => ocupado(ev.target, async () => { const r = lerForm($('form', md)); r.id = e.id; await api('guardarEvento', { registo: r }); md.remove(); aviso('Evento guardado.'); abrir('eventos'); });
  const ap = $('#apagar', md); if (ap) ap.onclick = (ev) => { if (confirm('Apagar o evento?')) ocupado(ev.target, async () => { await api('apagarEvento', { id: e.id }); md.remove(); abrir('eventos'); }); };
}
async function verEvento(e) {
  const d = S.clube_id ? await api('inscricoesEvento', { evento_id: e.id, clube_id: S.clube_id }) : { membros: [] };
  const insc = d.membros.filter(x => x.inscrito).map(x => x.id);
  const aberto = e.estado === 'Inscrições abertas' || e.organizador;
  const md = modal(`<h3>${esc(e.nome)}</h3><p class="dica">${esc(e.tipo)} · ${fmtData(e.data_inicio)}${e.data_fim !== e.data_inicio ? ' a ' + fmtData(e.data_fim) : ''} · ${esc(e.local || '')} · Taxa ${kz(e.taxa)} · ${esc(e.estado)}</p>
    <div class="barra"><button class="btn wa peq" id="waEv">${IC_WA} Convocatória</button>${e.organizador ? '<button class="btn sec peq" id="edit">Editar</button><button class="btn sec peq" id="lista">Inscritos (PDF)</button>' : ''}</div>
    ${S.clube_id ? `<h4 class="sec">Inscrições do clube ${esc(nomeClube(S.clube_id))}</h4>${aberto ? checklist(d.membros, insc, x => `<span class="tag ${x.seguro ? 'ok' : 'nao'}">${x.seguro ? 'Seguro' : 'Sem seguro'}</span>`) : `<p class="dica">${insc.length} inscritos. Inscrições fechadas.</p>`}
      <p class="dica" id="totEv"></p>` : ''}
    <div class="accoes"><button class="btn sec" data-fechar>Fechar</button>${S.clube_id && aberto ? '<button class="btn" id="gravar">Guardar inscrições</button>' : ''}</div>`);
  if (S.clube_id && aberto) {
    ligarChecklist(md);
    const tot = () => { $('#totEv', md).textContent = `Total a pagar: ${kz(lerChecklist(md).length * e.taxa)}`; };
    $$('.chkl input', md).forEach(i => i.addEventListener('change', tot)); $('.chkall', md).addEventListener('click', tot); tot();
    $('#gravar', md).onclick = (ev) => ocupado(ev.target, async () => { const r = await api('definirInscricoes', { evento_id: e.id, clube_id: S.clube_id, membros: lerChecklist(md) }); md.remove(); aviso(r.inscritos + ' inscrito(s).'); abrir('eventos'); });
  }
  if ($('#edit', md)) $('#edit', md).onclick = () => { md.remove(); formEvento(e); };
  $('#waEv', md).onclick = () => whats(`⛺ *${e.nome}*\n${e.tipo} · ${e.nivel === 'Missão' ? 'Missão' : nomeRegiao(e.regiao_id)}\n📅 ${fmtData(e.data_inicio)}${e.data_fim !== e.data_inicio ? ' a ' + fmtData(e.data_fim) : ''}${e.local ? '\n📍 ' + e.local : ''}\n💰 Taxa: ${kz(e.taxa)} por participante\n\nInscrições no SGC (separador Eventos). Confirmem o seguro de cada desbravador.\n\n— SGC Desbravadores MSC`);
  if ($('#lista', md)) $('#lista', md).onclick = (ev) => ocupado(ev.target, async () => {
    const r = await api('resumoEvento', { id: e.id });
    const porClube = {}; r.inscritos.forEach(x => { (porClube[x.clube] = porClube[x.clube] || []).push(x); });
    imprimir('Inscritos — ' + e.nome, `<div class="grelha"><div><b>Datas</b>${fmtData(e.data_inicio)} a ${fmtData(e.data_fim)}</div><div><b>Local</b>${esc(e.local || '—')}</div>
      <div><b>Inscritos</b>${r.inscritos.length}</div><div><b>Clubes</b>${Object.keys(porClube).length}</div><div><b>Taxa</b>${kz(e.taxa)}</div><div><b>Total</b>${kz(r.inscritos.length * e.taxa)}</div></div>
      <h2>Resumo por clube</h2>${tabela(['Clube', 'Inscritos', 'A pagar'], Object.entries(porClube).map(([c, l]) => [esc(c), l.length, kz(l.length * e.taxa)]), ['', 'n', 'n'])}
      ${Object.entries(porClube).map(([c, l]) => `<h2>${esc(c)}</h2>${tabela(['#', 'Nome', 'Tipo', 'Sexo', 'Idade'], l.map((x, i) => [i + 1, esc(x.nome), esc(x.tipo || ''), esc(x.sexo || ''), idade(x.data_nasc) ?? '']), ['n'])}`).join('')}`);
  });
}

/* ======================= FASE 4 ======================= */
const quando = (iso) => { if (!iso) return ''; const d = new Date(iso), s = (Date.now() - d) / 1000;
  if (s < 60) return 'agora'; if (s < 3600) return Math.floor(s / 60) + ' min'; if (s < 86400) return Math.floor(s / 3600) + ' h';
  if (s < 7 * 86400) return Math.floor(s / 86400) + ' d'; return d.toLocaleDateString('pt-PT'); };

/* ---------- sino ---------- */
let sinoT = null;
async function actualizarSino() {
  clearTimeout(sinoT); sinoT = setTimeout(actualizarSino, 90000);
  if (!S.token || !navigator.onLine) return;
  try {
    const d = await api('notificacoes'); S.notif = d;
    const b = $('#sinoN'); if (b) { b.hidden = !d.novas; b.textContent = d.novas > 99 ? '99+' : d.novas; }
    if (navigator.setAppBadge) { d.novas ? navigator.setAppBadge(d.novas).catch(() => {}) : navigator.clearAppBadge().catch(() => {}); }
  } catch (e) {}
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.token) actualizarSino(); });
async function abrirSino() {
  const ex = $('.notifP'); if (ex) { ex.remove(); return; }
  const pn = document.createElement('div'); pn.className = 'notifP'; pn.innerHTML = '<div class="vazio">A carregar…</div>'; document.body.appendChild(pn);
  const fora = (e) => { if (!pn.contains(e.target) && !e.target.closest('#sino')) { pn.remove(); document.removeEventListener('click', fora, true); } };
  setTimeout(() => document.addEventListener('click', fora, true), 0);
  try {
    const d = await api('notificacoes');
    pn.innerHTML = `<div class="np-c"><b>Notificações</b>${d.novas ? `<span class="tag">${d.novas} nova(s)</span>` : ''}</div>` + (d.lista.map(n => `<div class="it${n.nova ? ' nova' : ''}" data-aba="${esc(n.aba || '')}" data-c="${esc(n.clube_id || '')}">
      <b>${esc(n.titulo)}</b>${n.texto ? `<div>${esc(n.texto)}</div>` : ''}<small>${quando(n.data)}</small></div>`).join('') || '<div class="vazio">Sem notificações.</div>');
    $$('.it', pn).forEach(el => el.onclick = () => { pn.remove(); if (el.dataset.c && S.clubes.some(c => c.id === el.dataset.c)) { S.clube_id = el.dataset.c; const sel = $('#selClube'); if (sel) sel.value = S.clube_id; } if (el.dataset.aba && ABAS.some(a => a[0] === el.dataset.aba)) abrir(el.dataset.aba); });
    if (d.novas) { await api('marcarLidas'); const b = $('#sinoN'); if (b) b.hidden = true; if (navigator.clearAppBadge) navigator.clearAppBadge().catch(() => {}); }
  } catch (e) { pn.innerHTML = `<div class="vazio">${esc(e.message)}</div>`; }
}

/* ---------- comunicados ---------- */
async function vComunicados(m) {
  S.comArq = S.comArq || false;
  const l = await api('comunicados', { arquivados: S.comArq ? 1 : 0 });
  const naoLidos = l.filter(c => !c.lido && !c.meu).length;
  m.innerHTML = `<div class="barra"><h2>Comunicados</h2>${naoDir() ? '<button class="btn" id="novoC">+ Comunicado</button>' : ''}</div>
    <div class="barra"><span class="dica" style="flex:1">${naoLidos ? `<b>${naoLidos}</b> por ler` : 'Tudo lido'}</span>${naoDir() ? `<button class="btn sec peq" id="arq">${S.comArq ? 'Ver activos' : 'Ver arquivados'}</button>` : ''}</div>
    ${l.map(c => `<div class="card com${!c.lido && !c.meu ? ' novo' : ''}${c.prioridade === 'Urgente' ? ' urg' : ''}" data-id="${c.id}">
      <div class="barra"><h3>${c.prioridade === 'Urgente' ? '<span class="tag nao">Urgente</span> ' : ''}${esc(c.titulo)}</h3>${!c.lido && !c.meu ? '<span class="tag azul">Novo</span>' : ''}</div>
      <div class="dica">${esc(c.autor_nome)} · ${c.ambito === 'Missão' ? 'Missão' : esc(nomeRegiao(c.regiao_id))} · para ${esc(c.destinatarios.toLowerCase())} · ${quando(c.data)}${c.data_evento ? ' · 📅 ' + fmtData(c.data_evento) : ''}</div>
      <div class="txt">${esc(c.texto)}</div>
      <div class="barra" style="margin-top:8px"><button class="btn wa peq" data-wa="${c.id}">${IC_WA} Partilhar</button></div>
      ${c.meu ? `<div class="barra" style="margin-top:10px"><span class="dica" style="flex:1">${c.leituras} leitura(s)</span><button class="btn sec peq" data-leu="${c.id}">Quem leu</button><button class="btn sec peq" data-arq="${c.id}">${S.comArq ? 'Reactivar' : 'Arquivar'}</button></div>` : ''}</div>`).join('')
      || `<div class="card vazio">${S.comArq ? 'Sem comunicados arquivados.' : 'Ainda não há comunicados.'}</div>`}`;
  // Marcar como lido ao abrir o separador (os que estão visíveis).
  const porLer = l.filter(c => !c.lido && !c.meu);
  if (porLer.length) Promise.all(porLer.map(c => api('lerComunicado', { id: c.id }).catch(() => {}))).then(() => actualizarSino());
  if ($('#novoC')) $('#novoC').onclick = formComunicado;
  $$('[data-wa]', m).forEach(b => b.onclick = (e) => { e.stopPropagation(); const c = l.find(x => x.id === b.dataset.wa);
    whats(`📢 *${c.titulo}*\n${c.ambito === 'Missão' ? 'Missão Sul de Luanda e Cabinda' : nomeRegiao(c.regiao_id)}${c.data_evento ? '\n📅 ' + fmtData(c.data_evento) : ''}\n\n${c.texto}\n\n— ${c.autor_nome} · SGC Desbravadores MSC`); });
  if ($('#arq')) $('#arq').onclick = () => { S.comArq = !S.comArq; abrir('comunicados'); };
  $$('[data-arq]', m).forEach(b => b.onclick = (e) => { e.stopPropagation(); ocupado(b, async () => { await api('arquivarComunicado', { id: b.dataset.arq, reactivar: S.comArq }); abrir('comunicados'); }); });
  $$('[data-leu]', m).forEach(b => b.onclick = (e) => { e.stopPropagation(); ocupado(b, async () => {
    const r = await api('quemLeu', { id: b.dataset.leu }); const lid = r.filter(x => x.lido_em).length;
    modal(`<h3>Quem leu</h3><p class="dica">${lid} de ${r.length} leram</p><div class="lista">${r.map(x => `<div class="it"><div class="av">${esc(iniciais(x.nome))}</div>
      <div class="tx"><b>${esc(x.nome)}</b><small>${x.papel === 'DIRECTOR' ? esc(x.clube || 'Director') : x.papel === 'REGIONAL' ? 'Regional' : 'Missão'}</small></div>
      ${x.lido_em ? `<span class="tag ok">${quando(x.lido_em)}</span>` : '<span class="tag nao">Por ler</span>'}</div>`).join('')}</div>
      <div class="accoes"><button class="btn" data-fechar>Fechar</button></div>`);
  }); });
}
function formComunicado() {
  const msc = S.eu.papel === 'MSC';
  const md = modal(`<h3>Novo comunicado</h3><form class="form">
    <label class="full">Título<input name="titulo" maxlength="150" required></label>
    <label class="full">Texto<textarea name="texto" rows="6" maxlength="5000" required></textarea></label>
    ${msc ? `<label>Âmbito<select name="regiao_id">${opts(S.regioes.map(r => [r.id, r.nome]), '', 'Toda a Missão')}</select></label>` : ''}
    <label>Para<select name="destinatarios">${opts(msc ? ['Todos', 'Directores', 'Regionais'] : ['Todos', 'Directores'], 'Todos')}</select></label>
    <label>Prioridade<select name="prioridade">${opts(['Normal', 'Urgente'], 'Normal')}</select></label>
    <label>Data do evento (opcional)<input name="data_evento" type="date"></label></form>
    <p class="dica">${msc ? 'Toda a Missão ou uma região.' : 'Vai para os clubes da sua região.'} Os destinatários recebem uma notificação no sino e pode ver quem leu.</p>
    <div class="accoes"><button class="btn sec" data-fechar>Cancelar</button><button class="btn" id="gravar">Publicar</button></div>`);
  $('#gravar', md).onclick = (e) => ocupado(e.target, async () => { await api('publicarComunicado', { registo: lerForm($('form', md)) }); md.remove(); aviso('Comunicado publicado.'); abrir('comunicados'); });
}

/* ---------- pedidos: solicitações e transferências ---------- */
const TIPOS_SOL = ['Cerimónia de admissão', 'Investidura', 'Visita da região', 'Formação / capacitação', 'Apoio para evento', 'Outro'];
const corEst = (e) => ({ 'Aprovada': 'ok', 'Recusada': 'nao', 'Na Missão': 'azul', 'Pendente': '', 'Na região': '' }[e] ?? '');
async function vPedidos(m) {
  S.vistaPed = S.vistaPed || 'sol';
  const seg = segm([['sol', 'Solicitações'], ['tra', 'Transferências']], S.vistaPed);
  if (S.vistaPed === 'tra') return vTransferencias(m, seg);
  const l = await api('solicitacoes');
  const minha = l.filter(x => x.posso_decidir).length;
  m.innerHTML = `${seg}<div class="barra"><h2>Solicitações</h2>${S.clube_id ? '<button class="btn" id="novaS">+ Pedido</button>' : ''}</div>
    ${minha ? `<div class="card pend"><b>${minha}</b> pedido(s) à espera da sua decisão.</div>` : ''}
    <div class="card lista">${l.map(x => { const dias = Math.ceil((new Date(x.prazo_regiao) - Date.now()) / 864e5);
      return `<div class="it" data-id="${x.id}"><div class="av">${esc(iniciais(x.tipo))}</div><div class="tx"><b>${esc(x.tipo)}</b>
        <small>${esc(x.clube)} · ${quando(x.criado_em)}${x.data_pretendida ? ' · para ' + fmtData(x.data_pretendida) : ''}</small>
        ${x.estado === 'Na região' ? `<small style="color:${dias <= 3 ? 'var(--verm)' : 'var(--suave)'}">Região tem ${Math.max(0, dias)} dia(s) para responder</small>` : ''}
        ${x.regiao_decisao === 'Sem resposta' ? '<small style="color:var(--verm)">Passou pela região sem resposta</small>' : ''}</div>
        <span class="tag ${corEst(x.estado)}">${esc(x.estado)}</span>${x.posso_decidir ? '<span class="pt"></span>' : ''}</div>`; }).join('') || '<div class="vazio">Sem pedidos.</div>'}</div>
    <p class="dica">O clube envia à região, que tem ${14} dias para aprovar. Aprovado pela região, segue para a Missão. Se a região não responder no prazo, o pedido vai sozinho para a Missão com essa nota.</p>`;
  ligarSeg(m, 'vistaPed', 'pedidos');
  if ($('#novaS')) $('#novaS').onclick = formSolicitacao;
  $$('.lista .it', m).forEach(el => el.onclick = () => verSolicitacao(l.find(x => x.id === el.dataset.id)));
}
function formSolicitacao() {
  const md = modal(`<h3>Novo pedido · ${esc(nomeClube(S.clube_id))}</h3><form class="form">
    <label class="full">Tipo<select name="tipo">${opts(TIPOS_SOL, 'Cerimónia de admissão')}</select></label>
    <label>Data pretendida<input name="data_pretendida" type="date" min="${hoje()}"></label><label>Local<input name="local"></label>
    <label class="full">Descrição<textarea name="descricao" rows="4" required placeholder="Ex.: cerimónia de admissão de 12 novos desbravadores no culto de sábado"></textarea></label></form>
    <div class="accoes"><button class="btn sec" data-fechar>Cancelar</button><button class="btn" id="gravar">Enviar à região</button></div>`);
  $('#gravar', md).onclick = (e) => ocupado(e.target, async () => { const r = lerForm($('form', md)); r.clube_id = S.clube_id; await api('criarSolicitacao', { registo: r }); md.remove(); aviso('Pedido enviado à região.'); abrir('pedidos'); });
}
function verSolicitacao(x) {
  const fase = x.estado === 'Na região' ? 'região' : 'Missão';
  const md = modal(`<h3>${esc(x.tipo)}</h3><p class="dica">${esc(x.clube)} · <span class="tag ${corEst(x.estado)}">${esc(x.estado)}</span></p>
    <table>${[['Data pretendida', fmtData(x.data_pretendida)], ['Local', x.local], ['Pedido em', new Date(x.criado_em).toLocaleString('pt-PT')], ['Prazo da região', new Date(x.prazo_regiao).toLocaleDateString('pt-PT')],
      ['Decisão da região', [x.regiao_decisao, x.regiao_nota].filter(Boolean).join(' — ')], ['Decisão da Missão', [x.missao_decisao, x.missao_nota].filter(Boolean).join(' — ')]]
      .map(([k, v]) => `<tr><th>${k}</th><td>${esc(v || '—')}</td></tr>`).join('')}</table>
    <h4 class="sec">Descrição</h4><p>${esc(x.descricao)}</p>
    <h4 class="sec">Histórico</h4><div class="tl">${x.historico.map(h => `<div><b>${esc(h.accao)}</b><br><small class="dica">${new Date(h.data).toLocaleString('pt-PT')} · ${esc(h.por)}</small>${h.nota ? `<br>${esc(h.nota)}` : ''}</div>`).join('')}</div>
    ${x.posso_decidir ? `<h4 class="sec">Decisão (${fase})</h4><textarea id="nota" rows="2" placeholder="Nota (obrigatória para recusar)"></textarea>` : ''}
    <div class="accoes">${x.estado === 'Aprovada' && naoDir() ? '<button class="btn sec esq" id="esc">Criar escala</button>' : ''}<button class="btn sec" data-fechar>Fechar</button>${x.posso_decidir ? `<button class="btn del" id="rec">Recusar</button>
      ${x.estado === 'Na região' && S.eu.papel === 'MSC' ? '<button class="btn sec" id="apf">Aprovar já (final)</button>' : ''}<button class="btn" id="apr">${x.estado === 'Na região' ? 'Aprovar e enviar à Missão' : 'Aprovar'}</button>` : ''}</div>`);
  const dec = (aprovar, final) => (e) => ocupado(e.target, async () => { await api('decidirSolicitacao', { id: x.id, aprovar, final, nota: $('#nota', md).value }); md.remove(); aviso('Decisão registada.'); abrir('pedidos'); actualizarSino(); });
  if ($('#apr', md)) { $('#apr', md).onclick = dec(true); $('#rec', md).onclick = dec(false); }
  if ($('#apf', md)) $('#apf', md).onclick = dec(true, true);
  if ($('#esc', md)) $('#esc', md).onclick = () => { md.remove(); formEscala({ clube_id: x.clube_id, data: x.data_pretendida, solicitacao_id: x.id, local: x.local,
    funcao: /investidura/i.test(x.tipo) ? 'Oficiante da investidura' : /visita/i.test(x.tipo) ? 'Delegado da região' : /admiss/i.test(x.tipo) ? 'Delegado da região' : 'Delegado da Missão', notas: x.tipo + ': ' + x.descricao }); };
}

async function vTransferencias(m, seg) {
  const l = await api('transferencias');
  const minha = l.filter(x => x.posso_decidir).length;
  m.innerHTML = `${seg}<h2>Transferências</h2>
    ${minha ? `<div class="card pend"><b>${minha}</b> transferência(s) à espera da sua decisão.</div>` : ''}
    <p class="dica">Para pedir uma transferência, abra o membro em <b>Membros</b> e carregue em <b>Transferir</b>.</p>
    <div class="card lista">${l.map(t => `<div class="it" data-id="${t.id}"><div class="av">${esc(iniciais(t.membro_nome))}</div>
      <div class="tx"><b>${esc(t.membro_nome)}</b><small>${esc(t.origem_nome || '?')} → ${esc(t.destino_nome || t.missao_destino || '?')}</small><small>${esc(t.tipo)} · ${quando(t.pedido_em)}</small></div>
      <span class="tag ${corEst(t.estado)}">${esc(t.estado)}</span>${t.posso_decidir ? '<span class="pt"></span>' : ''}</div>`).join('') || '<div class="vazio">Sem transferências.</div>'}</div>`;
  ligarSeg(m, 'vistaPed', 'pedidos');
  $$('.lista .it', m).forEach(el => el.onclick = () => verTransferencia(l.find(x => x.id === el.dataset.id)));
}
const NOME_PASSO = { destino: 'Clube de destino', regiao_origem: 'Região de origem', regiao_destino: 'Região de destino', missao: 'Missão' };
function verTransferencia(t) {
  const md = modal(`<h3>Transferência · ${esc(t.membro_nome)}</h3><p class="dica">${esc(t.origem_nome)} → ${esc(t.destino_nome || t.missao_destino)} · <span class="tag ${corEst(t.estado)}">${esc(t.estado)}</span></p>
    <table><tr><th>Tipo</th><td>${esc(t.tipo)}</td></tr><tr><th>Motivo</th><td>${esc(t.motivo)}</td></tr><tr><th>Pedido por</th><td>${esc(t.pedido_por)} · ${new Date(t.pedido_em).toLocaleString('pt-PT')}</td></tr></table>
    <h4 class="sec">Aprovações</h4><div class="tl">${t.passos.map(p => `<div><b>${NOME_PASSO[p.tipo]}</b> — <span class="tag ${p.estado === 'Aprovado' ? 'ok' : p.estado === 'Recusado' ? 'nao' : ''}">${esc(p.estado)}</span>
      ${p.por ? `<br><small class="dica">${esc(p.por)} · ${new Date(p.em).toLocaleString('pt-PT')}</small>` : ''}${p.nota ? `<br>${esc(p.nota)}` : ''}</div>`).join('')}</div>
    ${t.posso_decidir ? '<textarea id="nota" rows="2" placeholder="Nota (obrigatória para recusar)"></textarea>' : ''}
    <div class="accoes"><button class="btn sec" data-fechar>Fechar</button>${t.posso_decidir ? '<button class="btn del" id="rec">Recusar</button><button class="btn" id="apr">Aprovar</button>' : ''}</div>`);
  const dec = (aprovar) => (e) => ocupado(e.target, async () => { const r = await api('decidirTransferencia', { id: t.id, aprovar, nota: $('#nota', md).value }); md.remove();
    aviso(r.estado === 'Aprovada' ? 'Transferência concluída.' : aprovar ? 'Aprovado. Segue para o passo seguinte.' : 'Transferência recusada.'); await carregarInicio(); abrir('pedidos'); });
  if ($('#apr', md)) { $('#apr', md).onclick = dec(true); $('#rec', md).onclick = dec(false); }
}
async function formTransferencia(x) {
  const cl = (await api('clubesDestino')).filter(c => c.id !== S.clube_id);
  const md = modal(`<h3>Transferir ${esc(x.nome)}</h3><form class="form">
    <label class="full">Para<select id="tp">${opts(['Outro clube da MSC', 'Outra missão'], 'Outro clube da MSC')}</select></label>
    <label class="full" id="lcl">Clube de destino<select id="cd">${opts(cl.map(c => [c.id, c.nome + ' · ' + nomeRegiao(c.regiao_id)]), '', 'Escolha…')}</select></label>
    <label class="full" id="lmi" hidden>Missão de destino<input id="mi" placeholder="Ex.: Missão Norte de Angola"></label>
    <label class="full">Motivo<textarea id="mo" rows="3" required placeholder="Ex.: mudança de residência da família"></textarea></label></form>
    <p class="dica" id="info"></p>
    <div class="accoes"><button class="btn sec" data-fechar>Cancelar</button><button class="btn" id="gravar">Pedir transferência</button></div>`);
  const actual = S.clubes.find(c => c.id === S.clube_id) || {};
  const info = () => { const out = $('#tp', md).value === 'Outra missão'; $('#lcl', md).hidden = out; $('#lmi', md).hidden = !out;
    const d = cl.find(c => c.id === $('#cd', md).value);
    $('#info', md).textContent = out ? 'Aprovam: a sua região e depois a Missão. No fim, o membro fica inactivo neste clube.'
      : !d ? '' : d.regiao_id === actual.regiao_id ? 'Mesma região: só o clube de destino tem de aceitar.' : 'Outra região: aprovam a região de origem, a região de destino e o clube de destino.'; };
  $('#tp', md).onchange = info; $('#cd', md).onchange = info; info();
  $('#gravar', md).onclick = (e) => ocupado(e.target, async () => {
    const out = $('#tp', md).value === 'Outra missão';
    const r = await api('pedirTransferencia', { membro_id: x.id, tipo: out ? 'Outra missão' : 'MSC', clube_destino: $('#cd', md).value, missao_destino: $('#mi', md).value, motivo: $('#mo', md).value });
    md.remove(); aviso(r.estado === 'Aprovada' ? 'Transferência concluída.' : 'Pedido de transferência enviado.'); S.vistaPed = 'tra'; abrir('pedidos');
  });
}

/* ======================= FASE 5 ======================= */
/* ---------- IndexedDB (o service worker lê daqui a sessão para mostrar as notificações push) ---------- */
function idb() { return new Promise((ok, falhou) => { const r = indexedDB.open('sgc', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => ok(r.result); r.onerror = () => falhou(r.error); }); }
async function idbSet(k, v) { try { const db = await idb(); const t = db.transaction('kv', 'readwrite'); v == null ? t.objectStore('kv').delete(k) : t.objectStore('kv').put(v, k); } catch (e) {} }

/* ---------- esqueci a palavra-passe ---------- */
function esqueciSenha() {
  const emailAtual = ($('.entrada input[name=email]') || {}).value || '';
  const md = modal(`<h3>Esqueci a palavra-passe</h3><p class="dica">Escreva o email com que entra no SGC.</p>
    <form class="form" id="f1"><label class="full">Email<input name="email" type="email" value="${esc(emailAtual)}" required></label></form>
    <div id="passo2" hidden><p class="dica" id="msg"></p><form class="form" id="f2">
      <label>Código de 6 dígitos<input name="codigo" inputmode="numeric" maxlength="6" autocomplete="one-time-code"></label>
      <label>Nova palavra-passe (mín. 8)<input name="nova" type="password" autocomplete="new-password"></label></form></div>
    <div class="accoes"><button class="btn sec" data-fechar>Cancelar</button><button class="btn" id="b1">Pedir código</button><button class="btn" id="b2" hidden>Mudar palavra-passe</button></div>`);
  $('#b1', md).onclick = (e) => ocupado(e.target, async () => {
    const email = $('#f1 input', md).value.trim(); const r = await api('pedirCodigo', { email });
    if (r.modo === 'responsavel') { $('#f1', md).hidden = true; $('#passo2', md).hidden = false; $('#f2', md).hidden = true; $('#msg', md).innerHTML = '✅ ' + esc(r.mensagem); $('#b1', md).hidden = true; return; }
    $('#f1 input', md).readOnly = true; $('#passo2', md).hidden = false; $('#msg', md).textContent = r.mensagem; $('#b1', md).textContent = 'Reenviar código'; $('#b2', md).hidden = false;
  });
  $('#b2', md).onclick = (e) => ocupado(e.target, async () => {
    const f = lerForm($('#f2', md)); const d = await api('reporSenha', { email: $('#f1 input', md).value.trim(), codigo: f.codigo, nova: f.nova });
    md.remove(); S.token = d.token; gravar('sgc_token', d.token); idbSet('token', d.token); await carregarInicio(); montar(); aviso('Palavra-passe alterada.');
  });
}

/* ---------- notificações push ---------- */
const pushSuportado = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
function b64aBytes(b) { const p = '='.repeat((4 - b.length % 4) % 4); const r = atob((b + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from([...r].map(c => c.charCodeAt(0))); }
async function activarPush() {
  if (!pushSuportado()) throw new Error('Este telemóvel/browser não suporta notificações. No iPhone, instale primeiro a aplicação no ecrã principal.');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('As notificações foram bloqueadas. Pode autorizá-las nas definições do browser (cadeado ao lado do endereço).');
  const reg = await navigator.serviceWorker.ready;
  const { chave } = await api('pushChave');
  let sub = await reg.pushManager.getSubscription();
  if (sub && sub.options && sub.options.applicationServerKey) {
    const atual = btoa(String.fromCharCode(...new Uint8Array(sub.options.applicationServerKey))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    if (atual !== chave) { await sub.unsubscribe(); sub = null; }
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64aBytes(chave) });
  await api('registarPush', { subscricao: sub.toJSON() });
  idbSet('token', S.token);
  aviso('Notificações activadas neste dispositivo.');
}
async function desenharPush(el) {
  if (!el) return;
  if (!pushSuportado()) { el.innerHTML = '<h3>Notificações no telemóvel</h3><p class="dica">Este browser não suporta notificações. No iPhone, instale primeiro o SGC no ecrã principal (iOS 16.4 ou mais recente).</p>'; return; }
  const reg = await navigator.serviceWorker.ready.catch(() => null); const sub = reg && await reg.pushManager.getSubscription();
  const on = Notification.permission === 'granted' && sub;
  el.innerHTML = `<h3>Notificações no telemóvel</h3><p class="dica">${on ? '✅ Activas neste dispositivo. Recebe os avisos do sino mesmo com a aplicação fechada.' : Notification.permission === 'denied' ? '⛔ Bloqueadas neste browser. Autorize-as nas definições do site (cadeado ao lado do endereço) e volte aqui.' : 'Receba comunicados, pedidos e transferências mesmo com a aplicação fechada.'}</p>
    <div class="accoes">${on ? '<button class="btn sec" id="pOff">Desactivar</button>' : Notification.permission !== 'denied' ? '<button class="btn" id="pOn">Activar notificações</button>' : ''}</div>`;
  const a = $('#pOn', el); if (a) a.onclick = (e) => ocupado(e.target, async () => { await activarPush(); desenharPush(el); });
  const d = $('#pOff', el); if (d) d.onclick = (e) => ocupado(e.target, async () => { await api('removerPush', { endpoint: sub.endpoint }); await sub.unsubscribe(); aviso('Notificações desactivadas.'); desenharPush(el); });
}

/* ---------- configuração de e-mail (Missão) ---------- */
async function cartaoEmail(m) {
  const c = await api('configEmail');
  const el = document.createElement('div'); el.className = 'card';
  el.innerHTML = `<h3>E-mail automático (recuperação de palavra-passe)</h3>
    <p class="dica">${c.configurado ? '✅ Configurado. Remetente: ' + esc(c.remetente) : 'Ainda não configurado: quem esquecer a palavra-passe envia um pedido à região/Missão, que a repõe em Utilizadores. Para enviar códigos por e-mail, crie uma conta grátis em brevo.com, verifique o email remetente e cole aqui a chave API (SMTP & API → API Keys).'}</p>
    <form class="form"><label>Email remetente (verificado na Brevo)<input name="remetente" type="email" value="${esc(c.remetente || 'coordenacaodbvmsc1@gmail.com')}"></label>
      <label>Chave API da Brevo${c.configurado ? ' (deixe vazio para manter)' : ''}<input name="chave" type="password" autocomplete="off"></label></form>
    <div class="accoes">${c.configurado ? '<button class="btn sec esq" id="eT">Enviar e-mail de teste</button><button class="btn del" id="eA">Desligar</button>' : ''}<button class="btn" id="eG">Guardar</button></div>`;
  m.appendChild(el);
  $('#eG', el).onclick = (e) => ocupado(e.target, async () => { await api('guardarConfigEmail', lerForm($('form', el))); aviso('Configuração guardada.'); abrir('admin'); });
  if ($('#eT', el)) $('#eT', el).onclick = (e) => ocupado(e.target, async () => { await api('testarEmail'); aviso('E-mail de teste enviado para ' + S.eu.email); });
  if ($('#eA', el)) $('#eA', el).onclick = (e) => ocupado(e.target, async () => { await api('guardarConfigEmail', { remetente: c.remetente, apagar: 1 }); abrir('admin'); });
}

/* ---------- QR ---------- */
let qrPronto = null;
function carregarQR() { if (window.qrcode) return Promise.resolve(); return qrPronto = qrPronto || carregarScript('/lib/qrcode.js'); }
function qrSVG(texto, px = 140) {
  const q = qrcode(0, 'M'); q.addData(texto); q.make();
  const n = q.getModuleCount(), cel = px / (n + 8); let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${(c + 4) * cel},${(r + 4) * cel}h${cel}v${cel}h${-cel}z`;
  return `<svg viewBox="0 0 ${px} ${px}" width="${px}" height="${px}" class="qr"><rect width="${px}" height="${px}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
// O QR é um endereço: lido com a câmara normal do telemóvel abre a ficha no SGC; lido em Presenças marca a presença.
const codigoQR = (id) => location.origin + '/?m=' + id;
function idDoQR(txt) {
  if (!txt) return null;
  if (txt.startsWith('SGC1:')) return txt.slice(5);
  try { const u = new URL(txt); if (u.origin === location.origin) return u.searchParams.get('m'); } catch (e) {}
  return null;
}

/* ---------- ficha individual ---------- */
async function verFicha(id, unidades) {
  const [d] = await Promise.all([api('fichaMembro', { id }), carregarQR().catch(() => {})]);
  const x = d.membro, i = idade(x.data_nasc);
  const pres = d.presencas.map(p => { const t = p.p + p.f + p.j; return `<tr><td>${p.ano}</td><td class="n">${p.p}</td><td class="n">${p.f}</td><td class="n">${p.j}</td><td class="n"><b>${t ? Math.round(p.p / t * 100) : 0}%</b></td></tr>`; }).join('');
  const md = modal(`<div class="ficha-c"><div class="av ${x.sexo || ''}" style="width:56px;height:56px;font-size:20px">${esc(iniciais(x.nome))}</div>
      <div style="flex:1;min-width:0"><h3 style="margin:0">${esc(x.nome)}</h3><div class="dica">${esc(x.tipo || '')}${i != null ? ' · ' + i + ' anos' : ''}${d.unidade ? ' · ' + esc(d.unidade) : ''}${x.cargo ? ' · ' + esc(x.cargo) : ''}</div>
      <div class="dica">${esc(d.clube.nome)} · ${esc(nomeRegiao(d.clube.regiao_id))}</div>${x.activo ? '' : '<span class="tag nao">Inactivo</span>'}</div>
      ${window.qrcode ? `<div class="qrbox">${qrSVG(codigoQR(x.id), 92)}</div>` : ''}</div>
    <div class="barra" style="margin-top:10px"><button class="btn peq" id="fEd">Editar dados</button><button class="btn sec peq" id="fCart">Cartão (PDF)</button></div>
    <div class="fkpis"><div><b>${d.classes.filter(c => c.estado === 'Investido').length}</b><small>Classes investidas</small></div><div><b>${d.especialidades.length}</b><small>Especialidades</small></div>
      <div><b>${d.pontos_ano.total}</b><small>Pontos manuais ${d.ano}</small></div><div><b>${d.eventos.length}</b><small>Eventos</small></div></div>
    <h4 class="sec">Percurso nas classes</h4>${d.classes.length ? `<div class="tl">${d.classes.map(c => `<div><b>${c.ano} · ${esc(c.classe)}</b> ${tagEstado(c.estado)}
      <div class="bar" style="margin:4px 0;max-width:260px"><i style="width:${c.total ? Math.round(c.feitos / c.total * 100) : 0}%"></i></div><small class="dica">${c.feitos}/${c.total} requisitos${c.data_investidura ? ' · investido em ' + fmtData(c.data_investidura) : ''}</small></div>`).join('')}</div>` : '<p class="dica">Sem inscrições nas classes.</p>'}
    <h4 class="sec">Especialidades</h4>${d.especialidades.length ? `<div class="chipsS">${d.especialidades.map(e => `<span class="tag" title="${esc(e.categoria || '')}">${esc(e.especialidade)}${e.data_conclusao ? ' · ' + e.data_conclusao.slice(0, 4) : ''}</span>`).join('')}</div>` : '<p class="dica">Nenhuma.</p>'}
    <h4 class="sec">Presenças</h4>${pres ? `<table><tr><th>Ano</th><th class="n">P</th><th class="n">F</th><th class="n">J</th><th class="n">Assid.</th></tr>${pres}</table>` : '<p class="dica">Sem registos.</p>'}
    ${d.pagamentos.length ? `<h4 class="sec">Pagamentos</h4><table>${d.pagamentos.map(p => `<tr><td>${esc(p.tipo)} ${p.ano}</td><td>${fmtData(p.data)}</td><td class="n">${kz(p.valor)}</td></tr>`).join('')}</table>` : ''}
    ${d.eventos.length ? `<h4 class="sec">Eventos</h4><p>${d.eventos.map(e => esc(e.nome) + ' (' + e.data_inicio.slice(0, 4) + ')').join(' · ')}</p>` : ''}
    ${d.transferencias.length ? `<h4 class="sec">Transferências</h4><p>${d.transferencias.map(t => `${esc(t.origem || '')} → ${esc(t.destino || '')} · ${esc(t.estado)} (${fmtData(t.pedido_em.slice(0, 10))})`).join('<br>')}</p>` : ''}
    <h4 class="sec">Contactos</h4><table><tr><th>Contacto</th><td>${esc(x.contacto || '—')}</td></tr><tr><th>Encarregado</th><td>${esc(x.encarregado_nome || '—')} ${x.encarregado_contacto ? '· ' + esc(x.encarregado_contacto) : ''}</td></tr>
      <tr><th>Nascimento</th><td>${fmtData(x.data_nasc) || '—'}</td></tr><tr><th>Baptizado</th><td>${esc(x.baptizado || '—')}</td></tr><tr><th>Entrada no clube</th><td>${fmtData(x.data_entrada) || '—'}</td></tr></table>
    <div class="accoes"><button class="btn" data-fechar>Fechar</button></div>`);
  $('#fEd', md).onclick = async () => { md.remove(); if (!unidades) unidades = (await api('membros', { clube_id: x.clube_id })).unidades; formMembro(x, unidades); };
  $('#fCart', md).onclick = (e) => ocupado(e.target, () => pdfCartoes([x.id]));
}

/* ---------- cartões de membro (PDF, 10 por folha A4) ---------- */
async function pdfCartoes(ids) {
  aviso('A preparar os cartões…');
  const d = await api('cartoesMembros', { clube_id: S.clube_id, ids: ids || [] });
  if (!d.membros.length) throw new Error('Sem membros activos.');
  await carregarPDF(); const logo = await logoDataURL();
  const W = 242.6, H = 153, M = 36, GX = 26, GY = 10; const conteudo = [];
  d.membros.forEach((x, i) => {
    const k = i % 10, col = k % 2, lin = Math.floor(k / 2), X = M + col * (W + GX), Y = 34 + lin * (H + GY);
    const abs = (o, dx, dy) => Object.assign(o, { absolutePosition: { x: X + dx, y: Y + dy } });
    if (k === 0 && i > 0) conteudo.push({ text: '', pageBreak: 'before' });
    conteudo.push(abs({ canvas: [{ type: 'rect', x: 0, y: 0, w: W, h: H, r: 8, lineColor: '#1f3a5f', lineWidth: 1 }, { type: 'rect', x: 0, y: 0, w: W, h: 34, r: 8, color: '#1f3a5f' }, { type: 'rect', x: 0, y: 20, w: W, h: 14, color: '#1f3a5f' }] }, 0, 0));
    conteudo.push(abs({ image: logo, width: 26 }, 6, 4));
    conteudo.push(abs({ text: [{ text: 'CLUBES DE DESBRAVADORES\n', bold: true, fontSize: 7.5 }, { text: 'Missão Sul de Luanda e Cabinda', fontSize: 6.5 }], color: '#ffffff', width: 190 }, 38, 8));
    conteudo.push(abs({ text: x.nome, bold: true, fontSize: 10.5, color: '#1f3a5f', width: 150 }, 10, 44));
    conteudo.push(abs({ text: [{ text: (x.tipo || '') + (x.cargo ? ' · ' + x.cargo : '') + '\n', fontSize: 7.5 }, { text: 'Clube: ', fontSize: 7, color: '#666' }, { text: d.clube + '\n', fontSize: 7.5 },
      ...(x.unidade ? [{ text: 'Unidade: ', fontSize: 7, color: '#666' }, { text: x.unidade + '\n', fontSize: 7.5 }] : []),
      ...(x.classe ? [{ text: `Classe ${d.ano}: `, fontSize: 7, color: '#666' }, { text: x.classe + '\n', fontSize: 7.5, bold: true }] : []),
      ...(x.data_nasc ? [{ text: 'Nascimento: ', fontSize: 7, color: '#666' }, { text: fmtData(x.data_nasc), fontSize: 7.5 }] : [])], width: 145, lineHeight: 1.15 }, 10, 72 - (x.nome.length > 28 ? 0 : 8)));
    conteudo.push(abs({ qr: codigoQR(x.id), fit: 78, eccLevel: 'M' }, W - 86, 44));
    conteudo.push(abs({ text: `Válido para ${d.ano}`, fontSize: 6.5, color: '#888', alignment: 'center', width: 80 }, W - 87, 126));
  });
  const doc = { pageSize: 'A4', pageMargins: [M, 34, M, 30], content: conteudo, defaultStyle: { fontSize: 8 },
    footer: (p, t) => ({ text: `Cartões de membro · ${d.clube} · recortar pelas linhas · página ${p} de ${t}`, fontSize: 7, color: '#888', alignment: 'center', margin: [0, 10, 0, 0] }) };
  const blob = await new Promise((ok, falhou) => { try { pdfMake.createPdf(doc).getBlob(ok); } catch (e) { falhou(e); } });
  entregarPDF(blob, ('Cartoes_' + d.clube).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w]+/g, '_') + '.pdf', 'Cartões de membro');
}

/* ---------- chamada por QR ---------- */
let jsqrPronto = null;
async function lerCartoes(lista, aoMarcar) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { aviso('Este dispositivo não permite usar a câmara aqui.', true); return; }
  const nomes = Object.fromEntries(lista.map(x => [x.id, x.nome])); const lidos = new Set();
  const md = modal(`<h3>Ler cartões</h3><p class="dica">Aponte a câmara para o QR do cartão de cada desbravador. Cada leitura marca <b>P</b>.</p>
    <div class="cam"><video playsinline muted></video><div class="mira"></div></div><div id="lidos" class="dica" style="margin-top:8px">Nenhum cartão lido.</div>
    <div class="accoes"><button class="btn" data-fechar>Concluir</button></div>`);
  const video = $('video', md); let stream, parar = false;
  const fim = () => { parar = true; if (stream) stream.getTracks().forEach(t => t.stop()); };
  $$('[data-fechar]', md).forEach(b => b.addEventListener('click', fim)); md.addEventListener('click', e => { if (e.target === md) fim(); });
  try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false }); }
  catch (e) { md.remove(); aviso('Sem acesso à câmara. Autorize a câmara para este site e tente de novo.', true); return; }
  video.srcObject = stream; await video.play().catch(() => {});
  let detetor = null;
  if ('BarcodeDetector' in window) { try { const f = await BarcodeDetector.getSupportedFormats(); if (f.includes('qr_code')) detetor = new BarcodeDetector({ formats: ['qr_code'] }); } catch (e) {} }
  if (!detetor) { jsqrPronto = jsqrPronto || carregarScript('/lib/jsQR.js'); await jsqrPronto; }
  const cv = document.createElement('canvas'), cx = cv.getContext('2d', { willReadFrequently: true });
  let ultimo = '', ultimoT = 0;
  const tratar = (txt) => {
    const id = idDoQR(txt); if (!id) return; const agoraT = Date.now();
    if (id === ultimo && agoraT - ultimoT < 2500) return; ultimo = id; ultimoT = agoraT;
    if (!nomes[id]) { aviso('Este cartão não é deste clube.', true); return; }
    aoMarcar(id); lidos.add(id); if (navigator.vibrate) navigator.vibrate(80);
    aviso('✓ ' + nomes[id]); $('#lidos', md).innerHTML = `<b>${lidos.size}</b> lido(s): ` + [...lidos].map(i => esc(nomes[i].split(' ')[0])).join(', ');
  };
  const ciclo = async () => {
    if (parar || !document.body.contains(md)) return fim();
    try {
      if (video.readyState >= 2) {
        if (detetor) { const r = await detetor.detect(video); r.forEach(c => tratar(c.rawValue)); }
        else { const w = video.videoWidth, h = video.videoHeight, k = Math.min(1, 640 / w); cv.width = w * k; cv.height = h * k; cx.drawImage(video, 0, 0, cv.width, cv.height);
          const img = cx.getImageData(0, 0, cv.width, cv.height); const r = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' }); if (r) tratar(r.data); }
      }
    } catch (e) {}
    setTimeout(ciclo, 180);
  };
  ciclo();
}

/* ---------- passagem de ano ---------- */
async function formPassagem(anoEsc) {
  const h = new Date(); const ano = anoEsc || (h.getMonth() >= 9 ? h.getFullYear() + 1 : h.getFullYear());
  const d = await api('passagemAno', { clube_id: S.clube_id, ano });
  const md = modal(`<div class="barra"><h3 style="flex:1">Passagem de ano</h3><select id="anoP" style="width:auto;flex:0 0 auto">${opts([new Date().getFullYear(), new Date().getFullYear() + 1], ano)}</select></div>
    <p class="dica">Proposta automática para cada desbravador: quem foi investido passa à classe seguinte; quem não concluiu repete; sem histórico, vai pela idade. Ajuste se for preciso e confirme.</p>
    <div class="tw"><table class="pass"><tr><th>Desbravador</th><th>${ano - 1}</th><th>${ano}</th></tr>
      ${d.lista.map(x => `<tr data-m="${x.id}"><td>${esc(x.nome)}<br><small class="dica">${esc(x.motivo)}</small></td><td><small>${x.classe_ant ? esc(x.classe_ant) + '<br>' + esc(x.estado_ant || '') : '—'}</small></td>
        <td>${x.ja ? '<span class="tag ok">Já inscrito</span>' : `<select>${opts([['', 'Não inscrever'], ...CLASSES], x.proposta || '')}</select>`}</td></tr>`).join('')}</table></div>
    <div class="accoes"><button class="btn sec" data-fechar>Cancelar</button><button class="btn" id="gravar">Inscrever em ${ano}</button></div>`);
  $('#anoP', md).onchange = (e) => { md.remove(); formPassagem(+e.target.value); };
  $('#gravar', md).onclick = (e) => ocupado(e.target, async () => {
    const itens = $$('tr[data-m]', md).map(tr => ({ membro_id: tr.dataset.m, classe: ($('select', tr) || {}).value })).filter(x => x.classe);
    if (!itens.length) throw new Error('Nada para inscrever.');
    const r = await api('inscreverClassesLista', { clube_id: S.clube_id, ano, itens }); md.remove(); S.ano = ano; aviso(r.inscritos + ' inscrito(s) em ' + ano + '.'); abrir('classes');
  });
}

/* ---------- classificação de clubes e regiões ---------- */
const NOMES_IND = { inspecao: 'Inspecção', assiduidade: 'Assiduidade', relatorios: 'Relatórios enviados', investidura: 'Classes concluídas', especialidades: 'Especialidades', actividades: 'Actividades', seguro: 'Seguro' };
async function vClassificacao(m, seg) {
  S.anoCl = S.anoCl || new Date().getFullYear();
  const d = await api('classificacao', { ano: S.anoCl });
  const meu = S.eu.papel === 'DIRECTOR' ? d.clubes.find(c => c.id === S.eu.clube_id) : null;
  const vis = S.eu.papel === 'REGIONAL' && S.verTodos !== true ? d.clubes.filter(c => c.regiao_id === S.eu.regiao_id) : d.clubes;
  const cores = ['#d4a017', '#a0aec0', '#c0784a'];
  const barra = (v) => `<div class="mini"><div class="bar"><i style="width:${v}%;background:${v >= 75 ? '#1baf7a' : v >= 50 ? '#d4a017' : '#e34948'}"></i></div><span>${v}</span></div>`;
  m.innerHTML = `${seg}<div class="barra"><h2>Classificação ${d.ano}</h2><select id="anoCl" style="flex:0 0 auto;width:auto;min-width:0">${opts([new Date().getFullYear(), new Date().getFullYear() - 1], S.anoCl)}</select></div>
    ${meu ? `<div class="card destaque"><b>${esc(meu.nome)}</b> está em <b>${meu.posicao}º lugar</b> de ${d.clubes.length} clubes, com <b>${meu.pontos} pontos</b>.</div>` : ''}
    <div class="podio">${d.clubes.slice(0, 3).map((x, i) => `<div><span class="md" style="background:${cores[i]}">${i + 1}º</span><b>${esc(x.nome)}</b><small>${x.pontos} pts · ${esc(nomeRegiao(x.regiao_id))}</small></div>`).join('')}</div>
    <div class="card"><h3>Regiões</h3>${gBarrasH(d.regioes.map(r => ({ l: nomeRegiao(r.regiao_id), v: r.pontos })), COR.s1, ' pts')}
      <div class="tw"><table class="tclubes"><tr><th>Região</th><th class="n">Clubes</th>${Object.keys(d.pesos).map(k => `<th class="n">${NOMES_IND[k].split(' ')[0]}</th>`).join('')}</tr>
      ${d.regioes.map(r => `<tr><td>${esc(nomeRegiao(r.regiao_id))}</td><td class="n">${r.clubes}</td>${Object.keys(d.pesos).map(k => `<td class="n">${r.indicadores[k] ?? '—'}</td>`).join('')}</tr>`).join('')}</table></div></div>
    <div class="card"><div class="barra"><h3>Clubes</h3>${S.eu.papel === 'REGIONAL' ? `<button class="btn sec peq" id="vt">${S.verTodos ? 'Só a minha região' : 'Ver todos'}</button>` : ''}</div>
      <div class="tw"><table class="tclubes"><tr><th>#</th><th>Clube</th><th>Pontos</th></tr>
      ${vis.map(x => `<tr class="clic${meu && meu.id === x.id ? ' eu' : ''}" data-c="${x.id}"><td>${x.posicao}º</td><td><b>${esc(x.nome)}</b><br><small class="dica">${esc(nomeRegiao(x.regiao_id))} · ${x.membros} membros</small></td><td style="min-width:130px">${barra(x.pontos)}</td></tr>`).join('')}</table></div>
      <p class="dica">Pontuação de 0 a 100: ${Object.entries(d.pesos).map(([k, w]) => `${NOMES_IND[k]} ${w}%`).join(' · ')}. Relatórios: meses fechados (${d.meses_relatorio}). Metas: 4 actividades por mês e 1 especialidade por desbravador no ano. Sem inspecção no ano, o peso dela é repartido pelos outros indicadores. Toque num clube para ver o detalhe.</p></div>`;
  ligarSeg(m, 'vistaMer', 'merito');
  $('#anoCl').onchange = (e) => { S.anoCl = +e.target.value; abrir('merito'); };
  if ($('#vt')) $('#vt').onclick = () => { S.verTodos = !S.verTodos; abrir('merito'); };
  $$('tr[data-c]', m).forEach(tr => tr.onclick = () => { const x = d.clubes.find(c => c.id === tr.dataset.c);
    modal(`<h3>${x.posicao}º · ${esc(x.nome)}</h3><p class="dica">${esc(nomeRegiao(x.regiao_id))} · ${x.pontos} pontos</p>
      ${Object.keys(d.pesos).map(k => `<div class="hb-l"><span>${NOMES_IND[k]} <small class="dica">(${d.pesos[k]}%)</small></span><div class="hb-t"><i style="width:${x.indicadores[k] || 0}%;background:${COR.s1}"></i></div><b>${x.indicadores[k] ?? '—'}</b></div>`).join('')}
      <div class="accoes"><button class="btn" data-fechar>Fechar</button></div>`); });
}

/* ---------- deslizar o dedo para mudar de ecrã (telemóvel) ---------- */
let swipeLigado = false;
function ligarSwipe() {
  if (swipeLigado) return; swipeLigado = true;
  let x0 = 0, y0 = 0, t0 = 0, valido = false;
  document.addEventListener('touchstart', (e) => {
    valido = false; if (e.touches.length !== 1 || !$('#main')) return;
    const alvo = e.target;
    // Não muda de ecrã se o gesto começar numa zona que já desliza na horizontal, num campo, num gráfico ou com janelas abertas.
    if ($('.modal, .notifP, .menuU') || alvo.closest('nav, header, input, textarea, select, .tw, .chips, .seg, .chkl, .gr, .cam, .hero-k, .filtros')) return;
    const t = e.touches[0]; x0 = t.clientX; y0 = t.clientY; t0 = Date.now(); valido = x0 > 18 && x0 < innerWidth - 18; // as margens ficam para o "voltar" do telemóvel
  }, { passive: true });
  document.addEventListener('touchend', (e) => {
    if (!valido) return; valido = false;
    const t = e.changedTouches[0], dx = t.clientX - x0, dy = t.clientY - y0;
    if (Date.now() - t0 > 700 || Math.abs(dx) < 70 || Math.abs(dy) > Math.abs(dx) * 0.6) return;
    const abas = abasVisiveis().map(a => a[0]), i = abas.indexOf(S.aba), j = i + (dx < 0 ? 1 : -1);
    if (j >= 0 && j < abas.length) abrir(abas[j], dx < 0 ? 1 : -1);
  }, { passive: true });
}

/* ======================= FASE 6 ======================= */
const IC_WA = '<svg viewBox="0 0 24 24" class="wai"><path fill="currentColor" d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 18.2c-1.5 0-3-.4-4.3-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.2-.4.2-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2c0 1.3.9 2.5 1.1 2.7.1.2 1.8 2.8 4.4 3.9 1.6.7 2.3.8 3.1.6.5-.1 1.5-.6 1.7-1.2.2-.6.2-1.1.2-1.2-.1-.1-.3-.2-.5-.3z"/></svg>';
function whats(texto) { const u = 'https://wa.me/?text=' + encodeURIComponent(texto); const w = window.open(u, '_blank'); if (!w) location.href = u; }

/* ---------- modo escuro ---------- */
function aplicarTema() {
  const pref = ler('sgc_tema') || 'auto';
  const escuro = pref === 'escuro' || (pref === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.tema = escuro ? 'escuro' : 'claro';
  const mt = document.querySelector('meta[name=theme-color]'); if (mt) mt.content = escuro ? '#0f1a2a' : '#1f3a5f';
}
aplicarTema();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', aplicarTema);
function cartaoTema(el) {
  const pref = ler('sgc_tema') || 'auto';
  el.innerHTML = `<h3>Aparência</h3><div class="seg">${[['auto', 'Automático'], ['claro', 'Claro'], ['escuro', 'Escuro']].map(([k, t]) => `<button data-t="${k}" class="${pref === k ? 'on' : ''}">${t}</button>`).join('')}</div>
    <p class="dica">O modo escuro poupa bateria e cansa menos a vista à noite. "Automático" segue a definição do telemóvel.</p>`;
  $$('[data-t]', el).forEach(b => b.onclick = () => { gravar('sgc_tema', b.dataset.t); aplicarTema(); cartaoTema(el); });
}

/* ---------- aniversários (painel do clube) ---------- */
async function cartaoAniversarios(m, clubeId) {
  try {
    const d = await api('aniversarios', { clube_id: clubeId }); if (!d.lista.length) return;
    const c = document.createElement('div'); c.className = 'card c3 aniv';
    c.innerHTML = `<h3>🎂 Aniversários nos próximos 30 dias</h3><div class="lista">${d.lista.map(x => { const hj = x.data === d.hoje;
      return `<div class="it${hj ? ' hoje' : ''}"><div class="av">${x.data.slice(8, 10)}/${x.data.slice(5, 7)}</div><div class="tx"><b>${esc(x.nome)}</b><small>${hj ? '🎉 Hoje! ' : ''}Faz ${x.idade} anos · ${esc(x.tipo || '')}</small></div>
        ${hj ? `<button class="btn wa peq" data-n="${esc(x.nome)}" data-i="${x.idade}">${IC_WA} Parabéns</button>` : ''}</div>`; }).join('')}</div>`;
    const dash = $('.dash', m); if (dash) dash.prepend(c); else m.appendChild(c);
    $$('[data-n]', c).forEach(b => b.onclick = () => whats(`🎉 Parabéns, ${b.dataset.n.split(' ')[0]}! Hoje fazes ${b.dataset.i} anos. Que Deus te abençoe muito! Com carinho, o teu Clube de Desbravadores ${nomeClube(clubeId)} 💙💛`));
  } catch (e) {}
}

/* ---------- agenda ---------- */
const COR_ORIGEM = { agenda: '#2a78d6', evento: '#d4a017', escala: '#7c3aed', pedido: '#1baf7a', comunicado: '#eb6834', prazo: '#e34948', aniversario: '#db2777' };
const NOME_ORIGEM = { agenda: 'Agenda', evento: 'Evento', escala: 'Escala', pedido: 'Pedido aprovado', comunicado: 'Comunicado', prazo: 'Prazo', aniversario: 'Aniversário' };
async function vAgenda(m) {
  S.mesAg = S.mesAg || hoje().slice(0, 7);
  const itens = await api('agenda', { mes: S.mesAg });
  const [ano, mes] = S.mesAg.split('-').map(Number);
  const primeiro = new Date(ano, mes - 1, 1), dias = new Date(ano, mes, 0).getDate(), desloc = (primeiro.getDay() + 6) % 7;
  const doDia = (d) => itens.filter(x => x.de <= d && x.ate >= d);
  const hj = hoje();
  let grelha = '';
  for (let i = 0; i < desloc; i++) grelha += '<div class="dia vazio"></div>';
  for (let n = 1; n <= dias; n++) {
    const d = `${S.mesAg}-${String(n).padStart(2, '0')}`, l = doDia(d);
    grelha += `<button class="dia${d === hj ? ' hj' : ''}${d === S.diaAg ? ' sel' : ''}" data-d="${d}"><span>${n}</span><i>${[...new Set(l.map(x => x.origem))].slice(0, 4).map(o => `<b style="background:${COR_ORIGEM[o]}"></b>`).join('')}</i></button>`;
  }
  const lista = S.diaAg && S.diaAg.startsWith(S.mesAg) ? doDia(S.diaAg) : itens.filter(x => x.ate >= `${S.mesAg}-01` && x.de <= `${S.mesAg}-31`);
  m.innerHTML = `<div class="barra"><h2>Agenda</h2>${naoDir() ? '<button class="btn" id="novaAg">+ Data</button>' : ''}</div>
    <div class="card"><div class="cal-c"><button class="btn sec peq" id="ant">‹</button><b>${MESES[mes - 1]} ${ano}</b><button class="btn sec peq" id="seg">›</button></div>
      <div class="cal">${['S', 'T', 'Q', 'Q', 'S', 'S', 'D'].map(x => `<div class="sem">${x}</div>`).join('')}${grelha}</div>
      <div class="leg-ag">${Object.entries(NOME_ORIGEM).filter(([k]) => k !== 'aniversario' || S.eu.papel === 'DIRECTOR').map(([k, t]) => `<span><b style="background:${COR_ORIGEM[k]}"></b>${t}</span>`).join('')}</div></div>
    <div class="card"><div class="barra"><h3>${S.diaAg && S.diaAg.startsWith(S.mesAg) ? fmtData(S.diaAg) : 'Este mês'}</h3>${S.diaAg ? '<button class="btn sec peq" id="todoMes">Ver o mês todo</button>' : ''}</div>
      <div class="lista">${lista.map(x => `<div class="it" data-k="${esc(x.origem + '|' + x.id)}"><div class="av" style="background:${COR_ORIGEM[x.origem]};color:#fff">${x.de.slice(8, 10)}</div>
        <div class="tx"><b>${esc(x.titulo)}</b><small>${NOME_ORIGEM[x.origem]}${x.tipo && x.tipo !== NOME_ORIGEM[x.origem] ? ' · ' + esc(x.tipo) : ''} · ${fmtData(x.de)}${x.ate !== x.de ? ' a ' + fmtData(x.ate) : ''}${x.hora ? ' · ' + x.hora : ''}${x.local ? ' · ' + esc(x.local) : ''}</small></div>
        <button class="btn wa peq" data-wa="${esc(x.origem + '|' + x.id)}" aria-label="Partilhar">${IC_WA}</button></div>`).join('') || '<div class="vazio">Nada marcado.</div>'}</div></div>
    <p class="dica">Recebe lembretes no sino (e no telemóvel, se activou as notificações) 7 dias e 1 dia antes de eventos, datas da agenda e escalas. Os clubes recebem também lembretes do relatório mensal nos dias 5 e 10.</p>`;
  const muda = (k) => { const d = new Date(ano, mes - 1 + k, 1); S.mesAg = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; S.diaAg = null; abrir('agenda'); };
  $('#ant').onclick = () => muda(-1); $('#seg').onclick = () => muda(1);
  if ($('#todoMes')) $('#todoMes').onclick = () => { S.diaAg = null; abrir('agenda'); };
  $$('.dia[data-d]', m).forEach(b => b.onclick = () => { S.diaAg = S.diaAg === b.dataset.d ? null : b.dataset.d; abrir('agenda'); });
  if ($('#novaAg')) $('#novaAg').onclick = () => formAgenda(null);
  const achar = (k) => { const [o, id] = k.split('|'); return itens.find(x => x.origem === o && x.id === id); };
  $$('[data-wa]', m).forEach(b => b.onclick = (e) => { e.stopPropagation(); const x = achar(b.dataset.wa);
    whats(`📅 *${x.titulo}*\n${fmtData(x.de)}${x.ate !== x.de ? ' a ' + fmtData(x.ate) : ''}${x.hora ? ' às ' + x.hora : ''}${x.local ? '\n📍 ' + x.local : ''}${x.descricao ? '\n\n' + x.descricao : ''}\n\n— Agenda SGC Desbravadores MSC`); });
  $$('.lista .it[data-k]', m).forEach(el => el.onclick = () => { const x = achar(el.dataset.k);
    if (x.origem === 'agenda' && x.meu) formAgenda(x); else if (x.origem === 'evento') abrir('eventos'); else if (x.origem === 'escala' && naoDir()) abrir('escala');
    else if (x.origem === 'pedido') abrir('pedidos'); else if (x.origem === 'comunicado') abrir('comunicados'); else if (x.origem === 'prazo') abrir('relatorio');
    else if (x.descricao) modal(`<h3>${esc(x.titulo)}</h3><p class="dica">${fmtData(x.de)}${x.local ? ' · ' + esc(x.local) : ''}</p><p>${esc(x.descricao)}</p><div class="accoes"><button class="btn" data-fechar>Fechar</button></div>`); });
}
function formAgenda(x) {
  const novo = !x; x = x || { de: S.diaAg || hoje(), tipo: 'Reunião' };
  const md = modal(`<h3>${novo ? 'Nova data na agenda' : 'Editar data'}</h3><form class="form">
    <label class="full">Título<input name="titulo" value="${esc(x.titulo)}" required></label>
    <label>Tipo<select name="tipo">${opts(['Reunião', 'Formação', 'Campori / Acampamento', 'Investidura', 'Prazo', 'Feriado / Data especial', 'Outro'], x.tipo)}</select></label>
    ${S.eu.papel === 'MSC' ? `<label>Para<select name="regiao_id">${opts(S.regioes.map(r => [r.id, r.nome]), x.regiao_id, 'Toda a Missão')}</select></label>` : ''}
    <label>Início<input name="data_inicio" type="date" value="${esc(x.de)}"></label><label>Fim<input name="data_fim" type="date" value="${esc(x.ate || x.de)}"></label>
    <label class="full">Local<input name="local" value="${esc(x.local)}"></label>
    <label class="full">Descrição<textarea name="descricao" rows="3">${esc(x.descricao)}</textarea></label></form>
    <p class="dica">${novo ? 'Todos os destinatários recebem uma notificação, e um lembrete 7 dias e 1 dia antes.' : ''}</p>
    <div class="accoes">${novo ? '' : '<button class="btn del esq" id="apagar">Apagar</button>'}<button class="btn sec" data-fechar>Cancelar</button><button class="btn" id="gravar">Guardar</button></div>`);
  $('#gravar', md).onclick = (e) => ocupado(e.target, async () => { const r = lerForm($('form', md)); r.id = novo ? null : x.id; await api('guardarAgenda', { registo: r }); md.remove(); aviso('Guardado na agenda.'); S.mesAg = r.data_inicio.slice(0, 7); abrir('agenda'); });
  const ap = $('#apagar', md); if (ap) ap.onclick = (e) => { if (confirm('Apagar esta data?')) ocupado(e.target, async () => { await api('apagarAgenda', { id: x.id }); md.remove(); abrir('agenda'); }); };
}

/* ---------- escala de delegados ---------- */
const FUNCOES_ESC = ['Delegado da Missão', 'Delegado da região', 'Pregador', 'Oficiante da investidura', 'Avaliador / inspector', 'Instrutor', 'Apoio', 'Outro'];
const corEsc = (e) => ({ Agendada: '', Confirmada: 'azul', Realizada: 'ok', Cancelada: 'nao' }[e] || '');
async function vEscala(m) {
  S.vistaEsc = S.vistaEsc || 'esc';
  const segE = segm([['esc', 'Escalas'], ['del', 'Delegados'], ['insp', 'Inspecções'], ['mapa', 'Mapa']], S.vistaEsc);
  if (S.vistaEsc === 'del') return vDelegados(m, segE);
  if (S.vistaEsc === 'insp') return vInspecoes(m, segE);
  if (S.vistaEsc === 'mapa') return vMapa(m, segE);
  S.escPer = S.escPer || 'prox';
  const de = S.escPer === 'prox' ? hoje() : `${new Date().getFullYear() - 1}-01-01`;
  const l = await api('escalas', { de });
  const vis = S.escReg ? l.filter(x => x.regiao_id === S.escReg || x.clube_regiao === S.escReg) : l;
  const porMes = {}; vis.forEach(x => (porMes[x.data.slice(0, 7)] = porMes[x.data.slice(0, 7)] || []).push(x));
  m.innerHTML = `${segE}<div class="barra"><h2>Escala</h2><button class="btn sec" id="autoE">⚡ Escala automática</button><button class="btn" id="novaE">+ Escala</button></div>
    <div class="barra"><select id="escPer">${opts([['prox', 'Próximas'], ['todas', 'Todas (desde o ano passado)']], S.escPer)}</select>
      ${S.eu.papel === 'MSC' ? `<select id="escReg">${opts(S.regioes.map(r => [r.id, r.nome]), S.escReg, 'Todas as regiões')}</select>` : ''}</div>
    <div class="barra"><button class="btn sec peq" id="pdfE">PDF da escala</button><button class="btn wa peq" id="waE">${IC_WA} Partilhar escala</button></div>
    ${Object.entries(porMes).map(([k, xs]) => `<h4 class="sec">${MESES[+k.slice(5) - 1]} ${k.slice(0, 4)}</h4><div class="card lista">${xs.map(x => `<div class="it" data-id="${x.id}">
      <div class="av esc"><b>${x.data.slice(8, 10)}</b><small>${MESES[+x.data.slice(5, 7) - 1].slice(0, 3)}</small></div>
      <div class="tx"><b>${esc(x.delegado_nome)}</b><small>${esc(x.funcao)}${x.hora ? ' · ' + x.hora : ''}</small><small>📍 ${esc(x.clube || x.local || '')}${x.evento ? ' · ' + esc(x.evento) : ''}</small></div>
      <span class="tag ${corEsc(x.estado)}">${esc(x.estado)}</span></div>`).join('')}</div>`).join('') || '<div class="card vazio">Sem escalas. Carregue em “+ Escala”.</div>'}`;
  $('#escPer').onchange = (e) => { S.escPer = e.target.value; abrir('escala'); };
  if ($('#escReg')) $('#escReg').onchange = (e) => { S.escReg = e.target.value; abrir('escala'); };
  $('#novaE').onclick = () => formEscala(null);
  $('#autoE').onclick = () => formEscalaMassa();
  ligarSeg(m, 'vistaEsc', 'escala');
  $$('.lista .it', m).forEach(el => el.onclick = () => verEscala(vis.find(x => x.id === el.dataset.id)));
  const linha = (x) => `• ${fmtData(x.data)}${x.hora ? ' ' + x.hora : ''} — ${x.funcao}: *${x.delegado_nome}* · ${x.clube || x.local || ''}${x.estado === 'Cancelada' ? ' (CANCELADA)' : ''}`;
  $('#waE').onclick = () => whats(`🗓️ *Escala de delegados*\n${S.escReg ? nomeRegiao(S.escReg) : S.eu.papel === 'REGIONAL' ? nomeRegiao(S.eu.regiao_id) : 'Missão Sul de Luanda e Cabinda'}\n\n${vis.map(linha).join('\n') || 'Sem escalas.'}\n\n— SGC Desbravadores MSC`);
  $('#pdfE').onclick = () => imprimir('Escala de delegados', `<div class="grelha"><div><b>Âmbito</b>${esc(S.escReg ? nomeRegiao(S.escReg) : S.eu.papel === 'REGIONAL' ? nomeRegiao(S.eu.regiao_id) : 'Toda a Missão')}</div><div><b>Período</b>${S.escPer === 'prox' ? 'A partir de ' + fmtData(hoje()) : 'Desde ' + fmtData(de)}</div><div><b>Escalas</b>${vis.length}</div></div>
    ${tabela(['Data', 'Hora', 'Função', 'Delegado', 'Contacto', 'Clube / local', 'Estado'], vis.map(x => [fmtData(x.data), x.hora || '', esc(x.funcao), esc(x.delegado_nome), esc(x.delegado_contacto || ''), esc(x.clube || x.local || ''), x.estado]))}`);
}
function verEscala(x) {
  const md = modal(`<h3>${esc(x.funcao)}</h3><p class="dica"><span class="tag ${corEsc(x.estado)}">${esc(x.estado)}</span></p>
    <table>${[['Delegado', x.delegado_nome], ['Contacto', x.delegado_contacto], ['Email', x.delegado_email], ['Data', fmtData(x.data) + (x.hora ? ' às ' + x.hora : '')], ['Clube', x.clube], ['Local', x.local], ['Evento', x.evento],
      ['Âmbito', x.ambito === 'Missão' ? 'Missão' : nomeRegiao(x.regiao_id)], ['Notas', x.notas], ['Criada por', x.criado_por]].filter(([, v]) => v).map(([k, v]) => `<tr><th>${k}</th><td>${esc(v)}</td></tr>`).join('')}</table>
    <div class="accoes"><button class="btn wa esq" id="wa1">${IC_WA} Partilhar</button>${x.clube_id && x.estado !== 'Cancelada' ? '<button class="btn" id="insp1">📋 Inspecção / relatório</button>' : ''}${x.meu ? '<button class="btn del" id="apagar">Apagar</button><button class="btn sec" id="edit">Editar</button>' : ''}<button class="btn" data-fechar>Fechar</button></div>`);
  $('#wa1', md).onclick = () => whats(`🗓️ *${x.funcao}*\n👤 ${x.delegado_nome}${x.delegado_contacto ? ' (' + x.delegado_contacto + ')' : ''}\n📅 ${fmtData(x.data)}${x.hora ? ' às ' + x.hora : ''}\n📍 ${x.clube || x.local || ''}${x.notas ? '\n\n' + x.notas : ''}\n\n— SGC Desbravadores MSC`);
  if ($('#edit', md)) $('#edit', md).onclick = () => { md.remove(); formEscala(x); };
  if ($('#insp1', md)) $('#insp1', md).onclick = () => { md.remove(); formInspecao({ escala_id: x.id, clube_id: x.clube_id, clube: x.clube, data: x.data <= hoje() ? x.data : hoje(), funcao: x.funcao, delegado: x.delegado_nome }); };
  if ($('#apagar', md)) $('#apagar', md).onclick = (e) => { if (confirm('Apagar esta escala?')) ocupado(e.target, async () => { await api('apagarEscala', { id: x.id }); md.remove(); abrir('escala'); }); };
}
async function formEscala(x) {
  const [pes, evs] = await Promise.all([api('pessoasEscala'), api('eventos').catch(() => [])]);
  x = x || {}; const novo = !x.id;
  const clubes = S.eu.papel === 'REGIONAL' ? S.clubes.filter(c => c.regiao_id === S.eu.regiao_id) : S.clubes;
  const pessoas = [...pes.utilizadores.map(u => ({ nome: u.nome, email: u.email, contacto: '' })), ...pes.anteriores.filter(a => !pes.utilizadores.some(u => u.nome === a.nome))];
  const md = modal(`<h3>${novo ? 'Nova escala' : 'Editar escala'}</h3><form class="form">
    <label>Função<select name="funcao">${opts(FUNCOES_ESC, x.funcao || 'Delegado da Missão')}</select></label>
    <label>Estado<select name="estado">${opts(['Agendada', 'Confirmada', 'Realizada', 'Cancelada'], x.estado || 'Agendada')}</select></label>
    <label>Data<input name="data" type="date" value="${esc(x.data || '')}" required></label><label>Hora<input name="hora" type="time" value="${esc(x.hora || '')}"></label>
    <label class="full">Clube<select name="clube_id">${opts(clubes.map(c => [c.id, c.nome + (S.eu.papel === 'MSC' ? ' · ' + nomeRegiao(c.regiao_id) : '')]), x.clube_id, '— (indicar local abaixo)')}</select></label>
    <label class="full">Local (se não for num clube)<input name="local" value="${esc(x.local || '')}"></label>
    <label class="full">Evento (opcional)<select name="evento_id">${opts(evs.map(e => [e.id, e.nome + ' · ' + fmtData(e.data_inicio)]), x.evento_id, '—')}</select></label>
    <label class="full">Delegado<input name="delegado_nome" list="dlP" value="${esc(x.delegado_nome || '')}" required placeholder="Nome de quem vai"><datalist id="dlP">${pessoas.map(p => `<option value="${esc(p.nome)}">`).join('')}</datalist></label>
    <label>Contacto<input name="delegado_contacto" type="tel" value="${esc(x.delegado_contacto || '')}"></label>
    <label>Email (para notificar)<input name="delegado_email" type="email" value="${esc(x.delegado_email || '')}"></label>
    <label class="full">Notas<textarea name="notas" rows="2">${esc(x.notas || '')}</textarea></label></form>
    <p class="dica">O clube recebe uma notificação. Se o delegado tiver conta no SGC (email), também é avisado, e ambos recebem lembretes 7 dias e 1 dia antes.</p>
    <div class="accoes"><button class="btn sec" data-fechar>Cancelar</button><button class="btn" id="gravar">Guardar</button></div>`);
  $('[name=delegado_nome]', md).addEventListener('change', (e) => { const p = pessoas.find(q => q.nome === e.target.value); if (p) { if (p.email && !$('[name=delegado_email]', md).value) $('[name=delegado_email]', md).value = p.email; if (p.contacto && !$('[name=delegado_contacto]', md).value) $('[name=delegado_contacto]', md).value = p.contacto; } });
  $('#gravar', md).onclick = (e) => ocupado(e.target, async () => { const r = lerForm($('form', md)); r.id = x.id; r.solicitacao_id = x.solicitacao_id; await api('guardarEscala', { registo: r }); md.remove(); aviso('Escala guardada. O clube foi notificado.'); abrir('escala'); });
}

/* ---------- ajuda ---------- */
const GUIA = [
  { t: 'Primeiros passos', p: ['todos'], h: `<ul><li>Abra o SGC no Chrome (Android) ou Safari (iPhone) e carregue em Instalar (ou menu → Adicionar ao ecrã principal). Fica como uma aplicação.</li>
    <li>Entre com o seu email e a palavra-passe que recebeu. Mude a palavra-passe em Conta / Sair.</li><li>Esqueceu a palavra-passe? No ecrã de entrada carregue em "Esqueci a palavra-passe".</li>
    <li>Para mudar de ecrã, toque nos ícones de baixo ou deslize o dedo para a esquerda/direita.</li><li>O sino (em cima) mostra as notificações. Active as notificações no telemóvel em Conta / Sair.</li>
    <li>Para sair ou entrar com outra conta, carregue em "Sair" no canto superior direito.</li></ul>` },
  { t: 'Membros e unidades', p: ['DIRECTOR', 'REGIONAL', 'MSC'], h: `<ul><li>Clube → "+ Unidade" para criar as unidades (Falcões, Gazelas…).</li><li>Membros → "+ Novo" para registar. Só o nome é obrigatório, mas preencha a data de nascimento: dá a classe sugerida e os aniversários.</li>
    <li>Muitos membros de uma vez: Membros → "Importar Excel" (descarregue primeiro o modelo).</li><li>Toque num membro para ver a ficha completa (classes, presenças, especialidades) e o código QR. "Editar dados" para corrigir.</li>
    <li>Cartões de membro: Membros → "Cartões (PDF)", 10 por folha A4.</li></ul>` },
  { t: 'Presenças (chamada)', p: ['DIRECTOR', 'REGIONAL', 'MSC'], h: `<ul><li>Presenças → "+ Chamada": escolha a data e o tipo, e marque P (presente), F (falta) ou J (justificada).</li>
    <li>"Todos presentes" marca P em todos; depois corrija as faltas.</li><li>"📷 Ler cartões": aponte a câmara aos cartões QR para marcar presença.</li>
    <li>Sem internet a chamada fica guardada no telemóvel ("Por enviar") e é enviada sozinha quando houver rede.</li></ul>` },
  { t: 'Classes, requisitos e especialidades', p: ['DIRECTOR', 'REGIONAL', 'MSC'], h: `<ul><li>Classes → "+ Inscrever": inscreva os desbravadores pela idade ou numa classe à escolha.</li>
    <li>Toque num desbravador para marcar os requisitos cumpridos. O estado passa sozinho a "Em curso" e "Concluído".</li><li>"Marcar para a turma" regista um requisito a vários de uma vez.</li>
    <li>Na investidura, mude o estado para "Investido" e indique a data.</li><li>No início do ano: "Passagem de ano" propõe a classe seguinte para todos.</li>
    <li>Especialidades: no mesmo separador, botão "Especialidades".</li></ul>` },
  { t: 'Mérito', p: ['DIRECTOR', 'REGIONAL', 'MSC'], h: `<ul><li>Presenças, faltas, actividades missionárias e especialidades contam pontos sozinhas.</li><li>"+ Pontos" lança pontos manuais (uniforme, Bíblia, verso…) a vários de uma vez.</li>
    <li>"Critérios" permite criar critérios próprios do clube.</li><li>"Clubes e regiões" mostra a classificação dos clubes na Missão.</li></ul>` },
  { t: 'Relatório mensal e trimestral', p: ['DIRECTOR', 'REGIONAL', 'MSC'], h: `<ul><li>Relatório → Mensal: os números vêm das presenças e classes. Responda às perguntas e carregue em "Enviar à região" até ao dia 10.</li>
    <li>Depois de enviado fica fechado. Para corrigir, peça à região que o reabra.</li><li>Trimestral: soma automática dos meses enviados (T1–T4). Botão PDF para imprimir.</li>
    <li>Região e Missão: "Envios" mostra que clubes enviaram (✓) e quais faltam.</li></ul>` },
  { t: 'Finanças, seguro e eventos', p: ['DIRECTOR', 'REGIONAL', 'MSC'], h: `<ul><li>Finanças → "+ Movimento" para entradas e saídas. Os erros não se apagam: anulam-se com motivo.</li>
    <li>"Seguro e taxas": registe quem pagou o seguro; o total entra sozinho nas finanças.</li><li>Eventos: abra o evento e marque quem vai. O aviso "Sem seguro" ajuda a não esquecer ninguém.</li>
    <li>"Convocatória" partilha o evento no WhatsApp.</li></ul>` },
  { t: 'Pedidos e transferências', p: ['DIRECTOR', 'REGIONAL', 'MSC'], h: `<ul><li>Pedidos → "+ Pedido" (cerimónia de admissão, investidura, visita…). A região tem 14 dias; se não responder, o pedido vai sozinho para a Missão.</li>
    <li>Transferências: abra o membro → "Transferir". Mesma região: aceita o clube de destino. Outra região: aprovam as duas regiões e o clube.</li></ul>` },
  { t: 'Para a região', p: ['REGIONAL', 'MSC'], h: `<ul><li>Escolha o clube no filtro do topo para ver e corrigir os dados de qualquer clube da região.</li><li>Gestão → crie e ajude os directores (repor palavra-passe em Utilizadores).</li>
    <li>Avisos → "+ Comunicado" para os clubes da região; veja "Quem leu".</li><li>Pedidos: decida dentro de 14 dias. Escala: marque os delegados que vão aos clubes.</li>
    <li>Agenda → "+ Data" para reuniões e formações (todos recebem lembretes).</li></ul>` },
  { t: 'Para a Missão', p: ['MSC'], h: `<ul><li>Gestão: regiões, clubes, utilizadores e o e-mail automático (Brevo) para a recuperação de palavra-passe.</li>
    <li>Escala: escale delegados da Missão para eventos nos clubes; partilhe a escala no WhatsApp ou em PDF.</li><li>Painel e Mérito → "Clubes e regiões" para comparar regiões.</li></ul>` },
  { t: 'Perguntas frequentes', p: ['todos'], h: `<ul><li>Não vejo as alterações? Feche e volte a abrir a aplicação (no computador: Ctrl+Shift+R).</li><li>Sem internet? O SGC abre com os últimos dados vistos; as chamadas são enviadas depois.</li>
    <li>O PDF não abre? Na janela "PDF pronto" use "Partilhar" ou "Descarregar".</li><li>Os dados são de menores: não partilhe a sua palavra-passe nem capturas com contactos e datas de nascimento.</li></ul>` }
];
const guiaVisivel = () => GUIA.filter(g => g.p.includes('todos') || g.p.includes(S.eu.papel));
async function vAjuda(m) {
  const g = guiaVisivel();
  m.innerHTML = `<div class="barra"><h2>Ajuda</h2><button class="btn sec peq" id="pdfG">Guia em PDF</button></div>
    <input type="search" id="qA" placeholder="Procurar na ajuda…" style="margin-bottom:10px">
    <div id="secs">${g.map((x, i) => `<details class="card ajuda"${i === 0 ? ' open' : ''}><summary>${esc(x.t)}</summary>${x.h}</details>`).join('')}</div>
    <div class="card"><h3>Precisa de mais ajuda?</h3><p class="dica">Fale com o director da sua região ou com a coordenação dos Desbravadores da Missão. Pode partilhar este guia em PDF no grupo de directores.</p></div>`;
  $('#qA').oninput = (e) => { const q = semAcento(e.target.value); $$('.ajuda', m).forEach(d => { const ok = !q || semAcento(d.textContent).includes(q); d.hidden = !ok; if (q && ok) d.open = true; }); };
  $('#pdfG').onclick = () => imprimir('Guia do SGC Desbravadores MSC', g.map(x => `<h2>${esc(x.t)}</h2>${x.h}`).join(''),
    { MSC: 'Versão para a Missão', REGIONAL: 'Versão para regionais', DIRECTOR: 'Versão para directores de clube' }[S.eu.papel]);
}

/* ======================= FASE 7 ======================= */
const telWA = (t) => { let d = String(t || '').replace(/\D/g, ''); if (d.length === 9) d = '244' + d; return d; };

/* ---------- cópia de segurança / exportar tudo ---------- */
async function cartaoCopia(m) {
  const info = await api('infoExportacao');
  const tot = info.tabelas.reduce((a, t) => a + t.linhas, 0);
  const el = document.createElement('div'); el.className = 'card';
  el.innerHTML = `<h3>Cópia de segurança e exportação</h3>
    <p class="dica">Última cópia completa: <b>${info.ultima ? new Date(info.ultima).toLocaleString('pt-PT') : 'nunca'}</b> · ${fmtN(tot)} registos em ${info.tabelas.length} tabelas.<br>
    A Cloudflare guarda automaticamente o histórico dos últimos 7 dias (permite recuar a base de dados). Esta cópia completa fica consigo: guarde-a no Google Drive ou num disco. Recebe um lembrete todas as segundas-feiras.</p>
    <div class="bar" id="cpBar" hidden><i style="width:0%"></i></div><p class="dica" id="cpTxt"></p>
    <div class="accoes"><button class="btn" id="cpGo">⬇️ Cópia completa (Excel + ficheiro de cópia)</button></div>`;
  m.prepend(el);
  $('#cpGo', el).onclick = (e) => ocupado(e.target, async () => {
    await carregarXLSX(); const bar = $('#cpBar', el), txt = $('#cpTxt', el); bar.hidden = false;
    const tudo = {}; let feitos = 0;
    for (const [i, t] of info.tabelas.entries()) {
      tudo[t.tabela] = []; let desde = 0;
      do {
        txt.textContent = `A copiar ${t.tabela}… (${fmtN(feitos)} de ${fmtN(tot)})`;
        const ult = i === info.tabelas.length - 1;
        const r = await api('exportarTabela', { tabela: t.tabela, desde, fim: false });
        tudo[t.tabela].push(...r.linhas); feitos += r.linhas.length; desde = r.seguinte;
        $('i', bar).style.width = Math.min(100, Math.round(feitos / Math.max(1, tot) * 100)) + '%';
      } while (desde);
    }
    await api('exportarTabela', { tabela: 'regioes', desde: 1e12, fim: true });
    const d = hoje();
    const wb = XLSX.utils.book_new();
    for (const [t, linhas] of Object.entries(tudo)) {
      if (linhas.length > 1000000) { txt.textContent = `A tabela ${t} é demasiado grande para Excel; fica só no ficheiro de cópia.`; continue; }
      XLSX.utils.book_append_sheet(wb, linhas.length ? XLSX.utils.json_to_sheet(linhas) : XLSX.utils.aoa_to_sheet([['(vazia)']]), t.slice(0, 31));
    }
    XLSX.writeFile(wb, `SGC_copia_${d}.xlsx`);
    const blob = new Blob([JSON.stringify({ sgc: 'copia', versao: 1, data: new Date().toISOString(), tabelas: tudo })], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `SGC_copia_${d}.json`; document.body.appendChild(a); a.click(); a.remove();
    txt.textContent = `✅ Cópia concluída: ${fmtN(feitos)} registos. Foram descarregados 2 ficheiros (Excel e .json). Guarde-os em lugar seguro.`;
  });
}

/* ---------- alerta de abandono ---------- */
async function cartaoRisco(m, clubeId) {
  try {
    const l = await api('emRisco', { clube_id: clubeId }); if (!l.length) return;
    const c = document.createElement('div'); c.className = 'card c3 risco';
    c.innerHTML = `<h3>⚠️ Em risco de abandono (${l.length})</h3><p class="dica">Desbravadores com 6 ou mais faltas seguidas. Contacte o encarregado.</p>
      <div class="lista">${l.map(x => `<div class="it"><div class="av" style="background:#fed7d7;color:#9b2c2c">${x.faltas}</div>
        <div class="tx"><b>${esc(x.nome)}</b><small>${x.faltas} faltas seguidas${x.encarregado_nome ? ' · Encarregado: ' + esc(x.encarregado_nome) : ''}</small></div>
        ${telWA(x.encarregado_contacto || x.contacto) ? `<button class="btn wa peq" data-t="${telWA(x.encarregado_contacto || x.contacto)}" data-n="${esc(x.nome)}" data-e="${esc(x.encarregado_nome || '')}">${IC_WA} Contactar</button>` : '<span class="tag">Sem contacto</span>'}</div>`).join('')}</div>`;
    const dash = $('.dash', m); if (dash) dash.prepend(c); else m.appendChild(c);
    $$('[data-t]', c).forEach(b => b.onclick = () => { const msg = `Olá${b.dataset.e ? ' ' + b.dataset.e.split(' ')[0] : ''}! Sentimos a falta do(a) ${b.dataset.n.split(' ')[0]} nas últimas reuniões do Clube de Desbravadores ${nomeClube(clubeId)}. Está tudo bem? Gostaríamos muito de o(a) ver de volta. 💙💛`;
      const u = `https://wa.me/${b.dataset.t}?text=${encodeURIComponent(msg)}`; if (!window.open(u, '_blank')) location.href = u; });
  } catch (e) {}
}

/* ---------- plano anual ---------- */
async function vPlano(m, seg) {
  S.anoPl = S.anoPl || new Date().getFullYear();
  const d = await api('plano', { clube_id: S.clube_id, ano: S.anoPl });
  const tot = d.itens.length, ok = d.itens.filter(x => x.cumprido).length, hM = new Date().getFullYear() === S.anoPl ? new Date().getMonth() + 1 : (S.anoPl < new Date().getFullYear() ? 13 : 0);
  const atras = d.itens.filter(x => !x.cumprido && x.mes < hM).length;
  const cel = (mes, pil) => { const pl = d.itens.filter(x => x.mes === mes && (x.pilar || '—') === pil), rl = (d.realizadas.find(x => x.mes === mes && x.pilar === pil) || {}).n || 0;
    if (!pl.length && !rl) return '<td></td>'; const c = pl.filter(x => x.cumprido).length;
    return `<td class="pc ${pl.length && c >= pl.length ? 'ok' : pl.length && mes < hM ? 'falta' : ''}" title="planeadas ${pl.length} · realizadas ${rl}">${pl.length ? c + '/' + pl.length : '+' + rl}</td>`; };
  m.innerHTML = `${seg}<div class="barra"><h2>Plano anual</h2><select id="anoPl" style="flex:0 0 auto;width:auto;min-width:0">${opts([new Date().getFullYear() + 1, new Date().getFullYear(), new Date().getFullYear() - 1], S.anoPl)}</select><button class="btn" id="novoPl">+ Actividade</button></div>
    <div class="kpis"><div class="kpi"><div class="v">${tot}</div><div class="l">Actividades planeadas</div></div><div class="kpi"><div class="v">${tot ? Math.round(ok / tot * 100) : 0}%</div><div class="l">Cumprido (${ok})</div></div>
      <div class="kpi" style="border-left-color:${atras ? 'var(--verm)' : 'var(--ouro)'}"><div class="v">${atras}</div><div class="l">Em atraso</div></div></div>
    ${!tot ? `<div class="card"><p class="dica">Ainda não há plano para ${S.anoPl}. Planeie as actividades de cada mês por pilar. As chamadas feitas em Presenças, com o pilar escolhido, marcam sozinhas o plano como cumprido.</p><button class="btn sec peq" id="copPl">Copiar o plano de ${S.anoPl - 1}</button></div>` : ''}
    <div class="card"><h3>Mês × pilar</h3><div class="tw"><table class="plano"><tr><th>Mês</th>${PILARES.map(p => `<th>${p.slice(0, 4)}.</th>`).join('')}</tr>
      ${MESES.map((n, i) => `<tr><td>${n.slice(0, 3)}</td>${PILARES.map(p => cel(i + 1, p)).join('')}</tr>`).join('')}</table></div>
      <p class="dica">“2/3” = 2 de 3 planeadas já cumpridas · “+1” = realizada sem estar no plano · vermelho = mês passado com actividades por cumprir.</p></div>
    ${MESES.map((n, i) => { const l = d.itens.filter(x => x.mes === i + 1); if (!l.length) return '';
      return `<h4 class="sec">${n}</h4><div class="card lista">${l.map(x => `<div class="it" data-id="${x.id}"><div class="av" style="background:${x.cumprido ? '#c6f6d5' : i + 1 < hM ? '#fed7d7' : ''}">${x.cumprido ? '✓' : esc((x.pilar || '—').slice(0, 2))}</div>
        <div class="tx"><b>${esc(x.titulo)}</b><small>${esc(x.pilar || 'Sem pilar')}${x.tipo ? ' · ' + esc(x.tipo) : ''}${x.cumprido ? (x.auto ? ' · cumprida (chamada registada)' : ' · cumprida') : ''}</small></div></div>`).join('')}</div>`; }).join('')}
    ${tot ? '<div class="accoes"><button class="btn sec" id="pdfPl">Plano em PDF</button></div>' : ''}`;
  ligarSeg(m, 'vistaPres', 'presencas');
  $('#anoPl').onchange = (e) => { S.anoPl = +e.target.value; abrir('presencas'); };
  $('#novoPl').onclick = () => formPlano(null);
  if ($('#copPl')) $('#copPl').onclick = (e) => ocupado(e.target, async () => { const r = await api('copiarPlano', { clube_id: S.clube_id, ano: S.anoPl }); aviso(r.copiados + ' actividades copiadas.'); abrir('presencas'); });
  $$('.lista .it', m).forEach(el => el.onclick = () => formPlano(d.itens.find(x => x.id === el.dataset.id)));
  if ($('#pdfPl')) $('#pdfPl').onclick = () => imprimir(`Plano anual ${S.anoPl} — ${nomeClube(S.clube_id)}`, `<div class="grelha"><div><b>Planeadas</b>${tot}</div><div><b>Cumpridas</b>${ok} (${tot ? Math.round(ok / tot * 100) : 0}%)</div><div><b>Em atraso</b>${atras}</div></div>
    ${tabela(['Mês', 'Pilar', 'Actividade', 'Tipo', 'Estado'], d.itens.map(x => [MESES[x.mes - 1], esc(x.pilar || ''), esc(x.titulo), esc(x.tipo || ''), x.cumprido ? 'Cumprida' : x.mes < hM ? 'Em atraso' : 'Por fazer']))}
    <div class="assin"><div>O Director do clube</div><div>O Director regional</div></div>`);
}
function formPlano(x) {
  const novo = !x; x = x || { ano: S.anoPl, mes: new Date().getMonth() + 1 };
  const md = modal(`<h3>${novo ? 'Nova actividade no plano' : 'Actividade do plano'}</h3><form class="form">
    <label class="full">Actividade<input name="titulo" value="${esc(x.titulo)}" required placeholder="Ex.: Caminhada ecológica, Visita ao lar de idosos"></label>
    <label>Mês<select name="mes">${opts(MESES.map((n, i) => [i + 1, n]), x.mes)}</select></label>
    <label>Pilar<select name="pilar">${opts(PILARES, x.pilar, '—')}</select></label>
    <label>Tipo<select name="tipo">${opts(TIPOS_ACT, x.tipo, '—')}</select></label>
    <label>Cumprida (manual)<select name="feito">${opts([['0', 'Automático pelas chamadas'], ['1', 'Sim, marcar como cumprida']], String(x.feito || 0))}</select></label>
    <label class="full">Descrição<textarea name="descricao" rows="2">${esc(x.descricao)}</textarea></label></form>
    <div class="accoes">${novo ? '' : '<button class="btn del esq" id="apagar">Apagar</button>'}<button class="btn sec" data-fechar>Cancelar</button><button class="btn" id="gravar">Guardar</button></div>`);
  $('#gravar', md).onclick = (e) => ocupado(e.target, async () => { const r = lerForm($('form', md)); r.id = x.id; r.clube_id = S.clube_id; r.ano = S.anoPl; await api('guardarPlano', { registo: r }); md.remove(); abrir('presencas'); });
  const ap = $('#apagar', md); if (ap) ap.onclick = (e) => ocupado(e.target, async () => { await api('apagarPlano', { id: x.id }); md.remove(); abrir('presencas'); });
}

/* ---------- inspecções ---------- */
let ITENS_INSP = null;
async function formInspecao(x) {
  ITENS_INSP = ITENS_INSP || await api('itensInspecao');
  const clubes = S.eu.papel === 'REGIONAL' ? S.clubes.filter(c => c.regiao_id === S.eu.regiao_id) : S.clubes;
  const val = {};
  const md = modal(`<h3>📋 Inspecção e relatório da visita</h3>${x.funcao ? `<p class="dica">${esc(x.funcao)} · ${esc(x.delegado || '')}</p>` : ''}<form class="form">
    ${x.escala_id ? `<label class="full">Clube<input value="${esc(x.clube || nomeClube(x.clube_id))}" readonly></label>` : `<label class="full">Clube<select name="clube_id">${opts(clubes.map(c => [c.id, c.nome]), x.clube_id || S.clube_id)}</select></label>`}
    <label>Data da visita<input name="data" type="date" value="${esc(x.data || hoje())}" max="${hoje()}"></label><label>Desbravadores presentes<input name="presentes" type="number" min="0" inputmode="numeric"></label></form>
    <h4 class="sec">Lista de verificação <span id="nota" class="tag azul">—</span></h4>
    <div class="insp">${ITENS_INSP.map(i => `<div class="ii" data-k="${i.k}"><span>${esc(i.t)}</span><div>${[[2, 'Sim'], [1, 'Parcial'], [0, 'Não']].map(([v, t]) => `<button type="button" data-v="${v}">${t}</button>`).join('')}</div></div>`).join('')}</div>
    <p class="dica">Itens não avaliados (sem resposta) não contam para a nota. Avalie pelo menos 5.</p>
    <form class="form" id="f2"><label class="full">Relatório da actividade (o que foi feito, como correu)<textarea name="relatorio" rows="5" required></textarea></label>
      <label class="full">Recomendações ao clube<textarea name="recomendacoes" rows="3"></textarea></label></form>
    <div class="accoes"><button class="btn sec" data-fechar>Cancelar</button><button class="btn" id="gravar">Guardar relatório</button></div>`);
  const nota = () => { const v = Object.values(val); $('#nota', md).textContent = v.length ? Math.round(v.reduce((a, b) => a + b, 0) / (v.length * 2) * 100) + '%' : '—'; };
  $$('.ii button', md).forEach(b => b.onclick = () => { const k = b.closest('.ii').dataset.k, v = +b.dataset.v;
    if (val[k] === v) delete val[k]; else val[k] = v; $$('button', b.parentNode).forEach(o => o.classList.toggle('on', +o.dataset.v === val[k])); nota(); });
  $('#gravar', md).onclick = (e) => ocupado(e.target, async () => {
    const r = Object.assign(lerForm($('form', md)), lerForm($('#f2', md)), { itens: val, escala_id: x.escala_id || null });
    if (x.escala_id) r.clube_id = x.clube_id;
    const res = await api('guardarInspecao', { registo: r }); md.remove(); aviso(`Relatório guardado. Nota: ${res.nota}%. O clube e a região foram notificados.`); abrir(S.aba);
  });
}
function verInspecao(x, itens) {
  const lbl = { 2: 'Sim', 1: 'Parcial', 0: 'Não' };
  const md = modal(`<h3>Inspecção · ${esc(x.clube)}</h3><p class="dica">${fmtData(x.data)} · ${esc(x.delegado_nome || '')}${x.funcao ? ' · ' + esc(x.funcao) : ''} · <span class="tag ${x.nota >= 75 ? 'ok' : x.nota >= 50 ? '' : 'nao'}">${x.nota}%</span></p>
    <table>${itens.filter(i => x.itens[i.k] != null).map(i => `<tr><td>${esc(i.t)}</td><td><b>${lbl[x.itens[i.k]]}</b></td></tr>`).join('')}</table>
    <h4 class="sec">Relatório</h4><p style="white-space:pre-wrap">${esc(x.relatorio || '')}</p>${x.recomendacoes ? `<h4 class="sec">Recomendações</h4><p style="white-space:pre-wrap">${esc(x.recomendacoes)}</p>` : ''}
    <p class="dica">Desbravadores presentes: ${x.presentes ?? '—'}</p><div class="accoes"><button class="btn sec esq" id="pdfI">PDF</button><button class="btn" data-fechar>Fechar</button></div>`);
  $('#pdfI', md).onclick = () => imprimir(`Relatório de visita — ${x.clube}`, `<div class="grelha"><div><b>Clube</b>${esc(x.clube)}</div><div><b>Data</b>${fmtData(x.data)}</div><div><b>Nota</b>${x.nota}%</div>
    <div><b>Delegado</b>${esc(x.delegado_nome || '')}</div><div><b>Função</b>${esc(x.funcao || '—')}</div><div><b>Presentes</b>${x.presentes ?? '—'}</div></div>
    <h2>Lista de verificação</h2>${tabela(['Item', 'Avaliação'], itens.filter(i => x.itens[i.k] != null).map(i => [esc(i.t), lbl[x.itens[i.k]]]))}
    <h2>Relatório da actividade</h2><p>${esc(x.relatorio || '')}</p><h2>Recomendações</h2><p>${esc(x.recomendacoes || '—')}</p><div class="assin"><div>O Delegado</div><div>O Director do clube</div></div>`);
}
async function vInspecoes(m, seg) {
  const d = await api('inspecoes', {});
  m.innerHTML = `${seg}<div class="barra"><h2>Inspecções</h2><button class="btn" id="novaI">+ Inspecção</button></div>
    <div class="card lista">${d.lista.map(x => `<div class="it" data-id="${x.id}"><div class="av" style="background:${x.nota >= 75 ? '#c6f6d5' : x.nota >= 50 ? '#fefcbf' : '#fed7d7'};color:#1d2733">${x.nota}</div>
      <div class="tx"><b>${esc(x.clube)}</b><small>${fmtData(x.data)} · ${esc(x.delegado_nome || '')}${S.eu.papel === 'MSC' ? ' · ' + esc(nomeRegiao(x.regiao_id)) : ''}</small></div></div>`).join('') || '<div class="vazio">Ainda sem inspecções. Abra uma escala e carregue em “Inspecção / relatório”.</div>'}</div>`;
  ligarSeg(m, 'vistaEsc', 'escala');
  $('#novaI').onclick = () => formInspecao({});
  $$('.lista .it', m).forEach(el => el.onclick = () => verInspecao(d.lista.find(x => x.id === el.dataset.id), d.itens));
}
async function cartaoInspecoesClube(m, c) {
  try {
    const d = await api('inspecoes', { clube_id: c.id }); if (!d.lista.length && !naoDir()) return;
    const el = document.createElement('div'); el.className = 'card';
    el.innerHTML = `<div class="barra"><h3>Inspecções e visitas</h3>${naoDir() ? '<button class="btn peq" id="nI">+ Inspecção</button>' : ''}</div><div class="lista">${d.lista.map(x => `<div class="it" data-id="${x.id}"><div class="av" style="background:${x.nota >= 75 ? '#c6f6d5' : x.nota >= 50 ? '#fefcbf' : '#fed7d7'};color:#1d2733">${x.nota}</div>
      <div class="tx"><b>${fmtData(x.data)} · ${esc(x.funcao || 'Visita')}</b><small>${esc(x.delegado_nome || '')}</small></div></div>`).join('') || '<div class="vazio">Sem inspecções.</div>'}</div>`;
    m.appendChild(el);
    $$('.it', el).forEach(e => e.onclick = () => verInspecao(d.lista.find(x => x.id === e.dataset.id), d.itens));
    if ($('#nI', el)) $('#nI', el).onclick = () => formInspecao({ clube_id: c.id });
  } catch (e) {}
}

/* ---------- mapa ---------- */
let lfPronto = null;
function carregarLeaflet() {
  if (window.L) return Promise.resolve();
  if (!lfPronto) { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = '/lib/leaflet/leaflet.css'; document.head.appendChild(l); lfPronto = carregarScript('/lib/leaflet/leaflet.js'); }
  return lfPronto;
}
async function definirLocalizacao(c) {
  if (!navigator.geolocation) throw new Error('Este dispositivo não dá a localização.');
  if (!confirm(`Guardar a sua localização actual como a localização do clube ${c.nome}? Faça isto no local onde o clube se reúne.`)) return;
  const pos = await new Promise((ok, falhou) => navigator.geolocation.getCurrentPosition(ok, () => falhou(new Error('Sem acesso à localização. Autorize-a para este site.')), { enableHighAccuracy: true, timeout: 15000 }));
  await api('guardarLocalizacao', { clube_id: c.id, lat: pos.coords.latitude, lng: pos.coords.longitude });
  aviso(`Localização guardada (precisão ~${Math.round(pos.coords.accuracy)} m).`);
}
async function vMapa(m, seg) {
  const [l] = await Promise.all([api('mapaClubes'), carregarLeaflet()]);
  const com = l.filter(c => c.lat != null), sem = l.filter(c => c.lat == null);
  m.innerHTML = `${seg}<h2>Mapa dos clubes</h2><div id="mapa" class="mapa"></div>
    <p class="dica">${com.length} de ${l.length} clubes com localização. Cada director define a do seu clube em <b>Clube → 📍 Localização no mapa</b>, no local das reuniões. Para a ajudar, a região pode fazê-lo também ao visitar o clube.</p>
    ${sem.length ? `<div class="card"><h3>Sem localização (${sem.length})</h3><p class="dica">${sem.map(c => esc(c.nome)).join(' · ')}</p></div>` : ''}`;
  ligarSeg(m, 'vistaEsc', 'escala');
  const mapa = L.map('mapa').setView(com.length ? [com[0].lat, com[0].lng] : [-8.84, 13.23], 10);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© OpenStreetMap' }).addTo(mapa);
  const corR = {}; const paleta = ['#2a78d6', '#eb6834', '#1baf7a', '#7c3aed', '#d4a017', '#db2777', '#0891b2', '#65a30d', '#b91c1c', '#4b5563', '#9333ea'];
  S.regioes.forEach((r, i) => corR[r.id] = paleta[i % paleta.length]);
  const pts = [];
  com.forEach(c => { pts.push([c.lat, c.lng]);
    L.circleMarker([c.lat, c.lng], { radius: 9, color: '#fff', weight: 2, fillColor: corR[c.regiao_id] || '#2a78d6', fillOpacity: .95 }).addTo(mapa)
      .bindPopup(`<b>${esc(c.nome)}</b><br>${esc(nomeRegiao(c.regiao_id))}${c.distrito ? ' · ' + esc(c.distrito) : ''}<br>${c.membros} membros${c.director ? '<br>Director: ' + esc(c.director) : ''}<br>${c.ult_insp ? 'Última inspecção: ' + fmtData(c.ult_insp) + ' (' + c.ult_nota + '%)' : 'Sem inspecções'}`); });
  if (pts.length > 1) mapa.fitBounds(pts, { padding: [30, 30] });
  setTimeout(() => mapa.invalidateSize(), 200);
}

/* ---------- delegados e escala automática ---------- */
async function vDelegados(m, seg) {
  const l = await api('delegados');
  m.innerHTML = `${seg}<div class="barra"><h2>Delegados</h2><button class="btn sec" id="impL">Importar líderes</button><button class="btn" id="novoD">+ Delegado</button></div>
    <p class="dica">Lista de pessoas que podem ser escaladas (delegados, pregadores, avaliadores). A escala automática escolhe a partir daqui.</p>
    <div class="card lista">${l.map(x => `<div class="it${x.activo ? '' : ' inactivo'}" data-id="${x.id}"><div class="av">${esc(iniciais(x.nome))}</div>
      <div class="tx"><b>${esc(x.nome)}</b><small>${x.clube ? esc(x.clube) : 'Sem clube'}${x.funcoes ? ' · ' + esc(x.funcoes) : ''}${x.contacto ? ' · ' + esc(x.contacto) : ''}</small></div><span class="tag">${x.escalas_ano} escalas</span></div>`).join('') || '<div class="vazio">Ainda sem delegados.</div>'}</div>`;
  ligarSeg(m, 'vistaEsc', 'escala');
  $('#novoD').onclick = () => formDelegado(null);
  $$('.lista .it', m).forEach(el => el.onclick = () => formDelegado(l.find(x => x.id === el.dataset.id)));
  $('#impL').onclick = (e) => ocupado(e.target, async () => {
    const r = await api('importarLideres', {});
    if (!r.encontrados) return aviso('Não há líderes novos para importar (directores, líderes, conselheiros, instrutores e capelães dos clubes).');
    if (!confirm(`Importar ${r.encontrados} líderes dos clubes${S.eu.papel === 'REGIONAL' ? ' da sua região' : ''} como delegados?\n\nEx.: ${r.exemplo.join(', ')}…`)) return;
    const f = await api('importarLideres', { confirmar: 1 }); aviso(f.importados + ' delegados importados.'); abrir('escala');
  });
}
function formDelegado(x) {
  const novo = !x; x = x || { activo: 1 };
  const clubes = S.eu.papel === 'REGIONAL' ? S.clubes.filter(c => c.regiao_id === S.eu.regiao_id) : S.clubes;
  const md = modal(`<h3>${novo ? 'Novo delegado' : 'Delegado'}</h3><form class="form">
    <label class="full">Nome<input name="nome" value="${esc(x.nome)}" required></label>
    <label>Contacto<input name="contacto" type="tel" value="${esc(x.contacto)}"></label><label>Email (se tiver conta no SGC)<input name="email" type="email" value="${esc(x.email)}"></label>
    <label class="full">Clube de origem (não é escalado para o próprio clube)<select name="clube_id">${opts(clubes.map(c => [c.id, c.nome]), x.clube_id, '—')}</select></label>
    <label class="full">Funções que pode fazer<input name="funcoes" value="${esc(x.funcoes)}" placeholder="Ex.: Pregador, Avaliador"></label>
    <label>Estado<select name="activo">${opts([['1', 'Disponível'], ['0', 'Indisponível']], String(x.activo))}</select></label></form>
    <div class="accoes">${novo ? '' : '<button class="btn del esq" id="apagar">Apagar</button>'}<button class="btn sec" data-fechar>Cancelar</button><button class="btn" id="gravar">Guardar</button></div>`);
  $('#gravar', md).onclick = (e) => ocupado(e.target, async () => { const r = lerForm($('form', md)); r.id = x.id; await api('guardarDelegado', { registo: r }); md.remove(); abrir('escala'); });
  const ap = $('#apagar', md); if (ap) ap.onclick = (e) => ocupado(e.target, async () => { await api('apagarDelegado', { id: x.id }); md.remove(); abrir('escala'); });
}
async function formEscalaMassa() {
  const dels = await api('delegados');
  if (!dels.filter(d => d.activo).length) { aviso('Registe primeiro os delegados (Escala → Delegados → Importar líderes).', true); S.vistaEsc = 'del'; return abrir('escala'); }
  const h = new Date(); const ini = hoje(), fim = new Date(h.getFullYear(), h.getMonth() + 1, 0).toISOString().slice(0, 10);
  const md = modal(`<h3>⚡ Escala automática</h3><p class="dica">O sistema distribui os delegados pelos clubes de forma aleatória e equilibrada: ninguém vai ao próprio clube, ninguém fica com dois clubes no mesmo dia (a não ser que permita) e, havendo localização, prefere o mais próximo. Vê a proposta antes de confirmar.</p>
    <form class="form"><label>Função<select name="funcao">${opts(FUNCOES_ESC, 'Avaliador / inspector')}</select></label><label>Hora<input name="hora" type="time" value="15:00"></label>
      <label>De<input name="de" type="date" value="${ini}"></label><label>Até<input name="ate" type="date" value="${fim}"></label>
      ${S.eu.papel === 'MSC' ? `<label>Clubes de<select name="regiao_id">${opts(S.regioes.map(r => [r.id, r.nome]), '', 'Todas as regiões')}</select></label>` : ''}
      <label>Visitas por delegado no mesmo dia<select name="max_por_dia">${opts([1, 2, 3], 1)}</select></label></form>
    <h4 class="sec">Dias da semana</h4><div class="dsem">${[[1, 'Seg'], [2, 'Ter'], [3, 'Qua'], [4, 'Qui'], [5, 'Sex'], [6, 'Sáb'], [0, 'Dom']].map(([v, t]) => `<label><input type="checkbox" value="${v}" ${v === 6 ? 'checked' : ''}> ${t}</label>`).join('')}</div>
    <h4 class="sec">Delegados a usar</h4>${checklist(dels.filter(d => d.activo).map(d => ({ id: d.id, nome: d.nome + (d.clube ? ' · ' + d.clube : '') })), dels.filter(d => d.activo).map(d => d.id))}
    <div class="accoes"><button class="btn sec" data-fechar>Cancelar</button><button class="btn" id="gerar">Gerar proposta</button></div>`);
  ligarChecklist(md);
  $('#gerar', md).onclick = (e) => ocupado(e.target, async () => {
    const f = lerForm($('form', md)); f.dias_semana = $$('.dsem input:checked', md).map(i => +i.value); f.delegados = lerChecklist(md);
    const r = await api('proporEscalaMassa', f); md.remove(); verPropostaEscala(r, f);
  });
}
function verPropostaEscala(r, f) {
  const semD = r.proposta.filter(x => !x.data).length;
  const md = modal(`<h3>Proposta: ${esc(r.funcao)}</h3><p class="dica">${r.proposta.length} clubes · ${r.datas.length} dia(s) · ${r.delegados.length} delegados${semD ? ` · <b style="color:var(--verm)">${semD} sem delegado livre</b> (aumente o período, os dias ou os delegados)` : ''}. Pode trocar a data ou o delegado em cada linha.</p>
    <div class="tw"><table class="prop"><tr><th>Clube</th><th>Data</th><th>Delegado</th></tr>${r.proposta.map((x, i) => `<tr data-i="${i}"><td>${esc(x.clube)}${x.km != null ? `<br><small class="dica">~${x.km} km</small>` : ''}</td>
      <td><select class="pd">${opts([['', '—'], ...r.datas.map(d => [d, fmtData(d)])], x.data || '')}</select></td>
      <td><select class="pl">${opts([['', '—'], ...r.delegados.map(d => [d.id, d.nome])], x.delegado_id || '')}</select></td></tr>`).join('')}</table></div>
    <div class="accoes"><button class="btn sec esq" id="denovo">🔀 Sortear de novo</button><button class="btn sec" data-fechar>Cancelar</button><button class="btn" id="conf">Confirmar e notificar</button></div>`);
  $('#denovo', md).onclick = (e) => ocupado(e.target, async () => { const n = await api('proporEscalaMassa', f); md.remove(); verPropostaEscala(n, f); });
  $('#conf', md).onclick = (e) => ocupado(e.target, async () => {
    const itens = $$('tr[data-i]', md).map(tr => { const x = r.proposta[tr.dataset.i], d = r.delegados.find(q => q.id === $('.pl', tr).value);
      return d && $('.pd', tr).value ? { clube_id: x.clube_id, data: $('.pd', tr).value, delegado_nome: d.nome, delegado_email: d.email, delegado_contacto: d.contacto } : null; }).filter(Boolean);
    if (!itens.length) throw new Error('Nada para confirmar.');
    if (!confirm(`Criar ${itens.length} escalas e notificar os clubes?`)) return;
    const res = await api('confirmarEscalaMassa', { funcao: r.funcao, hora: r.hora, itens }); md.remove(); aviso(res.criadas + ' escalas criadas. Clubes e delegados notificados.'); S.vistaEsc = 'esc'; abrir('escala');
  });
}

/* ---------- provas ---------- */
const corRes = (r) => ({ Apto: 'ok', 'Não apto': 'nao', Faltou: '' }[r] || '');
async function vProvas(m) {
  const l = await api('provas');
  m.innerHTML = `<div class="barra"><h2>Provas</h2>${naoDir() ? '<button class="btn" id="novaP">+ Prova</button>' : ''}</div>
    <p class="dica">Provas de especialidades e de classes: os clubes inscrevem os candidatos, quem organiza lança as notas e, ao fechar, os aptos ficam registados sozinhos. As listas de aptos e não aptos saem em PDF.</p>
    ${l.map(p => `<div class="card ev" data-id="${p.id}"><div class="barra"><h3>${esc(p.titulo)}</h3><span class="tag ${p.estado === 'Fechada' ? 'ok' : p.estado === 'Em avaliação' ? 'azul' : ''}">${esc(p.estado)}</span></div>
      <div class="dica">${esc(p.tipo)}: <b>${esc(p.alvo)}</b> · ${fmtData(p.data)}${p.local ? ' · ' + esc(p.local) : ''} · ${p.ambito === 'Missão' ? 'Missão' : esc(nomeRegiao(p.regiao_id))} · nota mínima ${p.nota_minima}<br>
      ${p.candidatos} candidato(s)${p.estado !== 'Inscrições abertas' ? ` · <b style="color:var(--verde)">${p.aptos || 0} aptos</b> · <b style="color:var(--verm)">${p.nao_aptos || 0} não aptos</b>` : ''}${S.eu.papel === 'DIRECTOR' ? ' (do clube)' : ''}</div></div>`).join('') || '<div class="card vazio">Ainda não há provas.</div>'}`;
  if ($('#novaP')) $('#novaP').onclick = () => formProva(null);
  $$('.ev', m).forEach(el => el.onclick = () => verProva(el.dataset.id));
}
function formProva(p) {
  p = p || { tipo: 'Especialidade', nota_minima: 70, data: hoje() };
  const md = modal(`<h3>${p.id ? 'Editar prova' : 'Nova prova'}</h3><form class="form">
    <label>Tipo<select name="tipo" id="tpP">${opts(['Especialidade', 'Classe'], p.tipo)}</select></label>
    <label id="lAlvo">Especialidade<input name="alvo" id="alvo" value="${esc(p.alvo)}" list="dlE"><datalist id="dlE"></datalist></label>
    <label id="lCat">Categoria<select name="categoria">${opts(CAT_ESP, p.categoria, '—')}</select></label>
    <label>Data<input name="data" type="date" value="${esc(p.data)}"></label><label>Nota mínima (0–100)<input name="nota_minima" type="number" min="0" max="100" value="${p.nota_minima}"></label>
    ${S.eu.papel === 'MSC' && !p.id ? `<label>Âmbito<select name="regiao_id">${opts(S.regioes.map(r => [r.id, r.nome]), '', 'Toda a Missão')}</select></label>` : ''}
    <label class="full">Local<input name="local" value="${esc(p.local)}"></label><label class="full">Título (opcional)<input name="titulo" value="${esc(p.titulo)}"></label>
    ${p.id ? `<label>Estado<select name="estado">${opts(['Inscrições abertas', 'Em avaliação'], p.estado)}</select></label>` : ''}</form>
    <div class="accoes"><button class="btn sec" data-fechar>Cancelar</button><button class="btn" id="gravar">Guardar</button></div>`);
  const tp = () => { const cl = $('#tpP', md).value === 'Classe'; $('#lCat', md).hidden = cl;
    $('#lAlvo', md).firstChild.textContent = cl ? 'Classe' : 'Especialidade'; $('#dlE', md).innerHTML = (cl ? CLASSES : []).map(c => `<option value="${c}">`).join(''); };
  $('#tpP', md).onchange = tp; tp();
  $('#gravar', md).onclick = (e) => ocupado(e.target, async () => { const r = lerForm($('form', md)); r.id = p.id; await api('guardarProva', { registo: r }); md.remove(); aviso('Prova guardada. Os clubes foram notificados.'); abrir('provas'); });
}
async function verProva(id) {
  const d = await api('resultadosProva', { id }); const pv = d.prova;
  const cand = S.clube_id && pv.estado !== 'Fechada' && (pv.estado === 'Inscrições abertas' || pv.organizador) ? await api('candidatosProva', { prova_id: id, clube_id: S.clube_id }) : null;
  const aptos = d.resultados.filter(r => r.resultado === 'Apto'), nao = d.resultados.filter(r => r.resultado === 'Não apto');
  const md = modal(`<h3>${esc(pv.titulo)}</h3><p class="dica">${esc(pv.tipo)}: ${esc(pv.alvo)} · ${fmtData(pv.data)} · nota mínima ${pv.nota_minima} · <span class="tag">${esc(pv.estado)}</span></p>
    <div class="fkpis"><div><b>${d.resultados.length}</b><small>Candidatos</small></div><div><b style="color:var(--verde)">${aptos.length}</b><small>Aptos</small></div><div><b style="color:var(--verm)">${nao.length}</b><small>Não aptos</small></div><div><b>${d.resultados.filter(r => r.nota == null && r.resultado !== 'Faltou').length}</b><small>Sem nota</small></div></div>
    <div class="barra">${pv.organizador && pv.estado !== 'Fechada' ? '<button class="btn" id="notas">✏️ Lançar notas</button><button class="btn sec" id="fechar">Fechar e publicar</button><button class="btn sec peq" id="edP">Editar</button>' : ''}
      ${d.resultados.length ? '<button class="btn sec peq" id="pdfNA">PDF não aptos</button><button class="btn sec peq" id="pdfR">PDF resultados</button>' : ''}</div>
    ${cand ? `<h4 class="sec">Candidatos do clube ${esc(nomeClube(S.clube_id))}</h4>${checklist(cand.membros.filter(x => x.nota == null), cand.membros.filter(x => x.inscrito && x.nota == null).map(x => x.id))}
      <div class="accoes"><button class="btn" id="insc">Guardar candidatos</button></div>` : ''}
    <h4 class="sec">Resultados</h4><div class="lista">${d.resultados.map(r => `<div class="it"><div class="av">${r.nota ?? '–'}</div><div class="tx"><b>${esc(r.nome)}</b><small>${esc(r.clube)}${r.obs ? ' · ' + esc(r.obs) : ''}</small></div>
      <span class="tag ${corRes(r.resultado)}">${esc(r.resultado || 'Aguarda')}</span></div>`).join('') || '<div class="vazio">Sem candidatos.</div>'}</div>
    <div class="accoes"><button class="btn" data-fechar>Fechar</button></div>`);
  if (cand) { ligarChecklist(md); $('#insc', md).onclick = (e) => ocupado(e.target, async () => { const r = await api('inscreverProva', { prova_id: id, clube_id: S.clube_id, membros: lerChecklist(md) }); aviso(r.inscritos + ' candidato(s).'); md.remove(); verProva(id); }); }
  if ($('#edP', md)) $('#edP', md).onclick = () => { md.remove(); formProva(pv); };
  if ($('#notas', md)) $('#notas', md).onclick = () => { md.remove(); lancarNotasUI(pv, d.resultados); };
  if ($('#fechar', md)) $('#fechar', md).onclick = (e) => { const sn = d.resultados.filter(r => r.nota == null && r.resultado !== 'Faltou').length;
    if (!confirm((sn ? `Há ${sn} candidato(s) sem nota. ` : '') + 'Fechar a prova e publicar? Os aptos ficam registados automaticamente e os clubes são notificados.')) return;
    ocupado(e.target, async () => { const r = await api('fecharProva', { id }); md.remove(); aviso(`Prova fechada: ${r.aptos} aptos registados.`); abrir('provas'); }); };
  const pdf = (so) => { const l = so ? nao : d.resultados; const grupos = {}; l.forEach(r => { const k = (r.distrito || 'Sem distrito') + ' · ' + r.clube; (grupos[k] = grupos[k] || []).push(r); });
    imprimir(`${so ? 'Não aptos' : 'Resultados'} — ${pv.titulo}`, `<div class="grelha"><div><b>${pv.tipo}</b>${esc(pv.alvo)}</div><div><b>Data</b>${fmtData(pv.data)}</div><div><b>Nota mínima</b>${pv.nota_minima}</div>
      <div><b>Candidatos</b>${d.resultados.length}</div><div><b>Aptos</b>${aptos.length}</div><div><b>Não aptos</b>${nao.length}</div></div>
      ${Object.entries(grupos).map(([k, rs]) => `<h2>${esc(k)}</h2>${tabela(['#', 'Nome', 'Idade', 'Nota', 'Resultado'], rs.map((r, i) => [i + 1, esc(r.nome), idade(r.data_nasc) ?? '', r.nota ?? '', esc(r.resultado || '')]), ['n', '', 'n', 'n'])}`).join('') || '<p>Nenhum.</p>'}`, nomeRegiao(pv.regiao_id) === '—' ? 'Missão Sul de Luanda e Cabinda' : nomeRegiao(pv.regiao_id)); };
  if ($('#pdfNA', md)) $('#pdfNA', md).onclick = () => pdf(true);
  if ($('#pdfR', md)) $('#pdfR', md).onclick = () => pdf(false);
}
function lancarNotasUI(pv, res) {
  const md = modal(`<h3>Notas · ${esc(pv.titulo)}</h3><p class="dica">Nota de 0 a 100 (mínima ${pv.nota_minima}). Deixe vazio quem ainda não fez. Marque "F" para quem faltou.</p>
    <input type="search" id="qN" placeholder="Procurar…" style="margin-bottom:8px">
    <div class="notas">${res.map(r => `<div class="ln" data-m="${r.membro_id}"><span>${esc(r.nome)}<small>${esc(r.clube)}</small></span>
      <input type="number" min="0" max="100" inputmode="numeric" value="${r.nota ?? ''}"><label class="f"><input type="checkbox" ${r.resultado === 'Faltou' ? 'checked' : ''}> F</label><b class="rs"></b></div>`).join('')}</div>
    <div class="accoes"><button class="btn sec" data-fechar>Cancelar</button><button class="btn" id="gravar">Guardar notas</button></div>`);
  const upd = (ln) => { const v = $('input[type=number]', ln).value, f = $('input[type=checkbox]', ln).checked, rs = $('.rs', ln);
    rs.textContent = f ? 'Faltou' : v === '' ? '' : +v >= pv.nota_minima ? 'Apto' : 'Não apto'; rs.className = 'rs ' + (rs.textContent === 'Apto' ? 'ok' : rs.textContent === 'Não apto' ? 'nao' : ''); };
  $$('.ln', md).forEach(ln => { upd(ln); $$('input', ln).forEach(i => i.addEventListener('input', () => upd(ln))); });
  $('#qN', md).oninput = (e) => { const q = semAcento(e.target.value); $$('.ln', md).forEach(ln => ln.hidden = q && !semAcento(ln.textContent).includes(q)); };
  $('#gravar', md).onclick = (e) => ocupado(e.target, async () => {
    const notas = $$('.ln', md).map(ln => ({ membro_id: ln.dataset.m, nota: $('input[type=number]', ln).value, falta: $('input[type=checkbox]', ln).checked }));
    await api('lancarNotas', { prova_id: pv.id, notas }); md.remove(); aviso('Notas guardadas.'); verProva(pv.id);
  });
}

arrancar();
