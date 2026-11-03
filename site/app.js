'use strict';
// OrbitWan xLend: fixed-term, fixed-rate loans between two people, on Wanchain (the network in NET).
// The page asks the wallet to sign these transactions, each to the xLend contract (XLend) at NET.lend or to a token
// the contract lists:
//   approve(contract, amount) on a token, for exactly what the next step takes, only when the allowance is short;
//   post(...) posts an offer and deposits the loan; cancel(id) takes back the lender's open offer;
//   accept(id) deposits the collateral and pays out the whole loan;
//   repay(id) repays loan, interest and the service fee; claim(id) takes the collateral after the grace period;
//   withdraw(token); mint(account, amount) on a test token (testnet only).
// While the contract's admin has paused new loans, the contract refuses post and accept and the page says so on those
// buttons; cancel, repay, claim and withdraw are never paused.
// Every transaction names NET's chain, every one but an approval runs first as an eth_call on the node (one that would
// fail never reaches the wallet), and the page reads the wallet's chain again just before it sends. A chain id can name
// more than one network (Wanchain testnet's 999 is also HyperEVM's), so the page accepts the wallet's chain only when
// the contract's code there hashes to NET.codehash.
// The tokens, their symbols and decimals, and the day are NET's own; every read checks that the contract's token list
// and day still equal them, so a node can never make the page show one amount and send another.
// The page's reads go to Wanchain's public RPC, one JSON-RPC batch per step, with or without a wallet; the wallet gets
// only the network check, its gas price, the dry run and the last reads before a transaction, the transaction and its
// receipt. The page also reads OrbitWan's price table (NET.prices) for the dollar value under the two amounts. Nothing
// else leaves the page.
(() => {
  // inside another site's frame the page does not run, so no other site can lay its own page over these buttons
  if (window.top !== window.self) return;
  const { Interface, AbiCoder, parseUnits, formatUnits, keccak256 } = window.ethers;
  const W = window.Wallet;

  // One release: the page, shared/style.css, shared/wallet.js and this file carry one release id; on a mismatch the
  // page loads itself once more under an address no cache holds (?r=), then runs with what it has.
  const BUILD = 'bc31ad92f';
  {
    const u = new URL(location.href);
    const css = getComputedStyle(document.documentElement).getPropertyValue('--build').trim();
    if (document.documentElement.dataset.build !== BUILD || css !== BUILD || !W || W.BUILD !== BUILD) {
      if (u.searchParams.get('r') !== BUILD) { u.searchParams.set('r', BUILD); location.replace(u.href); return; }
    } else if (u.searchParams.has('r')) {
      u.searchParams.delete('r');
      history.replaceState(null, '', u.href);
    }
  }

  // The network: Wanchain mainnet. Testnet replaces this block only (and the RPC in index.html's connect-src).
  const NET = {
    chainId: 888,
    params: {
      chainId: '0x378', chainName: 'Wanchain', nativeCurrency: { name: 'WAN', symbol: 'WAN', decimals: 18 },
      rpcUrls: ['https://gwan-ssl.wandevs.org:56891'], blockExplorerUrls: ['https://orbitwan.io'],
    },
    rpc: 'https://gwan-ssl.wandevs.org:56891',
    explorer: 'https://orbitwan.io',
    // OrbitWan's price table, for the dollar value under the two amounts (null: none shown)
    prices: 'https://orbitwan.io/idx/prices',
    lend: '0x6dfa0b14be511cb0ff735c147f650b5791b84848',
    // the block the xLend contract was deployed in: the page reads its events from there
    from: 47096213,
    // keccak256 of the contract's runtime code on this chain (admin, treasury and the 1-day day filled in)
    codehash: '0x9d302080d171134ddf215f620c7950e0f4d81c2dce8e273382c62ec6a2442f4d',
    day: 86400n,
    // the contract's tokens, in its order, with the symbol and decimals the page shows and computes with
    tokens: [
      { addr: '0x0000000000000000000000000000000000000000', sym: 'WAN', dec: 18 },
      { addr: '0x2ea407aa69be7367bf231e76b51fab9ec436766c', sym: 'xWAN', dec: 18 },
      { addr: '0x50c439b6d602297252505a6799d84ea5928bcfb6', sym: 'BTC', dec: 8 },
      { addr: '0xe3ae74d1518a76715ab4c7bedf1af73893cd435a', sym: 'ETH', dec: 18 },
      { addr: '0x11e77e27af5539872efed10abaa0b408cfd9fbbd', sym: 'USDT', dec: 6 },
      { addr: '0x52a9cea01c4cbdd669883e41758b8eb8e8e2b34b', sym: 'USDC', dec: 6 },
      { addr: '0x79d745178bc271a1f29f8fbe9251dfc512db842c', sym: 'ADA', dec: 6 },
      { addr: '0xe61f47a5fa9db061e2d9e2e88c604a583d878a5f', sym: 'VET', dec: 18 },
      { addr: '0xf665e0e3e75d16466345e1129530ec28839efaea', sym: 'XRP', dec: 6 },
    ],
    // the test tokens anyone can mint, and how much one tap mints (testnet only; empty on mainnet)
    mint: {},
  };
  const LEND = NET.lend;
  const WAN = '0x0000000000000000000000000000000000000000';
  const RPC_TIMEOUT_MS = 15000;  // a public RPC read that takes longer counts as unread
  const WAIT_MS = 300000;        // how long to wait for a sent transaction's receipt before saying it is unconfirmed
  const SETTLE_MS = 30000;       // how long a step waits, after its receipt, for a read of the chain at or after that block
  const REFRESH_MS = 15000;
  const PRICE_MS = 300000;       // the price table is read every 5 minutes (its writer runs every 15),
  const PRICE_RETRY_MS = 30000;  // and every 30 s while no read of it has worked
  const STALE_READ_MS = 3000;    // a loan's amount gone stale since the last read: read again, at most this often
  const CHUNK = 100;             // loans read per batch
  const MOVE_GUARD_MS = 800;     // a tap on a list button this soon after the list moved is ignored
  const GAS_RESERVE = parseUnits('0.01', 18); // WAN a step leaves in the wallet for gas
  const MAX_GAS_PRICE = parseUnits('50', 9);    // the most a public RPC's gas price can raise a transaction to
  const U128 = (1n << 128n) - 1n;
  // the contract's own constants: terms 0..4 last 30, 60, 90, 180 and 365 days; the APR is per 365-day year, at most
  // 1200% (MAX_APR_BPS)
  const TERM_DAYS = [30n, 60n, 90n, 180n, 365n];
  const YEAR_DAYS = 365n;
  const MAX_APR_BPS = 120000n;
  const GRACE_DAYS = 3n;
  const BPS = 10000n;
  // A repay is sent with what it will cost REPAY_MARGIN seconds from the latest block (a WAN overpayment comes back),
  // and a token approval covers APPROVE_MARGIN seconds, so a day boundary in the grace period does not fail it.
  const REPAY_MARGIN = 30n;
  const APPROVE_MARGIN = 120n;
  const OPEN = 1, ACTIVE = 2, REPAID = 3, CLAIMED = 4, CANCELLED = 5;

  const lend = new Interface([
    'function DAY() view returns (uint256)',
    'function tokens() view returns (address[])',
    'function feeBps(uint256 term) view returns (uint256)',
    'function paused() view returns (bool)',
    'function loanCount() view returns (uint256)',
    'function loanCountOf(address who) view returns (uint256)',
    'function loansOf(address who, uint256 start, uint256 max) view returns (uint256[])',
    'function getLoan(uint256 id) view returns ((address lender, uint32 aprBps, uint8 term, uint16 feeBps, uint8 state, address borrower, uint64 start, address loanToken, address collToken, uint128 loanAmount, uint128 collAmount))',
    'function owed(uint256 id) view returns (uint256 total, uint256 interest, uint256 late, uint256 fee, bool repayable)',
    'function credit(address owner, address token) view returns (uint256)',
    'function post(address loanToken, uint256 loanAmount, address collToken, uint256 collAmount, uint256 aprBps, uint256 term) payable returns (uint256 id)',
    'function cancel(uint256 id)',
    'function claim(uint256 id)',
    'function accept(uint256 id) payable',
    'function repay(uint256 id) payable',
    'function withdraw(address token)',
    'event Posted(uint256 indexed id, address indexed lender, address loanToken, uint256 loanAmount, address collToken, uint256 collAmount, uint256 aprBps, uint256 term, uint256 feeBps)',
    'event Accepted(uint256 indexed id, address indexed borrower, uint256 due)',
    'event Repaid(uint256 indexed id, uint256 interest, uint256 late, uint256 fee)',
    'event Claimed(uint256 indexed id)',
    'event Cancelled(uint256 indexed id)',
    'event Credited(address indexed owner, address indexed token, uint256 amount)',
  ]);
  const erc20 = new Interface([
    'function balanceOf(address owner) view returns (uint256)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)',
    'function mint(address to, uint256 amount)',
  ]);

  const $ = (id) => document.getElementById(id);
  const lc = (a) => String(a).toLowerCase();
  const same = (a, b) => !!a && !!b && lc(a) === lc(b);
  const s = {
    account: null,
    net: 'none',        // 'none' no account, 'other' another chain, 'check' NET's chain id not proven yet, 'bad' NET's chain id on another network, 'ok'
    meta: { day: NET.day, tokens: NET.tokens }, // NET's own; each read checks the contract still lists exactly these
    fees: null,         // the fee of each term now, in basis points
    paused: null,       // true: the contract refuses new offers and new loans
    now: null, nowAt: 0, // the latest block's time, and when it was read
    readBlock: null,    // the number of the block the last read saw
    loans: null,        // the loans read, newest first: every loan for the offers, the account's own among them
    mine: null,         // the account's own loans (the contract's list for it), newest first
    offersFailed: false, mineFailed: false, // that part of the last read failed; the rest of the page stands
    bal: null, allow: null, credit: null, owed: {}, // the connected account's, by token address; owed by loan id
    term: 0,
    otab: '',           // the Borrow card's tab: '' All, else a token address (the offers that lend it)
    approvedNow: '',    // the step whose approval just went through: its button says (2 of 2)
    busy: '', busyKey: '',
    notes: { post: null, offers: null, mine: null, test: null },
    readFailed: false,  // the last read failed: an unread figure shows a dash, else a blank
    prices: null,       // OrbitWan's price table as last read ({ fresh, rows, native }), or 'failed' while no read has worked
  };
  const noteOf = (key) => (key === 'post' ? 'post' : key[0] === 'o' ? 'offers' : key[0] === 'm' ? 'test' : 'mine');
  const setNote = (key, n) => { s.notes[noteOf(key)] = n; };
  const tok = (addr) => (s.meta ? s.meta.tokens.find((t) => t.addr === lc(addr)) : null) || null;
  const loanById = (id) => (s.mine || []).concat(s.loans || []).find((l) => String(l.id) === String(id)) || null;

  // ---- chain reads -------------------------------------------------------------------------------
  let rpcId = 0;
  const viaWallet = () => !!(s.account && s.net === 'ok');
  async function rpc(method, params) {
    if (viaWallet()) return W.eth().request({ method, params });
    const res = await fetch(NET.rpc, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
    const j = await res.json();
    if (j.error) throw Object.assign(new Error(j.error.message || 'rpc error'), { data: j.error.data });
    return j.result;
  }
  // The reads of one step go out at once: to the public RPC as one JSON-RPC batch, or (publicOnly false, with a wallet)
  // through the wallet side by side. A reply without a result fails the whole read. The page's own reads are publicOnly:
  // through a wallet each read is a request of its own, which made the page about three times slower to show. When the
  // public RPC fails them and a wallet is connected, they go through the wallet, so a borrower can still repay.
  async function readAll(reqs, publicOnly) {
    if (!reqs.length) return [];
    const throughWallet = () => Promise.all(reqs.map(([method, params]) => W.eth().request({ method, params })));
    if (viaWallet() && !publicOnly) return throughWallet();
    try { return await batch(reqs); } catch (e) { if (viaWallet()) return throughWallet(); throw e; }
  }
  async function batch(reqs) {
    const body = reqs.map(([method, params]) => ({ jsonrpc: '2.0', id: ++rpcId, method, params }));
    const res = await fetch(NET.rpc, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
    const j = await res.json();
    if (!Array.isArray(j)) throw new Error('rpc batch error');
    return body.map(({ id }) => {
      const r = j.find((x) => x && x.id === id);
      if (!r || r.error || r.result === undefined || r.result === null) throw new Error('rpc batch error');
      return r.result;
    });
  }
  const ec = (to, iface, fn, args = []) => ['eth_call', [{ to, data: iface.encodeFunctionData(fn, args) }, 'latest']];
  const dc = (iface, fn, data) => iface.decodeFunctionResult(fn, data)[0];
  const BLOCK = ['eth_getBlockByNumber', ['latest', false]];
  function blockTime(b) {
    if (!b || typeof b.timestamp !== 'string') throw new Error('no block');
    return BigInt(b.timestamp);
  }
  // a loan as the contract holds it; a term, state or token the contract cannot hold fails the read
  function toLoan(id, r) {
    const term = Number(r.term), state = Number(r.state);
    if (!(term >= 0 && term < 5) || !(state >= 1 && state <= 5) || !tok(lc(r.loanToken)) || !tok(lc(r.collToken))) throw new Error('loan');
    return {
      id: BigInt(id), lender: lc(r.lender), aprBps: BigInt(r.aprBps), term: Number(r.term), feeBps: BigInt(r.feeBps),
      state: Number(r.state), borrower: lc(r.borrower), start: BigInt(r.start), loanToken: lc(r.loanToken),
      collToken: lc(r.collToken), loanAmount: BigInt(r.loanAmount), collAmount: BigInt(r.collAmount),
    };
  }
  // The transaction each listed loan last changed in (posted, accepted, repaid, claimed or cancelled), from the
  // contract's own events: the loan's number opens it on the explorer. One read per loan and
  // state, again after TX_RETRY_MS while none was found; a read that fails or finds no single event leaves the number
  // plain, never a wrong link.
  const EVENT_OF = { [OPEN]: 'Posted', [ACTIVE]: 'Accepted', [REPAID]: 'Repaid', [CLAIMED]: 'Claimed', [CANCELLED]: 'Cancelled' };
  const TX_RETRY_MS = 60000;
  const txOf = new Map();   // loan id -> { state, hash (null: none found), at }
  let txReading = false;
  const topicOf = (name) => lend.getEvent(name).topicHash;
  const idTopic = (id) => '0x' + BigInt(id).toString(16).padStart(64, '0');
  const txLink = (l) => { const k = txOf.get(String(l.id)); return k && k.state === l.state && k.hash ? `${NET.explorer}/tx/${k.hash}` : ''; };
  async function readTxs() {
    if (txReading) return;
    const listed = (s.loans || []).filter((l) => l.state === OPEN).concat(s.mine || []);
    const want = [...new Map(listed.map((l) => [String(l.id), l])).values()].filter((l) => {
      const k = txOf.get(String(l.id));
      return EVENT_OF[l.state] && (!k || k.state !== l.state || (!k.hash && Date.now() - k.at >= TX_RETRY_MS));
    }).slice(0, CHUNK);
    if (!want.length) return;
    txReading = true;
    try {
      const names = [...new Set(want.map((l) => EVENT_OF[l.state]))];
      const [logs] = await readAll([['eth_getLogs', [{ address: LEND, fromBlock: '0x' + NET.from.toString(16), toBlock: 'latest', topics: [names.map(topicOf), want.map((l) => idTopic(l.id))] }]]], true);
      if (!Array.isArray(logs)) throw new Error('logs');
      for (const l of want) {
        const t0 = topicOf(EVENT_OF[l.state]), t1 = idTopic(l.id);
        const hits = logs.filter((g) => g && !g.removed && lc(g.address) === LEND && Array.isArray(g.topics) && lc(g.topics[0]) === t0 && lc(g.topics[1]) === t1);
        const hash = hits.length === 1 && /^0x[0-9a-fA-F]{64}$/.test(hits[0].transactionHash) ? lc(hits[0].transactionHash) : null;
        txOf.set(String(l.id), { state: l.state, hash, at: Date.now() });
      }
    } catch (e) {
      for (const l of want) txOf.set(String(l.id), { state: l.state, hash: null, at: Date.now() });
    } finally { txReading = false; }
    render();
  }
  const toOwed = (d) => { const o = lend.decodeFunctionResult('owed', d); return { total: o[0], interest: o[1], late: o[2], fee: o[3], repayable: o[4] }; };

  // the contract's figures, computed the way it computes them (the repay step checks them against the node)
  const ceilDiv = (a, b) => (a === 0n ? 0n : (a - 1n) / b + 1n);
  // interest for the whole term: loan x APR x days of the term / 365, rounded up
  const interestOf = (loan, apr, term) => ceilDiv(loan * apr * TERM_DAYS[term], YEAR_DAYS * BPS);
  const feeOf = (loan, feeBps) => (loan * feeBps) / BPS;
  const dueOf = (l) => l.start + TERM_DAYS[l.term] * s.meta.day;
  const graceEnd = (l) => dueOf(l) + GRACE_DAYS * s.meta.day;
  // what repaying costs at time t: loan + interest + late interest (APR / 365 for each day or part of a day past the
  // end of the term) + the service fee locked in the offer
  function totalAt(l, t) {
    const due = dueOf(l);
    const late = t > due ? ceilDiv(l.loanAmount * l.aprBps * ceilDiv(t - due, s.meta.day), YEAR_DAYS * BPS) : 0n;
    return l.loanAmount + interestOf(l.loanAmount, l.aprBps, l.term) + late + feeOf(l.loanAmount, l.feeBps);
  }
  // owed() as last read, only while the clock agrees it still holds. Late interest grows at the due time and at each
  // day boundary after it, and the chain is read every REFRESH_MS: between a boundary and the next read the figure read
  // is no longer what the loan costs, so it renders as a dash and the page reads again.
  function owedNow(l) {
    const o = s.owed[l.id], t = nowEst();
    return o && t !== null && o.total === totalAt(l, t) ? o : null;
  }
  const owedStale = () => !!s.mine && s.mine.some((l) => l.state === ACTIVE && s.owed[l.id] && !owedNow(l));
  // The gas price every transaction names, read from Wanchain itself, never left to the wallet's own estimate: a
  // wallet can price a transaction under the base fee, and then it is never mined. The highest of the public RPC's and
  // the wallet's eth_gasPrice and twice each one's latest base fee, but never above MAX_GAS_PRICE unless the wallet's
  // own figure is higher, so a node that lies cannot set a ruinous fee; Wanchain's own price is far below it.
  async function gasPriceNow() {
    const pair = ([g, b]) => { const gp = BigInt(g), base = b && b.baseFeePerGas ? BigInt(b.baseFeePerGas) : 0n; return gp > 2n * base ? gp : 2n * base; };
    const [pub, own] = await Promise.allSettled([
      readAll([['eth_gasPrice', []], BLOCK], true).then(pair),
      Promise.all([W.eth().request({ method: 'eth_gasPrice', params: [] }), W.eth().request({ method: 'eth_getBlockByNumber', params: ['latest', false] })]).then(pair),
    ]);
    const mine = own.status === 'fulfilled' ? own.value : 0n, theirs = pub.status === 'fulfilled' ? pub.value : 0n;
    const cap = mine > MAX_GAS_PRICE ? mine : MAX_GAS_PRICE;
    const p = mine > theirs ? mine : theirs > cap ? cap : theirs;
    if (p === 0n) throw new Error('no gas price');
    return p;
  }

  // the chain's time now: the latest block's time plus the seconds since it was read
  const nowEst = () => (s.now === null ? null : s.now + BigInt(Math.floor((Date.now() - s.nowAt) / 1000)));

  // the loan token starts as WAN and the collateral as BTC
  for (const [sel, pick] of [[$('ltok'), 0], [$('ctok'), 2]]) {
    sel.replaceChildren(...NET.tokens.map((t) => { const o = document.createElement('option'); o.value = t.addr; o.textContent = t.sym; return o; }));
    sel.value = NET.tokens[pick].addr;
  }
  $('lusd').hidden = $('cusd').hidden = !NET.prices;

  // Loans by id, in batches of CHUNK. A loan that has ended (repaid, claimed or cancelled) never changes again, so it is
  // read once per page visit and kept; open and active loans are read again each time.
  const ended = new Map();
  async function loansById(ids) {
    const out = new Map(), need = ids.filter((id) => !ended.has(String(id)));
    for (let k = 0; k < need.length; k += CHUNK) {
      const part = need.slice(k, k + CHUNK);
      const rr = await readAll(part.map((id) => ec(LEND, lend, 'getLoan', [id])), true);
      rr.forEach((d, j) => { const l = toLoan(part[j], dc(lend, 'getLoan', d)); out.set(String(l.id), l); if (l.state > ACTIVE) ended.set(String(l.id), l); });
    }
    return ids.map((id) => ended.get(String(id)) || out.get(String(id)));
  }
  const newestFirst = (a) => [...a].sort((p, q) => (p.id < q.id ? 1 : -1));

  // Three parts, each standing alone: the core (the block, fees, pause, the contract's tokens and day, and the
  // account's balances, allowances, waiting payments and its loan count); then the account's own loans, through the
  // contract's list for it; then every loan, for the open offers. A failed offers read never takes the account's own
  // loans or its Repay button off the page.
  async function readOnce() {
    const acct = viaWallet() ? s.account : null;
    let count;
    try {
      if (s.account && s.net === 'check') await checkNet(); // a wallet on NET's chain id whose code could not be read: again
      const T = NET.tokens;
      const reqs = [ec(LEND, lend, 'loanCount'), BLOCK, ec(LEND, lend, 'DAY'), ec(LEND, lend, 'tokens'), ec(LEND, lend, 'paused')];
      for (let t = 0; t < 5; t++) reqs.push(ec(LEND, lend, 'feeBps', [t]));
      if (acct) {
        reqs.push(ec(LEND, lend, 'loanCountOf', [acct]));
        for (const t of T) {
          reqs.push(t.addr === WAN ? ['eth_getBalance', [acct, 'latest']] : ec(t.addr, erc20, 'balanceOf', [acct]));
          if (t.addr !== WAN) reqs.push(ec(t.addr, erc20, 'allowance', [acct, LEND]));
          reqs.push(ec(LEND, lend, 'credit', [acct, t.addr]));
        }
      }
      const r = await readAll(reqs, true);
      count = dc(lend, 'loanCount', r[0]);
      const now = blockTime(r[1]);
      const readBlock = BigInt(r[1].number);
      // the contract must list exactly NET's tokens, in NET's order, and keep NET's day
      const listed = [...dc(lend, 'tokens', r[3])].map(lc);
      if (dc(lend, 'DAY', r[2]) !== NET.day || listed.join() !== T.map((t) => t.addr).join()) throw new Error('contract differs from NET');
      const paused = dc(lend, 'paused', r[4]);
      const fees = [0, 1, 2, 3, 4].map((t) => dc(lend, 'feeBps', r[5 + t]));
      const bal = {}, allow = {}, credit = {};
      let i = 10, nMine = 0n;
      if (acct) {
        nMine = dc(lend, 'loanCountOf', r[i++]);
        for (const t of T) {
          bal[t.addr] = t.addr === WAN ? BigInt(r[i++]) : dc(erc20, 'balanceOf', r[i++]);
          if (t.addr !== WAN) allow[t.addr] = dc(erc20, 'allowance', r[i++]);
          credit[t.addr] = dc(lend, 'credit', r[i++]);
        }
      }
      s.fees = fees; s.paused = paused; s.now = now; s.nowAt = Date.now(); s.readBlock = readBlock;
      // another account, or another chain, meanwhile: its figures are dropped
      const still = () => acct && s.account === acct && s.net === 'ok';
      if (still()) { s.bal = bal; s.allow = allow; s.credit = credit; }
      s.readFailed = false;

      // the account's own loans and what each active one costs now
      if (acct) {
        try {
          const ids = [];
          for (let k = 0n; k < nMine; k += 500n) ids.push(...(await readAll([ec(LEND, lend, 'loansOf', [acct, k, 500n])], true).then(([d]) => [...dc(lend, 'loansOf', d)])));
          if (BigInt(ids.length) !== nMine) throw new Error('list');
          const mine = await loansById(ids);
          if (mine.some((l) => l.lender !== lc(acct) && l.borrower !== lc(acct))) throw new Error('list');
          const act = mine.filter((l) => l.state === ACTIVE);
          const ro = await readAll(act.map((l) => ec(LEND, lend, 'owed', [l.id])), true);
          const owed = {};
          ro.forEach((d, j) => { owed[act[j].id] = toOwed(d); });
          if (still()) { s.mine = newestFirst(mine); s.owed = owed; s.mineFailed = false; }
        } catch (e) { s.mineFailed = true; }
      } else { s.mine = null; s.mineFailed = false; }
    } catch (e) {
      s.readFailed = true;
      s.fees = s.paused = s.now = s.readBlock = null;
      s.bal = s.allow = s.credit = null; s.owed = {}; s.mine = null; s.loans = null;
      return;
    }
    // every loan, newest first, for the open offers
    try {
      const ids = [];
      for (let id = count; id > 0n; id--) ids.push(id - 1n);
      s.loans = await loansById(ids);
      s.offersFailed = false;
    } catch (e) { s.loans = null; s.offersFailed = true; }
  }
  // One read at a time; a refresh asked for while one runs runs again right after it.
  let running = null, again = false;
  async function refresh() {
    if (running) { again = true; return running; }
    running = (async () => {
      try { do { again = false; await readOnce(); render(); readTxs(); } while (again); } finally { running = null; }
    })();
    return running;
  }
  // A step ends only once the page has read the chain at or after the block that mined it. A node can answer from an
  // earlier block for a few seconds, and the page would then read the old allowance and offer the same approval again.
  // Reads again every 1.5 s, for up to 30 s.
  async function settle(blockHex) {
    const want = BigInt(blockHex);
    const until = Date.now() + SETTLE_MS;
    for (;;) {
      await refresh();
      if ((s.readBlock !== null && s.readBlock >= want) || Date.now() >= until) return;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  // OrbitWan's price table: read at load, then every PRICE_MS (every PRICE_RETRY_MS while no read has worked). A failed
  // read keeps the table last read, whose prices then age out by their own times (usdPrice).
  let priceAt = 0, pricing = false;
  async function readPrices() {
    if (!NET.prices || pricing) return;
    pricing = true; priceAt = Date.now();
    try {
      const res = await fetch(NET.prices, { cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(RPC_TIMEOUT_MS) });
      const j = res.ok ? await res.json() : null;
      if (!j || !Number.isSafeInteger(j.fresh_secs) || j.fresh_secs <= 0 || !Array.isArray(j.prices)) throw new Error('price table');
      const rows = new Map();
      for (const r of j.prices) if (r && typeof r.token_address === 'string') rows.set(lc(r.token_address), r);
      s.prices = { fresh: BigInt(j.fresh_secs), rows, native: j.native_wan || null };
    } catch (e) { if (!s.prices) s.prices = 'failed'; }
    finally { pricing = false; }
    render();
  }

  // ---- wallet ------------------------------------------------------------------------------------
  // The wallet's chain is proven to be NET's by the contract's code there, read through the wallet.
  async function checkNet() {
    try {
      const code = await W.eth().request({ method: 'eth_getCode', params: [LEND, 'latest'] });
      s.net = typeof code === 'string' && code.length > 2 && keccak256(code) === NET.codehash ? 'ok' : 'bad';
    } catch (e) { s.net = 'check'; }
  }
  async function syncWallet() {
    const before = s.account;
    if (!W.eth()) { s.account = null; s.net = 'none'; }
    else {
      s.account = (await W.accounts())[0] || null;
      if (!s.account) s.net = 'none';
      else if ((await W.chainId()) !== NET.chainId) s.net = 'other';
      else await checkNet();
    }
    // another account, or none: the previous account's figures leave the page at once
    if (!s.account || s.net !== 'ok' || s.account !== before) { s.bal = s.allow = s.credit = null; s.owed = {}; }
  }
  async function connect() { await W.connect(); await syncWallet(); await refresh(); }
  async function switchChain() {
    try {
      await W.eth().request({ method: 'wallet_switchEthereumChain', params: [{ chainId: NET.params.chainId }] });
    } catch (e) {
      const code = e && (e.code ?? (e.data && e.data.originalError && e.data.originalError.code));
      if (code !== 4902) throw e;
      await W.eth().request({ method: 'wallet_addEthereumChain', params: [NET.params] });
    }
    await syncWallet(); await refresh();
  }
  async function disconnect() {
    W.disconnect();
    s.approvedNow = ''; s.notes.post = { text: 'Disconnected.', kind: '' };
    await syncWallet(); await refresh();
  }

  // ---- transactions ------------------------------------------------------------------------------
  const REASONS = {
    'not open': 'This offer is no longer open.',
    'own offer': 'This is your own offer.',
    'not active': 'This loan is no longer active.',
    'too late': 'The grace period is over.',
    'too early': 'The grace period is not over yet.',
    'not lender': 'Only the lender can do this.',
    'not borrower': 'Only the borrower can do this.',
    'nothing': 'Nothing to withdraw.',
    'paused': 'New loans are paused.',
  };
  function reasonText(e) {
    const hex = [e?.data, e?.data?.data, e?.data?.result, e?.data?.originalError?.data, e?.error?.data, e?.info?.error?.data]
      .find((d) => typeof d === 'string' && d.startsWith('0x08c379a0'));
    let r = null;
    try { if (hex) r = AbiCoder.defaultAbiCoder().decode(['string'], '0x' + hex.slice(10))[0]; } catch (err) { /* not a reason */ }
    for (const msg of [e?.message, e?.data?.message, e?.error?.message]) {
      const m = !r && typeof msg === 'string' && msg.match(/(?:execution reverted|revert):? (.+)$/);
      if (m) r = m[1].trim();
    }
    return (REASONS[r] || 'The transaction would fail.') + ' Nothing was sent.';
  }
  // the transaction as an eth_call first: one that would fail never reaches the wallet. Returns why, or null.
  async function dryRun(to, data, value) {
    const tx = { from: s.account, to, data };
    if (value) tx.value = '0x' + value.toString(16);
    try { await rpc('eth_call', [tx, 'latest']); return null; } catch (e) { return reasonText(e); }
  }
  // Sends one transaction through the wallet and waits up to WAIT_MS for its receipt, by the hash the wallet returns
  // (Wanchain's hash differs from one computed locally). Once sent, only a receipt decides the outcome: a failed read is
  // asked again, and no receipt in time returns ok: null, never a failure.
  async function send(to, data, waiting, key, value) {
    if ((await W.chainId()) !== NET.chainId) throw new Error('the wallet is not on ' + NET.params.chainName);
    await checkNet();
    if (s.net !== 'ok') throw new Error('the chain of the wallet is not ' + NET.params.chainName);
    // a step's transactions all come from the account it started with
    if (s.account !== s.busyAccount) throw new Error('the account changed');
    const gasPrice = await gasPriceNow();
    s.busy = 'Confirm in your wallet'; s.busyKey = key; render();
    const tx = { from: s.account, to, data, chainId: NET.params.chainId, gasPrice: '0x' + gasPrice.toString(16) };
    if (value) tx.value = '0x' + value.toString(16);
    const hash = await W.eth().request({ method: 'eth_sendTransaction', params: [tx] });
    s.busy = waiting; setNote(key, { text: 'Waiting for Wanchain.', kind: '', hash }); render();
    const until = Date.now() + WAIT_MS;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const rc = await W.eth().request({ method: 'eth_getTransactionReceipt', params: [hash] });
        if (rc) return { hash, ok: rc.status === '0x1', rc };
      } catch (e) { /* not read this time: ask again */ }
    }
    return { hash, ok: null };
  }
  const unconfirmed = (hash) => ({ text: 'Sent, but Wanchain has not confirmed it yet. Check it before trying again.', kind: 'bad', hash });
  function events(rc, name) {
    const out = [];
    for (const log of rc.logs || []) {
      if (lc(log.address) !== LEND) continue;
      try { const p = lend.parseLog(log); if (p && p.name === name) out.push(p.args); } catch (e) { /* not ours */ }
    }
    return out;
  }
  // a payment the account's address refused waits in the contract for it alone (withdraw)
  const credited = (rc) => events(rc, 'Credited').some((a) => same(a.owner, s.account));

  // Runs one write: dry run, send, then the outcome in the step's note. good(rc) words a success.
  async function write(key, to, data, value, waiting, good) {
    const why = await dryRun(to, data, value);
    if (why) { setNote(key, { text: why, kind: 'bad' }); return refresh(); }
    const r = await send(to, data, waiting, key, value);
    if (r.ok === null) setNote(key, unconfirmed(r.hash));
    else if (!r.ok) setNote(key, { text: 'The transaction failed. Nothing changed.', kind: 'bad', hash: r.hash });
    else { setNote(key, { text: good(r.rc), kind: 'good', hash: r.hash }); s.approvedNow = ''; }
    if (r.rc) await settle(r.rc.blockNumber); else await refresh();
    s.busy = '';
    return r.ok;
  }

  async function approve(token, amount, key) {
    const r = await send(token, erc20.encodeFunctionData('approve', [LEND, amount]), 'Approving', key);
    if (r.ok === null) { s.busy = ''; setNote(key, unconfirmed(r.hash)); return refresh(); }
    if (!r.ok) { s.busy = ''; setNote(key, { text: 'The approval failed.', kind: 'bad', hash: r.hash }); return refresh(); }
    s.approvedNow = key;
    setNote(key, null);
    await settle(r.rc.blockNumber);
    s.busy = '';
  }

  async function post() {
    const f = form();
    const data = lend.encodeFunctionData('post', [f.ltok, f.lamt, f.ctok, f.camt, f.apr, s.term]);
    const ok = await write('post', LEND, data, f.ltok === WAN ? f.lamt : 0n, 'Posting', (rc) => {
      const p = events(rc, 'Posted')[0];
      return p ? `Offer #${p.id} posted.` : 'Offer posted.';
    });
    if (ok) { $('lamt').value = ''; $('camt').value = ''; render(); }
  }

  async function accept(l) {
    const key = 'o' + l.id;
    const fresh = toLoan(l.id, dc(lend, 'getLoan', await rpc(...ec(LEND, lend, 'getLoan', [l.id]))));
    if (fresh.state !== OPEN) { setNote(key, { text: 'This offer is no longer open.', kind: 'bad' }); return refresh(); }
    // the offer read now must be the one shown, term for term, or nothing is sent
    const shown = ['lender', 'aprBps', 'term', 'feeBps', 'loanToken', 'collToken', 'loanAmount', 'collAmount'];
    if (shown.some((k) => String(fresh[k]) !== String(l[k]))) { setNote(key, { text: 'This offer changed. Nothing was sent.', kind: 'bad' }); return refresh(); }
    const lt = tok(fresh.loanToken);
    await write(key, LEND, lend.encodeFunctionData('accept', [fresh.id]), fresh.collToken === WAN ? fresh.collAmount : 0n, 'Accepting', (rc) => {
      const a = events(rc, 'Accepted')[0];
      if (credited(rc)) return `Loan #${fresh.id} accepted. The loan waits for you under Your loans.`;
      return a ? `Loan #${fresh.id} received: ${amt(fresh.loanAmount, lt)} ${lt.sym}.` : `Loan #${fresh.id} received.`;
    });
  }

  async function repay(l) {
    const key = 'l' + l.id;
    // the latest block's time and owed() now: the page's own figure must agree with the node's before anything is sent
    const [b, od] = await readAll([BLOCK, ec(LEND, lend, 'owed', [l.id])]);
    const t = blockTime(b), o = toOwed(od);
    if (!o.repayable) { setNote(key, { text: 'The grace period is over. Nothing was sent.', kind: 'bad' }); return refresh(); }
    if (o.total < totalAt(l, t) || o.total > totalAt(l, t + REPAY_MARGIN)) {
      setNote(key, { text: 'The amount owed could not be confirmed. Nothing was sent.', kind: 'bad' });
      return refresh();
    }
    const value = l.loanToken === WAN ? totalAt(l, t + REPAY_MARGIN) : 0n;
    await write(key, LEND, lend.encodeFunctionData('repay', [l.id]), value, 'Repaying', (rc) => {
      const p = events(rc, 'Repaid')[0];
      const late = p && p.late > 0n ? ` with ${amt(p.late, tok(l.loanToken))} ${tok(l.loanToken).sym} late interest` : '';
      return `Loan #${l.id} repaid${late}.` + (credited(rc) ? ' What you are owed waits for you under Your loans.' : ' The collateral is back in your wallet.');
    });
  }

  const claim = (l) => write('l' + l.id, LEND, lend.encodeFunctionData('claim', [l.id]), 0n, 'Claiming',
    (rc) => (credited(rc) ? `The collateral of loan #${l.id} waits for you under Your loans.` : `Collateral of loan #${l.id} claimed.`));
  const cancel = (l) => write('l' + l.id, LEND, lend.encodeFunctionData('cancel', [l.id]), 0n, 'Cancelling',
    (rc) => `Offer #${l.id} cancelled.` + (credited(rc) ? ' The loan waits for you under Your loans.' : ' The loan is back in your wallet.'));
  const withdraw = (addr) => write('w' + addr, LEND, lend.encodeFunctionData('withdraw', [addr]), 0n, 'Withdrawing',
    () => 'Withdrawn.');
  function mint(addr) {
    const t = tok(addr), a = parseUnits(NET.mint[addr], t.dec);
    return write('m' + addr, addr, erc20.encodeFunctionData('mint', [s.account, a]), 0n, 'Getting',
      () => `Received ${amt(a, t)} ${t.sym}.`);
  }

  // ---- what each button does -----------------------------------------------------------------------
  function walletStep() {
    if (!W.eth()) return { text: 'Open in MetaMask', run: () => { location.href = W.metamaskLink(); } };
    if (!s.account) return { text: 'Connect wallet', run: connect };
    if (s.net === 'other') return { text: `Switch to ${NET.params.chainName}`, run: switchChain };
    if (s.net === 'check') return { text: 'Reading Wanchain' };
    if (s.net === 'bad') return { text: 'Wrong network' };
    return null;
  }
  // enough of `token` for `amount`, and WAN for gas: null, or the step that says what is short
  function lacks(token, amount) {
    const t = tok(token), wan = s.bal[WAN];
    if (token === WAN ? amount + GAS_RESERVE > wan : amount > s.bal[token]) return { text: `Not enough ${t.sym}` };
    if (wan === 0n) return { text: 'No WAN for gas' };
    return null;
  }

  // A comma counts only as a decimal point, and only with no dot and not before exactly three digits: "10,5" is 10.5,
  // while "10,000" or "1,500" is refused, never read as 10 or 1.5.
  function cleanNum(raw) {
    const v = raw.trim();
    if (!v.includes(',')) return v;
    return /^[0-9]*,[0-9]*$/.test(v) && !/,[0-9]{3}$/.test(v) ? v.replace(',', '.') : 'bad';
  }
  function parseAmt(id, t) {
    const v = cleanNum($(id).value);
    if (!v) return null;
    if (!t || !/^[0-9]*[.]?[0-9]*$/.test(v) || v === '.') return 'bad';
    try { const a = parseUnits(v, t.dec); return a > U128 ? 'bad' : a; } catch (e) { return 'bad'; }
  }
  // the offer form as typed: amounts in the token's units (bigint, 'bad' or null), the APR in basis points a year (a
  // percent with up to two decimals, at most 1200%: exactly what the contract keeps)
  function form() {
    const ltok = $('ltok').value || null, ctok = $('ctok').value || null;
    const lt = ltok && tok(ltok), ct = ctok && tok(ctok);
    const v = cleanNum($('rate').value);
    let apr = null;
    if (v) {
      apr = /^[0-9]{1,4}([.][0-9]{0,2})?$/.test(v) ? parseUnits(v.endsWith('.') ? v + '0' : v, 2) : 'bad';
      if (typeof apr === 'bigint' && apr > MAX_APR_BPS) apr = 'bad';
    }
    return { ltok, ctok, lt, ct, lamt: parseAmt('lamt', lt), camt: parseAmt('camt', ct), apr };
  }

  function postStep() {
    const w = walletStep();
    if (w) return w;
    if (!s.meta || !s.fees || !s.bal) return { text: 'Reading Wanchain' };
    if (s.paused) return { text: 'New loans paused' };
    const f = form();
    if (f.lamt === 'bad') return { text: 'Enter a valid amount' };
    if (!f.lamt) return { text: 'Enter an amount' };
    if (f.camt === 'bad') return { text: 'Enter a valid collateral' };
    if (!f.camt) return { text: 'Enter the collateral' };
    if (f.ltok === f.ctok) return { text: 'Pick two different tokens' };
    if (f.apr === 'bad') return { text: 'Enter a valid APR' };
    if (f.apr === null) return { text: 'Enter an APR' };
    const sh = lacks(f.ltok, f.lamt);
    if (sh) return sh;
    if (f.ltok !== WAN && s.allow[f.ltok] < f.lamt) return { text: `Approve ${f.lt.sym} (1 of 2)`, run: () => approve(f.ltok, f.lamt, 'post') };
    return { text: s.approvedNow === 'post' ? 'Post offer (2 of 2)' : 'Post offer', run: post };
  }
  function acceptStep(l) {
    const w = walletStep();
    if (w) return w;
    if (l.lender === lc(s.account)) return { text: 'Your offer' };
    if (!s.bal) return { text: 'Reading Wanchain' };
    if (s.paused) return { text: 'New loans paused' };
    const key = 'o' + l.id;
    const sh = lacks(l.collToken, l.collAmount);
    if (sh) return sh;
    if (l.collToken !== WAN && s.allow[l.collToken] < l.collAmount) {
      return { text: `Approve ${tok(l.collToken).sym} (1 of 2)`, run: () => approve(l.collToken, l.collAmount, key) };
    }
    return { text: s.approvedNow === key ? 'Accept (2 of 2)' : 'Accept', run: () => accept(l) };
  }
  // the button under one of the account's loans, or null for none
  function loanStep(l) {
    if (walletStep() || !s.bal) return null;
    const me = lc(s.account), key = 'l' + l.id, t = nowEst();
    if (l.state === OPEN && l.lender === me) return { text: 'Cancel offer', run: () => cancel(l) };
    if (l.state !== ACTIVE || t === null) return null;
    if (l.lender === me && t > graceEnd(l)) return s.bal[WAN] === 0n ? { text: 'No WAN for gas' } : { text: 'Claim collateral', run: () => claim(l) };
    if (l.borrower !== me) return null;
    const o = s.owed[l.id];
    if (!o) return { text: 'Reading Wanchain' };
    if (!o.repayable || t > graceEnd(l)) return null;
    const need = totalAt(l, t + REPAY_MARGIN);
    const sh = lacks(l.loanToken, need);
    if (sh) return sh;
    if (l.loanToken !== WAN && s.allow[l.loanToken] < need) {
      return { text: `Approve ${tok(l.loanToken).sym} (1 of 2)`, run: () => approve(l.loanToken, totalAt(l, nowEst() + APPROVE_MARGIN), key) };
    }
    return { text: s.approvedNow === key ? 'Repay (2 of 2)' : 'Repay', run: () => repay(l) };
  }
  function withdrawStep(addr) {
    if (walletStep() || !s.credit || !s.credit[addr]) return null;
    if (s.bal[WAN] === 0n) return { text: 'No WAN for gas' };
    return { text: 'Withdraw', run: () => withdraw(addr) };
  }
  function mintStep(addr) {
    if (!NET.mint[addr]) return null;
    const w = walletStep();
    if (w) return w;
    if (!s.bal) return { text: 'Reading Wanchain' };
    if (s.bal[WAN] === 0n) return { text: 'No WAN for gas' };
    const t = tok(addr);
    return { text: `Get ${amt(parseUnits(NET.mint[addr], t.dec), t)} ${t.sym}`, run: () => mint(addr) };
  }
  function stepFor(key) {
    if (key === 'post') return postStep();
    const k = key[0], v = key.slice(1);
    if (k === 'o') { const l = loanById(v); return l && l.state === OPEN ? acceptStep(l) : null; }
    if (k === 'l') { const l = loanById(v); return l ? loanStep(l) : null; }
    if (k === 'w') return withdrawStep(v);
    if (k === 'm') return mintStep(v);
    return null;
  }
  // While a transaction waits, its button shows the progress and no button does anything.
  function action(key) {
    const a = stepFor(key);
    if (!s.busy) return a;
    if (key === s.busyKey) return { text: s.busy };
    return a ? { text: a.text } : null;
  }
  // the list a button's key belongs to; a tap there is ignored for MOVE_GUARD_MS after its rows moved
  const listOf = (key) => ({ o: 'offers', l: 'mine', w: 'mine', m: 'tokens' })[key[0]] || null;
  async function onClick(key) {
    const a = stepFor(key);
    if (!a || !a.run || s.busy) return;
    const list = listOf(key);
    if (list && Date.now() - Number($(list).dataset.moved || 0) < MOVE_GUARD_MS) return; // the row under the finger may have just changed
    setNote(key, null);
    s.busy = a.text; s.busyKey = key; s.busyAccount = s.account; render();
    try { await a.run(); }
    catch (e) {
      s.busy = '';
      setNote(key, W.rejected(e) ? { text: 'Cancelled in your wallet.', kind: 'bad' } : { text: 'Something went wrong. Nothing was sent.', kind: 'bad' });
      await syncWallet().catch(() => {});
      await refresh();
    }
    finally { s.busy = ''; render(); }
  }

  // ---- display -----------------------------------------------------------------------------------
  // thousands, on a string of digits: a comma after each digit followed by a whole number of three-digit groups
  const group = (d) => d.replace(/[0-9](?=(?:[0-9]{3})+$)/g, (m) => m + ',');
  // an amount in a token's units: grouped, at most 6 decimals, and never a real amount shown as 0
  function amt(v, t) {
    if (v === null || v === undefined || !t) return '-';
    let [i, f = ''] = formatUnits(v, t.dec).split('.');
    f = f.slice(0, 6).replace(/0+$/, '');
    i = group(i);
    if (v > 0n && i === '0' && !f) return `< 0.${'0'.repeat(Math.min(6, t.dec) - 1)}1`;
    return f ? `${i}.${f}` : i;
  }
  // an amount someone pays, rounded up at the 6th decimal, so the figure shown is never below what is charged
  const amtUp = (v, t) => { if (v === null || v === undefined || !t || t.dec <= 6) return amt(v, t); const q = 10n ** BigInt(t.dec - 6); return amt(ceilDiv(v, q) * q, t); };
  const exact = (v, t) => formatUnits(v, t.dec).replace(/[.]0$/, '');
  const pct = (bps) => formatUnits(BigInt(bps), 2).replace(/[.]0$/, '') + '%';
  // four characters written by code point, so the file holds only ASCII and no backslash
  const ELL = String.fromCharCode(0x2026), DOT = String.fromCharCode(0xb7), RSQ = String.fromCharCode(0x2019), APX = String.fromCharCode(0x2248);
  const short = (a) => `${a.slice(0, 6)}${ELL}${a.slice(-4)}`;
  // A token's USD price from the table, times 1e18: null while the table, or the chain's time, is still being read;
  // 'none' when the table has no price for it, or its price is older than the table's own limit (fresh_secs) by the
  // chain's time. A price's time is its oracle update, or for a price with none (CoinGecko) when the table's writer read it.
  function usdPrice(addr) {
    const P = s.prices;
    if (P === null) return null;
    if (P === 'failed') return 'none';
    const r = addr === WAN ? P.native : P.rows.get(addr);
    const m = r && typeof r.price_usd === 'string' ? /^([0-9]+)(?:[.]([0-9]+))?$/.exec(r.price_usd) : null;
    const p = m ? BigInt(m[1]) * 10n ** 18n + BigInt((m[2] || '').slice(0, 18).padEnd(18, '0')) : 0n;
    const at = r ? Date.parse(r.oracle_updated_at || r.observed_at) : NaN;
    if (p === 0n || !Number.isFinite(at)) return 'none';
    const t = nowEst();
    if (t === null) return s.readFailed ? 'none' : null;
    return t - BigInt(Math.floor(at / 1000)) <= P.fresh ? p : 'none';
  }
  // the dollar value under an amount the form holds, to the nearest cent; blank with no amount or while reading, a dash
  // when the token has no current price
  function usdOf(v, t) {
    if (typeof v !== 'bigint' || v === 0n || !t) return '';
    const p = usdPrice(t.addr);
    if (p === null) return '';
    if (p === 'none') return `(${APX} $-)`;
    const cents = (v * p * 100n / 10n ** BigInt(t.dec) + 5n * 10n ** 17n) / 10n ** 18n;
    if (cents === 0n) return '(< $0.01)';
    const dollars = group(String(cents / 100n));
    return `(${APX} $${dollars}.${String(cents % 100n).padStart(2, '0')})`;
  }
  // a term in the contract's days (on testnet a day lasts 20 seconds; the countdowns show the real time left)
  const days = (term) => `${TERM_DAYS[term]} days`;
  // time left, to the nearest second under an hour
  function left(sec) {
    const x = Number(sec < 0n ? 0n : sec);
    if (x >= 86400) return `${Math.floor(x / 86400)} d ${Math.floor((x % 86400) / 3600)} h`;
    if (x >= 3600) return `${Math.floor(x / 3600)} h ${Math.floor((x % 3600) / 60)} min`;
    if (x >= 60) return `${Math.floor(x / 60)} min ${x % 60} s`;
    return `${x} s`;
  }
  const menu = (open) => { $('menu').hidden = !open; $('acct').setAttribute('aria-expanded', open ? 'true' : 'false'); };
  const set = (n, text) => { if (n.textContent !== text) n.textContent = text; };
  const setCls = (n, c) => { if (n.className !== c) n.className = c; };

  function showNote(el, n) {
    const kind = n ? n.kind : '';
    const key = n ? `${kind}|${n.text}|${n.hash || ''}` : '';
    if (el.dataset.v === key) return;
    el.dataset.v = key;
    el.className = kind ? `note ${kind}` : 'note';
    el.textContent = n ? n.text : '';
    if (n && n.hash) {
      const link = document.createElement('a');
      link.href = `${NET.explorer}/tx/${n.hash}`; link.target = '_blank'; link.rel = 'noopener';
      link.textContent = 'View transaction';
      el.append(' ', link);
    }
  }
  function showButton(b, key) {
    const a = action(key);
    b.hidden = !a;
    if (a) { set(b, a.text); b.disabled = !a.run || !!s.busy; }
  }

  // Lists keep one element per item, keyed, so a refresh changes text in place and never replaces a button mid-tap.
  function row(key) {
    const el = document.createElement('div');
    el.className = key[0] === 'o' ? 'row offer' : 'row'; el.dataset.key = key;
    // a loan's number (.n, in .a for an offer, in .c for the account's loans) links to its latest transaction
    el.innerHTML = '<div class="r1"><span class="a"><span class="at"></span><a class="n" target="_blank" rel="noopener" hidden></a></span><span class="b"></span></div><div class="r2"><span class="c"><a class="n" target="_blank" rel="noopener" hidden></a><span class="ct"></span></span><span class="d"></span></div><div class="r3"></div><button class="btn sm" type="button"></button>';
    el.querySelector('button').addEventListener('click', () => onClick(key));
    return el;
  }
  function fillNum(n, num, href) {
    set(n, num || '');
    n.hidden = !num;
    if (href) { if (n.getAttribute('href') !== href) n.setAttribute('href', href); } else if (n.hasAttribute('href')) n.removeAttribute('href');
  }
  function fillRow(el, key, x) {
    set(el.querySelector('.at'), x.a || '');
    fillNum(el.querySelector('.a .n'), x.an, x.anHref);
    const b = el.querySelector('.b');
    set(b, x.b || ''); setCls(b, x.bc ? `b st ${x.bc}` : 'b');
    set(el.querySelector('.ct'), x.c || '');
    fillNum(el.querySelector('.c .n'), x.cn, x.cnHref);
    set(el.querySelector('.d'), x.d || '');
    el.querySelector('.r2').hidden = !x.c && !x.cn && !x.d;
    const box = el.querySelector('.r3'), rows = x.facts || [];
    const v = JSON.stringify(rows);
    if (box.dataset.v !== v) {
      box.dataset.v = v;
      box.replaceChildren(...rows.map(([k, val, cls]) => {
        const d = document.createElement('div'), p = document.createElement('span'), q = document.createElement('span');
        if (cls) d.className = cls;
        p.textContent = k; q.textContent = val; d.append(p, q); return d;
      }));
    }
    box.hidden = !rows.length;
    showButton(el.querySelector('button'), key);
  }
  // A row that appears above others, leaves from above others or changes place moves the rows under the finger: the
  // list then records when (data-moved), and a tap in it is ignored for MOVE_GUARD_MS.
  function syncList(list, items) {
    const keep = new Set(items.map((x) => x.key));
    const moved = () => { list.dataset.moved = String(Date.now()); };
    for (const el of [...list.children]) if (!keep.has(el.dataset.key)) { if (el !== list.lastElementChild) moved(); el.remove(); }
    items.forEach((x, i) => {
      let el = [...list.children].find((c) => c.dataset.key === x.key);
      if (!el) el = row(x.key);
      if (list.children[i] !== el) { if (i < list.children.length) moved(); list.insertBefore(el, list.children[i] || null); }
      fillRow(el, x.key, x);
    });
  }

  function offerItem(l) {
    const lt = tok(l.loanToken), ct = tok(l.collToken);
    const interest = interestOf(l.loanAmount, l.aprBps, l.term);
    const sym = lt ? lt.sym : '';
    // The borrower receives the whole loan and repays loan, interest and the service fee; the fee shows above You repay,
    // which includes it.
    return {
      key: 'o' + l.id,
      a: 'Borrow',
      an: `#${l.id}`,
      anHref: txLink(l),
      b: `${amt(l.loanAmount, lt)} ${sym}`,
      facts: [
        ['Collateral', `${amtUp(l.collAmount, ct)} ${ct ? ct.sym : ''}`],
        ['APR', pct(l.aprBps)],
        ['Service fee', `${amtUp(feeOf(l.loanAmount, l.feeBps), lt)} ${sym}`],
        ['You repay', `${amtUp(l.loanAmount + interest + feeOf(l.loanAmount, l.feeBps), lt)} ${sym}`, 'em'],
        ['Term', days(l.term)],
      ],
    };
  }
  function loanItem(l) {
    const me = lc(s.account), lender = l.lender === me;
    const lt = tok(l.loanToken), ct = tok(l.collToken), t = nowEst();
    const x = {
      key: 'l' + l.id,
      a: `${lender ? 'Lent' : 'Borrowed'} ${amt(l.loanAmount, lt)} ${lt ? lt.sym : ''}`,
      cn: `#${l.id}`,
      cnHref: txLink(l),
      c: ` ${DOT} Collateral ${lender ? amt(l.collAmount, ct) : amtUp(l.collAmount, ct)} ${ct ? ct.sym : ''}`,
      d: `${pct(l.aprBps)} APR ${DOT} ${days(l.term)}`,
      facts: [],
    };
    if (l.state === OPEN) { x.b = 'Open'; x.bc = 'live'; x.facts.push(['Term', days(l.term)]); }
    else if (l.state === REPAID) { x.b = 'Repaid'; x.bc = 'good'; }
    else if (l.state === CLAIMED) { x.b = 'Claimed'; x.bc = ''; }
    else if (l.state === CANCELLED) { x.b = 'Cancelled'; x.bc = ''; }
    else if (l.state === ACTIVE) {
      if (t === null) { x.b = s.readFailed ? '-' : ''; }
      else if (t <= dueOf(l)) { x.b = `Due in ${left(dueOf(l) - t)}`; x.bc = 'live'; }
      else if (t <= graceEnd(l)) { x.b = `Late ${DOT} ${left(graceEnd(l) - t)} left`; x.bc = 'warn'; }
      else { x.b = lender ? 'Claimable' : 'Grace over'; x.bc = 'bad'; }
      // the borrower owes loan, interest, late interest and the fee; the lender gets all of it but the fee. After the
      // grace period the loan can no longer be repaid, so no amount is shown: the lender can take the collateral.
      if (t !== null && t > graceEnd(l)) return x;
      const o = owedNow(l), stale = !o && !!s.owed[l.id];
      const total = o ? `${lender ? amt(o.total - o.fee, lt) : amtUp(o.total, lt)} ${lt ? lt.sym : ''}` : (s.readFailed || stale ? '-' : '');
      x.facts.push([lender ? 'You get back' : 'You owe', total]);
      if (o && o.late > 0n) x.facts.push(['Late interest', `${amtUp(o.late, lt)} ${lt.sym}`]);
      else if (stale && t !== null && t > dueOf(l)) x.facts.push(['Late interest', '-']);
    }
    return x;
  }

  function render() {
    $('acct').textContent = s.account ? short(s.account) : '';
    $('acct').hidden = !s.account;
    $('acct').disabled = !!s.busy;
    if (!s.account || s.busy) menu(false);
    $('netnote').hidden = s.net !== 'bad';
    $('netnote').textContent = s.net === 'bad' ? `This wallet${RSQ}s network ${NET.chainId} is not ${NET.params.chainName}.` : '';
    const none = s.readFailed ? '-' : '';
    const mine = viaWallet() && s.bal;

    // the offer form
    const f = form();
    for (const b of $('term').children) { b.setAttribute('aria-pressed', String(Number(b.dataset.term) === s.term)); b.disabled = !!s.busy; }
    // while a step runs the form is locked, so what it shows is what is being signed
    for (const id of ['lamt', 'ltok', 'camt', 'ctok', 'rate', 'lmax']) $(id).disabled = !!s.busy;
    $('lbalrow').hidden = $('lmax').hidden = !(mine && f.lt);
    if (mine && f.lt) set($('lbal'), `${amt(s.bal[f.ltok], f.lt)} ${f.lt.sym}`);
    const aprOk = typeof f.apr === 'bigint', lamtOk = typeof f.lamt === 'bigint';
    set($('lusd'), usdOf(f.lamt, f.lt));
    set($('cusd'), usdOf(f.camt, f.ct));
    set($('coll'), typeof f.camt === 'bigint' && f.ct ? `${amt(f.camt, f.ct)} ${f.ct.sym}` : '');
    set($('apr'), aprOk ? pct(f.apr) : '');
    set($('int'), aprOk && lamtOk && f.lt ? `${amt(interestOf(f.lamt, f.apr, s.term), f.lt)} ${f.lt.sym}` : '');
    // the fee of the term, then its amount in brackets: 0.12% (1.2 USDT)
    set($('fee'), !s.fees ? none : pct(s.fees[s.term]) + (lamtOk && f.lt ? ` (${amt(feeOf(f.lamt, s.fees[s.term]), f.lt)} ${f.lt.sym})` : ''));
    set($('grace'), s.meta ? `${GRACE_DAYS} days` : none);
    showButton($('post'), 'post');
    showNote($('pnote'), s.notes.post);

    // open offers, the lowest APR first and the newest first among equal APRs; a token's tab shows only the offers
    // that lend that token; the account's own offers show only under Your loans, once read there
    for (const b of $('otabs').children) b.setAttribute('aria-pressed', String(b.dataset.tok === s.otab));
    const me = mine && s.mine ? lc(s.account) : '';
    const open = s.loans && s.meta ? s.loans.filter((l) => l.state === OPEN && l.lender !== me) : [];
    const byApr = (p, q) => (p.aprBps < q.aprBps ? -1 : p.aprBps > q.aprBps ? 1 : p.id < q.id ? 1 : -1);
    const offers = (s.otab ? open.filter((l) => l.loanToken === s.otab) : open).sort(byApr);
    syncList($('offers'), offers.map(offerItem));
    // offers that could not be read show a dash; the page shows no message for a failed read
    const oUnread = !s.loans && (s.readFailed || s.offersFailed);
    $('noffers').hidden = !(s.loans && !offers.length) && !oUnread;
    set($('noffers'), oUnread ? '-' : 'No open offers');
    showNote($('onote'), s.notes.offers);

    // the account's loans: active first, the soonest due on top, then open offers, then the rest,
    // newest first; and anything to withdraw
    const items = [];
    if (mine) {
      for (const t of s.meta.tokens) {
        if (s.credit[t.addr] > 0n) items.push({ key: 'w' + t.addr, a: `${amt(s.credit[t.addr], t)} ${t.sym}`, b: 'To withdraw', bc: 'warn' });
      }
      if (s.mine) {
        const rank = (l) => (l.state === ACTIVE ? 0 : l.state === OPEN ? 1 : 2);
        const own = [...s.mine];
        const dueFirst = (p, q) => (p.state === ACTIVE ? Number(dueOf(p) - dueOf(q)) : 0);
        own.sort((p, q) => rank(p) - rank(q) || dueFirst(p, q) || (p.id < q.id ? 1 : -1));
        items.push(...own.map(loanItem));
      }
    }
    syncList($('mine'), items);
    $('nmine').hidden = !!items.length;
    set($('nmine'), !s.account ? 'Connect a wallet to see your loans' : s.net !== 'ok' ? '' : s.mine && s.bal ? 'No loans yet' : (s.readFailed || s.mineFailed ? '-' : ''));
    showNote($('mnote'), s.notes.mine);

    // test tokens: each listed token, the account's balance, and a button for the ones anyone can mint
    $('testcard').hidden = !Object.keys(NET.mint).length;
    const toks = s.meta.tokens.map((t) => ({
      key: 'm' + t.addr, a: t.sym, b: mine ? amt(s.bal[t.addr], t) : (viaWallet() ? none : ''),
    }));
    syncList($('tokens'), toks);
    showNote($('tnote'), s.notes.test);
  }

  // ---- input -------------------------------------------------------------------------------------
  const typed = () => { s.notes.post = null; render(); };
  for (const id of ['lamt', 'camt', 'rate']) $(id).addEventListener('input', typed);
  for (const id of ['ltok', 'ctok']) $(id).addEventListener('change', typed);
  for (const b of $('term').children) b.addEventListener('click', () => { s.term = Number(b.dataset.term); typed(); });
  // the Borrow card's tabs, built from NET's tokens: All, then each token in NET's order
  for (const [addr, label] of [['', 'All'], ...NET.tokens.map((t) => [t.addr, t.sym])]) {
    const b = document.createElement('button');
    b.type = 'button'; b.dataset.tok = addr; b.textContent = label;
    b.addEventListener('click', () => { s.otab = addr; render(); });
    $('otabs').appendChild(b);
  }
  $('lmax').addEventListener('click', () => {
    const f = form();
    if (!s.bal || !f.lt) return;
    const b = s.bal[f.ltok];
    $('lamt').value = exact(f.ltok === WAN ? (b > GAS_RESERVE ? b - GAS_RESERVE : 0n) : b, f.lt);
    typed();
  });
  $('post').addEventListener('click', () => onClick('post'));
  $('acct').addEventListener('click', (e) => { e.stopPropagation(); menu($('menu').hidden); });
  $('disc').addEventListener('click', () => { menu(false); disconnect().catch(() => {}); });
  document.addEventListener('click', (e) => { if (!$('menu').hidden && !$('menu').contains(e.target)) menu(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') menu(false); });
  W.on('accountsChanged', async () => { s.approvedNow = ''; await syncWallet().catch(() => {}); await refresh(); });
  W.on('chainChanged', async () => { await syncWallet().catch(() => {}); await refresh(); });
  setInterval(() => { if (!document.hidden && !s.busy) refresh(); }, REFRESH_MS);
  let staleReadAt = 0;
  setInterval(() => {
    if (document.hidden) return;
    if (NET.prices && Date.now() - priceAt >= (s.prices && s.prices !== 'failed' ? PRICE_MS : PRICE_RETRY_MS)) readPrices();
    render(); // the countdowns
    if (!s.busy && owedStale() && Date.now() - staleReadAt >= STALE_READ_MS) { staleReadAt = Date.now(); refresh(); }
  }, 1000);

  render();
  readPrices();
  syncWallet().catch(() => {}).then(refresh);
})();
