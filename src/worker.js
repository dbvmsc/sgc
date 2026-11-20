// SGC Desbravadores MSC — servidor (Cloudflare Worker + D1)
// Fase 1: instalação, login, regiões, clubes, unidades, membros, utilizadores, painel.

const VERSAO = '1.7.0';
const SESSAO_DIAS = 30;
const PBKDF2_ITER = 10000;
const MAX_TENTATIVAS = 5;
const BLOQUEIO_MIN = 15;
const PAPEIS = ['MSC', 'REGIONAL', 'DIRECTOR'];
const TIPOS_MEMBRO = ['Desbravador', 'Líder', 'Conselheiro', 'Instrutor', 'Director', 'Director associado', 'Secretário', 'Tesoureiro', 'Capelão'];
const CAMPOS_MEMBRO = ['tipo', 'nome', 'sexo', 'data_nasc', 'unidade_id', 'cargo', 'baptizado', 'contacto', 'encarregado_nome',
  'encarregado_contacto', 'autorizacao_pais', 'activo', 'data_entrada', 'obs'];
const CAMPOS_CLUBE = ['nome', 'igreja', 'distrito', 'regiao_id', 'director', 'contacto', 'data_fundacao', 'activo'];

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === '/api/ping') return json({ ok: true, versao: VERSAO });
    if (url.pathname === '/api' && req.method === 'POST') return tratarApi(req, env, ctx);
    if (url.pathname.startsWith('/api')) return json({ ok: false, erro: 'Pedido inválido.' }, 404);
    return env.ASSETS.fetch(req);
  },
  // Corre todos os dias (ver "triggers" no wrangler.jsonc): encaminha para a Missão as solicitações que a região não tratou em 14 dias.
  async scheduled(evt, env, ctx) { ctx.waitUntil(escalarSolicitacoes(env).then(() => lembretesDiarios(env)).then(() => processarPush(env))); }
};

/* ---------------- infra ---------------- */

class ErroSGC extends Error {}
const falha = (m) => { throw new ErroSGC(m); };
const exigir = (c, m) => { if (!c) falha(m || 'Sem permissão para esta acção.'); };

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
  });
}
const agora = () => new Date().toISOString();
const novoId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 12);
/** INSERT com várias linhas por instrução (D1: máx. 100 parâmetros por consulta). */
function inserirVarios(env, tabela, cols, rows, modo = 'INSERT') {
  const porSt = Math.max(1, Math.floor(100 / cols.length)); const out = [];
  for (let i = 0; i < rows.length; i += porSt) {
    const parte = rows.slice(i, i + porSt);
    const ph = parte.map(() => '(' + cols.map(() => '?').join(',') + ')').join(',');
    out.push(env.DB.prepare(`${modo} INTO ${tabela} (${cols.join(',')}) VALUES ${ph}`).bind(...parte.flat()));
  }
  return out;
}
const txt = (v, max = 500) => (v === undefined || v === null) ? null : String(v).trim().slice(0, max) || null;
const bool = (v) => (v === true || v === 1 || v === '1' || v === 'Sim' || v === 'true') ? 1 : 0;
const hex = (buf) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const limparEmail = (e) => String(e || '').trim().toLowerCase();

async function sha256(s) { return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))); }
async function hashSenha(senha, salt) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(senha), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: PBKDF2_ITER }, k, 256);
  return hex(bits);
}
function igual(a, b) { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }
function validarSenha(s) { exigir(typeof s === 'string' && s.length >= 8, 'A palavra-passe deve ter pelo menos 8 caracteres.'); }

async function auditar(env, u, accao, tabela, id, detalhe) {
  await env.DB.prepare('INSERT INTO auditoria (data,email,accao,tabela,registo_id,detalhe) VALUES (?,?,?,?,?,?)')
    .bind(agora(), u ? u.email : null, accao, tabela, id, detalhe ? String(detalhe).slice(0, 500) : null).run();
}

/* ---------------- sessão ---------------- */

async function criarSessao(env, email) {
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  const exp = new Date(Date.now() + SESSAO_DIAS * 864e5).toISOString();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessoes WHERE expira_em < ?').bind(agora()),
    env.DB.prepare('INSERT INTO sessoes (token,email,expira_em) VALUES (?,?,?)').bind(await sha256(token), email, exp),
    env.DB.prepare('UPDATE utilizadores SET ultimo_acesso=?, tentativas=0, bloqueado_ate=NULL WHERE email=?').bind(agora(), email)
  ]);
  return token;
}
async function utilizadorDaSessao(env, req) {
  const h = req.headers.get('authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const u = await env.DB.prepare(`SELECT u.email,u.nome,u.papel,u.regiao_id,u.clube_id,u.notif_visto,s.token AS sessao,
      COALESCE((SELECT c.regiao_id FROM clubes c WHERE c.id=u.clube_id), u.regiao_id) AS reg FROM sessoes s
    JOIN utilizadores u ON u.email=s.email WHERE s.token=? AND s.expira_em>? AND u.activo=1`).bind(await sha256(token), agora()).first();
  return u || null;
}
const publico = (u) => ({ email: u.email, nome: u.nome, papel: u.papel, regiao_id: u.regiao_id, clube_id: u.clube_id });

/* ---------------- permissões ---------------- */

function filtroClubes(u, alias = 'c') {
  if (u.papel === 'MSC') return { sql: '1=1', args: [] };
  if (u.papel === 'REGIONAL') return { sql: `${alias}.regiao_id=?`, args: [u.regiao_id] };
  return { sql: `${alias}.id=?`, args: [u.clube_id] };
}
async function exigirClube(env, u, clubeId) {
  exigir(clubeId, 'Escolha o clube.');
  const c = await env.DB.prepare('SELECT * FROM clubes WHERE id=?').bind(clubeId).first();
  exigir(c, 'Clube não encontrado.');
  if (u.papel === 'MSC') return c;
  if (u.papel === 'REGIONAL') { exigir(c.regiao_id === u.regiao_id); return c; }
  exigir(c.id === u.clube_id); return c;
}

/* ---------------- router ---------------- */

const SEM_SESSAO = { estado, instalar, login, pedirCodigo, reporSenha };
const ACCOES = {
  sair, inicio, painel, mudarSenha,
  membros, guardarMembro, apagarMembro, importarMembros,
  guardarUnidade, apagarUnidade,
  guardarClube, guardarRegiao,
  utilizadores, guardarUtilizador,
  requisitos, classes, cartaoClasse, inscreverClasses, guardarClasse, apagarClasse, marcarRequisito, marcarRequisitoTurma,
  especialidades, guardarEspecialidade, apagarEspecialidade,
  actividades, actividade, guardarActividade, apagarActividade,
  criterios, guardarCriterio, apagarCriterio, lancarPontos, apagarPonto, ranking,
  relatorio, guardarRelatorio, reabrirRelatorio, estadoRelatorios, trimestral,
  movimentos, guardarMovimento, anularMovimento, resumoFinancas,
  pagamentos, registarPagamentos, apagarPagamento,
  eventos, guardarEvento, apagarEvento, inscricoesEvento, definirInscricoes, resumoEvento,
  fichaClube,
  notificacoes, marcarLidas,
  comunicados, publicarComunicado, lerComunicado, arquivarComunicado, quemLeu,
  transferencias, clubesDestino, pedirTransferencia, decidirTransferencia,
  solicitacoes, criarSolicitacao, decidirSolicitacao,
  pushChave, registarPush, removerPush, configEmail, guardarConfigEmail, testarEmail,
  fichaMembro, cartoesMembros, passagemAno, inscreverClassesLista, classificacao,
  agenda, guardarAgenda, apagarAgenda, aniversarios,
  escalas, guardarEscala, apagarEscala, pessoasEscala,
  infoExportacao, exportarTabela,
  emRisco, plano, guardarPlano, apagarPlano, copiarPlano,
  inspecoes, guardarInspecao, itensInspecao,
  provas, guardarProva, candidatosProva, inscreverProva, lancarNotas, fecharProva, resultadosProva,
  mapaClubes, guardarLocalizacao,
  delegados, guardarDelegado, apagarDelegado, importarLideres, proporEscalaMassa, confirmarEscalaMassa
};

async function tratarApi(req, env, ctx) {
  let corpo;
  try { corpo = await req.json(); } catch (e) { return json({ ok: false, erro: 'Pedido inválido.' }, 400); }
  const accao = String(corpo.accao || ''); const p = corpo.p || {};
  try {
    if (SEM_SESSAO[accao]) return json({ ok: true, dados: await SEM_SESSAO[accao](env, p, req) });
    const fn = ACCOES[accao];
    if (!fn) return json({ ok: false, erro: 'Acção desconhecida.' }, 400);
    const u = await utilizadorDaSessao(env, req);
    if (!u) return json({ ok: false, erro: 'Sessão terminada. Entre novamente.', sessao: false }, 401);
    const dados = await fn(env, u, p);
    if (ctx && !accao.match(/^(inicio|painel|notificacoes|membros|classes|ranking|classificacao|ficha)/)) ctx.waitUntil(processarPush(env).catch(e => console.error('push', e)));
    return json({ ok: true, dados });
  } catch (e) {
    if (e instanceof ErroSGC) return json({ ok: false, erro: e.message });
    console.error(accao, e && e.stack || e);
    const m = String(e && e.message || '');
    if (m.includes('UNIQUE')) return json({ ok: false, erro: 'Já existe um registo igual.' });
    return json({ ok: false, erro: 'Erro no servidor. Tente de novo.' }, 500);
  }
}

/* ---------------- instalação e login ---------------- */

async function estado(env) {
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM utilizadores').first('n');
  return { instalado: n > 0, versao: VERSAO };
}
async function instalar(env, p) {
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM utilizadores').first('n');
  exigir(n === 0, 'O SGC já está instalado.');
  const email = limparEmail(p.email);
  exigir(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email), 'Email inválido.');
  exigir(txt(p.nome), 'Indique o nome.');
  validarSenha(p.senha);
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  await env.DB.prepare('INSERT INTO utilizadores (email,nome,papel,hash,salt,activo) VALUES (?,?,?,?,?,1)')
    .bind(email, txt(p.nome, 120), 'MSC', await hashSenha(p.senha, salt), salt).run();
  await auditar(env, { email }, 'instalar', 'utilizadores', email);
  const token = await criarSessao(env, email);
  return { token };
}
async function login(env, p) {
  const email = limparEmail(p.email);
  const u = await env.DB.prepare('SELECT * FROM utilizadores WHERE email=?').bind(email).first();
  const erro = 'Email ou palavra-passe incorrectos.';
  if (!u || !u.activo) { await hashSenha(String(p.senha || ''), 'x'); falha(erro); }
  if (u.bloqueado_ate && u.bloqueado_ate > agora()) falha('Conta bloqueada por tentativas falhadas. Tente daqui a ' + BLOQUEIO_MIN + ' minutos.');
  const h = await hashSenha(String(p.senha || ''), u.salt);
  if (!igual(h, u.hash)) {
    const t = (u.tentativas || 0) + 1;
    const bloq = t >= MAX_TENTATIVAS ? new Date(Date.now() + BLOQUEIO_MIN * 6e4).toISOString() : null;
    await env.DB.prepare('UPDATE utilizadores SET tentativas=?, bloqueado_ate=? WHERE email=?').bind(bloq ? 0 : t, bloq, email).run();
    falha(erro);
  }
  return { token: await criarSessao(env, email) };
}
async function sair(env, u) { await env.DB.prepare('DELETE FROM sessoes WHERE token=?').bind(u.sessao).run(); return true; }
async function mudarSenha(env, u, p) {
  const r = await env.DB.prepare('SELECT hash,salt FROM utilizadores WHERE email=?').bind(u.email).first();
  exigir(igual(await hashSenha(String(p.actual || ''), r.salt), r.hash), 'A palavra-passe actual não está correcta.');
  validarSenha(p.nova);
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  await env.DB.batch([
    env.DB.prepare('UPDATE utilizadores SET hash=?, salt=? WHERE email=?').bind(await hashSenha(p.nova, salt), salt, u.email),
    env.DB.prepare('DELETE FROM sessoes WHERE email=? AND token<>?').bind(u.email, u.sessao)
  ]);
  await auditar(env, u, 'mudarSenha', 'utilizadores', u.email);
  return true;
}

/* ---------------- início e painel ---------------- */

async function inicio(env, u) {
  const f = filtroClubes(u);
  const [reg, clu] = await env.DB.batch([
    env.DB.prepare('SELECT id,nome,sigla,activo FROM regioes ORDER BY nome'),
    env.DB.prepare(`SELECT c.*, (SELECT COUNT(*) FROM membros m WHERE m.clube_id=c.id AND m.activo=1) AS membros
      FROM clubes c WHERE ${f.sql} ORDER BY c.nome`).bind(...f.args)
  ]);
  return { eu: publico(u), regioes: reg.results, clubes: clu.results, versao: VERSAO };
}

async function painel(env, u, p) {
  // Âmbito: o que o utilizador pode ver, opcionalmente reduzido a uma região (MSC) ou a um clube.
  const f = filtroClubes(u);
  let sql = `c.activo=1 AND ${f.sql}`, args = [...f.args];
  if (p.clube_id) { await exigirClube(env, u, p.clube_id); sql += ' AND c.id=?'; args.push(p.clube_id); }
  else if (p.regiao_id) { exigir(u.papel === 'MSC' || u.regiao_id === p.regiao_id); sql += ' AND c.regiao_id=?'; args.push(p.regiao_id); }
  const hojeS = agora().slice(0, 10);
  const de = reData.test(p.de || '') ? p.de : hojeS.slice(0, 8) + '01';
  const ate = reData.test(p.ate || '') ? p.ate : hojeS;
  const dias = Math.round((Date.parse(ate) - Date.parse(de)) / 864e5) + 1;
  const deAnt = new Date(Date.parse(de) - dias * 864e5).toISOString().slice(0, 10), ateAnt = new Date(Date.parse(de) - 864e5).toISOString().slice(0, 10);
  const ano = Number(ate.slice(0, 4));
  const ini6 = new Date(Date.UTC(Number(ate.slice(0, 4)), Number(ate.slice(5, 7)) - 6, 1)).toISOString().slice(0, 10);
  const mesAnt = new Date(Date.UTC(Number(hojeS.slice(0, 4)), Number(hojeS.slice(5, 7)) - 2, 1));
  const W = `FROM membros m JOIN clubes c ON c.id=m.clube_id WHERE m.activo=1 AND ${sql}`;
  const A = `FROM actividades a JOIN clubes c ON c.id=a.clube_id WHERE ${sql}`;
  const q = (t, ...x) => env.DB.prepare(t).bind(...x);
  const r = await env.DB.batch([
    q(`SELECT COUNT(*) AS clubes, COUNT(DISTINCT c.regiao_id) AS regioes FROM clubes c WHERE ${sql}`, ...args),
    q(`SELECT COUNT(*) AS total, SUM(m.tipo='Desbravador') AS desb, SUM(m.tipo='Desbravador' AND m.sexo='M') AS dm, SUM(m.tipo='Desbravador' AND m.sexo='F') AS df,
        SUM(m.tipo='Desbravador' AND (m.unidade_id IS NULL OR m.unidade_id='')) AS sem_unid, SUM(m.baptizado='Sim') AS baptizados ${W}`, ...args),
    q(`SELECT CASE WHEN m.data_nasc IS NULL THEN 'Sem data' ELSE MIN(MAX(?-CAST(substr(m.data_nasc,1,4) AS INT),9),16) END AS k, COUNT(*) AS n ${W} AND m.tipo='Desbravador' GROUP BY 1`, ano, ...args),
    q(`SELECT COUNT(DISTINCT a.id) AS act, SUM(x.estado='P') AS p, COUNT(x.estado) AS t, COUNT(DISTINCT CASE WHEN a.tipo='Actividade missionária' THEN a.id END) AS mis ${A.replace('WHERE', 'LEFT JOIN presencas x ON x.actividade_id=a.id WHERE')} AND a.data BETWEEN ? AND ?`, ...args, de, ate),
    q(`SELECT COUNT(DISTINCT a.id) AS act, SUM(x.estado='P') AS p, COUNT(x.estado) AS t ${A.replace('WHERE', 'LEFT JOIN presencas x ON x.actividade_id=a.id WHERE')} AND a.data BETWEEN ? AND ?`, ...args, deAnt, ateAnt),
    q(`SELECT substr(a.data,1,7) AS mes, COUNT(DISTINCT a.id) AS act, SUM(x.estado='P') AS p, COUNT(x.estado) AS t ${A.replace('WHERE', 'LEFT JOIN presencas x ON x.actividade_id=a.id WHERE')} AND a.data BETWEEN ? AND ? GROUP BY 1 ORDER BY 1`, ...args, ini6, ate),
    q(`SELECT COALESCE(a.pilar,'—') AS k, COUNT(*) AS n ${A} AND a.data BETWEEN ? AND ? GROUP BY 1`, ...args, de, ate),
    q(`SELECT k.classe, k.estado, COUNT(*) AS n FROM classes k JOIN clubes c ON c.id=k.clube_id WHERE k.ano=? AND ${sql} GROUP BY 1,2`, ano, ...args),
    q(`SELECT COUNT(DISTINCT pg.membro_id) AS n FROM pagamentos pg JOIN membros m ON m.id=pg.membro_id JOIN clubes c ON c.id=pg.clube_id WHERE pg.tipo='Seguro anual' AND pg.ano=? AND m.activo=1 AND ${sql}`, ano, ...args),
    q(`SELECT COUNT(*) AS n FROM relatorios r JOIN clubes c ON c.id=r.clube_id WHERE r.ano=? AND r.mes=? AND r.estado='Enviado' AND ${sql}`, mesAnt.getUTCFullYear(), mesAnt.getUTCMonth() + 1, ...args),
    q(`SELECT COUNT(*) AS n FROM especialidades e JOIN clubes c ON c.id=e.clube_id WHERE e.data_conclusao BETWEEN ? AND ? AND ${sql}`, de, ate, ...args),
    q(`SELECT c.id, c.nome, c.regiao_id, (SELECT COUNT(*) FROM membros m WHERE m.clube_id=c.id AND m.activo=1) AS membros,
        (SELECT ROUND(100.0*SUM(x.estado='P')/COUNT(*)) FROM presencas x JOIN actividades a ON a.id=x.actividade_id WHERE a.clube_id=c.id AND a.data BETWEEN ? AND ?) AS assiduidade,
        (SELECT COUNT(*) FROM actividades a WHERE a.clube_id=c.id AND a.data BETWEEN ? AND ?) AS actividades,
        (SELECT estado FROM relatorios r WHERE r.clube_id=c.id AND r.ano=? AND r.mes=?) AS relatorio
      FROM clubes c WHERE ${sql} ORDER BY membros DESC, c.nome LIMIT 300`, de, ate, de, ate, mesAnt.getUTCFullYear(), mesAnt.getUTCMonth() + 1, ...args)
  ]);
  const um = (i) => r[i].results[0] || {};
  const pct = (x) => x && x.t ? Math.round((x.p || 0) / x.t * 100) : null;
  const clubes = r[11].results;
  const porRegiao = {};
  for (const c of clubes) { const g = porRegiao[c.regiao_id] = porRegiao[c.regiao_id] || { regiao_id: c.regiao_id, clubes: 0, membros: 0 }; g.clubes++; g.membros += c.membros; }
  return {
    periodo: { de, ate, deAnt, ateAnt, ano, mes_relatorio: [mesAnt.getUTCFullYear(), mesAnt.getUTCMonth() + 1] },
    clubes: um(0).clubes || 0, regioes: um(0).regioes || 0,
    membros: { total: um(1).total || 0, desbravadores: um(1).desb || 0, masculino: um(1).dm || 0, feminino: um(1).df || 0, sem_unidade: um(1).sem_unid || 0, baptizados: um(1).baptizados || 0 },
    idades: r[2].results,
    actividades: um(3).act || 0, assiduidade: pct(um(3)), missionarias: um(3).mis || 0,
    anterior: { actividades: um(4).act || 0, assiduidade: pct(um(4)) },
    mensal: r[5].results.map(x => ({ mes: x.mes, actividades: x.act, assiduidade: pct(x) })),
    pilares: r[6].results, classes: r[7].results, seguro: um(8).n || 0, relatorios_enviados: um(9).n || 0, especialidades: um(10).n || 0,
    por_clube: clubes, por_regiao: Object.values(porRegiao).sort((a, b) => b.membros - a.membros)
  };
}

/* ---------------- membros e unidades ---------------- */

async function membros(env, u, p) {
  await exigirClube(env, u, p.clube_id);
  const [m, un] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM membros WHERE clube_id=? ORDER BY activo DESC, nome').bind(p.clube_id),
    env.DB.prepare('SELECT * FROM unidades WHERE clube_id=? ORDER BY nome').bind(p.clube_id)
  ]);
  return { membros: m.results, unidades: un.results };
}

function lerMembro(r) {
  const o = {};
  for (const k of CAMPOS_MEMBRO) o[k] = k === 'activo' ? bool(r[k] === undefined ? 1 : r[k]) : txt(r[k], k === 'obs' ? 1000 : 200);
  exigir(o.nome, 'Indique o nome do membro.');
  exigir(!o.tipo || TIPOS_MEMBRO.includes(o.tipo), 'Tipo de membro inválido.');
  exigir(!o.sexo || ['M', 'F'].includes(o.sexo), 'Sexo inválido.');
  for (const d of ['data_nasc', 'data_entrada']) exigir(!o[d] || /^\d{4}-\d{2}-\d{2}$/.test(o[d]), 'Data inválida (use AAAA-MM-DD).');
  return o;
}

async function guardarMembro(env, u, p) {
  const r = p.registo || {};
  const o = lerMembro(r);
  if (r.id) {
    const actual = await env.DB.prepare('SELECT clube_id FROM membros WHERE id=?').bind(r.id).first();
    exigir(actual, 'Membro não encontrado.');
    await exigirClube(env, u, actual.clube_id);
    if (o.unidade_id) exigir(await env.DB.prepare('SELECT 1 FROM unidades WHERE id=? AND clube_id=?').bind(o.unidade_id, actual.clube_id).first(), 'Unidade inválida.');
    const sets = CAMPOS_MEMBRO.map(k => k + '=?').join(',');
    await env.DB.prepare(`UPDATE membros SET ${sets}, actualizado_em=? WHERE id=?`).bind(...CAMPOS_MEMBRO.map(k => o[k]), agora(), r.id).run();
    await auditar(env, u, 'editar', 'membros', r.id, o.nome);
    return { id: r.id };
  }
  await exigirClube(env, u, r.clube_id);
  if (o.unidade_id) exigir(await env.DB.prepare('SELECT 1 FROM unidades WHERE id=? AND clube_id=?').bind(o.unidade_id, r.clube_id).first(), 'Unidade inválida.');
  const id = novoId();
  await env.DB.prepare(`INSERT INTO membros (id,clube_id,${CAMPOS_MEMBRO.join(',')},criado_em) VALUES (?,?,${CAMPOS_MEMBRO.map(() => '?').join(',')},?)`)
    .bind(id, r.clube_id, ...CAMPOS_MEMBRO.map(k => o[k]), agora()).run();
  await auditar(env, u, 'criar', 'membros', id, o.nome);
  return { id };
}

async function apagarMembro(env, u, p) {
  const m = await env.DB.prepare('SELECT clube_id,nome FROM membros WHERE id=?').bind(p.id).first();
  exigir(m, 'Membro não encontrado.');
  await exigirClube(env, u, m.clube_id);
  const ligado = await env.DB.prepare(`SELECT (SELECT COUNT(*) FROM classes WHERE membro_id=?)+(SELECT COUNT(*) FROM especialidades WHERE membro_id=?)
    +(SELECT COUNT(*) FROM presencas WHERE membro_id=?)+(SELECT COUNT(*) FROM pontos WHERE membro_id=?) AS n`).bind(p.id, p.id, p.id, p.id).first('n');
  if (ligado > 0) {
    await env.DB.prepare('UPDATE membros SET activo=0, actualizado_em=? WHERE id=?').bind(agora(), p.id).run();
    await auditar(env, u, 'desactivar', 'membros', p.id, m.nome);
    return { desactivado: true };
  }
  await env.DB.prepare('DELETE FROM membros WHERE id=?').bind(p.id).run();
  await auditar(env, u, 'apagar', 'membros', p.id, m.nome);
  return { apagado: true };
}

async function importarMembros(env, u, p) {
  await exigirClube(env, u, p.clube_id);
  const linhas = Array.isArray(p.linhas) ? p.linhas.slice(0, 240) : [];
  exigir(linhas.length, 'Não há linhas para importar.');
  const unidades = (await env.DB.prepare('SELECT id,nome FROM unidades WHERE clube_id=?').bind(p.clube_id).all()).results;
  const porNome = Object.fromEntries(unidades.map(x => [x.nome.toLowerCase(), x.id]));
  const erros = []; const rows = []; const t = agora();
  linhas.forEach((r, i) => {
    try {
      if (r.unidade && !r.unidade_id) r.unidade_id = porNome[String(r.unidade).trim().toLowerCase()] || null;
      const o = lerMembro(r);
      rows.push([novoId(), p.clube_id, ...CAMPOS_MEMBRO.map(k => o[k]), t]);
    } catch (e) { erros.push({ linha: (p.inicio || 0) + i + 2, erro: e.message }); }
  });
  const st = inserirVarios(env, 'membros', ['id', 'clube_id', ...CAMPOS_MEMBRO, 'criado_em'], rows);
  if (st.length) await env.DB.batch(st);
  await auditar(env, u, 'importar', 'membros', p.clube_id, rows.length + ' membros');
  return { importados: rows.length, erros };
}

async function guardarUnidade(env, u, p) {
  const r = p.registo || {};
  exigir(txt(r.nome), 'Indique o nome da unidade.');
  if (r.id) {
    const a = await env.DB.prepare('SELECT clube_id FROM unidades WHERE id=?').bind(r.id).first();
    exigir(a, 'Unidade não encontrada.'); await exigirClube(env, u, a.clube_id);
    await env.DB.prepare('UPDATE unidades SET nome=?, sexo=?, conselheiro=? WHERE id=?').bind(txt(r.nome, 80), txt(r.sexo, 10), txt(r.conselheiro, 120), r.id).run();
    return { id: r.id };
  }
  await exigirClube(env, u, r.clube_id);
  const id = novoId();
  await env.DB.prepare('INSERT INTO unidades (id,clube_id,nome,sexo,conselheiro) VALUES (?,?,?,?,?)').bind(id, r.clube_id, txt(r.nome, 80), txt(r.sexo, 10), txt(r.conselheiro, 120)).run();
  await auditar(env, u, 'criar', 'unidades', id, r.nome);
  return { id };
}
async function apagarUnidade(env, u, p) {
  const a = await env.DB.prepare('SELECT clube_id FROM unidades WHERE id=?').bind(p.id).first();
  exigir(a, 'Unidade não encontrada.'); await exigirClube(env, u, a.clube_id);
  await env.DB.batch([
    env.DB.prepare('UPDATE membros SET unidade_id=NULL WHERE unidade_id=?').bind(p.id),
    env.DB.prepare('DELETE FROM unidades WHERE id=?').bind(p.id)
  ]);
  await auditar(env, u, 'apagar', 'unidades', p.id);
  return true;
}

/* ---------------- clubes e regiões ---------------- */

async function guardarClube(env, u, p) {
  const r = p.registo || {};
  const o = {};
  for (const k of CAMPOS_CLUBE) o[k] = k === 'activo' ? bool(r[k] === undefined ? 1 : r[k]) : txt(r[k], 160);
  exigir(o.nome, 'Indique o nome do clube.');
  exigir(!o.data_fundacao || /^\d{4}-\d{2}-\d{2}$/.test(o.data_fundacao), 'Data inválida (use AAAA-MM-DD).');
  if (r.id) {
    const c = await exigirClube(env, u, r.id);
    if (u.papel === 'DIRECTOR') { o.regiao_id = c.regiao_id; o.activo = c.activo; }
    if (u.papel === 'REGIONAL') o.regiao_id = u.regiao_id;
    exigir(o.regiao_id && await env.DB.prepare('SELECT 1 FROM regioes WHERE id=?').bind(o.regiao_id).first(), 'Escolha a região.');
    await env.DB.prepare(`UPDATE clubes SET ${CAMPOS_CLUBE.map(k => k + '=?').join(',')} WHERE id=?`).bind(...CAMPOS_CLUBE.map(k => o[k]), r.id).run();
    await auditar(env, u, 'editar', 'clubes', r.id, o.nome);
    return { id: r.id };
  }
  exigir(u.papel !== 'DIRECTOR');
  if (u.papel === 'REGIONAL') o.regiao_id = u.regiao_id;
  exigir(o.regiao_id && await env.DB.prepare('SELECT 1 FROM regioes WHERE id=?').bind(o.regiao_id).first(), 'Escolha a região.');
  const id = novoId();
  await env.DB.prepare(`INSERT INTO clubes (id,${CAMPOS_CLUBE.join(',')},criado_em) VALUES (?,${CAMPOS_CLUBE.map(() => '?').join(',')},?)`)
    .bind(id, ...CAMPOS_CLUBE.map(k => o[k]), agora()).run();
  await auditar(env, u, 'criar', 'clubes', id, o.nome);
  return { id };
}

async function guardarRegiao(env, u, p) {
  exigir(u.papel === 'MSC');
  const r = p.registo || {};
  exigir(txt(r.nome), 'Indique o nome da região.');
  const id = r.id || novoId();
  await env.DB.prepare('INSERT INTO regioes (id,nome,sigla,activo) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET nome=excluded.nome, sigla=excluded.sigla, activo=excluded.activo')
    .bind(id, txt(r.nome, 120), txt(r.sigla, 12), bool(r.activo === undefined ? 1 : r.activo)).run();
  await auditar(env, u, r.id ? 'editar' : 'criar', 'regioes', id, r.nome);
  return { id };
}

/* ---------------- utilizadores ---------------- */

async function utilizadores(env, u) {
  exigir(u.papel !== 'DIRECTOR');
  const sql = 'SELECT email,nome,papel,regiao_id,clube_id,activo,ultimo_acesso FROM utilizadores';
  const r = u.papel === 'MSC'
    ? await env.DB.prepare(sql + ' ORDER BY papel, nome').all()
    : await env.DB.prepare(sql + ` WHERE email=? OR (papel='DIRECTOR' AND clube_id IN (SELECT id FROM clubes WHERE regiao_id=?)) ORDER BY papel, nome`).bind(u.email, u.regiao_id).all();
  return r.results;
}

async function guardarUtilizador(env, u, p) {
  exigir(u.papel !== 'DIRECTOR');
  const r = p.registo || {};
  const email = limparEmail(r.email);
  exigir(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email), 'Email inválido.');
  exigir(txt(r.nome), 'Indique o nome.');
  exigir(PAPEIS.includes(r.papel), 'Papel inválido.');
  const o = { nome: txt(r.nome, 120), papel: r.papel, regiao_id: null, clube_id: null, activo: bool(r.activo === undefined ? 1 : r.activo) };
  if (o.papel === 'REGIONAL') { o.regiao_id = txt(r.regiao_id, 40); exigir(o.regiao_id && await env.DB.prepare('SELECT 1 FROM regioes WHERE id=?').bind(o.regiao_id).first(), 'Escolha a região.'); }
  if (o.papel === 'DIRECTOR') { const c = await exigirClube(env, u, txt(r.clube_id, 40)); o.clube_id = c.id; o.regiao_id = c.regiao_id; }
  if (u.papel === 'REGIONAL') exigir(o.papel === 'DIRECTOR', 'Um regional só pode gerir utilizadores de clubes da sua região.');
  const existente = await env.DB.prepare('SELECT * FROM utilizadores WHERE email=?').bind(email).first();
  if (existente && u.papel === 'REGIONAL') exigir(existente.papel === 'DIRECTOR' && existente.regiao_id === u.regiao_id);
  if (existente && email === u.email) exigir(o.papel === u.papel && o.activo, 'Não pode alterar o seu próprio papel nem desactivar-se.');
  const stmts = [];
  if (existente) {
    stmts.push(env.DB.prepare('UPDATE utilizadores SET nome=?, papel=?, regiao_id=?, clube_id=?, activo=? WHERE email=?').bind(o.nome, o.papel, o.regiao_id, o.clube_id, o.activo, email));
    if (!o.activo) stmts.push(env.DB.prepare('DELETE FROM sessoes WHERE email=?').bind(email));
  } else {
    validarSenha(r.senha);
    const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
    stmts.push(env.DB.prepare('INSERT INTO utilizadores (email,nome,papel,regiao_id,clube_id,hash,salt,activo) VALUES (?,?,?,?,?,?,?,?)')
      .bind(email, o.nome, o.papel, o.regiao_id, o.clube_id, await hashSenha(r.senha, salt), salt, o.activo));
  }
  if (existente && r.senha) {
    validarSenha(r.senha);
    const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
    stmts.push(env.DB.prepare('UPDATE utilizadores SET hash=?, salt=?, tentativas=0, bloqueado_ate=NULL WHERE email=?').bind(await hashSenha(r.senha, salt), salt, email));
    stmts.push(env.DB.prepare('DELETE FROM sessoes WHERE email=?').bind(email));
  }
  await env.DB.batch(stmts);
  await auditar(env, u, existente ? 'editar' : 'criar', 'utilizadores', email, o.papel);
  return { email };
}

/* ======================= FASE 2 ======================= */

const CLASSES = ['Amigo', 'Companheiro', 'Pesquisador', 'Pioneiro', 'Excursionista', 'Guia'];
const IDADE_CLASSE = { Amigo: 10, Companheiro: 11, Pesquisador: 12, Pioneiro: 13, Excursionista: 14, Guia: 15 };
const ESTADOS_CLASSE = ['Inscrito', 'Em curso', 'Concluído', 'Investido'];
const TIPOS_ACT = ['Reunião regular', 'Classe bíblica', 'Actividade missionária', 'Acampamento / Saída', 'Evento', 'Outro'];
const PILARES = ['Espiritual', 'Físico', 'Mental', 'Social'];
const CAT_ESP = ['ADRA', 'Actividades agrícolas', 'Actividades missionárias e comunitárias', 'Actividades profissionais', 'Actividades recreativas',
  'Artes e habilidades manuais', 'Ciência e saúde', 'Estudo da natureza', 'Habilidades domésticas'];
const reData = /^\d{4}-\d{2}-\d{2}$/;
const reIdCliente = /^[0-9a-f]{12}$/;

function classePorIdade(dataNasc, ano) {
  if (!dataNasc) return null;
  const idade = ano - Number(dataNasc.slice(0, 4));
  let c = null; for (const k of CLASSES) if (idade >= IDADE_CLASSE[k]) c = k;
  return c;
}
async function membrosDoClube(env, clubeId, ids) {
  exigir(Array.isArray(ids) && ids.length, 'Escolha pelo menos um membro.');
  exigir(ids.length <= 300, 'Demasiados membros de uma vez.');
  const r = await env.DB.prepare(`SELECT id,nome,data_nasc FROM membros WHERE clube_id=? AND id IN (SELECT value FROM json_each(?))`).bind(clubeId, JSON.stringify(ids)).all();
  exigir(r.results.length === new Set(ids).size, 'Há membros que não pertencem a este clube.');
  return r.results;
}
async function exigirClasse(env, u, classeId) {
  const c = await env.DB.prepare('SELECT * FROM classes WHERE id=?').bind(classeId).first();
  exigir(c, 'Inscrição não encontrada.'); await exigirClube(env, u, c.clube_id); return c;
}

/* ---- classes e requisitos ---- */

async function requisitos(env) {
  return (await env.DB.prepare('SELECT id,classe,seccao,pilar,avancado,ordem,codigo,descricao FROM requisitos WHERE activo=1 ORDER BY classe, avancado, ordem').all()).results;
}

async function classes(env, u, p) {
  await exigirClube(env, u, p.clube_id);
  const ano = Number(p.ano) || new Date().getFullYear();
  const r = await env.DB.prepare(`SELECT c.*, m.nome, m.sexo, m.data_nasc, m.unidade_id,
      (SELECT COUNT(*) FROM cumprimentos x JOIN requisitos q ON q.id=x.requisito_id WHERE x.classe_id=c.id AND q.avancado=0) AS feitos,
      (SELECT COUNT(*) FROM cumprimentos x JOIN requisitos q ON q.id=x.requisito_id WHERE x.classe_id=c.id AND q.avancado=1) AS feitos_av
    FROM classes c JOIN membros m ON m.id=c.membro_id WHERE c.clube_id=? AND c.ano=? ORDER BY m.nome`).bind(p.clube_id, ano).all();
  const tot = (await env.DB.prepare('SELECT classe, avancado, COUNT(*) AS n FROM requisitos WHERE activo=1 GROUP BY classe, avancado').all()).results;
  const totais = {};
  for (const t of tot) { totais[t.classe] = totais[t.classe] || { normal: 0, avancado: 0 }; totais[t.classe][t.avancado ? 'avancado' : 'normal'] = t.n; }
  return { ano, inscricoes: r.results, totais };
}

async function cartaoClasse(env, u, p) {
  const c = await exigirClasse(env, u, p.id);
  const feitos = (await env.DB.prepare('SELECT requisito_id, data FROM cumprimentos WHERE classe_id=?').bind(c.id).all()).results;
  return { classe: c, feitos };
}

async function inscreverClasses(env, u, p) {
  await exigirClube(env, u, p.clube_id);
  const ano = Number(p.ano) || new Date().getFullYear();
  exigir(!p.classe || CLASSES.includes(p.classe), 'Classe inválida.');
  const ms = await membrosDoClube(env, p.clube_id, p.membros);
  const rows = []; const sem = [];
  for (const m of ms) {
    const cl = p.classe || classePorIdade(m.data_nasc, ano);
    if (!cl) { sem.push(m.nome); continue; }
    rows.push([novoId(), p.clube_id, m.id, ano, cl, 'Inscrito']);
  }
  const st = inserirVarios(env, 'classes', ['id', 'clube_id', 'membro_id', 'ano', 'classe', 'estado'], rows, 'INSERT OR IGNORE');
  if (st.length) await env.DB.batch(st);
  await auditar(env, u, 'inscrever', 'classes', p.clube_id, rows.length + ' inscrições ' + ano);
  return { inscritos: rows.length, sem_idade: sem };
}

async function guardarClasse(env, u, p) {
  const r = p.registo || {};
  const c = await exigirClasse(env, u, r.id);
  exigir(ESTADOS_CLASSE.includes(r.estado), 'Estado inválido.');
  exigir(CLASSES.includes(r.classe || c.classe), 'Classe inválida.');
  const di = txt(r.data_investidura, 10);
  exigir(!di || reData.test(di), 'Data inválida.');
  exigir(r.estado !== 'Investido' || di, 'Indique a data da investidura.');
  await env.DB.prepare('UPDATE classes SET classe=?, estado=?, data_investidura=?, obs=? WHERE id=?')
    .bind(r.classe || c.classe, r.estado, di, txt(r.obs, 500), c.id).run();
  await auditar(env, u, 'editar', 'classes', c.id, r.estado);
  return { id: c.id };
}

async function apagarClasse(env, u, p) {
  const c = await exigirClasse(env, u, p.id);
  await env.DB.batch([env.DB.prepare('DELETE FROM cumprimentos WHERE classe_id=?').bind(c.id), env.DB.prepare('DELETE FROM classes WHERE id=?').bind(c.id)]);
  await auditar(env, u, 'apagar', 'classes', c.id);
  return true;
}

/** Depois de marcar requisitos: Inscrito → Em curso; todos os normais → Concluído (não mexe em Investido). */
function actualizarEstados(env, ids) {
  return env.DB.prepare(`UPDATE classes SET estado = CASE
      WHEN (SELECT COUNT(*) FROM cumprimentos x JOIN requisitos q ON q.id=x.requisito_id WHERE x.classe_id=classes.id AND q.avancado=0)
         >= (SELECT COUNT(*) FROM requisitos q WHERE q.classe=classes.classe AND q.avancado=0 AND q.activo=1) THEN 'Concluído'
      WHEN (SELECT COUNT(*) FROM cumprimentos x WHERE x.classe_id=classes.id) > 0 THEN 'Em curso'
      ELSE 'Inscrito' END
    WHERE estado<>'Investido' AND id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(ids));
}

