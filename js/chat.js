import {settings, state} from './store.js?v=20260819j';
import {$, esc, money, toast, lineAmount} from './util.js?v=20260819j';
import {CUR} from './config.js?v=20260819j';
import {hub} from './hub.js?v=20260819j';
import {chatConfig} from './ai.js?v=20260819j';
import {
  purchaseTotal, labourTotal, loanReceived, ownCash, fundsIn, totalSpent, inHand,
  extraNeeded, overdrawn, budgetMaterialsPlanned, budgetLabourPlanned, budgetPlan,
  spentMaterialsForCat, spentLabourForCat, totalPlan
} from './finance.js?v=20260819j';

let history = [];

function buildItemPriceSnapshot(limit) {
  const out = [];
  state.purchases.forEach(p => {
    const seller = p.seller || '';
    const date = p.date || '';
    if (Array.isArray(p.lines) && p.lines.length) {
      p.lines.forEach(l => {
        const item = String((l && l.item) || '').trim();
        if (!item) return;
        const amount = lineAmount(l);
        const rate = Number(l.rate) || 0;
        const qty = Number(l.qty) || 0;
        out.push({item, amount, rate, qty, seller, date, receipt: p.receipt || '', category: p.category || ''});
      });
    } else if (p.item) {
      out.push({
        item: String(p.item).trim(),
        amount: Number(p.price) || 0,
        rate: 0,
        qty: 0,
        seller,
        date,
        receipt: p.receipt || '',
        category: p.category || ''
      });
    }
  });
  out.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  return out.slice(0, limit || 300);
}

function localItemPriceAnswer(msg) {
  const q = String(msg || '').toLowerCase();
  if (!/(price|cost|rate|paid|how much|best price|cheapest)/i.test(q)) return '';
  const rows = buildItemPriceSnapshot(1000);
  if (!rows.length) return '';
  const tokens = q.replace(/[^a-z0-9\s/.-]/g, ' ').split(/\s+/).filter(w => w.length >= 3 && !['price', 'cost', 'rate', 'paid', 'much', 'best', 'cheapest', 'what', 'for', 'item', 'this'].includes(w));
  if (!tokens.length) return '';
  const hits = rows.filter(r => {
    const it = r.item.toLowerCase();
    return tokens.every(t => it.includes(t));
  });
  if (!hits.length) return '';
  const amounts = hits.map(h => h.amount).filter(n => Number.isFinite(n) && n > 0);
  if (!amounts.length) return '';
  const min = Math.min(...amounts), max = Math.max(...amounts);
  const avg = amounts.reduce((s, n) => s + n, 0) / amounts.length;
  const recent = hits[0];
  const sample = hits.slice(0, 4).map(h => `- ${h.date || '?'} · ${h.seller || 'Unknown seller'} · ${h.item} · ${money(h.amount)}`).join('\n');
  return `I found ${hits.length} matching line item${hits.length === 1 ? '' : 's'} for "${recent.item}".\n` +
    `Price range: ${money(min)} to ${money(max)} · Average: ${money(avg)}.\n` +
    `Most recent: ${money(recent.amount)} on ${recent.date || '?'} at ${recent.seller || 'Unknown seller'}.\n` +
    `Recent matches:\n${sample}`;
}

