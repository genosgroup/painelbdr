/**
 * Painel do BDR Genos - API do painel.
 *
 * Tudo o que o painel precisa guardar mora em um namespace KV do Cloudflare.
 * Sao tres coisas apenas:
 *
 *   estado        -> { v, rev, lancamentos: [...] }   os lancamentos do dia a dia
 *   pins          -> { rafael, isabella, gilvan }     o PIN de cada pessoa, embaralhado
 *   sess:<token>  -> "rafael"                         quem esta logado, expira sozinho
 *
 * O Worker so responde as rotas /api/*. Qualquer outro endereco e servido
 * direto do diretorio public/ pelo proprio Cloudflare, sem passar por aqui.
 */

const VALIDADE_SESSAO = 12 * 60 * 60; // 12 horas, em segundos
const TENTATIVAS_MAX = 10;            // erros de PIN tolerados por IP
const JANELA_TENTATIVAS = 10 * 60;    // dentro de 10 minutos

const PESSOAS = {
  gilvan:   { nome: "Gilvan Brito",    papel: "admin" },
  rafael:   { nome: "Rafael Abreu",    papel: "bdr" },
  isabella: { nome: "Isabella Borges", papel: "bdr" }
};

/* PINs originais do painel, embaralhados. So sao gravados na primeira vez que
   o painel sobe; depois disso quem manda e o que estiver no KV. */
const PINS_INICIAIS = { rafael: "yjb9on", isabella: "yjc1ft", gilvan: "yjct6z" };

/* Mesmo embaralhamento usado no navegador, para o PIN nunca trafegar em claro
   no armazenamento. Nao e criptografia forte: a protecao real de um PIN de
   quatro digitos e o limite de tentativas mais abaixo. */
function embaralhar(s) {
  let x = 5381;
  for (let i = 0; i < s.length; i++) x = ((x << 5) + x + s.charCodeAt(i)) >>> 0;
  return x.toString(36);
}

const json = (dados, status = 200) =>
  new Response(JSON.stringify(dados), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });

const erro = (codigo, mensagem, status) => json({ erro: codigo, mensagem }, status);

/* ---------- leitura e escrita do estado ---------- */

async function lerEstado(env) {
  const bruto = await env.PAINEL.get("estado", { type: "json" });
  if (bruto && Array.isArray(bruto.lancamentos)) {
    return { v: 1, rev: Number(bruto.rev) || 0, lancamentos: bruto.lancamentos };
  }
  return { v: 1, rev: 0, lancamentos: [] };
}

async function gravarEstado(env, estado) {
  const novo = { v: 1, rev: (Number(estado.rev) || 0) + 1, lancamentos: estado.lancamentos };
  await env.PAINEL.put("estado", JSON.stringify(novo));
  return novo;
}

async function lerPins(env) {
  const pins = await env.PAINEL.get("pins", { type: "json" });
  if (pins && typeof pins === "object") return pins;
  await env.PAINEL.put("pins", JSON.stringify(PINS_INICIAIS));
  return { ...PINS_INICIAIS };
}

/* ---------- sessao ---------- */

function novoToken() {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return [...b].map(x => x.toString(16).padStart(2, "0")).join("");
}

async function quemEsta(req, env) {
  const cab = req.headers.get("authorization") || "";
  const token = cab.startsWith("Bearer ") ? cab.slice(7).trim() : "";
  if (!/^[0-9a-f]{48}$/.test(token)) return null;
  const perfil = await env.PAINEL.get("sess:" + token);
  return perfil && PESSOAS[perfil] ? perfil : null;
}

/* ---------- limite de tentativas de PIN ---------- */

async function tentativasExcedidas(req, env) {
  const ip = req.headers.get("cf-connecting-ip") || "sem-ip";
  const chave = "tent:" + ip;
  const n = Number(await env.PAINEL.get(chave)) || 0;
  return { excedeu: n >= TENTATIVAS_MAX, registrarErro: () =>
    env.PAINEL.put(chave, String(n + 1), { expirationTtl: JANELA_TENTATIVAS }) };
}

/* ---------- validacao de um lancamento ---------- */

const CAMPOS = ["leads", "tentativas", "contatos", "decisores", "agendadas",
                "realizadas", "noshow", "propostas", "vendas"];

function limparLancamento(bruto, perfilDeQuemGrava) {
  if (!bruto || typeof bruto !== "object") return null;
  const bdr = String(bruto.bdr || "");
  if (bdr !== "rafael" && bdr !== "isabella") return null;
  /* um BDR so grava o proprio dia; o admin grava o de qualquer um */
  if (PESSOAS[perfilDeQuemGrava].papel !== "admin" && bdr !== perfilDeQuemGrava) return null;
  const data = String(bruto.data || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) return null;

  const limpo = {
    id: /^[a-z0-9]{4,32}$/.test(String(bruto.id || "")) ? String(bruto.id)
       : Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    bdr,
    data,
    obs: String(bruto.obs || "").slice(0, 500),
    em: new Date().toISOString()
  };
  for (const c of CAMPOS) {
    const n = Math.floor(Number(bruto[c]));
    limpo[c] = Number.isFinite(n) ? Math.min(Math.max(n, 0), 9999) : 0;
  }
  return limpo;
}