async function marcarRequisito(env, u, p) {
  const c = await exigirClasse(env, u, p.classe_id);
  const q = await env.DB.prepare('SELECT classe FROM requisitos WHERE id=?').bind(p.requisito_id).first();
  exigir(q && q.classe === c.classe, 'Requisito não pertence a esta classe.');
  const st = p.feito
    ? env.DB.prepare('INSERT OR REPLACE INTO cumprimentos (classe_id,requisito_id,data,registado_por) VALUES (?,?,?,?)').bind(c.id, p.requisito_id, reData.test(p.data || '') ? p.data : agora().slice(0, 10), u.email)
    : env.DB.prepare('DELETE FROM cumprimentos WHERE classe_id=? AND requisito_id=?').bind(c.id, p.requisito_id);
  await env.DB.batch([st, actualizarEstados(env, [c.id])]);
  const e = await env.DB.prepare('SELECT estado FROM classes WHERE id=?').bind(c.id).first('estado');
  return { estado: e };
}

async function marcarRequisitoTurma(env, u, p) {
  await exigirClube(env, u, p.clube_id);
  const q = await env.DB.prepare('SELECT classe FROM requisitos WHERE id=?').bind(p.requisito_id).first();
  exigir(q, 'Requisito não encontrado.');
  const ids = Array.isArray(p.classes) ? p.classes.slice(0, 300) : [];
  exigir(ids.length, 'Escolha pelo menos um desbravador.');
  const ok = await env.DB.prepare(`SELECT COUNT(*) AS n FROM classes WHERE clube_id=? AND classe=? AND id IN (SELECT value FROM json_each(?))`)
    .bind(p.clube_id, q.classe, JSON.stringify(ids)).first('n');
  exigir(ok === new Set(ids).size, 'Há inscrições que não são desta classe ou deste clube.');
  const data = reData.test(p.data || '') ? p.data : agora().slice(0, 10);
  const st = inserirVarios(env, 'cumprimentos', ['classe_id', 'requisito_id', 'data', 'registado_por'], ids.map(id => [id, p.requisito_id, data, u.email]), 'INSERT OR IGNORE');
  await env.DB.batch([...st, actualizarEstados(env, ids)]);
  await auditar(env, u, 'turma', 'cumprimentos', p.requisito_id, ids.length + ' desbravadores');
  return { marcados: ids.length };
}

/* ---- especialidades ---- */

async function especialidades(env, u, p) {
  await exigirClube(env, u, p.clube_id);
  return (await env.DB.prepare(`SELECT e.*, m.nome FROM especialidades e JOIN membros m ON m.id=e.membro_id WHERE e.clube_id=? ORDER BY e.data_conclusao DESC, m.nome`).bind(p.clube_id).all()).results;
}
async function guardarEspecialidade(env, u, p) {
  const r = p.registo || {};
  const o = { especialidade: txt(r.especialidade, 120), categoria: txt(r.categoria, 80), data_conclusao: txt(r.data_conclusao, 10), instrutor: txt(r.instrutor, 120), obs: txt(r.obs, 500) };
  exigir(o.especialidade, 'Indique a especialidade.');
  exigir(!o.categoria || CAT_ESP.includes(o.categoria), 'Categoria inválida.');
  exigir(!o.data_conclusao || reData.test(o.data_conclusao), 'Data inválida.');
  if (r.id) {
    const a = await env.DB.prepare('SELECT clube_id FROM especialidades WHERE id=?').bind(r.id).first();
    exigir(a, 'Registo não encontrado.'); await exigirClube(env, u, a.clube_id);
    await env.DB.prepare('UPDATE especialidades SET especialidade=?,categoria=?,data_conclusao=?,instrutor=?,obs=? WHERE id=?')
      .bind(o.especialidade, o.categoria, o.data_conclusao, o.instrutor, o.obs, r.id).run();
    return { id: r.id };
  }
  await exigirClube(env, u, r.clube_id);
  const ms = await membrosDoClube(env, r.clube_id, Array.isArray(r.membros) ? r.membros : [r.membro_id]);
  const rows = ms.map(m => [novoId(), r.clube_id, m.id, o.especialidade, o.categoria, o.data_conclusao, o.instrutor, o.obs]);
  await env.DB.batch(inserirVarios(env, 'especialidades', ['id', 'clube_id', 'membro_id', 'especialidade', 'categoria', 'data_conclusao', 'instrutor', 'obs'], rows));
  await auditar(env, u, 'criar', 'especialidades', r.clube_id, o.especialidade + ' × ' + rows.length);
  return { registados: rows.length };
}
async function apagarEspecialidade(env, u, p) {
  const a = await env.DB.prepare('SELECT clube_id FROM especialidades WHERE id=?').bind(p.id).first();
  exigir(a, 'Registo não encontrado.'); await exigirClube(env, u, a.clube_id);
  await env.DB.prepare('DELETE FROM especialidades WHERE id=?').bind(p.id).run();
  return true;
}

/* ---- presenças ---- */