export function buildSystemPrompt() {
  const loan = loanReceived(), cash = ownCash(), fin = fundsIn();
  const spent = totalSpent(), avail = inHand(), extra = extraNeeded(), over = overdrawn(), plan = totalPlan();

  const catSpend = {};
  (state.budget || []).forEach(b => {
    const c = b.category || 'Uncategorized';
    catSpend[c] = spentMaterialsForCat(c) + spentLabourForCat(c);
  });
  (state.purchases || []).forEach(p => {
    const c = (p.category || 'Uncategorized').trim();
    if (catSpend[c] == null) catSpend[c] = spentMaterialsForCat(c) + spentLabourForCat(c);
  });
  (state.labour || []).forEach(p => {
    const c = (p.category || 'Uncategorized').trim();
    if (catSpend[c] == null) catSpend[c] = spentMaterialsForCat(c) + spentLabourForCat(c);
  });
  const catBreakdown = Object.entries(catSpend).sort((a, b) => b[1] - a[1])
    .map(([c, a]) => `  ${c}: ${CUR}${a.toLocaleString()}`).join('\n');

  const budgetStatus = (state.budget || []).map(b => {
    const matP = budgetMaterialsPlanned(b), labP = budgetLabourPlanned(b);
    const matS = spentMaterialsForCat(b.category), labS = spentLabourForCat(b.category);
    const bud = budgetPlan(b), sp = matS + labS;
    return `  ${b.category}: plan ${CUR}${bud.toLocaleString()} (materials ${CUR}${matP.toLocaleString()} / labour ${CUR}${labP.toLocaleString()}), spent ${CUR}${sp.toLocaleString()} (materials ${CUR}${matS.toLocaleString()} / labour ${CUR}${labS.toLocaleString()}), remaining ${CUR}${(bud - sp).toLocaleString()}`;
  }).join('\n');

  const recent = [...(state.purchases || [])].sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 10)
    .map(p => `  ${p.date || '?'} | ${p.seller || '?'} | ${p.item || '?'} | ${CUR}${purchaseTotal(p).toLocaleString()} | ${p.category || ''} | ${p.paymentMethod || ''}`).join('\n');

  const recentLabour = [...(state.labour || [])].sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 10)
    .map(p => `  ${p.date || '?'} | ${p.payee || '?'} | ${p.category || ''} | ${CUR}${labourTotal(p).toLocaleString()} | ${p.method || ''}`).join('\n');

  const lineHistory = buildItemPriceSnapshot(250)
    .map(r => `  ${r.date || '?'} | ${r.seller || '?'} | ${r.item} | amount ${CUR}${(Number(r.amount) || 0).toLocaleString()}${r.rate ? (' | rate ' + CUR + Number(r.rate).toLocaleString()) : ''}${r.qty ? (' | qty ' + Number(r.qty).toLocaleString()) : ''}`)
    .join('\n');

  const sellers = state.sellers.map(s => {
    const parts = [s.name];
    if (s.item) parts.push(`for ${s.item}`);
    if (s.contact) parts.push(s.contact);
    if (s.price !== '' && s.price != null) parts.push(`quoted ${CUR}${(+s.price || 0).toLocaleString()}`);
    if (s.status) parts.push(`(${s.status})`);
    return '  ' + parts.join(' — ');
  }).join('\n');

  const pendingActions = state.actions.filter(a => a.status !== 'done')
    .map(a => `  ${a.title}${a.due ? ' (due ' + a.due + ')' : ''} [${a.status}]`).join('\n');

  return `You are a construction budget assistant for Site Ledger. Answer based on the data below. Be concise. Use Rs for currency. If asked about prices, compare from purchase history. Shop bills are materials; contractor payments are labour. Extra needed is max(0, plan − funds in).

FUNDS:
  Loan received: ${CUR}${loan.toLocaleString()}
  Own cash: ${CUR}${cash.toLocaleString()}
  Funds in: ${CUR}${fin.toLocaleString()}
  Plan (materials + labour): ${CUR}${plan.toLocaleString()}
  Total spent (purchases + labour): ${CUR}${spent.toLocaleString()}
  In hand: ${CUR}${avail.toLocaleString()}
  Extra needed: ${CUR}${extra.toLocaleString()}
  Already overdrawn: ${CUR}${over.toLocaleString()}

SPENDING BY TRADE:
${catBreakdown || '  (none)'}

BUDGET STATUS:
${budgetStatus || '  (no budget set)'}

RECENT PURCHASES (last 10, materials):
${recent || '  (none)'}

RECENT LABOUR PAYMENTS (last 10):
${recentLabour || '  (none)'}

SELLERS:
${sellers || '  (none)'}

PENDING ACTIONS:
${pendingActions || '  (none)'}

LINE ITEM PRICE HISTORY:
${lineHistory || '  (none)'}`;
}

function appendMsg(role, text) {
  const el = $('chat-messages');
  if (!el) return;
  const div = document.createElement('div');
  div.className = 'chat-msg ' + role;
  div.innerHTML = '<p>' + esc(text) + '</p>';
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}

function showTyping() {
  const el = $('chat-messages');
  if (!el) return;
  const div = document.createElement('div');
  div.className = 'chat-msg assistant typing';
  div.id = 'chat-typing';
  div.innerHTML = '<p>Thinking…</p>';
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}

