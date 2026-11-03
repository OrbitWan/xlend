// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title xLend
/// @notice Fixed-term, fixed-rate loans between two people on Wanchain.
/// - A lender posts an offer and deposits the loan: loan token and amount, collateral token and amount,
///   APR (the yearly rate, in basis points) and term (30, 60, 90, 180 or 365 days). The offer never changes after it
///   is posted.
/// - A borrower accepts it by depositing the collateral and receives the whole loan.
/// - Interest is loan x APR x days of the term / 365, owed in full whenever the loan is repaid.
/// - The borrower repays loan + interest + the platform fee up to the end of the term, or during a 3-day grace period
///   with one day of interest (APR / 365) for each day late, and gets the collateral back. After the grace period the
///   lender takes the collateral, and no fee is charged.
/// - No price is read anywhere: the collateral is the amount the two sides agreed.
/// - Funds go only to the lender of that loan, its borrower, or the fixed treasury (fees). No function takes a
///   destination address. A payment an address refuses waits in the contract for that address alone.
/// - Immutable: no upgrade. The admin can only set the fee of each term (a change applies only to offers posted
///   after it) and pause or resume new offers and new loans. Cancel, repay, claim, withdraw and sendFees are never
///   paused. The admin can never move funds or change a loan.
/// - Each address's loans (the offers it posted and the loans it borrowed) are listed in the contract, so a page
///   finds them without reading every loan.
contract XLend {
    address public constant WAN = address(0);        // native WAN
    uint256 public constant TERMS = 5;
    uint256 public constant GRACE_DAYS = 3;
    uint256 public constant MAX_FEE_BPS = 500;       // 5% of the loan per deal, hard cap
    uint256 public constant MAX_APR_BPS = 120000;    // 1200% a year, hard cap
    uint256 private constant BPS = 10000;
    uint256 private constant YEAR_DAYS = 365;
    uint256 private constant PUSH_GAS = 50000;       // gas for a WAN payment to an address that did not send the call

    address public immutable admin;
    address public immutable treasury;
    uint256 public immutable DAY;                    // seconds in a day: 86400 on mainnet

    enum State { None, Open, Active, Repaid, Claimed, Cancelled }

    struct Loan {
        address lender;
        uint32 aprBps;       // per year
        uint8 term;          // 0..4
        uint16 feeBps;       // locked when the offer is posted
        State state;
        address borrower;
        uint64 start;
        address loanToken;
        address collToken;
        uint128 loanAmount;
        uint128 collAmount;
    }

    Loan[] internal loans;
    mapping(address => uint256[]) internal loansBy;                    // address => ids it lent or borrowed
    address[] internal tokenList;
    mapping(address => bool) public allowed;
    uint16[5] internal feeTable;
    mapping(address => mapping(address => uint256)) public credit;   // owner => token => amount
    mapping(address => uint256) public fees;                         // token => fees owed to the treasury
    bool public paused;                                              // true: post and accept are refused

    uint256 private lock = 1;

    event Posted(uint256 indexed id, address indexed lender, address loanToken, uint256 loanAmount, address collToken, uint256 collAmount, uint256 aprBps, uint256 term, uint256 feeBps);
    event Cancelled(uint256 indexed id);
    event Accepted(uint256 indexed id, address indexed borrower, uint256 due);
    event Repaid(uint256 indexed id, uint256 interest, uint256 late, uint256 fee);
    event Claimed(uint256 indexed id);
    event Credited(address indexed owner, address indexed token, uint256 amount);
    event Withdrawn(address indexed owner, address indexed token, uint256 amount);
    event FeeSet(uint256 term, uint256 bps);
    event FeesSent(address indexed token, uint256 amount);
    event Paused();
    event Resumed();

    modifier nonReentrant() {
        require(lock == 1, "reentry");
        lock = 2;
        _;
        lock = 1;
    }

    constructor(address admin_, address treasury_, uint256 day_, address[] memory tokens_, uint16[5] memory fees_) {
        require(admin_ != address(0) && treasury_ != address(0), "zero address");
        require(day_ > 0 && (day_ == 1 days || block.chainid != 888), "day");
        require(tokens_.length >= 2, "tokens");
        for (uint256 i = 0; i < tokens_.length; i++) {
            address t = tokens_[i];
            require(!allowed[t], "duplicate token");
            require(t == WAN || t.code.length > 0, "not a token");
            allowed[t] = true;
            tokenList.push(t);
        }
        for (uint256 i = 0; i < TERMS; i++) {
            require(fees_[i] <= MAX_FEE_BPS, "fee cap");
            feeTable[i] = fees_[i];
            emit FeeSet(i, fees_[i]);
        }
        admin = admin_;
        treasury = treasury_;
        DAY = day_;
    }

    // =====================================================================
    // views
    // =====================================================================

    function termDays(uint256 term) public pure returns (uint256) {
        if (term == 0) return 30;
        if (term == 1) return 60;
        if (term == 2) return 90;
        if (term == 3) return 180;
        if (term == 4) return 365;
        revert("term");
    }

    function feeBps(uint256 term) external view returns (uint256) {
        require(term < TERMS, "term");
        return feeTable[term];
    }

    function tokens() external view returns (address[] memory) {
        return tokenList;
    }

    function loanCount() external view returns (uint256) {
        return loans.length;
    }

    function getLoan(uint256 id) external view returns (Loan memory) {
        require(id < loans.length, "no loan");
        return loans[id];
    }

    /// How many loans an address is in, as lender or borrower.
    function loanCountOf(address who) external view returns (uint256) {
        return loansBy[who].length;
    }

    /// The ids of the loans an address is in (the offers it posted, the loans it borrowed), oldest first: at most
    /// `max` of them, from position `start`.
    function loansOf(address who, uint256 start, uint256 max) external view returns (uint256[] memory ids) {
        uint256[] storage all = loansBy[who];
        uint256 end = all.length;
        if (start >= end) return new uint256[](0);
        if (end - start > max) end = start + max;
        ids = new uint256[](end - start);
        for (uint256 i = 0; i < ids.length; i++) ids[i] = all[start + i];
    }

    /// Interest for the whole term: loan x APR x days of the term / 365, rounded up.
    function interestOf(uint256 id) public view returns (uint256) {
        Loan storage l = _loan(id);
        return _ceilDiv(uint256(l.loanAmount) * l.aprBps * termDays(l.term), YEAR_DAYS * BPS);
    }

    /// End of the term; 0 while the loan is not active.
    function dueOf(uint256 id) public view returns (uint256) {
        Loan storage l = _loan(id);
        if (l.state != State.Active) return 0;
        return uint256(l.start) + termDays(l.term) * DAY;
    }

    /// The fee locked in the offer, rounded down; paid with the repayment.
    function feeOf(uint256 id) public view returns (uint256) {
        Loan storage l = _loan(id);
        return uint256(l.loanAmount) * l.feeBps / BPS;
    }

    /// What repaying costs now: loan + interest + late interest (one day of interest, APR / 365, per day or part of a
    /// day past the end of the term) + fee. Repayable is false once the grace period is over or the loan is not active.
    function owed(uint256 id) public view returns (uint256 total, uint256 interest, uint256 late, uint256 fee, bool repayable) {
        Loan storage l = _loan(id);
        if (l.state != State.Active) return (0, 0, 0, 0, false);
        uint256 due = dueOf(id);
        interest = interestOf(id);
        if (block.timestamp > due) {
            uint256 lateDays = _ceilDiv(block.timestamp - due, DAY);
            late = _ceilDiv(uint256(l.loanAmount) * l.aprBps * lateDays, YEAR_DAYS * BPS);
        }
        fee = feeOf(id);
        total = uint256(l.loanAmount) + interest + late + fee;
        repayable = block.timestamp <= due + GRACE_DAYS * DAY;
    }

    // =====================================================================
    // lender
    // =====================================================================

    /// Posts an offer and deposits the loan (as the call's WAN when the loan token is WAN; approve the token first
    /// otherwise). The fee in force now is locked into the offer.
    function post(address loanToken, uint256 loanAmount, address collToken, uint256 collAmount, uint256 aprBps, uint256 term)
        external payable nonReentrant returns (uint256 id)
    {
        require(!paused, "paused");
        require(allowed[loanToken] && allowed[collToken], "token");
        require(loanToken != collToken, "same token");
        require(loanAmount > 0 && loanAmount <= type(uint128).max, "loan amount");
        require(collAmount > 0 && collAmount <= type(uint128).max, "collateral amount");
        require(aprBps <= MAX_APR_BPS, "apr");
        require(term < TERMS, "term");
        uint16 f = feeTable[term];
        id = loans.length;
        loans.push(Loan({
            lender: msg.sender, aprBps: uint32(aprBps), term: uint8(term), feeBps: f, state: State.Open,
            borrower: address(0), start: 0, loanToken: loanToken, collToken: collToken,
            loanAmount: uint128(loanAmount), collAmount: uint128(collAmount)
        }));
        loansBy[msg.sender].push(id);
        _pull(loanToken, loanAmount);
        emit Posted(id, msg.sender, loanToken, loanAmount, collToken, collAmount, aprBps, term, f);
    }

    /// The lender takes back an offer nobody has accepted.
    function cancel(uint256 id) external nonReentrant {
        Loan storage l = _loan(id);
        require(msg.sender == l.lender, "not lender");
        require(l.state == State.Open, "not open");
        l.state = State.Cancelled;
        emit Cancelled(id);
        _pay(l.lender, l.loanToken, l.loanAmount);
    }

    /// After the grace period, the lender of an unpaid loan takes the collateral.
    function claim(uint256 id) external nonReentrant {
        Loan storage l = _loan(id);
        require(msg.sender == l.lender, "not lender");
        require(l.state == State.Active, "not active");
        require(block.timestamp > dueOf(id) + GRACE_DAYS * DAY, "too early");
        l.state = State.Claimed;
        emit Claimed(id);
        _pay(l.lender, l.collToken, l.collAmount);
    }

    // =====================================================================
    // borrower
    // =====================================================================

    /// Accepts an offer: deposits the collateral (as the call's WAN when it is WAN; approve the token first otherwise)
    /// and receives the whole loan. The fee locked in the offer is paid with the repayment.
    function accept(uint256 id) external payable nonReentrant {
        require(!paused, "paused");
        Loan storage l = _loan(id);
        require(l.state == State.Open, "not open");
        require(msg.sender != l.lender, "own offer");
        l.state = State.Active;
        l.borrower = msg.sender;
        loansBy[msg.sender].push(id);
        l.start = uint64(block.timestamp);
        _pull(l.collToken, l.collAmount);
        emit Accepted(id, msg.sender, dueOf(id));
        _pay(msg.sender, l.loanToken, l.loanAmount);
    }

    /// Repays loan + interest (+ late interest in the grace period) + fee and returns the collateral. Borrower only.
    /// For a WAN loan send at least owed(); the excess comes back. For a token loan approve at least owed().
    /// The lender receives loan + interest + late interest; the fee is booked for the treasury.
    function repay(uint256 id) external payable nonReentrant {
        Loan storage l = _loan(id);
        require(msg.sender == l.borrower, "not borrower");
        (uint256 total, uint256 interest, uint256 late, uint256 f, bool repayable) = owed(id);
        require(l.state == State.Active, "not active");
        require(repayable, "too late");
        l.state = State.Repaid;
        if (l.loanToken == WAN) {
            require(msg.value >= total, "value");
        } else {
            _pull(l.loanToken, total);
        }
        fees[l.loanToken] += f;
        emit Repaid(id, interest, late, f);
        _pay(l.lender, l.loanToken, total - f);
        _pay(msg.sender, l.collToken, l.collAmount);
        if (l.loanToken == WAN && msg.value > total) _pay(msg.sender, WAN, msg.value - total);
    }

    // =====================================================================
    // anyone
    // =====================================================================

    /// Takes a payment that the caller's address refused when it was made.
    function withdraw(address token) external nonReentrant {
        uint256 a = credit[msg.sender][token];
        require(a > 0, "nothing");
        credit[msg.sender][token] = 0;
        require(_send(msg.sender, token, a, false), "send");
        emit Withdrawn(msg.sender, token, a);
    }

    /// Sends the fees collected in a token to the treasury. Anyone may call.
    function sendFees(address token) external nonReentrant {
        uint256 a = fees[token];
        require(a > 0, "nothing");
        fees[token] = 0;
        require(_send(treasury, token, a, false), "send");
        emit FeesSent(token, a);
    }

    // =====================================================================
    // admin: the fee of each term, for offers posted afterwards; pause and resume new offers and new loans
    // =====================================================================

    function setFee(uint256 term, uint256 bps) external {
        require(msg.sender == admin, "not admin");
        require(term < TERMS, "term");
        require(bps <= MAX_FEE_BPS, "fee cap");
        feeTable[term] = uint16(bps);
        emit FeeSet(term, bps);
    }

    /// Refuses new offers (post) and new loans (accept) until resume. Nothing else is paused.
    function pause() external {
        require(msg.sender == admin, "not admin");
        require(!paused, "paused");
        paused = true;
        emit Paused();
    }

    function resume() external {
        require(msg.sender == admin, "not admin");
        require(paused, "not paused");
        paused = false;
        emit Resumed();
    }

    // =====================================================================
    // internals
    // =====================================================================

    function _loan(uint256 id) internal view returns (Loan storage) {
        require(id < loans.length, "no loan");
        return loans[id];
    }

    function _ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }

    /// Takes exactly `amount` from the caller: the call's WAN for WAN, otherwise a token transfer measured by the
    /// contract's balance, so a token that delivers less than asked is refused.
    function _pull(address token, uint256 amount) internal {
        if (token == WAN) {
            require(msg.value == amount, "value");
            return;
        }
        require(msg.value == 0, "value");
        uint256 b0 = _balance(token);
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(0x23b872dd, msg.sender, address(this), amount));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "transfer in");
        require(_balance(token) - b0 == amount, "amount in");
    }

    /// Pays `amount` to `to`; if the address refuses it, the amount waits in the contract for `to` alone.
    function _pay(address to, address token, uint256 amount) internal {
        if (amount == 0) return;
        if (!_send(to, token, amount, true)) {
            credit[to][token] += amount;
            emit Credited(to, token, amount);
        }
    }

    function _send(address to, address token, uint256 amount, bool capped) internal returns (bool) {
        if (token == WAN) {
            (bool okWan, ) = capped ? to.call{value: amount, gas: PUSH_GAS}("") : to.call{value: amount}("");
            return okWan;
        }
        uint256 b0 = _balance(token);
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        if (!ok || (data.length != 0 && (data.length < 32 || !abi.decode(data, (bool))))) return false;
        require(b0 - _balance(token) == amount, "amount out");
        return true;
    }

    function _balance(address token) internal view returns (uint256) {
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSelector(0x70a08231, address(this)));
        require(ok && data.length >= 32, "balance");
        return abi.decode(data, (uint256));
    }
}