async function actividades(env, u, p) {
  await exigirClube(env, u, p.clube_id);
  const mes = /^\d{4}-\d{2}$/.test(p.mes || '') ? p.mes : agora().slice(0, 7);
  return (await env.DB.prepare(`SELECT a.*,
      SUM(CASE WHEN x.estado='P' THEN 1 ELSE 0 END) AS p, SUM(CASE WHEN x.estado='F' THEN 1 ELSE 0 END) AS f, SUM(CASE WHEN x.estado='J' THEN 1 ELSE 0 END) AS j
    FROM actividades a LEFT JOIN presencas x ON x.actividade_id=a.id WHERE a.clube_id=? AND substr(a.data,1,7)=? GROUP BY a.id ORDER BY a.data DESC`).bind(p.clube_id, mes).all()).results;
}
async function actividade(env, u, p) {
  const a = await env.DB.prepare('SELECT * FROM actividades WHERE id=?').bind(p.id).first();
  exigir(a, 'Actividade não encontrada.'); await exigirClube(env, u, a.clube_id);
  const ch = (await env.DB.prepare('SELECT membro_id, estado FROM presencas WHERE actividade_id=?').bind(a.id).all()).results;
  return { actividade: a, chamada: Object.fromEntries(ch.map(x => [x.membro_id, x.estado])) };
}
async function guardarActividade(env, u, p) {
  const r = p.registo || {};
  await exigirClube(env, u, r.clube_id);
  exigir(reData.test(r.data || ''), 'Indique a data.');
  exigir(TIPOS_ACT.includes(r.tipo), 'Escolha o tipo de actividade.');
  exigir(!r.pilar || PILARES.includes(r.pilar), 'Pilar inválido.');
  exigir(reIdCliente.test(r.id || ''), 'Identificador inválido.');
  const existe = await env.DB.prepare('SELECT clube_id FROM actividades WHERE id=?').bind(r.id).first();
  exigir(!existe || existe.clube_id === r.clube_id, 'Identificador inválido.');
  const ch = Object.entries(p.chamada || {}).filter(([, e]) => ['P', 'F', 'J'].includes(e));
  if (ch.length) await membrosDoClube(env, r.clube_id, ch.map(([id]) => id));
  const stmts = [
    existe
      ? env.DB.prepare('UPDATE actividades SET data=?,tipo=?,pilar=?,tema=?,obs=? WHERE id=?').bind(r.data, r.tipo, txt(r.pilar, 20), txt(r.tema, 200), txt(r.obs, 500), r.id)
      : env.DB.prepare('INSERT INTO actividades (id,clube_id,data,tipo,pilar,tema,obs,criado_por,criado_em) VALUES (?,?,?,?,?,?,?,?,?)')
        .bind(r.id, r.clube_id, r.data, r.tipo, txt(r.pilar, 20), txt(r.tema, 200), txt(r.obs, 500), u.email, agora()),
    env.DB.prepare('DELETE FROM presencas WHERE actividade_id=?').bind(r.id),
    ...inserirVarios(env, 'presencas', ['actividade_id', 'membro_id', 'estado'], ch.map(([m, e]) => [r.id, m, e]))
  ];
  await env.DB.batch(stmts);
  await auditar(env, u, existe ? 'editar' : 'criar', 'actividades', r.id, r.data + ' ' + r.tipo);
  const comFalta = ch.filter(([, e]) => e === 'F').map(([m]) => m);
  if (comFalta.length) await alertarAbandono(env, r.clube_id, comFalta, u.email).catch(e => console.error('abandono', e));
  return { id: r.id };
}
async function apagarActividade(env, u, p) {
  const a = await env.DB.prepare('SELECT clube_id FROM actividades WHERE id=?').bind(p.id).first();
  if (!a) return true;
  await exigirClube(env, u, a.clube_id);
  await env.DB.batch([env.DB.prepare('DELETE FROM presencas WHERE actividade_id=?').bind(p.id), env.DB.prepare('DELETE FROM actividades WHERE id=?').bind(p.id)]);
  await auditar(env, u, 'apagar', 'actividades', p.id);
  return true;
}

/* ---- mérito ---- */

async function criterios(env, u, p) {
  await exigirClube(env, u, p.clube_id);
  return (await env.DB.prepare('SELECT * FROM criterios WHERE (clube_id IS NULL OR clube_id=?) ORDER BY clube_id IS NOT NULL, ordem, nome').bind(p.clube_id).all()).results;
}
async function guardarCriterio(env, u, p) {
  const r = p.registo || {};
  const pts = Number(r.pontos);
  exigir(txt(r.nome), 'Indique o nome do critério.');
  exigir(Number.isInteger(pts) && pts >= -100 && pts <= 100 && pts !== 0, 'Pontos: número inteiro entre -100 e 100 (diferente de 0).');
  if (r.id) {
    const a = await env.DB.prepare('SELECT clube_id FROM criterios WHERE id=?').bind(r.id).first();
    exigir(a, 'Critério não encontrado.');
    if (a.clube_id) await exigirClube(env, u, a.clube_id); else exigir(u.papel === 'MSC', 'Só a Missão altera os critérios padrão.');
    await env.DB.prepare('UPDATE criterios SET nome=?,categoria=?,pontos=?,activo=?,descricao=? WHERE id=?')
      .bind(txt(r.nome, 100), txt(r.categoria, 40), pts, bool(r.activo === undefined ? 1 : r.activo), txt(r.descricao, 200), r.id).run();
    return { id: r.id };
  }
  await exigirClube(env, u, r.clube_id);
  const id = novoId();
  await env.DB.prepare('INSERT INTO criterios (id,clube_id,nome,categoria,pontos,automatico,activo,ordem,descricao) VALUES (?,?,?,?,?,NULL,1,100,?)')
    .bind(id, r.clube_id, txt(r.nome, 100), txt(r.categoria, 40) || 'Clube', pts, txt(r.descricao, 200)).run();
  await auditar(env, u, 'criar', 'criterios', id, r.nome);
  return { id };
}
async function apagarCriterio(env, u, p) {
  const a = await env.DB.prepare('SELECT clube_id FROM criterios WHERE id=?').bind(p.id).first();
  exigir(a && a.clube_id, 'Os critérios padrão não se apagam.'); await exigirClube(env, u, a.clube_id);
  const usado = await env.DB.prepare('SELECT COUNT(*) AS n FROM pontos WHERE criterio_id=?').bind(p.id).first('n');
  await env.DB.prepare(usado ? 'UPDATE criterios SET activo=0 WHERE id=?' : 'DELETE FROM criterios WHERE id=?').bind(p.id).run();
  return { desactivado: !!usado };
}
async function lancarPontos(env, u, p) {
  await exigirClube(env, u, p.clube_id);
  const c = await env.DB.prepare('SELECT * FROM criterios WHERE id=? AND (clube_id IS NULL OR clube_id=?)').bind(p.criterio_id, p.clube_id).first();
  exigir(c && c.activo && !c.automatico, 'Escolha um critério manual activo.');
  exigir(reData.test(p.data || ''), 'Indique a data.');
  const ms = await membrosDoClube(env, p.clube_id, p.membros);
  const t = agora();
  const rows = ms.map(m => [novoId(), p.clube_id, m.id, c.id, p.data, c.pontos, txt(p.obs, 200), u.email, t]);
  await env.DB.batch(inserirVarios(env, 'pontos', ['id', 'clube_id', 'membro_id', 'criterio_id', 'data', 'pontos', 'obs', 'registado_por', 'registado_em'], rows));
  return { lancados: rows.length };
}
async function apagarPonto(env, u, p) {
  const a = await env.DB.prepare('SELECT clube_id FROM pontos WHERE id=?').bind(p.id).first();
  exigir(a, 'Lançamento não encontrado.'); await exigirClube(env, u, a.clube_id);
  await env.DB.prepare('DELETE FROM pontos WHERE id=?').bind(p.id).run();
  return true;
}
async function ranking(env, u, p) {
  await exigirClube(env, u, p.clube_id);
  exigir(reData.test(p.de || '') && reData.test(p.ate || '') && p.de <= p.ate, 'Período inválido.');
  const auto = Object.fromEntries((await env.DB.prepare('SELECT automatico, pontos FROM criterios WHERE clube_id IS NULL AND automatico IS NOT NULL AND automatico<>\'\' AND activo=1').all()).results.map(x => [x.automatico, x.pontos]));
  const [ms, pres, esp, man, ult] = await env.DB.batch([
    env.DB.prepare(`SELECT id,nome,sexo,unidade_id FROM membros WHERE clube_id=? AND activo=1 AND tipo='Desbravador'`).bind(p.clube_id),
    env.DB.prepare(`SELECT x.membro_id, SUM(x.estado='P') AS p, SUM(x.estado='F') AS f, SUM(x.estado='P' AND a.tipo='Actividade missionária') AS mis
      FROM presencas x JOIN actividades a ON a.id=x.actividade_id WHERE a.clube_id=? AND a.data BETWEEN ? AND ? GROUP BY x.membro_id`).bind(p.clube_id, p.de, p.ate),
    env.DB.prepare(`SELECT membro_id, COUNT(*) AS n FROM especialidades WHERE clube_id=? AND data_conclusao BETWEEN ? AND ? GROUP BY membro_id`).bind(p.clube_id, p.de, p.ate),
    env.DB.prepare(`SELECT membro_id, SUM(pontos) AS pts, COUNT(*) AS n FROM pontos WHERE clube_id=? AND data BETWEEN ? AND ? GROUP BY membro_id`).bind(p.clube_id, p.de, p.ate),
    env.DB.prepare(`SELECT pt.id, pt.data, pt.pontos, pt.obs, m.nome, c.nome AS criterio FROM pontos pt JOIN membros m ON m.id=pt.membro_id
      LEFT JOIN criterios c ON c.id=pt.criterio_id WHERE pt.clube_id=? AND pt.data BETWEEN ? AND ? ORDER BY pt.registado_em DESC LIMIT 60`).bind(p.clube_id, p.de, p.ate)
  ]);
  const idx = (r) => Object.fromEntries(r.results.map(x => [x.membro_id, x]));
  const P = idx(pres), E = idx(esp), M = idx(man);
  const lista = ms.results.map(m => {
    const pr = P[m.id] || {}, es = E[m.id] || {}, mn = M[m.id] || {};
    const presenca = (pr.p || 0) * (auto.presenca || 0), faltas = (pr.f || 0) * (auto.falta || 0),
      missao = (pr.mis || 0) * (auto.missionaria || 0), especial = (es.n || 0) * (auto.especialidade || 0), manual = mn.pts || 0;
    return { id: m.id, nome: m.nome, sexo: m.sexo, unidade_id: m.unidade_id, presencas: pr.p || 0, faltas: pr.f || 0,
      pontos: { presenca, faltas, missao, especial, manual }, total: presenca + faltas + missao + especial + manual };
  }).sort((a, b) => b.total - a.total || a.nome.localeCompare(b.nome));
  return { lista, ultimos: ult.results };
}

/* ======================= FASE 3 ======================= */

const num = (v, min = 0, max = 1e9) => { const n = Number(v); return Number.isFinite(n) && n >= min && n <= max ? n : null; };
function limitesMes(ano, mes) {
  const de = `${ano}-${String(mes).padStart(2, '0')}-01`;
  const ate = new Date(Date.UTC(ano, mes, 0)).toISOString().slice(0, 10);
  return [de, ate];
}
function regiaoDoUtilizador(u) { return u.papel === 'REGIONAL' ? u.regiao_id : null; }

/* ---- relatório mensal ---- */

const CAMPOS_MANUAIS = { classe_biblica_activa: 'sn', baptismos: 'n', calendario_trimestral: 'sn', visita: 'sn', data_visita: 'd', visitante: 't', destaques: 'tl', dificuldades: 'tl' };