function removeTyping() {
  const t = $('chat-typing');
  if (t) t.remove();
}

async function sendMessage() {
  const input = $('chat-input');
  if (!input) return;
  const msg = input.value.trim();
  if (!msg) return;

  if (!settings.apiKey) {
    appendMsg('assistant', 'Set up AI in Settings first — I need an API key to work.');
    return;
  }

  input.value = '';
  appendMsg('user', msg);

  const localPrice = localItemPriceAnswer(msg);
  if (localPrice) {
    appendMsg('assistant', localPrice);
    history.push({role: 'assistant', content: localPrice});
    if (history.length > 20) history = history.slice(history.length - 20);
    return;
  }

  history.push({role: 'user', content: msg});
  if (history.length > 20) history = history.slice(history.length - 20);

  const sendBtn = $('chat-send');
  if (sendBtn) sendBtn.disabled = true;
  showTyping();

  try {
    const cfg = chatConfig();
    const messages = [
      {role: 'system', content: buildSystemPrompt()},
      ...history
    ];

    const res = await fetch(cfg.url, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', Authorization: cfg.auth},
      body: JSON.stringify({model: cfg.model, messages, temperature: 0.4, max_tokens: 1200})
    });

    removeTyping();

    if (!res.ok) {
      let extra = '';
      try { const t = await res.text(); const j = JSON.parse(t); extra = (j.error && (j.error.message || j.error)) || ''; } catch (e) {}
      const errMsg = 'API error ' + res.status + (extra ? ': ' + String(extra).slice(0, 140) : '');
      appendMsg('assistant', errMsg);
      return;
    }

    const json = await res.json();
    const reply = (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || '(no response)';
    history.push({role: 'assistant', content: reply});
    if (history.length > 20) history = history.slice(history.length - 20);
    appendMsg('assistant', reply);
  } catch (e) {
    removeTyping();
    appendMsg('assistant', 'Error: ' + (e.message || 'Could not reach the AI'));
  } finally {
    if (sendBtn) sendBtn.disabled = false;
    const inp = $('chat-input');
    if (inp) inp.focus();
  }
}

export function openChat() {
  const p = $('chat-panel');
  if (p) p.classList.add('show');
  const inp = $('chat-input');
  if (inp) setTimeout(() => inp.focus(), 60);
}

export function closeChat() {
  const p = $('chat-panel');
  if (p) p.classList.remove('show');
}

export function initChat() {
  const msgs = $('chat-messages');
  if (msgs && !msgs.children.length) {
    const div = document.createElement('div');
    div.className = 'chat-msg assistant';
    div.innerHTML = '<p>Hi! I\'m your Site Ledger assistant. Ask me about your spending, budget, sellers, or anything about your construction project.</p>';
    msgs.appendChild(div);
  }

  const btn = $('chat-send');
  if (btn) btn.onclick = sendMessage;

  const input = $('chat-input');
  if (input) input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });

  const closeBtn = $('chat-close');
  if (closeBtn) closeBtn.onclick = closeChat;

  const openBtn = $('open-chat');
  if (openBtn) openBtn.onclick = openChat;
}

function insightFingerprint() {
  return [totalSpent(), totalPlan(), fundsIn(), (state.purchases || []).length, (state.labour || []).length, (state.actions || []).length].join('|');
}

let insightCache = {key: '', data: null};