/* um lancamento por BDR por dia: o novo substitui o antigo daquele dia */
function encaixar(lancamentos, reg) {
  const resto = lancamentos.filter(l => l.id !== reg.id && !(l.bdr === reg.bdr && l.data === reg.data));
  resto.push(reg);
  resto.sort((a, b) => a.data.localeCompare(b.data));
  return resto;
}

/* ---------- rotas ---------- */

async function api(req, env, rota) {
  /* entrar com o PIN */
  if (rota === "/api/login" && req.method === "POST") {
    const { excedeu, registrarErro } = await tentativasExcedidas(req, env);
    if (excedeu) return erro("bloqueado", "Muitas tentativas. Espere alguns minutos.", 429);

    const corpo = await req.json().catch(() => ({}));
    const perfil = String(corpo.perfil || "");
    const pin = String(corpo.pin || "");
    if (!PESSOAS[perfil] || !/^\d{4,8}$/.test(pin)) {
      await registrarErro();
      return erro("pin_invalido", "PIN incorreto.", 401);
    }
    const pins = await lerPins(env);
    if (pins[perfil] !== embaralhar(pin)) {
      await registrarErro();
      return erro("pin_invalido", "PIN incorreto.", 401);
    }
    const token = novoToken();
    await env.PAINEL.put("sess:" + token, perfil, { expirationTtl: VALIDADE_SESSAO });
    return json({ token, perfil, papel: PESSOAS[perfil].papel });
  }

  /* daqui para baixo tudo exige estar logado */
  const eu = await quemEsta(req, env);
  if (!eu) return erro("sem_sessao", "Sua sessão expirou. Entre de novo com o PIN.", 401);

  if (rota === "/api/eu" && req.method === "GET") {
    return json({ perfil: eu, papel: PESSOAS[eu].papel });
  }

  /* os lancamentos do periodo: todo mundo logado ve os numeros do time */
  if (rota === "/api/estado" && req.method === "GET") {
    const { rev, lancamentos } = await lerEstado(env);
    return json({ v: 1, rev, lancamentos });
  }

  if (rota === "/api/lancamento" && req.method === "POST") {
    const corpo = await req.json().catch(() => ({}));
    const reg = limparLancamento(corpo.lancamento, eu);
    if (!reg) return erro("dados_invalidos", "Não consegui entender esse lançamento.", 400);
    const estado = await lerEstado(env);
    estado.lancamentos = encaixar(estado.lancamentos, reg);
    const novo = await gravarEstado(env, estado);
    return json({ rev: novo.rev, lancamentos: novo.lancamentos });
  }

  if (rota === "/api/lancamento/excluir" && req.method === "POST") {
    const corpo = await req.json().catch(() => ({}));
    const id = String(corpo.id || "");
    const estado = await lerEstado(env);
    const alvo = estado.lancamentos.find(l => l.id === id);
    if (!alvo) return erro("nao_encontrado", "Esse lançamento não existe mais.", 404);
    if (PESSOAS[eu].papel !== "admin" && alvo.bdr !== eu) {
      return erro("sem_permissao", "Você só pode excluir os seus próprios lançamentos.", 403);
    }
    estado.lancamentos = estado.lancamentos.filter(l => l.id !== id);
    const novo = await gravarEstado(env, estado);
    return json({ rev: novo.rev, lancamentos: novo.lancamentos });
  }

  /* usado pelo botao de restaurar a copia guardada no navegador */
  if (rota === "/api/lancamentos/importar" && req.method === "POST") {
    const corpo = await req.json().catch(() => ({}));
    const lista = Array.isArray(corpo.lancamentos) ? corpo.lancamentos.slice(0, 500) : null;
    if (!lista) return erro("dados_invalidos", "Nada para importar.", 400);
    const estado = await lerEstado(env);
    for (const bruto of lista) {
      const reg = limparLancamento(bruto, eu);
      if (reg) estado.lancamentos = encaixar(estado.lancamentos, reg);
    }
    const novo = await gravarEstado(env, estado);
    return json({ rev: novo.rev, lancamentos: novo.lancamentos });
  }

  /* trocar o PIN de alguem: so o admin */
  if (rota === "/api/pin" && req.method === "POST") {
    if (PESSOAS[eu].papel !== "admin") {
      return erro("sem_permissao", "Só o Gilvan pode trocar PINs.", 403);
    }
    const corpo = await req.json().catch(() => ({}));
    const alvo = String(corpo.alvo || "");
    const pin = String(corpo.pin || "");
    if (!PESSOAS[alvo]) return erro("dados_invalidos", "Perfil não encontrado.", 400);
    if (!/^\d{4}$/.test(pin)) return erro("dados_invalidos", "O PIN precisa ter 4 dígitos.", 400);
    const pins = await lerPins(env);
    pins[alvo] = embaralhar(pin);
    await env.PAINEL.put("pins", JSON.stringify(pins));
    return json({ ok: true });
  }

  if (rota === "/api/sair" && req.method === "POST") {
    const token = (req.headers.get("authorization") || "").slice(7).trim();
    await env.PAINEL.delete("sess:" + token);
    return json({ ok: true });
  }

  return erro("rota_desconhecida", "Endereço não encontrado.", 404);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (url.pathname.startsWith("/api/")) {
      try {
        return await api(req, env, url.pathname);
      } catch (e) {
        return erro("falha_interna", "Deu problema no servidor. Tente de novo.", 500);
      }
    }

    /* qualquer outro endereco cai no index.html do painel */
    return env.ASSETS.fetch(new Request(new URL("/", url), req));
  }
};