async function calcularMensal(env, clubeId, ano, mes) {
  const [de, ate] = limitesMes(ano, mes);
  const [m, cl, act, pr, esp] = await env.DB.batch([
    env.DB.prepare(`SELECT SUM(tipo='Desbravador') AS activos, SUM(tipo<>'Desbravador' OR tipo IS NULL) AS lideres FROM membros WHERE clube_id=? AND activo=1`).bind(clubeId),
    env.DB.prepare(`SELECT COUNT(*) AS inscritos, SUM(estado='Investido' AND data_investidura BETWEEN ? AND ?) AS investidos FROM classes WHERE clube_id=? AND ano=?`).bind(de, ate, clubeId, ano),
    env.DB.prepare(`SELECT COUNT(*) AS n, SUM(pilar='Espiritual') AS esp, SUM(pilar='Físico') AS fis, SUM(pilar='Mental') AS men, SUM(pilar='Social') AS soc,
      SUM(tipo='Actividade missionária') AS mis, SUM(tipo='Classe bíblica') AS cb FROM actividades WHERE clube_id=? AND data BETWEEN ? AND ?`).bind(clubeId, de, ate),
    env.DB.prepare(`SELECT SUM(x.estado='P') AS p, COUNT(*) AS t FROM presencas x JOIN actividades a ON a.id=x.actividade_id WHERE a.clube_id=? AND a.data BETWEEN ? AND ?`).bind(clubeId, de, ate),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM especialidades WHERE clube_id=? AND data_conclusao BETWEEN ? AND ?`).bind(clubeId, de, ate)
  ]);
  const a = act.results[0], p = pr.results[0];
  return {
    activos: m.results[0].activos || 0, lideres: m.results[0].lideres || 0, inscritos: cl.results[0].inscritos || 0, investidos: cl.results[0].investidos || 0,
    actividades: a.n || 0, pilar_espiritual: a.esp || 0, pilar_fisico: a.fis || 0, pilar_mental: a.men || 0, pilar_social: a.soc || 0,
    missionarias: a.mis || 0, encontros_cb: a.cb || 0, especialidades: esp.results[0].n || 0,
    assiduidade: p.t ? Math.round((p.p || 0) / p.t * 100) : null
  };
}
function validarPeriodo(ano, mes) {
  ano = Number(ano); mes = Number(mes);
  exigir(Number.isInteger(ano) && ano >= 2020 && ano <= 2100 && Number.isInteger(mes) && mes >= 1 && mes <= 12, 'Período inválido.');
  return [ano, mes];
}

async function relatorio(env, u, p) {
  await exigirClube(env, u, p.clube_id);
  const [ano, mes] = validarPeriodo(p.ano, p.mes);
  const r = await env.DB.prepare('SELECT * FROM relatorios WHERE clube_id=? AND ano=? AND mes=?').bind(p.clube_id, ano, mes).first();
  const dados = r && r.dados ? JSON.parse(r.dados) : {};
  const auto = r && r.estado === 'Enviado' ? dados : await calcularMensal(env, p.clube_id, ano, mes);
  return { registo: r ? { id: r.id, estado: r.estado, enviado_em: r.enviado_em, enviado_por: r.enviado_por } : null, auto, manual: dados };
}

async function guardarRelatorio(env, u, p) {
  await exigirClube(env, u, p.clube_id);
  const [ano, mes] = validarPeriodo(p.ano, p.mes);
  const r = await env.DB.prepare('SELECT * FROM relatorios WHERE clube_id=? AND ano=? AND mes=?').bind(p.clube_id, ano, mes).first();
  exigir(!r || r.estado !== 'Enviado', 'Este relatório já foi enviado. Peça à região que o reabra.');
  const m = p.manual || {}; const manual = {};
  for (const [k, t] of Object.entries(CAMPOS_MANUAIS)) {
    const v = m[k];
    if (t === 'sn') { exigir(!v || ['Sim', 'Não'].includes(v), 'Resposta inválida.'); manual[k] = v || null; }
    else if (t === 'n') { manual[k] = v === '' || v == null ? null : num(v, 0, 1000); exigir(v === '' || v == null || manual[k] !== null, 'Número inválido.'); }
    else if (t === 'd') { manual[k] = txt(v, 10); exigir(!manual[k] || reData.test(manual[k]), 'Data inválida.'); }
    else manual[k] = txt(v, t === 'tl' ? 1500 : 120);
  }
  if (p.enviar) {
    exigir(manual.classe_biblica_activa && manual.calendario_trimestral && manual.visita, 'Responda às perguntas Sim/Não antes de enviar.');
    exigir(manual.visita !== 'Sim' || manual.data_visita, 'Indique a data da visita.');
  }
  const auto = await calcularMensal(env, p.clube_id, ano, mes);
  const dados = JSON.stringify(Object.assign({}, auto, manual));
  const estado = p.enviar ? 'Enviado' : 'Rascunho';
  const id = r ? r.id : novoId();
  await env.DB.prepare(`INSERT INTO relatorios (id,clube_id,ano,mes,estado,dados,enviado_em,enviado_por,actualizado_em) VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(clube_id,ano,mes) DO UPDATE SET estado=excluded.estado, dados=excluded.dados, enviado_em=excluded.enviado_em, enviado_por=excluded.enviado_por, actualizado_em=excluded.actualizado_em`)
    .bind(id, p.clube_id, ano, mes, estado, dados, p.enviar ? agora() : null, p.enviar ? u.email : null, agora()).run();
  await auditar(env, u, p.enviar ? 'enviar' : 'rascunho', 'relatorios', id, `${ano}-${mes}`);
  return { id, estado };
}

async function reabrirRelatorio(env, u, p) {
  exigir(u.papel !== 'DIRECTOR', 'Só a região ou a Missão podem reabrir um relatório.');
  const r = await env.DB.prepare('SELECT * FROM relatorios WHERE id=?').bind(p.id).first();
  exigir(r, 'Relatório não encontrado.'); await exigirClube(env, u, r.clube_id);
  await env.DB.prepare(`UPDATE relatorios SET estado='Reaberto', actualizado_em=? WHERE id=?`).bind(agora(), r.id).run();
  await auditar(env, u, 'reabrir', 'relatorios', r.id, txt(p.motivo, 200));
  return true;
}

async function estadoRelatorios(env, u, p) {
  const ano = Number(p.ano) || new Date().getFullYear();
  const f = filtroClubes(u);
  const reg = u.papel === 'MSC' && p.regiao_id ? ' AND c.regiao_id=?' : '';
  const r = await env.DB.prepare(`SELECT c.id, c.nome, c.regiao_id, json_group_object(r.mes, r.estado) AS meses FROM clubes c
    LEFT JOIN relatorios r ON r.clube_id=c.id AND r.ano=? WHERE c.activo=1 AND ${f.sql}${reg} GROUP BY c.id ORDER BY c.nome`)
    .bind(ano, ...f.args, ...(reg ? [p.regiao_id] : [])).all();
  return { ano, clubes: r.results.map(x => ({ id: x.id, nome: x.nome, regiao_id: x.regiao_id, meses: JSON.parse(x.meses || '{}') })) };
}

async function trimestral(env, u, p) {
  const ano = Number(p.ano); const t = Number(p.t);
  exigir(ano >= 2020 && ano <= 2100 && [1, 2, 3, 4].includes(t), 'Período inválido.');
  const f = filtroClubes(u);
  let extra = '', args = [];
  if (p.clube_id) { await exigirClube(env, u, p.clube_id); extra = ' AND c.id=?'; args = [p.clube_id]; }
  else if (p.regiao_id) { exigir(u.papel === 'MSC' || u.regiao_id === p.regiao_id); extra = ' AND c.regiao_id=?'; args = [p.regiao_id]; }
  const meses = [t * 3 - 2, t * 3 - 1, t * 3];
  const r = await env.DB.prepare(`SELECT c.id, c.nome, c.regiao_id, r.mes, r.estado, r.dados FROM clubes c
    LEFT JOIN relatorios r ON r.clube_id=c.id AND r.ano=? AND r.mes IN (?,?,?) AND r.estado='Enviado'
    WHERE c.activo=1 AND ${f.sql}${extra} ORDER BY c.nome, r.mes`).bind(ano, ...meses, ...f.args, ...args).all();
  const porClube = new Map();
  for (const x of r.results) {
    if (!porClube.has(x.id)) porClube.set(x.id, { id: x.id, nome: x.nome, regiao_id: x.regiao_id, enviados: 0, actividades: 0, missionarias: 0, encontros_cb: 0,
      especialidades: 0, investidos: 0, baptismos: 0, visitas: 0, assid: [], activos: null, lideres: null, inscritos: null, pilares: { Espiritual: 0, Físico: 0, Mental: 0, Social: 0 } });
    if (!x.dados) continue;
    const c = porClube.get(x.id), d = JSON.parse(x.dados);
    c.enviados++; c.actividades += d.actividades || 0; c.missionarias += d.missionarias || 0; c.encontros_cb += d.encontros_cb || 0;
    c.especialidades += d.especialidades || 0; c.investidos += d.investidos || 0; c.baptismos += d.baptismos || 0; c.visitas += d.visita === 'Sim' ? 1 : 0;
    c.pilares.Espiritual += d.pilar_espiritual || 0; c.pilares.Físico += d.pilar_fisico || 0; c.pilares.Mental += d.pilar_mental || 0; c.pilares.Social += d.pilar_social || 0;
    if (d.assiduidade != null) c.assid.push(d.assiduidade);
    c.activos = d.activos; c.lideres = d.lideres; c.inscritos = d.inscritos; // último mês enviado
  }
  const clubes = [...porClube.values()].map(c => Object.assign(c, { assiduidade: c.assid.length ? Math.round(c.assid.reduce((a, b) => a + b, 0) / c.assid.length) : null, assid: undefined }));
  const soma = (k) => clubes.reduce((a, c) => a + (c[k] || 0), 0);
  const comAss = clubes.filter(c => c.assiduidade != null);
  const totais = { clubes: clubes.length, clubes_completos: clubes.filter(c => c.enviados === 3).length, relatorios: soma('enviados'), relatorios_esperados: clubes.length * 3,
    activos: soma('activos'), lideres: soma('lideres'), inscritos: soma('inscritos'), actividades: soma('actividades'), missionarias: soma('missionarias'),
    encontros_cb: soma('encontros_cb'), especialidades: soma('especialidades'), investidos: soma('investidos'), baptismos: soma('baptismos'), visitas: soma('visitas'),
    assiduidade: comAss.length ? Math.round(comAss.reduce((a, c) => a + c.assiduidade, 0) / comAss.length) : null };
  return { ano, t, clubes, totais };
}

/* ---- finanças ---- */

const CAT_ENT = ['Quotas', 'Seguro', 'Ofertas', 'Doações', 'Vendas e actividades', 'Taxas de eventos', 'Apoio da igreja', 'Outras entradas'];
const CAT_SAI = ['Material', 'Uniformes e insígnias', 'Transporte', 'Alimentação', 'Eventos e camporis', 'Seguro (pago à Missão)', 'Taxas', 'Manutenção', 'Outras saídas'];
const METODOS = ['Numerário', 'Transferência', 'Multicaixa Express', 'Outro'];

async function movimentos(env, u, p) {
  await exigirClube(env, u, p.clube_id);
  exigir(reData.test(p.de || '') && reData.test(p.ate || ''), 'Período inválido.');
  const [l, s, sp] = await env.DB.batch([
    env.DB.prepare(`SELECT mv.*, m.nome AS membro FROM movimentos mv LEFT JOIN membros m ON m.id=mv.membro_id WHERE mv.clube_id=? AND mv.data BETWEEN ? AND ? ORDER BY mv.data DESC, mv.registado_em DESC`).bind(p.clube_id, p.de, p.ate),
    env.DB.prepare(`SELECT COALESCE(SUM(CASE WHEN tipo='Entrada' THEN valor ELSE -valor END),0) AS saldo FROM movimentos WHERE clube_id=? AND estado='Válido'`).bind(p.clube_id),
    env.DB.prepare(`SELECT tipo, categoria, SUM(valor) AS total FROM movimentos WHERE clube_id=? AND estado='Válido' AND data BETWEEN ? AND ? GROUP BY tipo, categoria ORDER BY total DESC`).bind(p.clube_id, p.de, p.ate)
  ]);
  const ent = sp.results.filter(x => x.tipo === 'Entrada').reduce((a, x) => a + x.total, 0), sai = sp.results.filter(x => x.tipo === 'Saída').reduce((a, x) => a + x.total, 0);
  return { lista: l.results, saldo: s.results[0].saldo, entradas: ent, saidas: sai, por_categoria: sp.results, pode_escrever: true };
}

async function guardarMovimento(env, u, p) {
  const r = p.registo || {};
  await exigirClube(env, u, r.clube_id);
  exigir(['Entrada', 'Saída'].includes(r.tipo), 'Escolha Entrada ou Saída.');
  exigir((r.tipo === 'Entrada' ? CAT_ENT : CAT_SAI).includes(r.categoria), 'Escolha a categoria.');
  const valor = num(r.valor, 0.01, 1e9); exigir(valor, 'Valor inválido.');
  exigir(reData.test(r.data || ''), 'Indique a data.');
  exigir(r.data <= agora().slice(0, 10), 'A data não pode ser no futuro.');
  exigir(!r.metodo || METODOS.includes(r.metodo), 'Método inválido.');
  if (r.membro_id) await membrosDoClube(env, r.clube_id, [r.membro_id]);
  const id = novoId();
  await env.DB.prepare(`INSERT INTO movimentos (id,clube_id,data,tipo,categoria,descricao,valor,metodo,referencia,membro_id,registado_por,registado_papel,registado_em,estado)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'Válido')`).bind(id, r.clube_id, r.data, r.tipo, r.categoria, txt(r.descricao, 200), Math.round(valor * 100) / 100,
    txt(r.metodo, 40), txt(r.referencia, 80), r.membro_id || null, u.email, u.papel, agora()).run();
  await auditar(env, u, 'criar', 'movimentos', id, `${r.tipo} ${valor}`);
  return { id };
}

async function anularMovimento(env, u, p) {
  const mv = await env.DB.prepare('SELECT * FROM movimentos WHERE id=?').bind(p.id).first();
  exigir(mv && mv.estado === 'Válido', 'Movimento não encontrado ou já anulado.');
  await exigirClube(env, u, mv.clube_id);
  exigir(txt(p.motivo), 'Indique o motivo da anulação.');
  await env.DB.prepare(`UPDATE movimentos SET estado='Anulado', anulado_por=?, anulado_em=?, motivo_anulacao=? WHERE id=?`).bind(u.email, agora(), txt(p.motivo, 200), mv.id).run();
  await auditar(env, u, 'anular', 'movimentos', mv.id, p.motivo);
  return true;
}

async function resumoFinancas(env, u, p) {
  exigir(u.papel !== 'DIRECTOR');
  const ano = Number(p.ano) || new Date().getFullYear();
  const f = filtroClubes(u);
  const r = await env.DB.prepare(`SELECT c.id, c.nome, c.regiao_id,
      COALESCE(SUM(CASE WHEN mv.estado='Válido' THEN (CASE WHEN mv.tipo='Entrada' THEN mv.valor ELSE -mv.valor END) END),0) AS saldo,
      COALESCE(SUM(CASE WHEN mv.estado='Válido' AND mv.tipo='Entrada' AND substr(mv.data,1,4)=? THEN mv.valor END),0) AS entradas,
      COALESCE(SUM(CASE WHEN mv.estado='Válido' AND mv.tipo='Saída' AND substr(mv.data,1,4)=? THEN mv.valor END),0) AS saidas,
      MAX(mv.data) AS ultimo
    FROM clubes c LEFT JOIN movimentos mv ON mv.clube_id=c.id WHERE c.activo=1 AND ${f.sql} GROUP BY c.id ORDER BY c.nome`).bind(String(ano), String(ano), ...f.args).all();
  return { ano, clubes: r.results };
}

/* ---- seguro e taxas ---- */

const TIPOS_PAG = ['Seguro anual', 'Quota anual', 'Quota mensal', 'Taxa de evento', 'Outro'];

async function pagamentos(env, u, p) {
  await exigirClube(env, u, p.clube_id);
  const ano = Number(p.ano) || new Date().getFullYear();
  return (await env.DB.prepare(`SELECT pg.*, m.nome FROM pagamentos pg JOIN membros m ON m.id=pg.membro_id WHERE pg.clube_id=? AND pg.ano=? ORDER BY pg.data DESC`).bind(p.clube_id, ano).all()).results;
}

async function registarPagamentos(env, u, p) {
  await exigirClube(env, u, p.clube_id);
  const ano = Number(p.ano); exigir(ano >= 2020 && ano <= 2100, 'Ano inválido.');
  exigir(TIPOS_PAG.includes(p.tipo), 'Escolha o tipo de pagamento.');
  const valor = num(p.valor, 0, 1e8); exigir(valor !== null, 'Valor inválido.');
  exigir(reData.test(p.data || '') && p.data <= agora().slice(0, 10), 'Data inválida.');
  const ms = await membrosDoClube(env, p.clube_id, p.membros);
  if (p.tipo === 'Seguro anual') {
    const ja = (await env.DB.prepare(`SELECT m.nome FROM pagamentos pg JOIN membros m ON m.id=pg.membro_id WHERE pg.clube_id=? AND pg.ano=? AND pg.tipo='Seguro anual' AND pg.membro_id IN (SELECT value FROM json_each(?))`)
      .bind(p.clube_id, ano, JSON.stringify(ms.map(m => m.id))).all()).results;
    exigir(!ja.length, 'Já tem seguro pago em ' + ano + ': ' + ja.map(x => x.nome).join(', '));
  }
  const rows = ms.map(m => [novoId(), p.clube_id, m.id, ano, p.tipo, txt(p.descricao, 120), valor, p.data, txt(p.recibo, 60), null]);
  const st = inserirVarios(env, 'pagamentos', ['id', 'clube_id', 'membro_id', 'ano', 'tipo', 'descricao', 'valor', 'data', 'recibo', 'obs'], rows);
  if (p.movimento && valor > 0) {
    const cat = p.tipo === 'Seguro anual' ? 'Seguro' : p.tipo === 'Taxa de evento' ? 'Taxas de eventos' : p.tipo.startsWith('Quota') ? 'Quotas' : 'Outras entradas';
    st.push(env.DB.prepare(`INSERT INTO movimentos (id,clube_id,data,tipo,categoria,descricao,valor,metodo,referencia,registado_por,registado_papel,registado_em,estado)
      VALUES (?,?,?,'Entrada',?,?,?,?,?,?,?,?,'Válido')`).bind(novoId(), p.clube_id, p.data, cat, `${p.tipo} ${ano} — ${ms.length} membro(s)`, Math.round(valor * ms.length * 100) / 100,
      txt(p.metodo, 40) || 'Numerário', txt(p.recibo, 80), u.email, u.papel, agora()));
  }
  await env.DB.batch(st);
  await auditar(env, u, 'pagamentos', 'pagamentos', p.clube_id, `${p.tipo} × ${ms.length}`);
  return { registados: ms.length };
}

async function apagarPagamento(env, u, p) {
  const a = await env.DB.prepare('SELECT clube_id FROM pagamentos WHERE id=?').bind(p.id).first();
  exigir(a, 'Pagamento não encontrado.'); await exigirClube(env, u, a.clube_id);
  await env.DB.prepare('DELETE FROM pagamentos WHERE id=?').bind(p.id).run();
  await auditar(env, u, 'apagar', 'pagamentos', p.id);
  return true;
}

/* ---- eventos ---- */

const TIPOS_EV = ['Campori', 'Acampamento', 'Investidura', 'Feira', 'Formação de líderes', 'Desfile', 'Actividade missionária', 'Outro'];
const ESTADOS_EV = ['Inscrições abertas', 'Inscrições fechadas', 'Realizado', 'Cancelado'];

async function eventoVisivel(env, u, id) {
  const e = await env.DB.prepare('SELECT * FROM eventos WHERE id=?').bind(id).first();
  exigir(e, 'Evento não encontrado.');
  if (e.nivel === 'Região' && u.papel !== 'MSC') {
    const reg = u.papel === 'REGIONAL' ? u.regiao_id : (await env.DB.prepare('SELECT regiao_id FROM clubes WHERE id=?').bind(u.clube_id).first('regiao_id'));
    exigir(reg === e.regiao_id);
  }
  return e;
}
const organiza = (u, e) => u.papel === 'MSC' || (u.papel === 'REGIONAL' && e.nivel === 'Região' && e.regiao_id === u.regiao_id);

async function eventos(env, u) {
  let reg = null;
  if (u.papel === 'REGIONAL') reg = u.regiao_id;
  if (u.papel === 'DIRECTOR') reg = await env.DB.prepare('SELECT regiao_id FROM clubes WHERE id=?').bind(u.clube_id).first('regiao_id');
  const filtro = u.papel === 'MSC' ? '1=1' : `(e.nivel='Missão' OR e.regiao_id=?)`;
  const r = await env.DB.prepare(`SELECT e.*, COUNT(i.id) AS inscritos, COUNT(DISTINCT i.clube_id) AS clubes,
      SUM(CASE WHEN i.clube_id=? THEN 1 ELSE 0 END) AS do_clube
    FROM eventos e LEFT JOIN inscricoes i ON i.evento_id=e.id WHERE ${filtro} GROUP BY e.id ORDER BY e.data_inicio DESC`)
    .bind(u.clube_id || '', ...(u.papel === 'MSC' ? [] : [reg])).all();
  return r.results.map(e => Object.assign(e, { organizador: organiza(u, e) }));
}

async function guardarEvento(env, u, p) {
  exigir(u.papel !== 'DIRECTOR', 'Só a região ou a Missão criam eventos.');
  const r = p.registo || {};
  const o = { nome: txt(r.nome, 150), tipo: r.tipo, nivel: u.papel === 'REGIONAL' ? 'Região' : r.nivel, regiao_id: null, data_inicio: r.data_inicio, data_fim: r.data_fim || r.data_inicio,
    local: txt(r.local, 150), taxa: num(r.taxa || 0, 0, 1e8), estado: r.estado || 'Inscrições abertas' };
  exigir(o.nome, 'Indique o nome do evento.');
  exigir(TIPOS_EV.includes(o.tipo), 'Escolha o tipo.'); exigir(['Missão', 'Região'].includes(o.nivel), 'Nível inválido.');
  exigir(reData.test(o.data_inicio || '') && reData.test(o.data_fim || '') && o.data_fim >= o.data_inicio, 'Datas inválidas.');
  exigir(o.taxa !== null, 'Taxa inválida.'); exigir(ESTADOS_EV.includes(o.estado), 'Estado inválido.');
  if (o.nivel === 'Região') { o.regiao_id = u.papel === 'REGIONAL' ? u.regiao_id : r.regiao_id; exigir(o.regiao_id, 'Escolha a região.'); }
  const cols = Object.keys(o);
  if (r.id) {
    const e = await eventoVisivel(env, u, r.id); exigir(organiza(u, e));
    await env.DB.prepare(`UPDATE eventos SET ${cols.map(k => k + '=?').join(',')} WHERE id=?`).bind(...cols.map(k => o[k]), r.id).run();
    await auditar(env, u, 'editar', 'eventos', r.id, o.nome); return { id: r.id };
  }
  const id = novoId();
  await env.DB.prepare(`INSERT INTO eventos (id,${cols.join(',')}) VALUES (?,${cols.map(() => '?').join(',')})`).bind(id, ...cols.map(k => o[k])).run();
  await auditar(env, u, 'criar', 'eventos', id, o.nome);
  return { id };
}

async function apagarEvento(env, u, p) {
  const e = await eventoVisivel(env, u, p.id); exigir(organiza(u, e));
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM inscricoes WHERE evento_id=?').bind(e.id).first('n');
  exigir(!n, 'O evento já tem inscrições. Mude o estado para "Cancelado" em vez de apagar.');
  await env.DB.prepare('DELETE FROM eventos WHERE id=?').bind(e.id).run();
  await auditar(env, u, 'apagar', 'eventos', e.id, e.nome);
  return true;
}

async function inscricoesEvento(env, u, p) {
  const e = await eventoVisivel(env, u, p.evento_id);
  await exigirClube(env, u, p.clube_id);
  const r = await env.DB.prepare(`SELECT m.id, m.nome, m.tipo, m.sexo, m.data_nasc, (i.id IS NOT NULL) AS inscrito,
      EXISTS(SELECT 1 FROM pagamentos pg WHERE pg.membro_id=m.id AND pg.tipo='Seguro anual' AND pg.ano=?) AS seguro
    FROM membros m LEFT JOIN inscricoes i ON i.membro_id=m.id AND i.evento_id=? WHERE m.clube_id=? AND (m.activo=1 OR i.id IS NOT NULL) ORDER BY m.tipo<>'Desbravador', m.nome`)
    .bind(Number(e.data_inicio.slice(0, 4)), e.id, p.clube_id).all();
  return { evento: e, membros: r.results };
}

async function definirInscricoes(env, u, p) {
  const e = await eventoVisivel(env, u, p.evento_id);
  await exigirClube(env, u, p.clube_id);
  exigir(e.estado === 'Inscrições abertas' || organiza(u, e), 'As inscrições deste evento estão fechadas.');
  const ids = Array.isArray(p.membros) ? p.membros : [];
  if (ids.length) await membrosDoClube(env, p.clube_id, ids);
  const st = [env.DB.prepare('DELETE FROM inscricoes WHERE evento_id=? AND clube_id=?').bind(e.id, p.clube_id),
    ...inserirVarios(env, 'inscricoes', ['id', 'evento_id', 'clube_id', 'membro_id', 'data'], ids.map(m => [novoId(), e.id, p.clube_id, m, agora().slice(0, 10)]))];
  await env.DB.batch(st);
  await auditar(env, u, 'inscricoes', 'eventos', e.id, `${p.clube_id}: ${ids.length}`);
  return { inscritos: ids.length };
}

async function resumoEvento(env, u, p) {
  const e = await eventoVisivel(env, u, p.id);
  const f = filtroClubes(u);
  const r = await env.DB.prepare(`SELECT c.id AS clube_id, c.nome AS clube, c.regiao_id, m.nome, m.tipo, m.sexo, m.data_nasc FROM inscricoes i
    JOIN clubes c ON c.id=i.clube_id JOIN membros m ON m.id=i.membro_id WHERE i.evento_id=? AND ${f.sql} ORDER BY c.nome, m.nome`).bind(e.id, ...f.args).all();
  return { evento: e, inscritos: r.results };
}

/* ---- ficha do clube (para PDF) ---- */
async function fichaClube(env, u, p) {
  const c = await exigirClube(env, u, p.clube_id);
  const ano = new Date().getFullYear();
  const [m, un, cl, seg] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM membros WHERE clube_id=? AND activo=1 ORDER BY tipo<>\'Desbravador\', nome').bind(c.id),
    env.DB.prepare('SELECT * FROM unidades WHERE clube_id=? ORDER BY nome').bind(c.id),
    env.DB.prepare('SELECT membro_id, classe, estado FROM classes WHERE clube_id=? AND ano=?').bind(c.id, ano),
    env.DB.prepare(`SELECT membro_id FROM pagamentos WHERE clube_id=? AND ano=? AND tipo='Seguro anual'`).bind(c.id, ano)
  ]);
  return { clube: c, membros: m.results, unidades: un.results, classes: cl.results, seguro: seg.results.map(x => x.membro_id), ano };
}

/* ======================= FASE 4 ======================= */

/* ---- notificações (sino) ---- */
// para_tipo: todos | msc | regiao (regionais da região) | regiao_todos (regionais + directores da região) | clube (director do clube) | user (um email)
function notificar(env, n) {
  return env.DB.prepare('INSERT INTO notificacoes (id,data,para_tipo,para_id,titulo,texto,aba,clube_id,autor) VALUES (?,?,?,?,?,?,?,?,?)')
    .bind(novoId(), agora(), n.para_tipo, n.para_id || null, String(n.titulo).slice(0, 150), n.texto ? String(n.texto).slice(0, 400) : null, n.aba || null, n.clube_id || null, n.autor || null);
}
const visivelNotif = `(n.para_tipo='todos' OR (n.para_tipo='msc' AND ?1='MSC') OR (n.para_tipo='regiao' AND ?1='REGIONAL' AND n.para_id=?2)
  OR (n.para_tipo='regiao_todos' AND ?1<>'MSC' AND n.para_id=?2) OR (n.para_tipo='clube' AND ?1='DIRECTOR' AND n.para_id=?3) OR (n.para_tipo='user' AND n.para_id=?4))
  AND COALESCE(n.autor,'')<>?4`;

async function notificacoes(env, u) {
  await escalarSolicitacoes(env, true);
  const visto = u.notif_visto || '';
  const [l, c] = await env.DB.batch([
    env.DB.prepare(`SELECT n.* FROM notificacoes n WHERE ${visivelNotif} ORDER BY n.data DESC LIMIT 50`).bind(u.papel, u.reg || '', u.clube_id || '', u.email),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM notificacoes n WHERE ${visivelNotif} AND n.data > ?5`).bind(u.papel, u.reg || '', u.clube_id || '', u.email, visto)
  ]);
  return { lista: l.results.map(x => Object.assign(x, { nova: x.data > visto })), novas: c.results[0].n };
}
async function marcarLidas(env, u) { await env.DB.prepare('UPDATE utilizadores SET notif_visto=? WHERE email=?').bind(agora(), u.email).run(); return true; }

/* ---- comunicados ---- */
const DESTINOS_COM = ['Todos', 'Directores', 'Regionais'];
const visivelCom = `(c.autor_email=?4 OR ?1='MSC' OR ((c.ambito='Missão' OR c.regiao_id=?2) AND (c.destinatarios='Todos' OR (c.destinatarios='Directores' AND ?1='DIRECTOR') OR (c.destinatarios='Regionais' AND ?1='REGIONAL'))))`;

async function comunicados(env, u, p) {
  const arq = p.arquivados ? 0 : 1;
  const r = await env.DB.prepare(`SELECT c.*, EXISTS(SELECT 1 FROM leituras l WHERE l.comunicado_id=c.id AND l.email=?4) AS lido,
      (SELECT COUNT(*) FROM leituras l WHERE l.comunicado_id=c.id) AS leituras
    FROM comunicados c WHERE c.activo=?3 AND ${visivelCom} ORDER BY c.prioridade='Urgente' DESC, c.data DESC LIMIT 100`)
    .bind(u.papel, u.reg || '', arq, u.email).all();
  return r.results.map(c => Object.assign(c, { meu: c.autor_email === u.email || u.papel === 'MSC' }));
}