export function localDashboardInsights() {
  const spent = totalSpent(), plan = totalPlan(), avail = inHand(), extra = extraNeeded(), over = overdrawn();
  const remain = Math.max(0, plan - spent);
  const usedPct = plan > 0 ? Math.round(spent / plan * 100) : 0;
  const cards = [];
  if (over > 0) cards.push({tone: 'alert', title: 'Overdrawn', body: 'Spend exceeds funds in by ' + money(over) + '. Add a tranche or pause non-critical buys.'});
  else if (remain > 0 && avail / remain < 0.1) cards.push({tone: 'alert', title: 'Cash is tight', body: 'In hand covers under 10% of remaining plan. Extra needed: ' + money(extra) + '.'});
  else if (remain > 0 && avail / remain < 0.3) cards.push({tone: 'warn', title: 'Request the next tranche soon', body: 'In hand is 10–30% of remaining plan (' + money(remain) + ' left to spend).'});
  else cards.push({tone: 'ok', title: 'Position looks healthy', body: 'In hand ' + money(avail) + ' · plan used ' + usedPct + '% · extra needed ' + money(extra) + '.'});

  const overTrades = (state.budget || []).filter(b => {
    const rem = budgetPlan(b) - spentMaterialsForCat(b.category) - spentLabourForCat(b.category);
    return rem < 0;
  });
  if (overTrades.length) {
    cards.push({tone: 'warn', title: overTrades.length + ' trade' + (overTrades.length === 1 ? '' : 's') + ' over plan', body: overTrades.slice(0, 3).map(b => b.category).join(', ') + ' — check labour vs materials tagging.'});
  }
  const pending = (state.actions || []).filter(a => a.status !== 'done');
  if (pending.length) cards.push({tone: 'ok', title: pending.length + ' open task' + (pending.length === 1 ? '' : 's'), body: pending.slice(0, 3).map(a => a.title).join(' · ') || 'Review the Actions tab.'});
  return {
    headline: usedPct + '% of plan used · ' + money(avail) + ' in hand',
    cards: cards.slice(0, 4),
    source: 'local'
  };
}

export function insightCardsHtml(data) {
  const d = data || localDashboardInsights();
  return '<div class="ai-headline">' + esc(d.headline || 'Site briefing') + '</div>' +
    '<div class="ai-cards">' +
    (d.cards || []).map(c =>
      '<article class="ai-card ' + esc(c.tone || 'ok') + '"><p class="ai-k">' + esc(c.title || '') + '</p><p class="ai-b">' + esc(c.body || '') + '</p></article>'
    ).join('') +
    '</div>' +
    '<p class="ai-source">' + (d.source === 'ai' ? 'Written from your ledger by AI' : (settings.apiKey ? 'Refreshing AI briefing…' : 'Local briefing — add an AI key in Settings for a written analysis')) + '</p>';
}

export async function loadDashboardInsights(force) {
  const key = insightFingerprint();
  if (!force && insightCache.key === key && insightCache.data) return insightCache.data;
  const local = localDashboardInsights();
  if (!settings.apiKey) {
    insightCache = {key, data: local};
    return local;
  }
  try {
    const cfg = chatConfig();
    const prompt = 'You are the Site Ledger analyst. Using ONLY the ledger snapshot, write a short briefing. Reply ONLY JSON: {"headline":string,"cards":[{"tone":"ok"|"warn"|"alert","title":string,"body":string}]}. 3 to 4 cards. headline max 90 chars. title max 40 chars. body max 140 chars. Be specific with Rs amounts and trade names. Flag over-budget trades, cash runway, and the next useful action.\n\n' + buildSystemPrompt();
    const res = await fetch(cfg.url, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', Authorization: cfg.auth},
      body: JSON.stringify({
        model: cfg.model,
        messages: [{role: 'user', content: prompt}],
        temperature: 0.3,
        max_tokens: 700
      })
    });
    if (!res.ok) throw new Error('API ' + res.status);
    const json = await res.json();
    const txt = (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || '';
    const raw = String(txt).replace(/```json/gi, '').replace(/```/g, '').trim();
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    const parsed = JSON.parse(start >= 0 ? raw.slice(start, end + 1) : raw);
    const cards = Array.isArray(parsed.cards) ? parsed.cards.slice(0, 4).map(c => ({
      tone: /alert|warn|ok/.test(c.tone) ? c.tone : 'ok',
      title: String(c.title || '').slice(0, 60),
      body: String(c.body || '').slice(0, 220)
    })) : local.cards;
    const data = {headline: String(parsed.headline || local.headline).slice(0, 120), cards, source: 'ai'};
    insightCache = {key, data};
    return data;
  } catch (e) {
    insightCache = {key, data: Object.assign({}, local, {source: 'local'})};
    return insightCache.data;
  }
}

export async function mountDashboardInsights() {
  const host = $('ai-briefing');
  if (!host) return;
  host.innerHTML = insightCardsHtml(insightCache.data || localDashboardInsights());
  const data = await loadDashboardInsights(false);
  if ($('ai-briefing') === host) host.innerHTML = insightCardsHtml(data);
}

