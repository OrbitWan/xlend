'use strict';
// Wallet helpers shared by OrbitWan's dapps. They speak EIP-1193 to the wallet the browser provides
// (MetaMask or any compatible wallet) and never see a key: the wallet signs, the page only asks.
window.Wallet = (() => {
  const BUILD = 'bc31ad92f'; // release id: the page, shared/style.css and the page's app.js carry the same one
  const WANCHAIN = {
    chainId: '0x378', // 888
    chainName: 'Wanchain',
    nativeCurrency: { name: 'WAN', symbol: 'WAN', decimals: 18 },
    rpcUrls: ['https://gwan-ssl.wandevs.org:56891'],
    blockExplorerUrls: ['https://orbitwan.io'],
  };
  const eth = () => window.ethereum || null;

  // Disconnect is the page's own choice, kept in this browser under 'orbit-wallet-off' (and in memory when storage is
  // blocked): many wallets keep a site connected until the user removes it in the wallet, so while it is set the page
  // asks the wallet for no account. Only Connect clears it.
  const OFF = 'orbit-wallet-off';
  let offNow = false;
  const isOff = () => { if (offNow) return true; try { return localStorage.getItem(OFF) === '1'; } catch (e) { return false; } };

  async function accounts() { return eth() && !isOff() ? eth().request({ method: 'eth_accounts' }) : []; }
  async function connect() {
    const a = await eth().request({ method: 'eth_requestAccounts' });
    offNow = false;
    try { localStorage.removeItem(OFF); } catch (e) { /* storage blocked: memory only */ }
    return a;
  }
  // Forgets the account in this page at once, then asks the wallet to end the site's access too
  // (wallet_revokePermissions; MetaMask's browser extension has it, other wallets may not). True only when the wallet
  // confirms within 10 s; false means the wallet may still list the site as connected.
  async function disconnect() {
    offNow = true;
    try { localStorage.setItem(OFF, '1'); } catch (e) { /* storage blocked: memory only */ }
    if (!eth()) return false;
    try {
      const ask = eth().request({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] });
      await Promise.race([ask, new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 10000))]);
      return true;
    } catch (e) { return false; }
  }
  async function chainId() { return parseInt(await eth().request({ method: 'eth_chainId' }), 16); }

  // Switch to Wanchain, adding it to the wallet first if the wallet does not know it (error 4902).
  async function switchToWanchain() {
    try {
      await eth().request({ method: 'wallet_switchEthereumChain', params: [{ chainId: WANCHAIN.chainId }] });
    } catch (e) {
      const code = e && (e.code ?? (e.data && e.data.originalError && e.data.originalError.code));
      if (code !== 4902) throw e;
      await eth().request({ method: 'wallet_addEthereumChain', params: [WANCHAIN] });
    }
  }

  function on(event, fn) { if (eth() && eth().on) eth().on(event, fn); }

  // On a phone without a wallet in the browser, this link opens the same page inside MetaMask's own browser.
  const metamaskLink = () => 'https://metamask.app.link/dapp/' + location.host + location.pathname;

  // True when the user declined in the wallet, as opposed to a failure.
  const rejected = (e) => !!e && (e.code === 4001 || e.code === 'ACTION_REJECTED' ||
    (e.info && e.info.error && e.info.error.code === 4001));

  return { BUILD, WANCHAIN, eth, accounts, connect, disconnect, chainId, switchToWanchain, on, metamaskLink, rejected };
})();