async function publicarComunicado(env, u, p) {
  exigir(u.papel !== 'DIRECTOR', 'Só a região e a Missão publicam comunicados.');
  const r = p.registo || {};
  const o = { titulo: txt(r.titulo, 150), texto: txt(r.texto, 5000), prioridade: r.prioridade === 'Urgente' ? 'Urgente' : 'Normal', data_evento: txt(r.data_evento, 10),
    destinatarios: DESTINOS_COM.includes(r.destinatarios) ? r.destinatarios : 'Todos' };
  exigir(o.titulo && o.texto, 'Escreva o título e o texto.');
  exigir(!o.data_evento || reData.test(o.data_evento), 'Data inválida.');
  let ambito = 'Missão', regiao = null;
  if (u.papel === 'REGIONAL') { ambito = 'Região'; regiao = u.regiao_id; exigir(o.destinatarios !== 'Regionais', 'Destinatários inválidos.'); }
  else if (r.regiao_id) { exigir(await env.DB.prepare('SELECT 1 FROM regioes WHERE id=?').bind(r.regiao_id).first(), 'Região inválida.'); ambito = 'Região'; regiao = r.regiao_id; }
  const id = novoId();
  const para = ambito === 'Missão' ? { para_tipo: 'todos' } : { para_tipo: 'regiao_todos', para_id: regiao };
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO comunicados (id,data,autor_email,autor_nome,autor_papel,ambito,regiao_id,destinatarios,titulo,texto,prioridade,data_evento,activo) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)`)
      .bind(id, agora(), u.email, u.nome, u.papel, ambito, regiao, o.destinatarios, o.titulo, o.texto, o.prioridade, o.data_evento),
    notificar(env, Object.assign(para, { titulo: (o.prioridade === 'Urgente' ? 'URGENTE: ' : 'Comunicado: ') + o.titulo, texto: o.texto.slice(0, 140), aba: 'comunicados', autor: u.email }))
  ]);
  await auditar(env, u, 'publicar', 'comunicados', id, o.titulo);
  return { id };
}
async function lerComunicado(env, u, p) {
  const c = await env.DB.prepare(`SELECT c.id FROM comunicados c WHERE c.id=?3 AND ${visivelCom}`).bind(u.papel, u.reg || '', p.id, u.email).first();
  exigir(c, 'Comunicado não encontrado.');
  await env.DB.prepare('INSERT OR IGNORE INTO leituras (comunicado_id,email,data) VALUES (?,?,?)').bind(p.id, u.email, agora()).run();
  return true;
}
async function arquivarComunicado(env, u, p) {
  const c = await env.DB.prepare('SELECT * FROM comunicados WHERE id=?').bind(p.id).first();
  exigir(c && (c.autor_email === u.email || u.papel === 'MSC'));
  await env.DB.prepare('UPDATE comunicados SET activo=? WHERE id=?').bind(p.reactivar ? 1 : 0, c.id).run();
  return true;
}
async function quemLeu(env, u, p) {
  const c = await env.DB.prepare('SELECT * FROM comunicados WHERE id=?').bind(p.id).first();
  exigir(c && (c.autor_email === u.email || u.papel === 'MSC'));
  const papeis = c.destinatarios === 'Directores' ? "('DIRECTOR')" : c.destinatarios === 'Regionais' ? "('REGIONAL')" : "('DIRECTOR','REGIONAL','MSC')";
  const r = await env.DB.prepare(`SELECT ut.email, ut.nome, ut.papel, cl.nome AS clube, l.data AS lido_em FROM utilizadores ut
      LEFT JOIN clubes cl ON cl.id=ut.clube_id LEFT JOIN leituras l ON l.comunicado_id=? AND l.email=ut.email
    WHERE ut.activo=1 AND ut.email<>? AND ut.papel IN ${papeis} AND (?='Missão' OR COALESCE(cl.regiao_id, ut.regiao_id)=?) ORDER BY l.data IS NULL DESC, ut.nome`)
    .bind(c.id, c.autor_email, c.ambito, c.regiao_id || '').all();
  return r.results;
}

/* ---- transferências ---- */
async function clubesDestino(env) {
  return (await env.DB.prepare('SELECT id, nome, regiao_id FROM clubes WHERE activo=1 ORDER BY nome').all()).results;
}
async function podePasso(env, u, passo, t) {
  if (u.papel === 'MSC') return true;
  if (passo.tipo === 'missao') return false;
  if (passo.tipo === 'regiao_origem') return u.papel === 'REGIONAL' && u.regiao_id === t.regiao_origem;
  if (passo.tipo === 'regiao_destino') return u.papel === 'REGIONAL' && u.regiao_id === t.regiao_destino;
  if (passo.tipo === 'destino') return (u.papel === 'REGIONAL' && u.regiao_id === t.regiao_destino) || (u.papel === 'DIRECTOR' && u.clube_id === t.clube_destino);
  return false;
}
const NOME_PASSO = { destino: 'Clube de destino', regiao_origem: 'Região de origem', regiao_destino: 'Região de destino', missao: 'Missão' };
function avisoPasso(env, t, passo, autor) {
  const base = { titulo: `Transferência a aprovar: ${t.membro_nome}`, texto: `${NOME_PASSO[passo.tipo]} — falta a sua decisão.`, aba: 'pedidos', autor };
  if (passo.tipo === 'destino') return notificar(env, Object.assign(base, { para_tipo: 'clube', para_id: t.clube_destino }));
  if (passo.tipo === 'regiao_origem') return notificar(env, Object.assign(base, { para_tipo: 'regiao', para_id: t.regiao_origem }));
  if (passo.tipo === 'regiao_destino') return notificar(env, Object.assign(base, { para_tipo: 'regiao', para_id: t.regiao_destino }));
  return notificar(env, Object.assign(base, { para_tipo: 'msc' }));
}
async function transferencias(env, u, p) {
  const f = (u.papel === 'MSC' ? '1=1' : u.papel === 'REGIONAL' ? '(t.regiao_origem=?1 OR t.regiao_destino=?1)' : '(t.clube_origem=?2 OR t.clube_destino=?2)') + ' AND ?1=?1 AND ?2=?2';
  const r = await env.DB.prepare(`SELECT t.*, co.nome AS origem_nome, cd.nome AS destino_nome FROM transferencias t LEFT JOIN clubes co ON co.id=t.clube_origem
    LEFT JOIN clubes cd ON cd.id=t.clube_destino WHERE ${f} ORDER BY t.estado='Pendente' DESC, t.pedido_em DESC LIMIT 200`).bind(u.regiao_id || '', u.clube_id || '').all();
  const out = [];
  for (const t of r.results) {
    t.passos = JSON.parse(t.passos || '[]');
    const prox = t.passos.find(x => x.estado === 'Pendente');
    t.posso_decidir = t.estado === 'Pendente' && prox ? await podePasso(env, u, prox, t) : false;
    out.push(t);
  }
  return out;
}
async function pedirTransferencia(env, u, p) {
  const m = await env.DB.prepare('SELECT * FROM membros WHERE id=?').bind(p.membro_id).first();
  exigir(m && m.activo, 'Membro não encontrado ou inactivo.');
  const co = await exigirClube(env, u, m.clube_id);
  exigir(!(await env.DB.prepare(`SELECT 1 FROM transferencias WHERE membro_id=? AND estado='Pendente'`).bind(m.id).first()), 'Já existe uma transferência pendente para este membro.');
  const motivo = txt(p.motivo, 500); exigir(motivo, 'Indique o motivo.');
  const t = { id: novoId(), membro_id: m.id, membro_nome: m.nome, clube_origem: co.id, regiao_origem: co.regiao_id, clube_destino: null, regiao_destino: null, missao_destino: null, motivo };
  let passos;
  if (p.tipo === 'Outra missão') {
    t.missao_destino = txt(p.missao_destino, 120); exigir(t.missao_destino, 'Indique a missão de destino.');
    t.tipo = 'Outra missão'; passos = ['regiao_origem', 'missao'];
  } else {
    const cd = await env.DB.prepare('SELECT * FROM clubes WHERE id=? AND activo=1').bind(p.clube_destino).first();
    exigir(cd && cd.id !== co.id, 'Escolha o clube de destino.');
    t.clube_destino = cd.id; t.regiao_destino = cd.regiao_id;
    t.tipo = cd.regiao_id === co.regiao_id ? 'Na mesma região' : 'Outra região';
    passos = t.tipo === 'Na mesma região' ? ['destino'] : ['regiao_origem', 'regiao_destino', 'destino'];
  }
  t.passos = passos.map(tipo => ({ tipo, estado: 'Pendente' }));
  // Os passos que quem pede já pode aprovar ficam aprovados logo.
  for (const ps of t.passos) { if (await podePasso(env, u, ps, t)) Object.assign(ps, { estado: 'Aprovado', por: u.email, em: agora(), nota: 'Aprovado ao pedir' }); else break; }
  const pend = t.passos.find(x => x.estado === 'Pendente');
  t.estado = pend ? 'Pendente' : 'Aprovada';
  const st = [env.DB.prepare(`INSERT INTO transferencias (id,membro_id,membro_nome,clube_origem,regiao_origem,clube_destino,regiao_destino,missao_destino,tipo,motivo,estado,passos,pedido_por,pedido_em,concluida_em)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(t.id, t.membro_id, t.membro_nome, t.clube_origem, t.regiao_origem, t.clube_destino, t.regiao_destino, t.missao_destino, t.tipo,
      t.motivo, t.estado, JSON.stringify(t.passos), u.email, agora(), pend ? null : agora())];
  if (pend) st.push(avisoPasso(env, t, pend, u.email)); else st.push(...executarTransferencia(env, t, u.email));
  await env.DB.batch(st);
  await auditar(env, u, 'pedir', 'transferencias', t.id, `${m.nome} → ${t.clube_destino || t.missao_destino}`);
  return { id: t.id, estado: t.estado };
}
function executarTransferencia(env, t, autor) {
  const ano = new Date().getFullYear();
  const st = [];
  if (t.tipo === 'Outra missão') {
    st.push(env.DB.prepare(`UPDATE membros SET activo=0, obs=TRIM(COALESCE(obs,'')||' Transferido para '||?||' em '||?), actualizado_em=? WHERE id=?`).bind(t.missao_destino, agora().slice(0, 10), agora(), t.membro_id));
  } else {
    st.push(env.DB.prepare('UPDATE membros SET clube_id=?, unidade_id=NULL, actualizado_em=? WHERE id=?').bind(t.clube_destino, agora(), t.membro_id));
    st.push(env.DB.prepare('UPDATE classes SET clube_id=? WHERE membro_id=? AND ano>=?').bind(t.clube_destino, t.membro_id, ano));
    st.push(env.DB.prepare('UPDATE especialidades SET clube_id=? WHERE membro_id=?').bind(t.clube_destino, t.membro_id));
    st.push(notificar(env, { para_tipo: 'clube', para_id: t.clube_destino, titulo: `Novo membro transferido: ${t.membro_nome}`, aba: 'membros', autor }));
  }
  st.push(notificar(env, { para_tipo: 'clube', para_id: t.clube_origem, titulo: `Transferência concluída: ${t.membro_nome}`, texto: t.tipo === 'Outra missão' ? 'Para ' + t.missao_destino : null, aba: 'pedidos', autor }));
  return st;
}
async function decidirTransferencia(env, u, p) {
  const t = await env.DB.prepare('SELECT * FROM transferencias WHERE id=?').bind(p.id).first();
  exigir(t && t.estado === 'Pendente', 'Transferência não encontrada ou já decidida.');
  t.passos = JSON.parse(t.passos || '[]');
  const ps = t.passos.find(x => x.estado === 'Pendente');
  exigir(ps && await podePasso(env, u, ps, t), 'Esta decisão não lhe cabe.');
  const nota = txt(p.nota, 300);
  exigir(p.aprovar || nota, 'Indique o motivo da recusa.');
  Object.assign(ps, { estado: p.aprovar ? 'Aprovado' : 'Recusado', por: u.email, em: agora(), nota });
  const st = [];
  if (!p.aprovar) {
    t.estado = 'Recusada';
    st.push(notificar(env, { para_tipo: 'clube', para_id: t.clube_origem, titulo: `Transferência recusada: ${t.membro_nome}`, texto: nota, aba: 'pedidos', autor: u.email }));
  } else {
    for (const nx of t.passos) { if (nx.estado !== 'Pendente') continue; if (await podePasso(env, u, nx, t)) Object.assign(nx, { estado: 'Aprovado', por: u.email, em: agora() }); else break; }
    const prox = t.passos.find(x => x.estado === 'Pendente');
    if (prox) st.push(avisoPasso(env, t, prox, u.email)); else { t.estado = 'Aprovada'; st.push(...executarTransferencia(env, t, u.email)); }
  }
  st.unshift(env.DB.prepare('UPDATE transferencias SET estado=?, passos=?, concluida_em=? WHERE id=?').bind(t.estado, JSON.stringify(t.passos), t.estado === 'Pendente' ? null : agora(), t.id));
  await env.DB.batch(st);
  await auditar(env, u, p.aprovar ? 'aprovar' : 'recusar', 'transferencias', t.id, nota);
  return { estado: t.estado };
}

/* ---- solicitações de serviço ---- */
const TIPOS_SOL = ['Cerimónia de admissão', 'Investidura', 'Visita da região', 'Formação / capacitação', 'Apoio para evento', 'Outro'];
const PRAZO_REGIAO_DIAS = 14;
const histo = (h, por, accao, nota) => JSON.stringify([...(JSON.parse(h || '[]')), { data: agora(), por, accao, nota: nota || null }]);

async function escalarSolicitacoes(env, leve) {
  const r = await env.DB.prepare(`SELECT s.*, c.nome AS clube FROM solicitacoes s JOIN clubes c ON c.id=s.clube_id WHERE s.estado='Na região' AND s.prazo_regiao < ? LIMIT 50`).bind(agora()).all();
  if (!r.results.length) return 0;
  const nota = `Encaminhada automaticamente: a região não respondeu em ${PRAZO_REGIAO_DIAS} dias.`;
  const st = [];
  for (const s of r.results) {
    st.push(env.DB.prepare(`UPDATE solicitacoes SET estado='Na Missão', regiao_decisao='Sem resposta', regiao_nota=?, historico=?, actualizado_em=? WHERE id=? AND estado='Na região'`)
      .bind(nota, histo(s.historico, 'Sistema', 'Encaminhada à Missão', nota), agora(), s.id));
    const base = { titulo: `Solicitação encaminhada à Missão: ${s.tipo}`, texto: `${s.clube} — ${nota}`, aba: 'pedidos', autor: 'sistema' };
    st.push(notificar(env, Object.assign({}, base, { para_tipo: 'msc' })), notificar(env, Object.assign({}, base, { para_tipo: 'clube', para_id: s.clube_id })),
      notificar(env, Object.assign({}, base, { para_tipo: 'regiao', para_id: s.regiao_id })));
  }
  await env.DB.batch(st.slice(0, 45));
  return r.results.length;
}

async function solicitacoes(env, u) {
  await escalarSolicitacoes(env, true);
  const f = (u.papel === 'MSC' ? '1=1' : u.papel === 'REGIONAL' ? 's.regiao_id=?1' : 's.clube_id=?2') + ' AND ?1=?1 AND ?2=?2';
  const r = await env.DB.prepare(`SELECT s.*, c.nome AS clube FROM solicitacoes s JOIN clubes c ON c.id=s.clube_id WHERE ${f}
    ORDER BY CASE s.estado WHEN 'Na região' THEN 0 WHEN 'Na Missão' THEN 1 ELSE 2 END, s.criado_em DESC LIMIT 200`).bind(u.regiao_id || '', u.clube_id || '').all();
  return r.results.map(s => Object.assign(s, { historico: JSON.parse(s.historico || '[]'),
    posso_decidir: (s.estado === 'Na região' && (u.papel === 'MSC' || (u.papel === 'REGIONAL' && u.regiao_id === s.regiao_id))) || (s.estado === 'Na Missão' && u.papel === 'MSC') }));
}

