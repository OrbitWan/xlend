# xLend

Fixed-term, fixed-rate loans between two people on Wanchain. One lender, one borrower, terms set up front. No pool,
no price oracle, and no one, the admin included, can move the funds held for a loan.

**App:** https://xlend.orbitwan.io

## How a loan works

1. **Offer.** A lender posts an offer: the token and amount to lend, the collateral token and amount, the APR and the
   term (30, 60, 90, 180 or 365 days). The loan is deposited into the contract with the offer. An offer never changes;
   the lender can cancel it until someone accepts it.
2. **Accept.** A borrower accepts the offer, deposits the collateral and receives the whole loan at once.
3. **Repay.** By the end of the term the borrower repays the loan, the interest for the whole term and the service fee,
   and gets the collateral back. Interest = loan x APR x term days / 365. Repaying early costs the same: the interest
   is always for the whole term.
4. **Grace.** Three days of grace follow the term. Repaying then adds one day of interest (APR / 365) for each day, or
   part of a day, late.
5. **Claim.** After the grace period the lender can take the collateral. No service fee is charged then.

## What the contract guarantees

- Funds go only to that loan's lender, its borrower, or the treasury (the service fee). No function takes a destination
  address.
- It cannot be upgraded. The admin can only set the service fee of each term (at most 5% of the loan; a change applies
  only to offers posted after it) and pause or resume new offers and new loans. Cancel, repay, claim and withdraw are
  never paused. The admin cannot move funds or change a loan.
- The APR is at most 1200%. No price is read anywhere: the collateral is what the two sides agreed.
- There is no liquidation. Whatever prices do, the lender can take the collateral only after the grace period, and only
  if the loan has not been repaid.
- A payment an address refuses waits in the contract for that address (`withdraw`).

## Contract

| | |
|---|---|
| Network | Wanchain mainnet, chain id 888 |
| Address | [`0x6dfa0b14Be511cb0ff735C147F650b5791b84848`](https://orbitwan.io/address/0x6dfa0b14be511cb0ff735c147f650b5791b84848) |
| Source | [`contracts/XLend.sol`](contracts/XLend.sol), verified on orbitwan.io and on Sourcify (exact match) |
| Compiler | solc 0.8.36, optimizer on (200 runs), EVM version paris |

The loan and collateral tokens, fixed when the contract was deployed (`tokens()`):

| Token | Symbol on chain | Address |
|---|---|---|
| WAN | native | `0x0000000000000000000000000000000000000000` |
| xWAN | XWAN | `0x2eA407Aa69be7367BF231E76B51fab9eC436766c` |
| BTC | wanBTC | `0x50c439B6d602297252505a6799d84eA5928bCFb6` |
| ETH | wanETH | `0xE3aE74D1518A76715aB4C7BeDF1af73893cd435A` |
| USDT | wanUSDT | `0x11e77E27Af5539872efEd10abaA0b408cfd9fBBD` |
| USDC | wanUSDC | `0x52A9CEA01c4CBDd669883e41758B8eB8e8E2B34b` |
| ADA | wanADA | `0x79d745178BC271A1f29F8fbE9251dfC512db842C` |
| VET | VET | `0xe61f47a5fa9db061E2d9E2e88c604a583d878A5F` |
| XRP | wanXRP | `0xf665E0e3E75D16466345E1129530ec28839EfaEa` |

## For developers and agents

Read the contract directly; every figure the app shows comes from these calls.

- **Loans:** `loanCount()`, `getLoan(id)`, `owed(id)` (what repaying costs now: total, interest, late interest, fee,
  repayable), `interestOf(id)`, `feeOf(id)`, `dueOf(id)`, `loansOf(address, start, max)` and `loanCountOf(address)`.
- **Terms:** `termDays(term)` (term 0 to 4: 30, 60, 90, 180, 365 days), `feeBps(term)` (the service fee now, in basis
  points; an offer keeps the fee in force when it was posted), `tokens()`, `paused()`, `admin()`, `treasury()`.
- **Payments waiting:** `credit(address, token)` (a payment the address refused), `fees(token)` (fees not yet sent to
  the treasury).
- **Actions:** `post(loanToken, loanAmount, collToken, collAmount, aprBps, term)`, `cancel(id)`, `accept(id)`,
  `repay(id)`, `claim(id)`, `withdraw(token)`, and `sendFees(token)` (anyone may call it; the fees go to the treasury).
  For WAN send the amount as the call's value; for a token, `approve` the contract first. Amounts are in the token's
  smallest unit.
- **Events:** `Posted`, `Accepted`, `Repaid`, `Claimed`, `Cancelled`, `Credited`, `Withdrawn`, `FeesSent`, and the
  admin's `FeeSet`, `Paused` and `Resumed`.
- **RPC:** Wanchain's public RPC, `https://gwan-ssl.wandevs.org:56891`.
- **Explorer:** every loan of the contract is listed on its page on [orbitwan.io](https://orbitwan.io/address/0x6dfa0b14be511cb0ff735c147f650b5791b84848).

## The app

[`site/`](site/) is served at https://xlend.orbitwan.io by [`.github/workflows/pages.yml`](.github/workflows/pages.yml),
exactly as committed: there is no build step.

- Your wallet signs every transaction; the app never sees a key. Before it asks you to sign, it checks that your wallet
  is on Wanchain and that the contract there is this one (by the hash of its code), and runs each transaction but an
  approval once as a dry run, so one that would fail is never sent.
- It connects only to Wanchain's public RPC, to your wallet, and to orbitwan.io for token prices (the dollar values
  under the amounts). It loads nothing from other sites.
- `site/shared/ethers-6.17.0.umd.min.js` is `dist/ethers.umd.min.js` from the npm package ethers 6.17.0, sha256
  `532950515fd29ae9f7a21ceb2b68100815024d7944c3d5a92246d5b900bd703b`.
- Fonts: Space Grotesk and IBM Plex, from @fontsource. Icons: the globe is drawn for the app; the GitHub mark is from
  @primer/octicons and the X logo from simple-icons; those marks belong to GitHub and X. Their licenses are in [`site/shared/licenses/`](site/shared/licenses/).

## License

MIT. See [LICENSE](LICENSE).
