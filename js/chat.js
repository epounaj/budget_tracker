import {settings, state} from './store.js?v=20260818e';
import {$, esc, money, toast} from './util.js?v=20260818e';
import {CUR, CATEGORIES} from './config.js?v=20260818e';
import {hub} from './hub.js?v=20260818e';
import {chatConfig} from './ai.js?v=20260818e';

let history = [];

function buildSystemPrompt() {
  const loan = state.funds.filter(f => f.type === 'loan').reduce((s, f) => s + (+f.amount || 0), 0);
  const cash = state.funds.filter(f => f.type === 'cash').reduce((s, f) => s + (+f.amount || 0), 0);
  const total = loan + cash;
  const spent = state.purchases.reduce((s, p) => s + (+p.price || 0), 0);
  const avail = total - spent;

  const catSpend = {};
  state.purchases.forEach(p => {
    const c = (p.category || 'Uncategorized').trim();
    catSpend[c] = (catSpend[c] || 0) + (+p.price || 0);
  });
  const catBreakdown = Object.entries(catSpend).sort((a, b) => b[1] - a[1])
    .map(([c, a]) => `  ${c}: ${CUR}${a.toLocaleString()}`).join('\n');

  const budgetStatus = state.budget.map(b => {
    const bud = +b.budgeted || 0;
    const sp = state.purchases.filter(p => (p.category || '').toLowerCase() === (b.category || '').toLowerCase())
      .reduce((s, p) => s + (+p.price || 0), 0);
    return `  ${b.category}: budgeted ${CUR}${bud.toLocaleString()}, spent ${CUR}${sp.toLocaleString()}, remaining ${CUR}${(bud - sp).toLocaleString()}`;
  }).join('\n');

  const recent = [...state.purchases].sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 10)
    .map(p => `  ${p.date || '?'} | ${p.seller || '?'} | ${p.item || '?'} | ${CUR}${(+p.price || 0).toLocaleString()} | ${p.category || ''}`).join('\n');

  const sellers = state.sellers.map(s => {
    const parts = [s.name];
    if (s.item) parts.push(`for ${s.item}`);
    if (s.price !== '' && s.price != null) parts.push(`quoted ${CUR}${(+s.price || 0).toLocaleString()}`);
    if (s.status) parts.push(`(${s.status})`);
    return '  ' + parts.join(' — ');
  }).join('\n');

  const pendingActions = state.actions.filter(a => a.status !== 'done')
    .map(a => `  ${a.title}${a.due ? ' (due ' + a.due + ')' : ''} [${a.status}]`).join('\n');

  return `You are a construction budget assistant for Site Ledger. Answer based on the data below. Be concise. Use Rs for currency. If asked about prices, compare from purchase history.

FUNDS:
  Loan received: ${CUR}${loan.toLocaleString()}
  Own cash: ${CUR}${cash.toLocaleString()}
  Total available: ${CUR}${total.toLocaleString()}
  Total spent: ${CUR}${spent.toLocaleString()}
  Remaining: ${CUR}${avail.toLocaleString()}

SPENDING BY CATEGORY:
${catBreakdown || '  (none)'}

BUDGET STATUS:
${budgetStatus || '  (no budget set)'}

RECENT PURCHASES (last 10):
${recent || '  (none)'}

SELLERS:
${sellers || '  (none)'}

PENDING ACTIONS:
${pendingActions || '  (none)'}`;
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