async function criarSolicitacao(env, u, p) {
  const r = p.registo || {};
  const c = await exigirClube(env, u, r.clube_id);
  exigir(TIPOS_SOL.includes(r.tipo), 'Escolha o tipo de pedido.');
  const desc = txt(r.descricao, 1500); exigir(desc, 'Descreva o pedido.');
  const dp = txt(r.data_pretendida, 10); exigir(!dp || reData.test(dp), 'Data inválida.');
  const id = novoId(), prazo = new Date(Date.now() + PRAZO_REGIAO_DIAS * 864e5).toISOString();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO solicitacoes (id,clube_id,regiao_id,tipo,descricao,data_pretendida,local,estado,criado_por,criado_em,prazo_regiao,historico,actualizado_em)
      VALUES (?,?,?,?,?,?,?,'Na região',?,?,?,?,?)`).bind(id, c.id, c.regiao_id, r.tipo, desc, dp, txt(r.local, 150), u.email, agora(), prazo, histo(null, u.email, 'Pedido criado'), agora()),
    notificar(env, { para_tipo: 'regiao', para_id: c.regiao_id, titulo: `Nova solicitação: ${r.tipo}`, texto: `${c.nome} — tem ${PRAZO_REGIAO_DIAS} dias para responder.`, aba: 'pedidos', autor: u.email })
  ]);
  await auditar(env, u, 'criar', 'solicitacoes', id, r.tipo);
  return { id };
}

async function decidirSolicitacao(env, u, p) {
  const s = await env.DB.prepare('SELECT s.*, c.nome AS clube FROM solicitacoes s JOIN clubes c ON c.id=s.clube_id WHERE s.id=?').bind(p.id).first();
  exigir(s, 'Solicitação não encontrada.');
  const nota = txt(p.nota, 500);
  exigir(p.aprovar || nota, 'Indique o motivo da recusa.');
  const st = [];
  if (s.estado === 'Na região') {
    exigir(u.papel === 'MSC' || (u.papel === 'REGIONAL' && u.regiao_id === s.regiao_id), 'Esta decisão não lhe cabe.');
    if (u.papel === 'MSC' && p.aprovar && p.final) {
      st.push(env.DB.prepare(`UPDATE solicitacoes SET estado='Aprovada', missao_decisao='Aprovada', missao_nota=?, historico=?, actualizado_em=? WHERE id=?`).bind(nota, histo(s.historico, u.email, 'Aprovada pela Missão', nota), agora(), s.id));
    } else if (p.aprovar) {
      st.push(env.DB.prepare(`UPDATE solicitacoes SET estado='Na Missão', regiao_decisao='Aprovada', regiao_nota=?, historico=?, actualizado_em=? WHERE id=?`).bind(nota, histo(s.historico, u.email, 'Aprovada pela região e enviada à Missão', nota), agora(), s.id));
      st.push(notificar(env, { para_tipo: 'msc', titulo: `Solicitação para decidir: ${s.tipo}`, texto: `${s.clube} — aprovada pela região.`, aba: 'pedidos', autor: u.email }));
    } else {
      st.push(env.DB.prepare(`UPDATE solicitacoes SET estado='Recusada', regiao_decisao='Recusada', regiao_nota=?, historico=?, actualizado_em=? WHERE id=?`).bind(nota, histo(s.historico, u.email, 'Recusada pela região', nota), agora(), s.id));
    }
  } else if (s.estado === 'Na Missão') {
    exigir(u.papel === 'MSC', 'Só a Missão decide nesta fase.');
    const e = p.aprovar ? 'Aprovada' : 'Recusada';
    st.push(env.DB.prepare(`UPDATE solicitacoes SET estado=?, missao_decisao=?, missao_nota=?, historico=?, actualizado_em=? WHERE id=?`).bind(e, e, nota, histo(s.historico, u.email, e + ' pela Missão', nota), agora(), s.id));
    st.push(notificar(env, { para_tipo: 'regiao', para_id: s.regiao_id, titulo: `Solicitação ${e.toLowerCase()} pela Missão: ${s.tipo}`, texto: s.clube, aba: 'pedidos', autor: u.email }));
  } else falha('Esta solicitação já foi decidida.');
  st.push(notificar(env, { para_tipo: 'clube', para_id: s.clube_id, titulo: `Actualização do seu pedido: ${s.tipo}`, texto: (nota ? nota + ' ' : '') + '— veja em Pedidos.', aba: 'pedidos', autor: u.email }));
  await env.DB.batch(st);
  await auditar(env, u, p.aprovar ? 'aprovar' : 'recusar', 'solicitacoes', s.id, nota);
  return true;
}

/* ======================= FASE 5 ======================= */

async function cfgLer(env, chave) { return await env.DB.prepare('SELECT valor FROM config WHERE chave=?').bind(chave).first('valor'); }
function cfgGravar(env, chave, valor) { return env.DB.prepare('INSERT INTO config (chave,valor) VALUES (?,?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor').bind(chave, valor); }
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/* ---- e-mail (Brevo, opcional) ---- */
async function enviarEmail(env, para, assunto, html) {
  const chave = await cfgLer(env, 'brevo_chave'), rem = await cfgLer(env, 'email_remetente');
  if (!chave || !rem) return false;
  let r;
  try { r = await fetch('https://api.brevo.com/v3/smtp/email', { method: 'POST', headers: { 'api-key': chave, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ sender: { email: rem, name: 'SGC Desbravadores MSC' }, to: [{ email: para }], subject: assunto, htmlContent: html }) }); }
  catch (e) { console.error('email', e); return false; }
  if (!r.ok) { console.error('email', r.status, await r.text()); return false; }
  return true;
}
async function configEmail(env, u) {
  exigir(u.papel === 'MSC');
  return { configurado: !!(await cfgLer(env, 'brevo_chave')), remetente: await cfgLer(env, 'email_remetente') };
}
async function guardarConfigEmail(env, u, p) {
  exigir(u.papel === 'MSC');
  const rem = limparEmail(p.remetente);
  exigir(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(rem), 'Email do remetente inválido.');
  const st = [cfgGravar(env, 'email_remetente', rem)];
  if (p.chave) st.push(cfgGravar(env, 'brevo_chave', String(p.chave).trim()));
  if (p.apagar) st.push(env.DB.prepare(`DELETE FROM config WHERE chave='brevo_chave'`));
  await env.DB.batch(st);
  await auditar(env, u, 'config', 'config', 'email', rem);
  return true;
}
async function testarEmail(env, u) {
  exigir(u.papel === 'MSC');
  const ok = await enviarEmail(env, u.email, 'Teste do SGC Desbravadores MSC', '<p>O envio de e-mails do SGC está a funcionar.</p>');
  exigir(ok, 'O e-mail não foi enviado. Confirme a chave Brevo e o remetente verificado.');
  return true;
}

/* ---- recuperação da palavra-passe ---- */
const MSG_CODIGO = 'Se o email estiver registado, receberá um código de 6 dígitos. Veja também a pasta de spam.';
async function pedirCodigo(env, p) {
  const email = limparEmail(p.email);
  exigir(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email), 'Email inválido.');
  const u = await env.DB.prepare(`SELECT u.*, COALESCE((SELECT c.regiao_id FROM clubes c WHERE c.id=u.clube_id), u.regiao_id) AS reg FROM utilizadores u WHERE email=? AND activo=1`).bind(email).first();
  if (!u) return { modo: 'email', mensagem: MSG_CODIGO };
  const recentes = await env.DB.prepare(`SELECT COUNT(*) AS n FROM codigos_senha WHERE email=? AND criado_em > ?`).bind(email, new Date(Date.now() - 3600e3).toISOString()).first('n');
  exigir(recentes < 3, 'Já pediu vários códigos. Espere uma hora ou peça ajuda à sua região.');
  const temEmail = !!(await cfgLer(env, 'brevo_chave'));
  if (!temEmail) {
    // Sem e-mail configurado: o pedido vai para quem pode repor a palavra-passe.
    const para = u.papel === 'DIRECTOR' && u.reg ? { para_tipo: 'regiao', para_id: u.reg } : { para_tipo: 'msc' };
    await env.DB.batch([
      env.DB.prepare('INSERT INTO codigos_senha (email,hash,expira_em,criado_em) VALUES (?,?,?,?)').bind(email, 'pedido', agora(), agora()),
      notificar(env, Object.assign(para, { titulo: `Pedido de nova palavra-passe: ${u.nome}`, texto: `${email} esqueceu a palavra-passe. Reponha-a em Gestão → Utilizadores.`, aba: 'admin', autor: email }))
    ]);
    await processarPush(env).catch(() => {});
    return { modo: 'responsavel', mensagem: 'O seu pedido foi enviado ao responsável (região ou Missão), que lhe vai dar uma nova palavra-passe.' };
  }
  const codigo = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
  await env.DB.batch([
    env.DB.prepare('DELETE FROM codigos_senha WHERE email=? AND expira_em < ?').bind(email, agora()),
    env.DB.prepare('INSERT INTO codigos_senha (email,hash,expira_em,criado_em) VALUES (?,?,?,?)').bind(email, await sha256(email + ':' + codigo), new Date(Date.now() + 15 * 6e4).toISOString(), agora())
  ]);
  await enviarEmail(env, email, 'Código para nova palavra-passe — SGC MSC',
    `<p>Olá ${u.nome.replace(/</g, '')},</p><p>O seu código para criar uma nova palavra-passe no SGC Desbravadores MSC é:</p>
     <p style="font-size:28px;font-weight:bold;letter-spacing:6px">${codigo}</p><p>É válido durante 15 minutos. Se não foi você que pediu, ignore este e-mail.</p>`);
  return { modo: 'email', mensagem: MSG_CODIGO };
}
async function reporSenha(env, p) {
  const email = limparEmail(p.email); const codigo = String(p.codigo || '').trim();
  exigir(/^\d{6}$/.test(codigo), 'O código tem 6 dígitos.');
  validarSenha(p.nova);
  const c = await env.DB.prepare(`SELECT rowid AS rid, * FROM codigos_senha WHERE email=? AND hash<>'pedido' AND expira_em > ? ORDER BY criado_em DESC LIMIT 1`).bind(email, agora()).first();
  exigir(c, 'Código inválido ou expirado. Peça um novo.');
  if (c.tentativas >= 5) falha('Demasiadas tentativas. Peça um novo código.');
  if (!igual(await sha256(email + ':' + codigo), c.hash)) {
    await env.DB.prepare('UPDATE codigos_senha SET tentativas=tentativas+1 WHERE rowid=?').bind(c.rid).run();
    falha('Código incorrecto.');
  }
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  await env.DB.batch([
    env.DB.prepare('UPDATE utilizadores SET hash=?, salt=?, tentativas=0, bloqueado_ate=NULL WHERE email=?').bind(await hashSenha(p.nova, salt), salt, email),
    env.DB.prepare('DELETE FROM sessoes WHERE email=?').bind(email),
    env.DB.prepare('DELETE FROM codigos_senha WHERE email=?').bind(email)
  ]);
  await auditar(env, { email }, 'reporSenha', 'utilizadores', email);
  return { token: await criarSessao(env, email) };
}

/* ---- notificações push (Web Push com VAPID, sem conteúdo cifrado: a app vai buscar o texto) ---- */
async function chavesVapid(env) {
  let pub = await cfgLer(env, 'vapid_pub'), priv = await cfgLer(env, 'vapid_priv');
  if (!pub || !priv) {
    const k = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    pub = b64url(await crypto.subtle.exportKey('raw', k.publicKey)); priv = JSON.stringify(await crypto.subtle.exportKey('jwk', k.privateKey));
    await env.DB.batch([cfgGravar(env, 'vapid_pub', pub), cfgGravar(env, 'vapid_priv', priv)]);
  }
  return { pub, priv };
}
async function pushChave(env) { return { chave: (await chavesVapid(env)).pub }; }
async function registarPush(env, u, p) {
  const s = p.subscricao || {};
  exigir(typeof s.endpoint === 'string' && /^https:\/\//.test(s.endpoint) && s.endpoint.length < 1000, 'Subscrição inválida.');
  await env.DB.prepare('INSERT INTO push (endpoint,email,dados,criado_em) VALUES (?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET email=excluded.email, dados=excluded.dados')
    .bind(s.endpoint, u.email, JSON.stringify(s).slice(0, 2000), agora()).run();
  return true;
}
async function removerPush(env, u, p) { await env.DB.prepare('DELETE FROM push WHERE endpoint=? AND email=?').bind(String(p.endpoint || ''), u.email).run(); return true; }

async function jwtVapid(priv, aud) {
  const k = await crypto.subtle.importKey('jwk', JSON.parse(priv), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const enc = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const dados = enc({ typ: 'JWT', alg: 'ES256' }) + '.' + enc({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'mailto:coordenacaodbvmsc1@gmail.com' });
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, k, new TextEncoder().encode(dados));
  return dados + '.' + b64url(sig);
}
const destinatariosSQL = `SELECT DISTINCT p.endpoint FROM push p JOIN utilizadores u ON u.email=p.email AND u.activo=1 WHERE p.email<>COALESCE(?5,'') AND (
  ?1='todos' OR (?1='msc' AND u.papel='MSC') OR (?1='regiao' AND u.papel='REGIONAL' AND u.regiao_id=?2)
  OR (?1='regiao_todos' AND u.papel<>'MSC' AND COALESCE((SELECT c.regiao_id FROM clubes c WHERE c.id=u.clube_id), u.regiao_id)=?2)
  OR (?1='clube' AND u.papel='DIRECTOR' AND u.clube_id=?3) OR (?1='user' AND u.email=?4))`;
async function processarPush(env) {
  const marca = (await cfgLer(env, 'push_marca')) || agora();
  const ns = (await env.DB.prepare('SELECT * FROM notificacoes WHERE data > ? ORDER BY data LIMIT 10').bind(marca).all()).results;
  if (!ns.length) { if (!(await cfgLer(env, 'push_marca'))) await cfgGravar(env, 'push_marca', marca).run(); return 0; }
  await cfgGravar(env, 'push_marca', ns[ns.length - 1].data).run();
  const alvos = new Set();
  for (const n of ns) {
    const r = await env.DB.prepare(destinatariosSQL).bind(n.para_tipo, n.para_id || '', n.para_id || '', n.para_id || '', n.autor || '').all();
    r.results.forEach(x => alvos.add(x.endpoint));
  }
  if (!alvos.size) return 0;
  const { pub, priv } = await chavesVapid(env);
  const jwts = {}; let enviados = 0; const mortos = [];
  for (const ep of [...alvos].slice(0, 35)) {
    try {
      const aud = new URL(ep).origin; jwts[aud] = jwts[aud] || await jwtVapid(priv, aud);
      const r = await fetch(ep, { method: 'POST', headers: { TTL: '86400', Urgency: 'normal', Authorization: `vapid t=${jwts[aud]}, k=${pub}`, 'Content-Length': '0' } });
      if (r.status === 404 || r.status === 410) mortos.push(ep); else if (r.ok) enviados++;
    } catch (e) { console.error('push', e); }
  }
  if (mortos.length) await env.DB.prepare('DELETE FROM push WHERE endpoint IN (SELECT value FROM json_each(?))').bind(JSON.stringify(mortos)).run();
  return enviados;
}

/* ---- ficha individual e cartões ---- */
async function fichaMembro(env, u, p) {
  const m = await env.DB.prepare('SELECT * FROM membros WHERE id=?').bind(p.id).first();
  exigir(m, 'Membro não encontrado.');
  const c = await exigirClube(env, u, m.clube_id);
  const ano = new Date().getFullYear();
  const [cl, esp, pres, pts, pag, tra, ins, un] = await env.DB.batch([
    env.DB.prepare(`SELECT k.*, (SELECT COUNT(*) FROM cumprimentos x JOIN requisitos q ON q.id=x.requisito_id WHERE x.classe_id=k.id AND q.avancado=0) AS feitos,
      (SELECT COUNT(*) FROM requisitos q WHERE q.classe=k.classe AND q.avancado=0 AND q.activo=1) AS total FROM classes k WHERE k.membro_id=? ORDER BY k.ano DESC`).bind(m.id),
    env.DB.prepare('SELECT especialidade, categoria, data_conclusao FROM especialidades WHERE membro_id=? ORDER BY data_conclusao DESC').bind(m.id),
    env.DB.prepare(`SELECT substr(a.data,1,4) AS ano, SUM(x.estado='P') AS p, SUM(x.estado='F') AS f, SUM(x.estado='J') AS j FROM presencas x JOIN actividades a ON a.id=x.actividade_id
      WHERE x.membro_id=? GROUP BY 1 ORDER BY 1 DESC`).bind(m.id),
    env.DB.prepare(`SELECT COALESCE(SUM(pontos),0) AS total, COUNT(*) AS n FROM pontos WHERE membro_id=? AND substr(data,1,4)=?`).bind(m.id, String(ano)),
    env.DB.prepare('SELECT tipo, ano, valor, data FROM pagamentos WHERE membro_id=? ORDER BY data DESC').bind(m.id),
    env.DB.prepare(`SELECT t.tipo, t.estado, t.pedido_em, co.nome AS origem, COALESCE(cd.nome, t.missao_destino) AS destino FROM transferencias t LEFT JOIN clubes co ON co.id=t.clube_origem
      LEFT JOIN clubes cd ON cd.id=t.clube_destino WHERE t.membro_id=? ORDER BY t.pedido_em DESC`).bind(m.id),
    env.DB.prepare('SELECT e.nome, e.data_inicio, e.tipo FROM inscricoes i JOIN eventos e ON e.id=i.evento_id WHERE i.membro_id=? ORDER BY e.data_inicio DESC').bind(m.id),
    env.DB.prepare('SELECT nome FROM unidades WHERE id=?').bind(m.unidade_id || '')
  ]);
  return { membro: m, clube: { id: c.id, nome: c.nome, regiao_id: c.regiao_id }, unidade: (un.results[0] || {}).nome || null, classes: cl.results, especialidades: esp.results,
    presencas: pres.results, pontos_ano: pts.results[0], pagamentos: pag.results, transferencias: tra.results, eventos: ins.results, ano };
}
async function cartoesMembros(env, u, p) {
  const c = await exigirClube(env, u, p.clube_id);
  const ano = new Date().getFullYear();
  const filtro = Array.isArray(p.ids) && p.ids.length ? ' AND m.id IN (SELECT value FROM json_each(?))' : '';
  const r = await env.DB.prepare(`SELECT m.id, m.nome, m.tipo, m.cargo, m.data_nasc, un.nome AS unidade,
      (SELECT k.classe FROM classes k WHERE k.membro_id=m.id AND k.ano=? LIMIT 1) AS classe
    FROM membros m LEFT JOIN unidades un ON un.id=m.unidade_id WHERE m.clube_id=? AND m.activo=1${filtro} ORDER BY m.tipo<>'Desbravador', m.nome`)
    .bind(ano, c.id, ...(filtro ? [JSON.stringify(p.ids)] : [])).all();
  return { clube: c.nome, regiao_id: c.regiao_id, ano, membros: r.results };
}

/* ---- passagem de ano ---- */
async function passagemAno(env, u, p) {
  await exigirClube(env, u, p.clube_id);
  const ano = Number(p.ano) || new Date().getFullYear();
  const r = await env.DB.prepare(`SELECT m.id, m.nome, m.data_nasc,
      (SELECT k.classe FROM classes k WHERE k.membro_id=m.id AND k.ano=? ORDER BY k.rowid DESC LIMIT 1) AS classe_ant,
      (SELECT k.estado FROM classes k WHERE k.membro_id=m.id AND k.ano=? ORDER BY k.rowid DESC LIMIT 1) AS estado_ant,
      (SELECT MAX(CASE k.classe WHEN 'Amigo' THEN 1 WHEN 'Companheiro' THEN 2 WHEN 'Pesquisador' THEN 3 WHEN 'Pioneiro' THEN 4 WHEN 'Excursionista' THEN 5 WHEN 'Guia' THEN 6 END)
         FROM classes k WHERE k.membro_id=m.id AND k.estado='Investido') AS max_inv,
      EXISTS(SELECT 1 FROM classes k WHERE k.membro_id=m.id AND k.ano=?) AS ja
    FROM membros m WHERE m.clube_id=? AND m.activo=1 AND m.tipo='Desbravador' ORDER BY m.nome`).bind(ano - 1, ano - 1, ano, p.clube_id).all();
  return { ano, lista: r.results.map(x => {
    let proposta = null, motivo;
    if (x.ja) motivo = 'Já inscrito em ' + ano;
    else if (x.max_inv >= 6) motivo = 'Já investido em Guia';
    else if (x.estado_ant === 'Concluído' && CLASSES.indexOf(x.classe_ant) >= 0 && CLASSES.indexOf(x.classe_ant) > (x.max_inv || 0) - 1) {
      const i = CLASSES.indexOf(x.classe_ant); proposta = CLASSES[i + 1] || null; motivo = i === 5 ? 'Concluiu Guia' : 'Concluiu ' + x.classe_ant + ' (falta a investidura)'; }
    else if (x.max_inv) { proposta = CLASSES[x.max_inv]; motivo = 'Investido em ' + CLASSES[x.max_inv - 1]; }
    else if (x.classe_ant && x.estado_ant !== 'Investido') { proposta = x.classe_ant; motivo = 'Não concluiu ' + x.classe_ant + ' (repete)'; }
    else { proposta = classePorIdade(x.data_nasc, ano); motivo = proposta ? 'Pela idade' : 'Sem data de nascimento'; }
    return { id: x.id, nome: x.nome, classe_ant: x.classe_ant, estado_ant: x.estado_ant, proposta, motivo, ja: !!x.ja };
  }) };
}
async function inscreverClassesLista(env, u, p) {
  await exigirClube(env, u, p.clube_id);
  const ano = Number(p.ano); exigir(ano >= 2020 && ano <= 2100, 'Ano inválido.');
  const itens = (Array.isArray(p.itens) ? p.itens : []).filter(x => x && CLASSES.includes(x.classe)).slice(0, 300);
  exigir(itens.length, 'Nada para inscrever.');
  await membrosDoClube(env, p.clube_id, itens.map(x => x.membro_id));
  const st = inserirVarios(env, 'classes', ['id', 'clube_id', 'membro_id', 'ano', 'classe', 'estado'], itens.map(x => [novoId(), p.clube_id, x.membro_id, ano, x.classe, 'Inscrito']), 'INSERT OR IGNORE');
  await env.DB.batch(st);
  await auditar(env, u, 'passagemAno', 'classes', p.clube_id, `${itens.length} → ${ano}`);
  return { inscritos: itens.length };
}

/* ---- classificação de clubes e regiões ---- */
const PESOS = { assiduidade: 25, relatorios: 20, inspecao: 15, investidura: 15, especialidades: 10, actividades: 10, seguro: 5 };
async function classificacao(env, u, p) {
  const ano = Number(p.ano) || new Date().getFullYear();
  const hojeS = agora().slice(0, 10);
  const de = `${ano}-01-01`, ate = ano === Number(hojeS.slice(0, 4)) ? hojeS : `${ano}-12-31`;
  const meses = ano === Number(hojeS.slice(0, 4)) ? Math.max(1, Number(hojeS.slice(5, 7)) - 1) : 12; // relatórios esperados (meses fechados)
  const mesesAct = Math.max(1, Number(ate.slice(5, 7)));
  const r = await env.DB.prepare(`SELECT c.id, c.nome, c.regiao_id,
      (SELECT COUNT(*) FROM membros m WHERE m.clube_id=c.id AND m.activo=1 AND m.tipo='Desbravador') AS desb,
      (SELECT 100.0*SUM(x.estado='P')/NULLIF(COUNT(*),0) FROM presencas x JOIN actividades a ON a.id=x.actividade_id WHERE a.clube_id=c.id AND a.data BETWEEN ?1 AND ?2) AS assid,
      (SELECT COUNT(*) FROM actividades a WHERE a.clube_id=c.id AND a.data BETWEEN ?1 AND ?2) AS act,
      (SELECT COUNT(*) FROM relatorios rr WHERE rr.clube_id=c.id AND rr.ano=?3 AND rr.estado='Enviado') AS rel,
      (SELECT COUNT(*) FROM classes k WHERE k.clube_id=c.id AND k.ano=?3) AS insc,
      (SELECT COUNT(*) FROM classes k WHERE k.clube_id=c.id AND k.ano=?3 AND k.estado IN ('Investido','Concluído')) AS inv,
      (SELECT COUNT(*) FROM especialidades e WHERE e.clube_id=c.id AND e.data_conclusao BETWEEN ?1 AND ?2) AS esp,
      (SELECT COUNT(DISTINCT pg.membro_id) FROM pagamentos pg JOIN membros m ON m.id=pg.membro_id WHERE pg.clube_id=c.id AND pg.ano=?3 AND pg.tipo='Seguro anual' AND m.activo=1) AS seg,
      (SELECT COUNT(*) FROM membros m WHERE m.clube_id=c.id AND m.activo=1) AS membros,
      (SELECT i.nota FROM inspecoes i WHERE i.clube_id=c.id AND i.data BETWEEN ?1 AND ?2 ORDER BY i.data DESC LIMIT 1) AS insp
    FROM clubes c WHERE c.activo=1 ORDER BY c.nome`).bind(de, ate, ano).all();
  const lim = (v) => Math.max(0, Math.min(100, v));
  const clubes = r.results.map(c => {
    const ind = {
      assiduidade: c.assid == null ? 0 : lim(c.assid),
      relatorios: lim(c.rel / meses * 100),
      investidura: c.insc ? lim(c.inv / c.insc * 100) : 0,
      especialidades: c.desb ? lim(c.esp / c.desb * 100) : 0, // meta: 1 especialidade por desbravador no ano
      actividades: lim(c.act / (mesesAct * 4) * 100),          // meta: 4 actividades por mês
      seguro: c.membros ? lim(c.seg / c.membros * 100) : 0,
      inspecao: c.insp == null ? null : lim(c.insp)
    };
    // Sem inspecção no ano, o peso dela é repartido pelos outros indicadores (o clube não é penalizado por não ter sido visitado).
    const usados = Object.entries(PESOS).filter(([k]) => ind[k] != null), soma = usados.reduce((a, [, w]) => a + w, 0);
    const pontos = Math.round(usados.reduce((a, [k, w]) => a + ind[k] * w, 0) / soma);
    return { id: c.id, nome: c.nome, regiao_id: c.regiao_id, membros: c.membros, desbravadores: c.desb, indicadores: Object.fromEntries(Object.entries(ind).map(([k, v]) => [k, v == null ? null : Math.round(v)])), pontos };
  }).sort((a, b) => b.pontos - a.pontos || a.nome.localeCompare(b.nome));
  clubes.forEach((c, i) => c.posicao = i + 1);
  const reg = {};
  for (const c of clubes) { const g = reg[c.regiao_id] = reg[c.regiao_id] || { regiao_id: c.regiao_id, clubes: 0, membros: 0, soma: 0, ind: {} };
    g.clubes++; g.membros += c.membros; g.soma += c.pontos; for (const k in c.indicadores) if (c.indicadores[k] != null) { g.ind[k] = (g.ind[k] || 0) + c.indicadores[k]; g['n_' + k] = (g['n_' + k] || 0) + 1; } }
  const regioes = Object.values(reg).map(g => ({ regiao_id: g.regiao_id, clubes: g.clubes, membros: g.membros, pontos: Math.round(g.soma / g.clubes),
    indicadores: Object.fromEntries(Object.keys(PESOS).map(k => [k, g.ind[k] == null ? null : Math.round(g.ind[k] / g['n_' + k])])) })).sort((a, b) => b.pontos - a.pontos);
  return { ano, pesos: PESOS, meses_relatorio: meses, clubes, regioes };
}

/* ======================= FASE 6 ======================= */

/* ---- agenda (calendário) ---- */
const TIPOS_AGENDA = ['Reunião', 'Formação', 'Campori / Acampamento', 'Investidura', 'Prazo', 'Feriado / Data especial', 'Outro'];
async function agenda(env, u, p) {
  exigir(/^\d{4}-\d{2}$/.test(p.mes || ''), 'Mês inválido.');
  const [de] = limitesMes(Number(p.mes.slice(0, 4)), Number(p.mes.slice(5, 7)));
  // janela de 3 meses (mês anterior, actual e seguinte) para a lista "próximos"
  const ini = new Date(Date.UTC(Number(de.slice(0, 4)), Number(de.slice(5, 7)) - 2, 1)).toISOString().slice(0, 10);
  const fim = new Date(Date.UTC(Number(de.slice(0, 4)), Number(de.slice(5, 7)) + 1, 0)).toISOString().slice(0, 10);
  const reg = u.reg || '';
  const fReg = u.papel === 'MSC' ? '1=1' : `(x.ambito='Missão' OR x.regiao_id=?)`;
  const argsReg = u.papel === 'MSC' ? [] : [reg];
  const fEsc = u.papel === 'MSC' ? '1=1' : u.papel === 'REGIONAL' ? `(x.regiao_id=? OR x.clube_id IN (SELECT id FROM clubes WHERE regiao_id=?))` : `x.clube_id=?`;
  const argsEsc = u.papel === 'MSC' ? [] : u.papel === 'REGIONAL' ? [reg, reg] : [u.clube_id || ''];
  const fEv = u.papel === 'MSC' ? '1=1' : `(e.nivel='Missão' OR e.regiao_id=?)`;
  const fSol = u.papel === 'MSC' ? '1=1' : u.papel === 'REGIONAL' ? 's.regiao_id=?' : 's.clube_id=?';
  const argSol = u.papel === 'MSC' ? [] : [u.papel === 'REGIONAL' ? reg : (u.clube_id || '')];
  const [ag, ev, es, so, co] = await env.DB.batch([
    env.DB.prepare(`SELECT x.*, 'agenda' AS origem FROM agenda x WHERE COALESCE(x.data_fim,x.data_inicio)>=? AND x.data_inicio<=? AND ${fReg}`).bind(ini, fim, ...argsReg),
    env.DB.prepare(`SELECT e.id, e.nome AS titulo, e.tipo, e.data_inicio, e.data_fim, e.local, e.nivel, e.regiao_id FROM eventos e WHERE e.estado<>'Cancelado' AND e.data_fim>=? AND e.data_inicio<=? AND ${fEv}`).bind(ini, fim, ...argsReg),
    env.DB.prepare(`SELECT x.*, c.nome AS clube FROM escalas x LEFT JOIN clubes c ON c.id=x.clube_id WHERE x.estado<>'Cancelada' AND x.data BETWEEN ? AND ? AND ${fEsc}`).bind(ini, fim, ...argsEsc),
    env.DB.prepare(`SELECT s.id, s.tipo, s.data_pretendida, c.nome AS clube FROM solicitacoes s JOIN clubes c ON c.id=s.clube_id WHERE s.estado='Aprovada' AND s.data_pretendida BETWEEN ? AND ? AND ${fSol}`).bind(ini, fim, ...argSol),
    env.DB.prepare(`SELECT c.id, c.titulo, c.data_evento FROM comunicados c WHERE c.activo=1 AND c.data_evento BETWEEN ?5 AND ?6 AND ${visivelCom}`).bind(u.papel, reg, 1, u.email, ini, fim)
  ]);
  const itens = [
    ...ag.results.map(x => ({ id: x.id, origem: 'agenda', titulo: x.titulo, tipo: x.tipo, de: x.data_inicio, ate: x.data_fim || x.data_inicio, local: x.local, descricao: x.descricao, ambito: x.ambito, regiao_id: x.regiao_id, meu: u.papel === 'MSC' || (u.papel === 'REGIONAL' && x.regiao_id === u.regiao_id) })),
    ...ev.results.map(x => ({ id: x.id, origem: 'evento', titulo: x.titulo, tipo: x.tipo, de: x.data_inicio, ate: x.data_fim, local: x.local, ambito: x.nivel, regiao_id: x.regiao_id })),
    ...es.results.map(x => ({ id: x.id, origem: 'escala', titulo: `${x.funcao}: ${x.delegado_nome}`, tipo: 'Escala', de: x.data, ate: x.data, local: x.clube || x.local, hora: x.hora })),
    ...so.results.map(x => ({ id: x.id, origem: 'pedido', titulo: `${x.tipo} — ${x.clube}`, tipo: x.tipo, de: x.data_pretendida, ate: x.data_pretendida })),
    ...co.results.map(x => ({ id: x.id, origem: 'comunicado', titulo: x.titulo, tipo: 'Comunicado', de: x.data_evento, ate: x.data_evento }))
  ];
  // Prazo do relatório mensal: dia 10 de cada mês
  for (let i = -1; i <= 1; i++) {
    const d = new Date(Date.UTC(Number(de.slice(0, 4)), Number(de.slice(5, 7)) - 1 + i, 10)).toISOString().slice(0, 10);
    itens.push({ id: 'rel' + d, origem: 'prazo', titulo: 'Prazo do relatório mensal', tipo: 'Prazo', de: d, ate: d });
  }
  if (u.papel === 'DIRECTOR') (await aniversariosDoClube(env, u.clube_id, ini, fim)).forEach(x => itens.push({ id: 'ani' + x.id + x.data, origem: 'aniversario', titulo: `🎂 ${x.nome} (${x.idade} anos)`, tipo: 'Aniversário', de: x.data, ate: x.data }));
  return itens.sort((a, b) => a.de.localeCompare(b.de));
}
async function guardarAgenda(env, u, p) {
  exigir(u.papel !== 'DIRECTOR', 'Só a região e a Missão marcam datas na agenda.');
  const r = p.registo || {};
  const o = { titulo: txt(r.titulo, 150), tipo: TIPOS_AGENDA.includes(r.tipo) ? r.tipo : 'Outro', data_inicio: r.data_inicio, data_fim: r.data_fim || r.data_inicio, local: txt(r.local, 150), descricao: txt(r.descricao, 1000) };
  exigir(o.titulo, 'Indique o título.'); exigir(reData.test(o.data_inicio || '') && reData.test(o.data_fim || '') && o.data_fim >= o.data_inicio, 'Datas inválidas.');
  let ambito = 'Missão', regiao = null;
  if (u.papel === 'REGIONAL') { ambito = 'Região'; regiao = u.regiao_id; } else if (r.regiao_id) { ambito = 'Região'; regiao = r.regiao_id; }
  if (r.id) {
    const a = await env.DB.prepare('SELECT * FROM agenda WHERE id=?').bind(r.id).first();
    exigir(a && (u.papel === 'MSC' || a.regiao_id === u.regiao_id));
    await env.DB.prepare('UPDATE agenda SET titulo=?,tipo=?,data_inicio=?,data_fim=?,local=?,descricao=?,ambito=?,regiao_id=? WHERE id=?')
      .bind(o.titulo, o.tipo, o.data_inicio, o.data_fim, o.local, o.descricao, ambito, regiao, r.id).run();
    return { id: r.id };
  }
  const id = novoId();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO agenda (id,titulo,tipo,data_inicio,data_fim,ambito,regiao_id,local,descricao,criado_por,criado_em) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .bind(id, o.titulo, o.tipo, o.data_inicio, o.data_fim, ambito, regiao, o.local, o.descricao, u.email, agora()),
    notificar(env, Object.assign(ambito === 'Missão' ? { para_tipo: 'todos' } : { para_tipo: 'regiao_todos', para_id: regiao },
      { titulo: `Nova data na agenda: ${o.titulo}`, texto: o.data_inicio.split('-').reverse().join('/') + (o.local ? ' · ' + o.local : ''), aba: 'agenda', autor: u.email }))
  ]);
  return { id };
}
async function apagarAgenda(env, u, p) {
  const a = await env.DB.prepare('SELECT * FROM agenda WHERE id=?').bind(p.id).first();
  exigir(a && (u.papel === 'MSC' || (u.papel === 'REGIONAL' && a.regiao_id === u.regiao_id)));
  await env.DB.prepare('DELETE FROM agenda WHERE id=?').bind(a.id).run();
  return true;
}

/* ---- aniversários ---- */
async function aniversariosDoClube(env, clubeId, de, ate) {
  const r = await env.DB.prepare(`SELECT id, nome, data_nasc, tipo FROM membros WHERE clube_id=? AND activo=1 AND data_nasc IS NOT NULL`).bind(clubeId).all();
  const out = [];
  const a0 = Number(de.slice(0, 4)), a1 = Number(ate.slice(0, 4));
  for (const m of r.results) for (let a = a0; a <= a1; a++) {
    const d = a + m.data_nasc.slice(4);
    if (d >= de && d <= ate) out.push({ id: m.id, nome: m.nome, tipo: m.tipo, data: d, idade: a - Number(m.data_nasc.slice(0, 4)) });
  }
  return out.sort((x, y) => x.data.localeCompare(y.data));
}
async function aniversarios(env, u, p) {
  await exigirClube(env, u, p.clube_id);
  const h = agora().slice(0, 10);
  const ate = new Date(Date.parse(h) + 30 * 864e5).toISOString().slice(0, 10);
  return { hoje: h, lista: await aniversariosDoClube(env, p.clube_id, h, ate) };
}

/* ---- escala de delegados (região e Missão) ---- */
const FUNCOES_ESCALA = ['Delegado da Missão', 'Delegado da região', 'Pregador', 'Oficiante da investidura', 'Avaliador / inspector', 'Instrutor', 'Apoio', 'Outro'];
const ESTADOS_ESCALA = ['Agendada', 'Confirmada', 'Realizada', 'Cancelada'];
async function escalas(env, u, p) {
  exigir(u.papel !== 'DIRECTOR', 'A escala é só para a região e a Missão.');
  const f = u.papel === 'MSC' ? '1=1' : `(x.regiao_id=?1 OR c.regiao_id=?1)`;
  const de = reData.test(p.de || '') ? p.de : agora().slice(0, 8) + '01', ate = reData.test(p.ate || '') ? p.ate : '2999-12-31';
  const r = await env.DB.prepare(`SELECT x.*, c.nome AS clube, c.regiao_id AS clube_regiao, e.nome AS evento FROM escalas x LEFT JOIN clubes c ON c.id=x.clube_id
    LEFT JOIN eventos e ON e.id=x.evento_id WHERE x.data BETWEEN ?2 AND ?3 AND ${f} ORDER BY x.data, x.hora`).bind(u.papel === 'MSC' ? '' : u.regiao_id, de, ate).all();
  return r.results.map(x => Object.assign(x, { meu: u.papel === 'MSC' || (x.ambito === 'Região' && x.regiao_id === u.regiao_id) }));
}
async function pessoasEscala(env, u) {
  exigir(u.papel !== 'DIRECTOR');
  const r = await env.DB.prepare(`SELECT email, nome, papel FROM utilizadores WHERE activo=1 AND papel IN ('MSC','REGIONAL') ORDER BY nome`).all();
  const ant = await env.DB.prepare(`SELECT DISTINCT delegado_nome AS nome, delegado_email AS email, delegado_contacto AS contacto FROM escalas ORDER BY criado_em DESC LIMIT 100`).all();
  return { utilizadores: r.results, anteriores: ant.results };
}
async function guardarEscala(env, u, p) {
  exigir(u.papel !== 'DIRECTOR', 'A escala é só para a região e a Missão.');
  const r = p.registo || {};
  const o = { funcao: FUNCOES_ESCALA.includes(r.funcao) ? r.funcao : null, data: r.data, hora: txt(r.hora, 5), clube_id: r.clube_id || null, evento_id: r.evento_id || null,
    solicitacao_id: r.solicitacao_id || null, local: txt(r.local, 150), delegado_nome: txt(r.delegado_nome, 120), delegado_email: r.delegado_email ? limparEmail(r.delegado_email) : null,
    delegado_contacto: txt(r.delegado_contacto, 40), estado: ESTADOS_ESCALA.includes(r.estado) ? r.estado : 'Agendada', notas: txt(r.notas, 500) };
  exigir(o.funcao, 'Escolha a função.'); exigir(reData.test(o.data || ''), 'Indique a data.'); exigir(!o.hora || /^\d{2}:\d{2}$/.test(o.hora), 'Hora inválida.');
  exigir(o.delegado_nome, 'Indique o delegado.'); exigir(o.clube_id || o.local, 'Escolha o clube ou escreva o local.');
  let c = null;
  if (o.clube_id) { c = await env.DB.prepare('SELECT * FROM clubes WHERE id=?').bind(o.clube_id).first(); exigir(c, 'Clube inválido.'); }
  let ambito = 'Missão', regiao = c ? c.regiao_id : null;
  if (u.papel === 'REGIONAL') { ambito = 'Região'; exigir(!c || c.regiao_id === u.regiao_id, 'Só pode escalar para clubes da sua região.'); regiao = u.regiao_id; }
  if (o.evento_id) exigir(await env.DB.prepare('SELECT 1 FROM eventos WHERE id=?').bind(o.evento_id).first(), 'Evento inválido.');
  const cols = ['funcao', 'data', 'hora', 'clube_id', 'evento_id', 'solicitacao_id', 'local', 'delegado_nome', 'delegado_email', 'delegado_contacto', 'estado', 'notas'];
  const quando = o.data.split('-').reverse().join('/') + (o.hora ? ' às ' + o.hora : '');
  const st = [];
  let id = r.id;
  if (id) {
    const a = await env.DB.prepare('SELECT * FROM escalas WHERE id=?').bind(id).first();
    exigir(a && (u.papel === 'MSC' || (a.ambito === 'Região' && a.regiao_id === u.regiao_id)), 'Não pode alterar esta escala.');
    st.push(env.DB.prepare(`UPDATE escalas SET ${cols.map(k => k + '=?').join(',')} WHERE id=?`).bind(...cols.map(k => o[k]), id));
    if (a.estado !== o.estado && o.estado === 'Cancelada' && c) st.push(notificar(env, { para_tipo: 'clube', para_id: c.id, titulo: `Escala cancelada: ${o.funcao}`, texto: `${o.delegado_nome} · ${quando}`, aba: 'agenda', autor: u.email }));
  } else {
    id = novoId();
    st.push(env.DB.prepare(`INSERT INTO escalas (id,${cols.join(',')},ambito,regiao_id,criado_por,criado_em) VALUES (?,${cols.map(() => '?').join(',')},?,?,?,?)`)
      .bind(id, ...cols.map(k => o[k]), ambito, regiao, u.email, agora()));
    if (c) st.push(notificar(env, { para_tipo: 'clube', para_id: c.id, titulo: `${o.funcao} escalado para o vosso clube`, texto: `${o.delegado_nome} · ${quando}`, aba: 'agenda', autor: u.email }));
    if (o.delegado_email) st.push(notificar(env, { para_tipo: 'user', para_id: o.delegado_email, titulo: `Foi escalado: ${o.funcao}`, texto: `${c ? c.nome : o.local} · ${quando}`, aba: 'escala', autor: u.email }));
  }
  await env.DB.batch(st);
  await auditar(env, u, r.id ? 'editar' : 'criar', 'escalas', id, `${o.funcao} ${o.delegado_nome}`);
  return { id };
}
async function apagarEscala(env, u, p) {
  const a = await env.DB.prepare('SELECT * FROM escalas WHERE id=?').bind(p.id).first();
  exigir(a && (u.papel === 'MSC' || (a.ambito === 'Região' && a.regiao_id === u.regiao_id)), 'Não pode apagar esta escala.');
  await env.DB.prepare('DELETE FROM escalas WHERE id=?').bind(a.id).run();
  return true;
}

/* ---- lembretes automáticos (corre uma vez por dia) ---- */
async function lembretesDiarios(env) {
  const hoje = agora().slice(0, 10), dia = Number(hoje.slice(8, 10));
  const em = (n) => new Date(Date.parse(hoje) + n * 864e5).toISOString().slice(0, 10);
  const st = []; const marcas = [];
  const uma = async (chave, fn) => { if (await env.DB.prepare('SELECT 1 FROM lembretes WHERE chave=?').bind(chave).first()) return; marcas.push(chave); fn(); };
  // eventos, agenda e escalas: 7 dias antes e na véspera
  for (const n of [7, 1]) {
    const d = em(n), q = n === 1 ? 'amanhã' : 'daqui a 7 dias';
    for (const e of (await env.DB.prepare(`SELECT * FROM eventos WHERE data_inicio=? AND estado<>'Cancelado'`).bind(d).all()).results)
      await uma(`ev:${e.id}:${n}`, () => st.push(notificar(env, Object.assign(e.nivel === 'Missão' ? { para_tipo: 'todos' } : { para_tipo: 'regiao_todos', para_id: e.regiao_id }, { titulo: `Lembrete: ${e.nome} é ${q}`, texto: e.local, aba: 'eventos', autor: 'sistema' }))));
    for (const a of (await env.DB.prepare(`SELECT * FROM agenda WHERE data_inicio=?`).bind(d).all()).results)
      await uma(`ag:${a.id}:${n}`, () => st.push(notificar(env, Object.assign(a.ambito === 'Missão' ? { para_tipo: 'todos' } : { para_tipo: 'regiao_todos', para_id: a.regiao_id }, { titulo: `Lembrete: ${a.titulo} é ${q}`, texto: a.local, aba: 'agenda', autor: 'sistema' }))));
    for (const x of (await env.DB.prepare(`SELECT x.*, c.nome AS clube FROM escalas x LEFT JOIN clubes c ON c.id=x.clube_id WHERE x.data=? AND x.estado IN ('Agendada','Confirmada')`).bind(d).all()).results) {
      await uma(`es:${x.id}:${n}`, () => {
        if (x.delegado_email) st.push(notificar(env, { para_tipo: 'user', para_id: x.delegado_email, titulo: `Lembrete: ${x.funcao} ${q}`, texto: `${x.clube || x.local}${x.hora ? ' às ' + x.hora : ''}`, aba: 'escala', autor: 'sistema' }));
        if (x.clube_id) st.push(notificar(env, { para_tipo: 'clube', para_id: x.clube_id, titulo: `Lembrete: visita de ${x.delegado_nome} ${q}`, texto: x.funcao, aba: 'agenda', autor: 'sistema' }));
      });
    }
  }
  // relatório mensal: dias 5 e 10, só aos clubes que ainda não enviaram o mês anterior
  if (dia === 5 || dia === 10) {
    const m = new Date(Date.UTC(Number(hoje.slice(0, 4)), Number(hoje.slice(5, 7)) - 2, 1)); const ano = m.getUTCFullYear(), mes = m.getUTCMonth() + 1;
    const falta = (await env.DB.prepare(`SELECT c.id FROM clubes c WHERE c.activo=1 AND NOT EXISTS (SELECT 1 FROM relatorios r WHERE r.clube_id=c.id AND r.ano=? AND r.mes=? AND r.estado='Enviado')`).bind(ano, mes).all()).results;
    const MES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'][mes - 1];
    await uma(`rel:${hoje}`, () => {
      const t = agora();
      st.push(...inserirVarios(env, 'notificacoes', ['id', 'data', 'para_tipo', 'para_id', 'titulo', 'texto', 'aba', 'autor'],
        falta.map(c => [novoId(), t, 'clube', c.id, dia === 10 ? `Último dia: relatório de ${MES}` : `Lembrete: relatório de ${MES}`, 'O prazo de envio é o dia 10.', 'relatorio', 'sistema'])));
    });
  }
  if (new Date().getUTCDay() === 1) await uma(`copia:${hoje}`, () => st.push(notificar(env, { para_tipo: 'msc', titulo: 'Cópia de segurança semanal', texto: 'Faça a cópia completa em Gestão → Cópia de segurança (1 toque).', aba: 'admin', autor: 'sistema' })));
  if (marcas.length) st.push(...inserirVarios(env, 'lembretes', ['chave', 'data'], marcas.map(k => [k, hoje]), 'INSERT OR IGNORE'));
  for (let i = 0; i < st.length; i += 40) await env.DB.batch(st.slice(i, i + 40));
  return marcas.length;
}

/* ======================= FASE 7 ======================= */

/* ---- exportação completa (cópia de segurança feita no browser da Missão) ---- */
const EXPORTAVEIS = {
  regioes: '*', clubes: '*', clubes_geo: '*', unidades: '*', membros: '*', classes: '*', cumprimentos: '*', requisitos: '*', especialidades: '*',
  actividades: '*', presencas: '*', criterios: '*', pontos: '*', relatorios: '*', pagamentos: '*', movimentos: '*', eventos: '*', inscricoes: '*',
  utilizadores: 'email,nome,papel,regiao_id,clube_id,activo,ultimo_acesso', comunicados: '*', leituras: '*', transferencias: '*', solicitacoes: '*',
  agenda: '*', escalas: '*', delegados: '*', inspecoes: '*', plano: '*', provas: '*', prova_resultados: '*', auditoria: '*'
};
async function infoExportacao(env, u) {
  exigir(u.papel === 'MSC', 'Só a Missão faz a cópia completa.');
  const nomes = Object.keys(EXPORTAVEIS);
  const r = await env.DB.batch(nomes.map(t => env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t}`)));
  return { tabelas: nomes.map((t, i) => ({ tabela: t, linhas: r[i].results[0].n })), ultima: await cfgLer(env, 'ultima_copia') };
}
async function exportarTabela(env, u, p) {
  exigir(u.papel === 'MSC', 'Só a Missão faz a cópia completa.');
  const cols = EXPORTAVEIS[p.tabela]; exigir(cols, 'Tabela inválida.');
  const desde = Number(p.desde) || 0;
  const r = await env.DB.prepare(`SELECT rowid AS _r, ${cols} FROM ${p.tabela} WHERE rowid > ? ORDER BY rowid LIMIT 1500`).bind(desde).all();
  const linhas = r.results; const ultimo = linhas.length ? linhas[linhas.length - 1]._r : null;
  linhas.forEach(x => delete x._r);
  if (p.fim) { await cfgGravar(env, 'ultima_copia', agora()).run(); await auditar(env, u, 'copia', 'todas', null, 'cópia completa'); }
  return { linhas, seguinte: linhas.length === 1500 ? ultimo : null };
}

/* ---- alerta de abandono (6 faltas seguidas) ---- */
const FALTAS_ALERTA = 6;
async function sequenciasFaltas(env, clubeId, ids) {
  const filtro = ids ? 'AND x.membro_id IN (SELECT value FROM json_each(?2))' : '';
  const r = await env.DB.prepare(`SELECT membro_id, estado, actividade_id FROM (SELECT x.membro_id, x.estado, x.actividade_id,
      ROW_NUMBER() OVER (PARTITION BY x.membro_id ORDER BY a.data DESC, a.criado_em DESC) AS rn
    FROM presencas x JOIN actividades a ON a.id=x.actividade_id WHERE a.clube_id=?1 ${filtro}) WHERE rn<=20 ORDER BY membro_id, rn`).bind(clubeId, ...(ids ? [JSON.stringify(ids)] : [])).all();
  const seq = {};
  for (const x of r.results) { const s = seq[x.membro_id] = seq[x.membro_id] || { n: 0, fim: false, ultima: x.actividade_id }; if (s.fim) continue; if (x.estado === 'F') s.n++; else s.fim = true; }
  return seq;
}
async function alertarAbandono(env, clubeId, ids, autor) {
  const seq = await sequenciasFaltas(env, clubeId, ids);
  const alvo = Object.entries(seq).filter(([, s]) => s.n === FALTAS_ALERTA);
  if (!alvo.length) return;
  const nomes = Object.fromEntries((await env.DB.prepare('SELECT id, nome FROM membros WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(alvo.map(([m]) => m))).all()).results.map(x => [x.id, x.nome]));
  const st = [];
  for (const [m, s] of alvo) {
    const chave = `aband:${m}:${s.ultima}`;
    if (await env.DB.prepare('SELECT 1 FROM lembretes WHERE chave=?').bind(chave).first()) continue;
    st.push(env.DB.prepare('INSERT OR IGNORE INTO lembretes (chave,data) VALUES (?,?)').bind(chave, agora().slice(0, 10)));
    st.push(notificar(env, { para_tipo: 'clube', para_id: clubeId, titulo: `⚠️ Risco de abandono: ${nomes[m] || 'desbravador'}`, texto: `${FALTAS_ALERTA} faltas seguidas. Contacte o encarregado (Painel → Em risco).`, aba: 'painel', autor: 'sistema' }));
  }
  if (st.length) await env.DB.batch(st);
}
async function emRisco(env, u, p) {
  await exigirClube(env, u, p.clube_id);
  const seq = await sequenciasFaltas(env, p.clube_id, null);
  const ids = Object.entries(seq).filter(([, s]) => s.n >= FALTAS_ALERTA).map(([m]) => m);
  if (!ids.length) return [];
  const r = await env.DB.prepare(`SELECT id, nome, tipo, contacto, encarregado_nome, encarregado_contacto FROM membros WHERE activo=1 AND id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(ids)).all();
  return r.results.map(m => Object.assign(m, { faltas: seq[m.id].n })).sort((a, b) => b.faltas - a.faltas);
}

/* ---- plano anual do clube ---- */
async function plano(env, u, p) {
  await exigirClube(env, u, p.clube_id);
  const ano = Number(p.ano) || new Date().getFullYear();
  const [pl, act] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM plano WHERE clube_id=? AND ano=? ORDER BY mes, pilar, criado_em').bind(p.clube_id, ano),
    env.DB.prepare(`SELECT CAST(substr(data,6,2) AS INT) AS mes, COALESCE(pilar,'—') AS pilar, COUNT(*) AS n FROM actividades WHERE clube_id=? AND substr(data,1,4)=? GROUP BY 1,2`).bind(p.clube_id, String(ano))
  ]);
  // Cumprimento automático: as actividades realizadas no mês e pilar vão "cumprindo" os itens planeados por ordem.
  const real = {}; act.results.forEach(x => real[x.mes + '|' + x.pilar] = x.n);
  const usados = {};
  const itens = pl.results.map(x => { const k = x.mes + '|' + (x.pilar || '—'); usados[k] = (usados[k] || 0) + 1;
    return Object.assign(x, { cumprido: !!x.feito || usados[k] <= (real[k] || 0), auto: !x.feito && usados[k] <= (real[k] || 0) }); });
  return { ano, itens, realizadas: act.results };
}
async function guardarPlano(env, u, p) {
  const r = p.registo || {};
  await exigirClube(env, u, r.clube_id);
  const ano = Number(r.ano), mes = Number(r.mes);
  exigir(ano >= 2020 && ano <= 2100 && mes >= 1 && mes <= 12, 'Mês inválido.');
  exigir(txt(r.titulo), 'Indique a actividade.'); exigir(!r.pilar || PILARES.includes(r.pilar), 'Pilar inválido.');
  const o = [ano, mes, r.pilar || null, txt(r.tipo, 60), txt(r.titulo, 150), txt(r.descricao, 500), bool(r.feito)];
  if (r.id) {
    const a = await env.DB.prepare('SELECT clube_id FROM plano WHERE id=?').bind(r.id).first(); exigir(a && a.clube_id === r.clube_id, 'Item não encontrado.');
    await env.DB.prepare('UPDATE plano SET ano=?,mes=?,pilar=?,tipo=?,titulo=?,descricao=?,feito=? WHERE id=?').bind(...o, r.id).run(); return { id: r.id };
  }
  const id = novoId();
  await env.DB.prepare('INSERT INTO plano (id,clube_id,ano,mes,pilar,tipo,titulo,descricao,feito,criado_em) VALUES (?,?,?,?,?,?,?,?,?,?)').bind(id, r.clube_id, ...o, agora()).run();
  return { id };
}
async function apagarPlano(env, u, p) {
  const a = await env.DB.prepare('SELECT clube_id FROM plano WHERE id=?').bind(p.id).first(); exigir(a, 'Item não encontrado.');
  await exigirClube(env, u, a.clube_id); await env.DB.prepare('DELETE FROM plano WHERE id=?').bind(p.id).run(); return true;
}
async function copiarPlano(env, u, p) {
  await exigirClube(env, u, p.clube_id);
  const ano = Number(p.ano);
  const ja = await env.DB.prepare('SELECT COUNT(*) AS n FROM plano WHERE clube_id=? AND ano=?').bind(p.clube_id, ano).first('n');
  exigir(!ja, `O plano de ${ano} já tem actividades.`);
  const ant = (await env.DB.prepare('SELECT * FROM plano WHERE clube_id=? AND ano=?').bind(p.clube_id, ano - 1).all()).results;
  exigir(ant.length, `Não há plano de ${ano - 1} para copiar.`);
  await env.DB.batch(inserirVarios(env, 'plano', ['id', 'clube_id', 'ano', 'mes', 'pilar', 'tipo', 'titulo', 'descricao', 'feito', 'criado_em'],
    ant.map(x => [novoId(), p.clube_id, ano, x.mes, x.pilar, x.tipo, x.titulo, x.descricao, 0, agora()])));
  return { copiados: ant.length };
}

/* ---- inspecção / relatório de visita do delegado ---- */
const ITENS_INSPECAO = [
  ['bandeiras', 'Bandeira do clube e bandeira nacional'], ['unif_desb', 'Uniformes dos desbravadores'], ['unif_lid', 'Uniformes dos líderes'],
  ['secretaria', 'Secretaria e livros de registo em dia'], ['tesouraria', 'Tesouraria e livro de caixa em dia'], ['unidades', 'Unidades organizadas (capitão, conselheiro, bandeirim)'],
  ['classes', 'Classes regulares a funcionar'], ['especialidades', 'Especialidades em curso'], ['espiritual', 'Momento espiritual / devocional'],
  ['ordem_unida', 'Ordem unida'], ['pontualidade', 'Pontualidade e programa da reunião'], ['seguro', 'Seguro dos membros'],
  ['material', 'Material de acampamento e primeiros socorros'], ['local', 'Organização e higiene do local']
];
async function itensInspecao() { return ITENS_INSPECAO.map(([k, t]) => ({ k, t })); }
async function podeInspeccionar(env, u, escala, clube) {
  if (u.papel === 'MSC') return true;
  if (escala && escala.delegado_email && escala.delegado_email === u.email) return true;
  return u.papel === 'REGIONAL' && clube.regiao_id === u.regiao_id;
}
async function guardarInspecao(env, u, p) {
  const r = p.registo || {};
  let esc = null;
  if (r.escala_id) { esc = await env.DB.prepare('SELECT * FROM escalas WHERE id=?').bind(r.escala_id).first(); exigir(esc, 'Escala não encontrada.'); r.clube_id = r.clube_id || esc.clube_id; }
  const c = await env.DB.prepare('SELECT * FROM clubes WHERE id=?').bind(r.clube_id).first(); exigir(c, 'Escolha o clube.');
  exigir(await podeInspeccionar(env, u, esc, c), 'Não pode registar inspecções neste clube.');
  exigir(reData.test(r.data || ''), 'Indique a data.');
  const itens = {}; let soma = 0, max = 0;
  for (const [k] of ITENS_INSPECAO) { const v = r.itens && r.itens[k]; if (v === undefined || v === '' || v === null) continue; const n = Number(v); exigir([0, 1, 2].includes(n), 'Pontuação inválida.'); itens[k] = n; soma += n; max += 2; }
  exigir(max >= 10, 'Avalie pelo menos 5 itens.');
  exigir(txt(r.relatorio), 'Escreva o relatório da visita.');
  const nota = Math.round(soma / max * 100);
  const id = r.id || novoId();
  const st = [env.DB.prepare(`INSERT INTO inspecoes (id,escala_id,clube_id,data,delegado_nome,delegado_email,itens,nota,presentes,relatorio,recomendacoes,criado_por,criado_em) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET data=excluded.data, itens=excluded.itens, nota=excluded.nota, presentes=excluded.presentes, relatorio=excluded.relatorio, recomendacoes=excluded.recomendacoes`)
    .bind(id, esc ? esc.id : null, c.id, r.data, esc ? esc.delegado_nome : u.nome, esc ? esc.delegado_email : u.email, JSON.stringify(itens), nota, num(r.presentes || 0, 0, 10000), txt(r.relatorio, 4000), txt(r.recomendacoes, 2000), u.email, agora())];
  if (esc) st.push(env.DB.prepare(`UPDATE escalas SET estado='Realizada' WHERE id=?`).bind(esc.id));
  if (!r.id) {
    st.push(notificar(env, { para_tipo: 'clube', para_id: c.id, titulo: `Relatório da visita: nota ${nota}%`, texto: `${esc ? esc.funcao + ' — ' : ''}${esc ? esc.delegado_nome : u.nome}. Veja em Clube → Inspecções.`, aba: 'clube', autor: u.email }));
    st.push(notificar(env, { para_tipo: 'regiao', para_id: c.regiao_id, titulo: `Inspecção ao clube ${c.nome}: ${nota}%`, aba: 'escala', autor: u.email }));
  }
  await env.DB.batch(st);
  await auditar(env, u, r.id ? 'editar' : 'criar', 'inspecoes', id, `${c.nome} ${nota}%`);
  return { id, nota };
}
async function inspecoes(env, u, p) {
  let f, args;
  if (p.clube_id) { await exigirClube(env, u, p.clube_id); f = 'i.clube_id=?'; args = [p.clube_id]; }
  else { exigir(u.papel !== 'DIRECTOR'); const fc = filtroClubes(u); f = fc.sql; args = fc.args; }
  const r = await env.DB.prepare(`SELECT i.*, c.nome AS clube, c.regiao_id, x.funcao FROM inspecoes i JOIN clubes c ON c.id=i.clube_id LEFT JOIN escalas x ON x.id=i.escala_id WHERE ${f} ORDER BY i.data DESC LIMIT 200`).bind(...args).all();
  return { itens: ITENS_INSPECAO.map(([k, t]) => ({ k, t })), lista: r.results.map(x => Object.assign(x, { itens: JSON.parse(x.itens || '{}') })) };
}

/* ---- provas (especialidades e classes) ---- */
async function provaVisivel(env, u, id) {
  const pv = await env.DB.prepare('SELECT * FROM provas WHERE id=?').bind(id).first(); exigir(pv, 'Prova não encontrada.');
  if (pv.ambito === 'Região' && u.papel !== 'MSC') exigir(u.reg === pv.regiao_id);
  return pv;
}
const organizaProva = (u, pv) => u.papel === 'MSC' || (u.papel === 'REGIONAL' && pv.ambito === 'Região' && pv.regiao_id === u.regiao_id);
async function provas(env, u) {
  const f = u.papel === 'MSC' ? '1=1' : `(p.ambito='Missão' OR p.regiao_id=?)`;
  const fc = u.papel === 'DIRECTOR' ? 'AND r.clube_id=?' : u.papel === 'REGIONAL' ? 'AND r.clube_id IN (SELECT id FROM clubes WHERE regiao_id=?)' : '';
  const r = await env.DB.prepare(`SELECT p.*, COUNT(r.membro_id) AS candidatos, SUM(r.resultado='Apto') AS aptos, SUM(r.resultado='Não apto') AS nao_aptos
    FROM provas p LEFT JOIN prova_resultados r ON r.prova_id=p.id ${fc} WHERE ${f} GROUP BY p.id ORDER BY p.data DESC LIMIT 200`)
    .bind(...(fc ? [u.papel === 'DIRECTOR' ? u.clube_id : u.regiao_id] : []), ...(u.papel === 'MSC' ? [] : [u.reg || ''])).all();
  return r.results.map(x => Object.assign(x, { organizador: organizaProva(u, x) }));
}
async function guardarProva(env, u, p) {
  exigir(u.papel !== 'DIRECTOR', 'Só a região e a Missão criam provas.');
  const r = p.registo || {};
  const o = { titulo: txt(r.titulo, 150), tipo: r.tipo === 'Classe' ? 'Classe' : 'Especialidade', alvo: txt(r.alvo, 120), categoria: txt(r.categoria, 80), data: r.data, local: txt(r.local, 150),
    nota_minima: num(r.nota_minima ?? 70, 0, 100), estado: ['Inscrições abertas', 'Em avaliação', 'Fechada'].includes(r.estado) ? r.estado : 'Inscrições abertas' };
  exigir(o.alvo, o.tipo === 'Classe' ? 'Escolha a classe.' : 'Indique a especialidade.'); exigir(o.tipo !== 'Classe' || CLASSES.includes(o.alvo), 'Classe inválida.');
  exigir(reData.test(o.data || ''), 'Indique a data.'); exigir(o.nota_minima !== null, 'Nota mínima inválida.');
  o.titulo = o.titulo || `Prova de ${o.alvo}`;
  let ambito = 'Missão', regiao = null;
  if (u.papel === 'REGIONAL') { ambito = 'Região'; regiao = u.regiao_id; } else if (r.regiao_id) { ambito = 'Região'; regiao = r.regiao_id; }
  if (r.id) {
    const pv = await provaVisivel(env, u, r.id); exigir(organizaProva(u, pv)); exigir(pv.estado !== 'Fechada', 'Prova fechada.');
    await env.DB.prepare('UPDATE provas SET titulo=?,tipo=?,alvo=?,categoria=?,data=?,local=?,nota_minima=?,estado=? WHERE id=?')
      .bind(o.titulo, o.tipo, o.alvo, o.categoria, o.data, o.local, o.nota_minima, o.estado === 'Fechada' ? pv.estado : o.estado, r.id).run();
    return { id: r.id };
  }
  const id = novoId();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO provas (id,titulo,tipo,alvo,categoria,data,local,ambito,regiao_id,nota_minima,estado,criado_por,criado_em) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind(id, o.titulo, o.tipo, o.alvo, o.categoria, o.data, o.local, ambito, regiao, o.nota_minima, 'Inscrições abertas', u.email, agora()),
    notificar(env, Object.assign(ambito === 'Missão' ? { para_tipo: 'todos' } : { para_tipo: 'regiao_todos', para_id: regiao },
      { titulo: `Nova prova: ${o.titulo}`, texto: `${o.data.split('-').reverse().join('/')} — inscreva os candidatos em Provas.`, aba: 'provas', autor: u.email }))
  ]);
  return { id };
}
async function candidatosProva(env, u, p) {
  const pv = await provaVisivel(env, u, p.prova_id); await exigirClube(env, u, p.clube_id);
  const r = await env.DB.prepare(`SELECT m.id, m.nome, m.data_nasc, m.tipo, (r.membro_id IS NOT NULL) AS inscrito, r.nota, r.resultado
    FROM membros m LEFT JOIN prova_resultados r ON r.membro_id=m.id AND r.prova_id=? WHERE m.clube_id=? AND (m.activo=1 OR r.membro_id IS NOT NULL) ORDER BY m.tipo<>'Desbravador', m.nome`).bind(pv.id, p.clube_id).all();
  return { prova: pv, membros: r.results };
}
async function inscreverProva(env, u, p) {
  const pv = await provaVisivel(env, u, p.prova_id); await exigirClube(env, u, p.clube_id);
  exigir(pv.estado === 'Inscrições abertas' || organizaProva(u, pv), 'As inscrições desta prova estão fechadas.');
  const ids = Array.isArray(p.membros) ? p.membros : [];
  if (ids.length) await membrosDoClube(env, p.clube_id, ids);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM prova_resultados WHERE prova_id=? AND clube_id=? AND nota IS NULL AND membro_id NOT IN (SELECT value FROM json_each(?))').bind(pv.id, p.clube_id, JSON.stringify(ids)),
    ...inserirVarios(env, 'prova_resultados', ['prova_id', 'membro_id', 'clube_id', 'registado_por', 'registado_em'], ids.map(m => [pv.id, m, p.clube_id, u.email, agora()]), 'INSERT OR IGNORE')
  ]);
  return { inscritos: ids.length };
}
async function resultadosProva(env, u, p) {
  const pv = await provaVisivel(env, u, p.id);
  const fc = filtroClubes(u);
  const r = await env.DB.prepare(`SELECT r.*, m.nome, m.data_nasc, c.nome AS clube, c.distrito, c.regiao_id FROM prova_resultados r JOIN membros m ON m.id=r.membro_id JOIN clubes c ON c.id=r.clube_id
    WHERE r.prova_id=? AND ${fc.sql} ORDER BY c.regiao_id, c.distrito, c.nome, m.nome`).bind(pv.id, ...fc.args).all();
  return { prova: Object.assign(pv, { organizador: organizaProva(u, pv) }), resultados: r.results };
}
async function lancarNotas(env, u, p) {
  const pv = await provaVisivel(env, u, p.prova_id); exigir(organizaProva(u, pv), 'Só quem organiza a prova lança as notas.'); exigir(pv.estado !== 'Fechada', 'Prova fechada.');
  const notas = Array.isArray(p.notas) ? p.notas.slice(0, 500) : [];
  const st = [];
  for (const x of notas) {
    const n = x.nota === '' || x.nota == null ? null : num(x.nota, 0, 100); exigir(x.nota === '' || x.nota == null || n !== null, 'Nota inválida (0 a 100).');
    st.push(env.DB.prepare('UPDATE prova_resultados SET nota=?, resultado=?, obs=?, registado_por=?, registado_em=? WHERE prova_id=? AND membro_id=?')
      .bind(n, n == null ? (x.falta ? 'Faltou' : null) : n >= pv.nota_minima ? 'Apto' : 'Não apto', txt(x.obs, 200), u.email, agora(), pv.id, x.membro_id));
  }
  for (let i = 0; i < st.length; i += 40) await env.DB.batch(st.slice(i, i + 40));
  if (pv.estado === 'Inscrições abertas') await env.DB.prepare(`UPDATE provas SET estado='Em avaliação' WHERE id=?`).bind(pv.id).run();
  return { gravadas: st.length };
}
async function fecharProva(env, u, p) {
  const pv = await provaVisivel(env, u, p.id); exigir(organizaProva(u, pv)); exigir(pv.estado !== 'Fechada', 'Já está fechada.');
  const aptos = (await env.DB.prepare(`SELECT membro_id, clube_id FROM prova_resultados WHERE prova_id=? AND resultado='Apto'`).bind(pv.id).all()).results;
  const st = [env.DB.prepare(`UPDATE provas SET estado='Fechada' WHERE id=?`).bind(pv.id)];
  if (pv.tipo === 'Especialidade') {
    // Os aptos ficam com a especialidade registada (se ainda não a tinham).
    st.push(...inserirVarios(env, 'especialidades', ['id', 'clube_id', 'membro_id', 'especialidade', 'categoria', 'data_conclusao', 'instrutor', 'obs'],
      aptos.map(a => [novoId(), a.clube_id, a.membro_id, pv.alvo, pv.categoria, pv.data, null, 'Prova: ' + pv.titulo])));
    st.push(env.DB.prepare(`DELETE FROM especialidades WHERE obs=? AND rowid NOT IN (SELECT MIN(rowid) FROM especialidades WHERE obs=? GROUP BY membro_id, especialidade)`).bind('Prova: ' + pv.titulo, 'Prova: ' + pv.titulo));
  } else {
    const ano = Number(pv.data.slice(0, 4));
    st.push(env.DB.prepare(`UPDATE classes SET estado='Concluído' WHERE ano=? AND classe=? AND estado IN ('Inscrito','Em curso') AND membro_id IN (SELECT membro_id FROM prova_resultados WHERE prova_id=? AND resultado='Apto')`).bind(ano, pv.alvo, pv.id));
  }
  const clubes = [...new Set((await env.DB.prepare('SELECT DISTINCT clube_id FROM prova_resultados WHERE prova_id=?').bind(pv.id).all()).results.map(x => x.clube_id))];
  const t = agora();
  st.push(...inserirVarios(env, 'notificacoes', ['id', 'data', 'para_tipo', 'para_id', 'titulo', 'texto', 'aba', 'autor'],
    clubes.map(c => [novoId(), t, 'clube', c, `Resultados publicados: ${pv.titulo}`, 'Veja os aptos e não aptos do seu clube em Provas.', 'provas', u.email])));
  for (let i = 0; i < st.length; i += 40) await env.DB.batch(st.slice(i, i + 40));
  await auditar(env, u, 'fechar', 'provas', pv.id, `${aptos.length} aptos`);
  return { aptos: aptos.length };
}

/* ---- mapa dos clubes ---- */
async function mapaClubes(env, u) {
  const f = filtroClubes(u);
  const r = await env.DB.prepare(`SELECT c.id, c.nome, c.regiao_id, c.distrito, c.director, g.lat, g.lng,
      (SELECT COUNT(*) FROM membros m WHERE m.clube_id=c.id AND m.activo=1) AS membros,
      (SELECT i.nota FROM inspecoes i WHERE i.clube_id=c.id ORDER BY i.data DESC LIMIT 1) AS ult_nota,
      (SELECT i.data FROM inspecoes i WHERE i.clube_id=c.id ORDER BY i.data DESC LIMIT 1) AS ult_insp
    FROM clubes c LEFT JOIN clubes_geo g ON g.clube_id=c.id WHERE c.activo=1 AND ${f.sql} ORDER BY c.nome`).bind(...f.args).all();
  return r.results;
}
async function guardarLocalizacao(env, u, p) {
  await exigirClube(env, u, p.clube_id);
  const lat = num(p.lat, -90, 90), lng = num(p.lng, -180, 180);
  exigir(lat !== null && lng !== null, 'Localização inválida.');
  await env.DB.prepare('INSERT INTO clubes_geo (clube_id,lat,lng,actualizado_em) VALUES (?,?,?,?) ON CONFLICT(clube_id) DO UPDATE SET lat=excluded.lat, lng=excluded.lng, actualizado_em=excluded.actualizado_em')
    .bind(p.clube_id, lat, lng, agora()).run();
  return true;
}

/* ---- delegados e escala automática ---- */
async function delegados(env, u) {
  exigir(u.papel !== 'DIRECTOR');
  const f = u.papel === 'MSC' ? '1=1' : '(d.regiao_id=? OR d.regiao_id IS NULL)';
  const r = await env.DB.prepare(`SELECT d.*, c.nome AS clube, g.lat, g.lng,
      (SELECT COUNT(*) FROM escalas x WHERE x.delegado_nome=d.nome AND x.data >= date('now','-365 days') AND x.estado<>'Cancelada') AS escalas_ano
    FROM delegados d LEFT JOIN clubes c ON c.id=d.clube_id LEFT JOIN clubes_geo g ON g.clube_id=d.clube_id WHERE ${f} ORDER BY d.activo DESC, d.nome`).bind(...(u.papel === 'MSC' ? [] : [u.regiao_id])).all();
  return r.results;
}
async function guardarDelegado(env, u, p) {
  exigir(u.papel !== 'DIRECTOR');
  const r = p.registo || {};
  const o = { nome: txt(r.nome, 120), email: r.email ? limparEmail(r.email) : null, contacto: txt(r.contacto, 40), clube_id: r.clube_id || null, funcoes: txt(r.funcoes, 300), activo: bool(r.activo === undefined ? 1 : r.activo) };
  exigir(o.nome, 'Indique o nome.');
  let regiao = u.papel === 'REGIONAL' ? u.regiao_id : (r.regiao_id || null);
  if (o.clube_id) { const c = await env.DB.prepare('SELECT regiao_id FROM clubes WHERE id=?').bind(o.clube_id).first(); exigir(c, 'Clube inválido.'); if (u.papel === 'MSC' && !r.regiao_id) regiao = c.regiao_id; }
  if (r.id) {
    const a = await env.DB.prepare('SELECT * FROM delegados WHERE id=?').bind(r.id).first(); exigir(a && (u.papel === 'MSC' || a.regiao_id === u.regiao_id));
    await env.DB.prepare('UPDATE delegados SET nome=?,email=?,contacto=?,clube_id=?,funcoes=?,activo=?,regiao_id=? WHERE id=?').bind(o.nome, o.email, o.contacto, o.clube_id, o.funcoes, o.activo, regiao, r.id).run();
    return { id: r.id };
  }
  const id = novoId();
  await env.DB.prepare('INSERT INTO delegados (id,nome,email,contacto,regiao_id,clube_id,funcoes,activo,criado_em) VALUES (?,?,?,?,?,?,?,?,?)').bind(id, o.nome, o.email, o.contacto, regiao, o.clube_id, o.funcoes, o.activo, agora()).run();
  return { id };
}
async function apagarDelegado(env, u, p) {
  const a = await env.DB.prepare('SELECT * FROM delegados WHERE id=?').bind(p.id).first(); exigir(a && (u.papel === 'MSC' || a.regiao_id === u.regiao_id));
  await env.DB.prepare('DELETE FROM delegados WHERE id=?').bind(a.id).run(); return true;
}
async function importarLideres(env, u, p) {
  exigir(u.papel !== 'DIRECTOR');
  const f = filtroClubes(u);
  const r = await env.DB.prepare(`SELECT m.nome, m.contacto, m.clube_id, c.regiao_id, m.tipo FROM membros m JOIN clubes c ON c.id=m.clube_id
    WHERE m.activo=1 AND m.tipo IN ('Director','Director associado','Líder','Conselheiro','Instrutor','Capelão') AND ${f.sql}
    AND NOT EXISTS (SELECT 1 FROM delegados d WHERE d.nome=m.nome AND COALESCE(d.clube_id,'')=m.clube_id)`).bind(...f.args).all();
  const lista = (Array.isArray(p.tipos) && p.tipos.length) ? r.results.filter(x => p.tipos.includes(x.tipo)) : r.results;
  if (!p.confirmar) return { encontrados: lista.length, exemplo: lista.slice(0, 8).map(x => x.nome) };
  await env.DB.batch(inserirVarios(env, 'delegados', ['id', 'nome', 'email', 'contacto', 'regiao_id', 'clube_id', 'funcoes', 'activo', 'criado_em'],
    lista.map(x => [novoId(), x.nome, null, x.contacto, x.regiao_id, x.clube_id, x.tipo, 1, agora()])));
  return { importados: lista.length };
}
function distanciaKm(a, b) {
  if (a.lat == null || b.lat == null) return null;
  const R = 6371, r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
async function proporEscalaMassa(env, u, p) {
  exigir(u.papel !== 'DIRECTOR');
  exigir(FUNCOES_ESCALA.includes(p.funcao), 'Escolha a função.');
  exigir(reData.test(p.de || '') && reData.test(p.ate || '') && p.ate >= p.de, 'Período inválido.');
  const dias = (Array.isArray(p.dias_semana) && p.dias_semana.length ? p.dias_semana : [6]).map(Number);
  const datas = [];
  for (let t = Date.parse(p.de); t <= Date.parse(p.ate) && datas.length < 120; t += 864e5) { const d = new Date(t); if (dias.includes(d.getUTCDay())) datas.push(d.toISOString().slice(0, 10)); }
  exigir(datas.length, 'Não há dias no período escolhido.');
  const f = filtroClubes(u);
  let clubes = (await env.DB.prepare(`SELECT c.id, c.nome, c.regiao_id, g.lat, g.lng FROM clubes c LEFT JOIN clubes_geo g ON g.clube_id=c.id WHERE c.activo=1 AND ${f.sql}`).bind(...f.args).all()).results;
  if (Array.isArray(p.clubes) && p.clubes.length) clubes = clubes.filter(c => p.clubes.includes(c.id));
  else if (p.regiao_id) clubes = clubes.filter(c => c.regiao_id === p.regiao_id);
  exigir(clubes.length, 'Não há clubes para escalar.');
  let dels = await delegados(env, u);
  dels = dels.filter(d => d.activo && (!Array.isArray(p.delegados) || !p.delegados.length || p.delegados.includes(d.id)));
  exigir(dels.length, 'Não há delegados. Registe-os primeiro em Escala → Delegados.');
  const maxDia = Math.max(1, Number(p.max_por_dia) || 1);
  // Aleatório mas equilibrado: clubes baralhados; para cada clube, a data com menos visitas e o delegado livre com menos escalas,
  // que não seja do próprio clube e, se houver localização, o mais próximo.
  const baralhar = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  baralhar(clubes); baralhar(dels);
  const carga = Object.fromEntries(dels.map(d => [d.id, 0])), ocupado = {}, porData = Object.fromEntries(datas.map(d => [d, 0]));
  const proposta = [];
  for (const c of clubes) {
    const ordem = [...datas].sort((a, b) => porData[a] - porData[b] || a.localeCompare(b));
    let feito = false;
    for (const d of ordem) {
      const livres = dels.filter(x => x.clube_id !== c.id && (ocupado[x.id + d] || 0) < maxDia);
      if (!livres.length) continue;
      livres.sort((a, b) => carga[a.id] - carga[b.id] || ((distanciaKm(a, c) ?? 9e9) - (distanciaKm(b, c) ?? 9e9)));
      const e = livres[0]; carga[e.id]++; ocupado[e.id + d] = (ocupado[e.id + d] || 0) + 1; porData[d]++;
      const km = distanciaKm(e, c);
      proposta.push({ clube_id: c.id, clube: c.nome, regiao_id: c.regiao_id, data: d, delegado_id: e.id, delegado_nome: e.nome, delegado_email: e.email, delegado_contacto: e.contacto, km: km == null ? null : Math.round(km) });
      feito = true; break;
    }
    if (!feito) proposta.push({ clube_id: c.id, clube: c.nome, regiao_id: c.regiao_id, data: null, delegado_id: null, sem: 'Sem delegado livre' });
  }
  proposta.sort((a, b) => (a.data || '9').localeCompare(b.data || '9') || a.clube.localeCompare(b.clube));
  return { funcao: p.funcao, hora: txt(p.hora, 5), datas, delegados: dels.map(d => ({ id: d.id, nome: d.nome, email: d.email, contacto: d.contacto })), proposta };
}
async function confirmarEscalaMassa(env, u, p) {
  exigir(u.papel !== 'DIRECTOR');
  exigir(FUNCOES_ESCALA.includes(p.funcao), 'Escolha a função.');
  const itens = (Array.isArray(p.itens) ? p.itens : []).filter(x => x && x.clube_id && reData.test(x.data || '') && txt(x.delegado_nome)).slice(0, 200);
  exigir(itens.length, 'Nada para escalar.');
  const f = filtroClubes(u);
  const ok = (await env.DB.prepare(`SELECT c.id, c.regiao_id FROM clubes c WHERE ${f.sql} AND c.id IN (SELECT value FROM json_each(?))`).bind(...f.args, JSON.stringify(itens.map(x => x.clube_id))).all()).results;
  const reg = Object.fromEntries(ok.map(c => [c.id, c.regiao_id]));
  exigir(itens.every(x => reg[x.clube_id]), 'Há clubes fora da sua área.');
  const ambito = u.papel === 'REGIONAL' ? 'Região' : 'Missão', t = agora(), hora = txt(p.hora, 5);
  const rows = itens.map(x => [novoId(), p.funcao, x.data, hora, x.clube_id, null, null, null, txt(x.delegado_nome, 120), x.delegado_email ? limparEmail(x.delegado_email) : null, txt(x.delegado_contacto, 40),
    ambito, u.papel === 'REGIONAL' ? u.regiao_id : reg[x.clube_id], 'Agendada', txt(p.notas, 300) || 'Escala automática', u.email, t]);
  const st = inserirVarios(env, 'escalas', ['id', 'funcao', 'data', 'hora', 'clube_id', 'evento_id', 'solicitacao_id', 'local', 'delegado_nome', 'delegado_email', 'delegado_contacto', 'ambito', 'regiao_id', 'estado', 'notas', 'criado_por', 'criado_em'], rows);
  const nts = [];
  for (const x of itens) {
    const q = x.data.split('-').reverse().join('/') + (hora ? ' às ' + hora : '');
    nts.push([novoId(), t, 'clube', x.clube_id, `${p.funcao} escalado para o vosso clube`, `${x.delegado_nome} · ${q}`, 'agenda', u.email]);
    if (x.delegado_email) nts.push([novoId(), t, 'user', limparEmail(x.delegado_email), `Foi escalado: ${p.funcao}`, `${q}`, 'escala', u.email]);
  }
  st.push(...inserirVarios(env, 'notificacoes', ['id', 'data', 'para_tipo', 'para_id', 'titulo', 'texto', 'aba', 'autor'], nts));
  for (let i = 0; i < st.length; i += 40) await env.DB.batch(st.slice(i, i + 40));
  await auditar(env, u, 'escalaMassa', 'escalas', null, `${itens.length} escalas`);
  return { criadas: itens.length };
}
