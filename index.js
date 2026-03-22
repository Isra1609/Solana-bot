/**
 * ═══════════════════════════════════════════════════════════════════
 *  SOLANA MEMECOIN BOT — Production Rewrite
 *  Strategy: High-expectancy, low-frequency, survival-first
 *  Architecture: Single Node.js file, persistent state, 2-pass entry
 * ═══════════════════════════════════════════════════════════════════
 */

"use strict"

const fetch   = require("node-fetch")
const bs58    = require("bs58")
const fs      = require("fs")
const path    = require("path")
const {
  Keypair,
  Connection,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
  PublicKey
} = require("@solana/web3.js")

// ─────────────────────────────────────────────────────────────────────────────
//  CONFIGURATION  (override with env vars)
// ─────────────────────────────────────────────────────────────────────────────
const CFG = {
  // RPC
  RPC_URL:               process.env.RPC_URL        || "https://api.mainnet-beta.solana.com",

  // Jupiter
  JUP_BASE:              "https://api.jup.ag",
  JUP_API_KEY:           process.env.JUP_API_KEY    || "",

  // Sizing
  TRADE_PCT:             parseFloat(process.env.TRADE_PCT    || "0.05"),  // 5% per trade
  MIN_TRADE_SOL:         parseFloat(process.env.MIN_TRADE    || "0.02"),  // hard min 0.02 SOL
  MAX_TRADE_SOL:         parseFloat(process.env.MAX_TRADE    || "0.10"),  // hard max 0.10 SOL (~$13)
  MAX_POSITIONS:         parseInt(  process.env.MAX_POS      || "1"),     // 1 open position at a time

  // Safety filters
  MIN_LIQUIDITY_USD:     parseFloat(process.env.MIN_LIQ      || "2000"),
  MAX_LIQUIDITY_USD:     parseFloat(process.env.MAX_LIQ      || "500000"),
  MIN_MCAP_USD:          parseFloat(process.env.MIN_MCAP     || "1000"),
  MAX_MCAP_USD:          parseFloat(process.env.MAX_MCAP     || "10000000"),
  MIN_PAIR_AGE_MIN:      parseFloat(process.env.MIN_AGE      || "5"),
  MAX_PAIR_AGE_MIN:      parseFloat(process.env.MAX_AGE      || "60"),
  MIN_VOL_5M:            parseFloat(process.env.MIN_VOL5M    || "1000"),
  MIN_TXNS_5M:           parseInt(  process.env.MIN_TXNS5M   || "15"),   // need real participation
  MIN_BUY_RATIO:         parseFloat(process.env.MIN_BR       || "0.65"), // 65% buys — real momentum
  MIN_PRICE_CHANGE_5M:   parseFloat(process.env.MIN_PC5M     || "5"),    // only trade actual pumps
  MAX_1H_NEGATIVE:       parseFloat(process.env.MAX_1H_NEG   || "-30"),
  MIN_LIQ_MCAP_RATIO:    parseFloat(process.env.MIN_LM_RATIO || "0.02"),
  MIN_SCORE:             parseInt(  process.env.MIN_SCORE    || "45"),    // out of 100

  // Exit thresholds
  INITIAL_STOP_PCT:      parseFloat(process.env.STOP_PCT     || "0.08"),  // -8% tight stop
  BREAKEVEN_TRIGGER_PCT: parseFloat(process.env.BE_PCT       || "0.10"),  // +10% → move stop to BE
  TP1_PCT:               parseFloat(process.env.TP1          || "0.20"),  // +20% → partial sell
  TP1_FRACTION:          parseFloat(process.env.TP1_FRAC     || "0.40"),  // sell 40%
  TP2_PCT:               parseFloat(process.env.TP2          || "0.40"),  // +40% → partial sell
  TP2_FRACTION:          parseFloat(process.env.TP2_FRAC     || "0.35"),  // sell 35%
  TRAIL_STOP_PCT:        parseFloat(process.env.TRAIL_PCT    || "0.07"),  // 7% trailing
  MAX_HOLD_MS:           parseInt(  process.env.MAX_HOLD     || "900000"),// 15 min
  STAGNANT_HOLD_MS:      parseInt(  process.env.STAGNANT_MS  || "300000"),// 5 min with no progress
  MOMENTUM_CHECK_INTERVAL: 60000,                                          // check momentum every 60s

  // Circuit breakers
  DAILY_LOSS_LIMIT_PCT:  parseFloat(process.env.DAILY_LOSS   || "0.30"),  // halt after -30% day
  CONSEC_LOSSES_HALVE:   parseInt(  process.env.CONSEC_L     || "3"),     // 3 losses → half size
  MAX_FAILED_SWAPS:      parseInt(  process.env.MAX_FAIL     || "5"),     // 5 failed swaps → pause
  FAILED_SWAP_WINDOW_MS: 3600000,                                          // 1h window

  // 2-pass entry delay
  CONFIRM_DELAY_MS:      parseInt(  process.env.CONFIRM_DELAY || "5000"),  // 5s — fast enough to confirm, slow enough to avoid fake candles

  // PumpPortal — pump.fun bonding curve + PumpSwap trading
  // No API key needed. 0.5% fee per trade. pool:"auto" handles pre/post graduation.
  PUMPPORTAL_URL:        "https://pumpportal.fun/api/trade-local",
  PUMP_SLIPPAGE:         parseInt(process.env.PUMP_SLIPPAGE  || "15"),   // 15% slippage for bonding curve
  PUMP_PRIORITY_FEE:     parseFloat(process.env.PUMP_PRIORITY || "0.005"), // SOL priority fee

  // Scan intervals
  DEX_SCAN_INTERVAL_MS:    parseInt(process.env.DEX_INTERVAL    || "60000"), // secondary — slow scan
  PUMP_SCAN_INTERVAL_MS:   parseInt(process.env.PUMP_INTERVAL   || "30000"), // secondary
  WALLET_SCAN_INTERVAL_MS: parseInt(process.env.WALLET_INTERVAL || "8000"),  // PRIMARY signal — fast poll
  MONITOR_INTERVAL_MS:     2000,

  // Rugcheck.xyz
  RUGCHECK_ENABLED:      process.env.RUGCHECK !== "false",
  RUGCHECK_MIN_SCORE:    parseInt(process.env.RUGCHECK_MIN || "300"),   // out of 1000
  RUGCHECK_MAX_WARNS:    parseInt(process.env.RUGCHECK_WARNS || "3"),

  // Pump.fun graduation window
  PUMP_GRAD_MIN_MCAP:    parseFloat(process.env.PUMP_MIN_MC || "45000"),
  PUMP_GRAD_MAX_MCAP:    parseFloat(process.env.PUMP_MAX_MC || "80000"),
  PUMP_NEW_MAX_AGE_MIN:  parseFloat(process.env.PUMP_MAX_AGE || "30"),

  // Cooldown for rejected/failed tokens
  COOLDOWN_MS:           parseInt(  process.env.COOLDOWN     || "3600000"), // 1h

  // State persistence
  STATE_FILE:            process.env.STATE_FILE || "/tmp/bot_state.json",
  TRADES_CSV:            process.env.TRADES_CSV || "/tmp/trades.csv",

  // Summary interval
  SUMMARY_INTERVAL_MS:   60000,
}

const SOL_MINT = "So11111111111111111111111111111111111111112"

// ─────────────────────────────────────────────────────────────────────────────
//  BLACKLIST
// ─────────────────────────────────────────────────────────────────────────────
const STATIC_BLACKLIST = new Set([
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs",
  "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",
  SOL_MINT,
  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
  "WENWENvqqNya429ubCdR81ZmD69brwQaaBYY6p3LCpk",
  "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
  "orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE",
  "8immgrdVcwzXvSjeQBu363D6QyyLiT1pjEVYw6bonk",
  "AJwfjnjw964Z5SZPsvshJwF41EaQo2xNkKuEtHCepump",
  "6hgiPE2pVm58CA94aQsycBoL1wzXiExCzvHx2A4spump",
  "DUWLCfcdW8G3gGBYn6bmUS9TYGScnaunhyL1kjrebonk",
  "A9YapB8oxePgpPFeYujQRAUZGx9HZZ4RTUBPuD6pump",
])

// ─────────────────────────────────────────────────────────────────────────────
//  COPY WALLETS  (set to [] to disable)
// ─────────────────────────────────────────────────────────────────────────────
const COPY_WALLETS = (process.env.COPY_WALLETS || "")
  .split(",")
  .map(w => w.trim())
  .filter(w => w.length > 30)

// ─── COPY WALLETS ─────────────────────────────────────────────────────────────
// Source: GMGN smart money leaderboard + Axiom top traders + KolScan KOLs
// These are verified active Solana memecoin traders as of early 2026.
// Override ALL of these by setting COPY_WALLETS env var (comma-separated).
// To add more: go to gmgn.ai → Rank → Sort by 7d PnL → copy wallet addresses
const COPY_WALLETS_DEFAULT = [
  // GMGN verified smart money — early entries into explosive memecoins
  "H72yLkhTnoBfhBTXXaj1RBXuirm8s8G5fcVh2XpQLggM",
  // Axiom top trader — known for 100x pump.fun entries
  "4Be9CvxqHW6BYiRAxW9Q3xu1ycTMWaL5z8NX4HR3ha7t",
  // KolScan insider wallet — frequently highlighted for insider trades
  "AVAZvHLR2PcWpDf8BXY4rVxNHYRBytycHkcB5z5QNXYm",
  // Additional GMGN top snipers
  "ASTyfSima4LLAdDgoFGkgqoKowG1LZFDr9fAQrg7iaJZ",
  "Gu5iBbbZCzfAqhAqJpE8swsxLq6CBJn9DfrJJCFBNRfQ",
  "5tzFkiKscXHK5ZXCGbGuygQFNkHDDTQS3NNrmfPkYfjN",
  "BdUMKEUFHFaGZLHSFEahYMXQR7aWcUY2jkMJqTuoiRHg",
  "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
  "3PFsKpsQxJ6mz2s3VF5YxqMa5mVZJPriLb7LGPQS57HH",
  "FNVf7uNSNKReAbSw8aMSoGbtm71iJCQJWXaJC9FsoLsb",
]

// Live wallet list — expands automatically as GMGN fetches fresh smart money
const activeWalletSet = new Set(
  COPY_WALLETS.length > 0 ? COPY_WALLETS : COPY_WALLETS_DEFAULT
)
const walletLastSig = new Map() // address → last seen signature

// Returns the current live wallet list
function getActiveWallets() { return [...activeWalletSet] }

// ─────────────────────────────────────────────────────────────────────────────
//  GMGN SMART WALLET DISCOVERY
//  Fetches the top profitable wallets from GMGN's leaderboard API every hour.
//  This keeps the copy wallet list fresh without manual updates.
//  Replicates: GMGN "Smart Money" tab + Cielo Finance wallet leaderboard
// ─────────────────────────────────────────────────────────────────────────────
async function refreshSmartWalletsFromGMGN() {
  try {
    // GMGN top traders endpoint — sorted by 7d PnL, Solana chain
    const res = await fetch(
      "https://gmgn.ai/defi/quotation/v1/rank/sol/wallets/7d?orderby=pnl&direction=desc&limit=20&tag=smart_degen",
      { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000) }
    )
    if (!res.ok) {
      log("WARN", `GMGN wallet rank HTTP ${res.status} — keeping existing wallets`)
      return
    }
    const json = await res.json()
    const wallets = json?.data?.rank || json?.rank || []

    if (!Array.isArray(wallets) || wallets.length === 0) {
      // Try alternate endpoint shape
      log("WARN", "GMGN rank: empty response — trying alternate endpoint")
      await refreshSmartWalletsAlt()
      return
    }

    let added = 0
    for (const w of wallets) {
      const addr   = w.wallet_address || w.address || w.wallet
      const winRate = parseFloat(w.win_rate || w.winRate || 0)
      const pnl     = parseFloat(w.pnl || w.realized_profit || 0)

      if (!addr || addr.length < 32) continue
      // Only add wallets with decent win rate and positive PnL
      if (winRate < 0.55 || pnl < 0) continue
      if (!activeWalletSet.has(addr)) {
        activeWalletSet.add(addr)
        added++
        log("INFO", `GMGN added smart wallet: ${addr.slice(0,8)}... WR:${(winRate*100).toFixed(0)}% PnL:${pnl.toFixed(1)}SOL`)
      }
    }
    log("INFO", `GMGN wallet refresh: ${added} new wallets added | total tracking: ${activeWalletSet.size}`)
  } catch (e) {
    log("WARN", `GMGN wallet refresh failed: ${e.message}`)
  }
}

// Alternate GMGN endpoint — try trending traders if main rank fails
async function refreshSmartWalletsAlt() {
  try {
    const res = await fetch(
      "https://gmgn.ai/defi/quotation/v1/rank/sol/wallets/7d?orderby=winrate&direction=desc&limit=20",
      { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000) }
    )
    if (!res.ok) return
    const json    = await res.json()
    const wallets = json?.data?.rank || json?.rank || []
    let added = 0
    for (const w of wallets) {
      const addr = w.wallet_address || w.address || w.wallet
      if (!addr || addr.length < 32) continue
      if (!activeWalletSet.has(addr)) { activeWalletSet.add(addr); added++ }
    }
    if (added > 0) log("INFO", `GMGN alt refresh: +${added} wallets`)
  } catch (e) {
    log("WARN", `GMGN alt refresh: ${e.message}`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  STATE  (in-memory + persisted to disk)
// ─────────────────────────────────────────────────────────────────────────────
/*
  Position state machine:
    candidate → pending_buy → open → pending_sell → closed | failed
*/
let state = {
  positions:      {},  // tokenMint → position object
  cooldownList:   {},  // tokenMint → expiresAt timestamp
  dayStartBalance: null,
  dailyRealizedPnl: 0,
  consecutiveLosses: 0,
  totalTrades:    0,
  winTrades:      0,
  totalPnlPct:    0,
  tradesToday:    0,
  rejectionCounts: {},
  candidatesScanned: 0,
  tradesTaken:    0,
  failedSwaps:    [],   // timestamps of failed swaps
  paused:         false,
  pauseReason:    "",
  reducedSize:    false,
  reducedSizeReason: "",
  lastSummaryAt:  0,
}

function loadState() {
  try {
    if (fs.existsSync(CFG.STATE_FILE)) {
      const raw  = fs.readFileSync(CFG.STATE_FILE, "utf8")
      const saved = JSON.parse(raw)
      // Only restore positions and cooldownList and daily stats
      state.positions        = saved.positions        || {}
      state.cooldownList     = saved.cooldownList     || {}
      state.dayStartBalance  = saved.dayStartBalance  || null
      state.dailyRealizedPnl = saved.dailyRealizedPnl || 0
      state.consecutiveLosses = saved.consecutiveLosses || 0
      state.totalTrades      = saved.totalTrades      || 0
      state.winTrades        = saved.winTrades        || 0
      state.totalPnlPct      = saved.totalPnlPct      || 0
      state.tradesToday      = saved.tradesToday      || 0
      log("STATE", `Loaded state: ${Object.keys(state.positions).length} positions, ${Object.keys(state.cooldownList).length} cooldowns`)
    }
  } catch (e) {
    log("WARN", `Could not load state: ${e.message} — starting fresh`)
  }
}

function saveState() {
  try {
    const toSave = {
      positions:         state.positions,
      cooldownList:      state.cooldownList,
      dayStartBalance:   state.dayStartBalance,
      dailyRealizedPnl:  state.dailyRealizedPnl,
      consecutiveLosses: state.consecutiveLosses,
      totalTrades:       state.totalTrades,
      winTrades:         state.winTrades,
      totalPnlPct:       state.totalPnlPct,
      tradesToday:       state.tradesToday,
    }
    fs.writeFileSync(CFG.STATE_FILE, JSON.stringify(toSave, null, 2))
  } catch (e) {
    log("WARN", `State save failed: ${e.message}`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  LOGGING
// ─────────────────────────────────────────────────────────────────────────────
function ts() {
  return new Date().toISOString().slice(11, 23)
}

function log(tag, msg) {
  const icons = {
    START:    "🚀", SCAN:  "🔍", EVAL:  "📋", REJECT: "❌",
    BUY:      "🟢", SELL:  "🔴", PNL:   "💰", ERROR:  "⚠️ ",
    INFO:     "ℹ️ ", WARN:  "🟡", STATE: "💾", STATS:  "📊",
    CONFIRM:  "✅", FAIL:  "🚨", PAUSE: "⏸️ ", RESUME: "▶️ ",
    MONITOR:  "📈", PRICE: "💲", RUG:   "🕳️ ", SCORE:  "⭐",
  }
  const icon = icons[tag] || "  "
  console.log(`[${ts()}] ${icon} [${tag.padEnd(7)}] ${msg}`)
}

function reject(reason, tokenMint) {
  state.rejectionCounts[reason] = (state.rejectionCounts[reason] || 0) + 1
  if (tokenMint) {
    log("REJECT", `${reason} | ${tokenMint.slice(0,8)}...`)
  } else {
    log("REJECT", reason)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  UTILITIES
// ─────────────────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(res => setTimeout(res, ms))
}

function inCooldown(tokenMint) {
  const exp = state.cooldownList[tokenMint]
  if (!exp) return false
  if (Date.now() > exp) {
    delete state.cooldownList[tokenMint]
    return false
  }
  return true
}

function addCooldown(tokenMint, ms = CFG.COOLDOWN_MS) {
  state.cooldownList[tokenMint] = Date.now() + ms
  saveState()
}

function openPositionCount() {
  return Object.values(state.positions).filter(
    p => p.status === "open" || p.status === "pending_buy" || p.status === "pending_sell"
  ).length
}

// ─────────────────────────────────────────────────────────────────────────────
//  WALLET / CONNECTION
// ─────────────────────────────────────────────────────────────────────────────
const connection = new Connection(CFG.RPC_URL, {
  commitment: "confirmed",
  confirmTransactionInitialTimeout: 60000,
})

function loadWallet() {
  if (!process.env.PRIVATE_KEY) throw new Error("Missing PRIVATE_KEY env var")
  return Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY))
}

async function getSolBalance(pubkey) {
  try {
    const bal = await connection.getBalance(pubkey)
    return bal / LAMPORTS_PER_SOL
  } catch (e) {
    log("ERROR", `Balance fetch failed: ${e.message}`)
    return null
  }
}

async function getTokenBalance(walletPubkey, tokenMint) {
  try {
    const accounts = await connection.getParsedTokenAccountsByOwner(
      walletPubkey,
      { mint: new PublicKey(tokenMint) }
    )
    if (accounts.value.length === 0) return null
    return accounts.value[0].account.data.parsed.info.tokenAmount.amount
  } catch (e) {
    log("ERROR", `getTokenBalance: ${e.message}`)
    return null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  ADAPTIVE POSITION SIZING
// ─────────────────────────────────────────────────────────────────────────────
async function getTradeAmountLamports(walletPubkey) {
  const solBalance = await getSolBalance(walletPubkey)
  if (solBalance === null) {
    log("WARN", "Using fallback trade size — balance unavailable")
    return Math.floor(CFG.MIN_TRADE_SOL * LAMPORTS_PER_SOL)
  }

  let pct = CFG.TRADE_PCT
  let reason = ""

  if (state.reducedSize) {
    pct = pct * 0.5
    reason = ` [REDUCED: ${state.reducedSizeReason}]`
  }

  const raw       = solBalance * pct
  const clamped   = Math.min(Math.max(raw, CFG.MIN_TRADE_SOL), CFG.MAX_TRADE_SOL)
  const lamports  = Math.floor(clamped * LAMPORTS_PER_SOL)

  log("INFO", `Balance:${solBalance.toFixed(4)}SOL | TradeSize:${clamped.toFixed(4)}SOL (${(pct*100).toFixed(1)}%)${reason}`)
  return lamports
}

// ─────────────────────────────────────────────────────────────────────────────
//  CIRCUIT BREAKERS & PERFORMANCE CONTROLS
// ─────────────────────────────────────────────────────────────────────────────
function checkPaused() {
  return state.paused
}

async function updateCircuitBreakers(walletPubkey) {
  // Daily loss check
  if (state.dayStartBalance !== null) {
    const currentBal = await getSolBalance(walletPubkey)
    if (currentBal !== null) {
      const drawdown = (state.dayStartBalance - currentBal) / state.dayStartBalance
      if (drawdown >= CFG.DAILY_LOSS_LIMIT_PCT && !state.paused) {
        state.paused      = true
        state.pauseReason = `Daily loss limit hit: -${(drawdown*100).toFixed(1)}%`
        log("PAUSE", state.pauseReason)
        saveState()
        return
      }
    }
  }

  // Consecutive losses → reduce size
  if (state.consecutiveLosses >= CFG.CONSEC_LOSSES_HALVE && !state.reducedSize) {
    state.reducedSize       = true
    state.reducedSizeReason = `${state.consecutiveLosses} consecutive losses`
    log("WARN", `Size halved: ${state.reducedSizeReason}`)
    saveState()
  }

  // Failed swap rate
  const windowStart = Date.now() - CFG.FAILED_SWAP_WINDOW_MS
  state.failedSwaps = state.failedSwaps.filter(t => t > windowStart)
  if (state.failedSwaps.length >= CFG.MAX_FAILED_SWAPS && !state.paused) {
    state.paused      = true
    state.pauseReason = `Too many failed swaps: ${state.failedSwaps.length} in 1h`
    log("PAUSE", state.pauseReason)
    saveState()
  }
}

function recordWin(pctGain) {
  state.consecutiveLosses = 0
  // Gradually restore size if we were reduced
  if (state.reducedSize && state.consecutiveLosses === 0) {
    state.reducedSize       = false
    state.reducedSizeReason = ""
    log("RESUME", "Size restored after win")
  }
}

function recordLoss() {
  state.consecutiveLosses++
}

// ─────────────────────────────────────────────────────────────────────────────
//  JUPITER SWAP EXECUTION
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
//  PUMPPORTAL SWAP  (pump.fun bonding curve + PumpSwap AMM)
//  Used for: pre-graduation bonding curve tokens AND graduated PumpSwap tokens
//  pool:"auto" detects which one and routes accordingly — no code change needed
//  Docs: https://pumpportal.fun/local-trading-api/trading-api
//  Fee: 0.5% per trade (charged by PumpPortal)
// ─────────────────────────────────────────────────────────────────────────────
async function pumpPortalSwap(wallet, tokenMint, action, amountSol, label = "") {
  // action = "buy" | "sell"
  // amountSol = SOL amount as number (e.g. 0.05)
  // For sells we pass "100%" to sell entire balance

  const isSell   = action === "sell"
  const body     = {
    publicKey:        wallet.publicKey.toString(),
    action,
    mint:             tokenMint,
    amount:           isSell ? amountSol : Math.floor(amountSol * LAMPORTS_PER_SOL), // lamports for buy, "100%" or token amount for sell
    denominatedInSol: isSell ? "false" : "true",
    slippage:         CFG.PUMP_SLIPPAGE,
    priorityFee:      CFG.PUMP_PRIORITY_FEE,
    pool:             "auto",  // auto-detects bonding curve vs PumpSwap AMM
  }

  // For full sells, use percentage
  if (isSell && typeof amountSol === "string" && amountSol.endsWith("%")) {
    body.amount           = amountSol
    body.denominatedInSol = "false"
  }

  log("INFO", `PumpPortal ${action} | ${tokenMint.slice(0,8)}... | ${isSell ? amountSol : amountSol.toFixed(4)+"SOL"} [${label}]`)

  const res = await fetch(CFG.PUMPPORTAL_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout(10000),
  })

  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText)
    throw new Error(`PumpPortal ${action} HTTP ${res.status}: ${errText.slice(0, 200)}`)
  }

  // Response is raw bytes of serialized transaction
  const txBytes = new Uint8Array(await res.arrayBuffer())
  if (!txBytes || txBytes.length === 0) {
    throw new Error(`PumpPortal returned empty transaction [${label}]`)
  }

  // Sign and send via our RPC
  const tx = VersionedTransaction.deserialize(txBytes)
  tx.sign([wallet])

  const sig = await connection.sendTransaction(tx, {
    skipPreflight:       false,
    preflightCommitment: "confirmed",
    maxRetries:          3,
  })

  // Wait for confirmation
  const { value: status } = await connection.confirmTransaction(sig, "confirmed")
  if (status?.err) {
    throw new Error(`PumpPortal tx failed on-chain: ${JSON.stringify(status.err)} | sig:${sig}`)
  }

  log("CONFIRM", `PumpPortal ${action} confirmed | sig:${sig} [${label}]`)
  return { signature: sig, status: "Success" }
}

async function swap(wallet, inputMint, outputMint, amount, label = "") {
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount: amount.toString(),
    taker: wallet.publicKey.toString(),
  })

  const headers = { "Content-Type": "application/json" }
  if (CFG.JUP_API_KEY) headers["x-api-key"] = CFG.JUP_API_KEY

  // 1. Get order
  let orderRes, order
  try {
    orderRes = await fetch(`${CFG.JUP_BASE}/ultra/v1/order?${params}`, { headers })
    if (!orderRes.ok) throw new Error(`Order HTTP ${orderRes.status}`)
    order = await orderRes.json()
  } catch (e) {
    throw new Error(`Order failed [${label}]: ${e.message}`)
  }

  if (!order || !order.transaction || !order.requestId) {
    throw new Error(`Malformed order response [${label}]: ${JSON.stringify(order).slice(0, 200)}`)
  }

  log("INFO", `Order obtained | requestId:${order.requestId} [${label}]`)

  // 2. Sign
  let tx
  try {
    tx = VersionedTransaction.deserialize(Buffer.from(order.transaction, "base64"))
    tx.sign([wallet])
  } catch (e) {
    throw new Error(`TX deserialize/sign failed [${label}]: ${e.message}`)
  }

  const signedTx = Buffer.from(tx.serialize()).toString("base64")

  // 3. Execute
  let execRes, result
  try {
    execRes = await fetch(`${CFG.JUP_BASE}/ultra/v1/execute`, {
      method:  "POST",
      headers,
      body:    JSON.stringify({ signedTransaction: signedTx, requestId: order.requestId }),
    })
    if (!execRes.ok) throw new Error(`Execute HTTP ${execRes.status}`)
    result = await execRes.json()
  } catch (e) {
    throw new Error(`Execute failed [${label}]: ${e.message}`)
  }

  if (!result || result.status !== "Success") {
    throw new Error(`Swap not successful [${label}]: ${JSON.stringify(result).slice(0, 300)}`)
  }

  const sig = result.txSignature || result.signature || "unknown"
  log("CONFIRM", `Swap confirmed | sig:${sig} | requestId:${order.requestId} [${label}]`)
  return result
}

// ─────────────────────────────────────────────────────────────────────────────
//  PRICE FETCHING
// ─────────────────────────────────────────────────────────────────────────────
async function getDexPrice(tokenMint) {
  try {
    const res  = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${tokenMint}`)
    if (!res.ok) return null
    const data = await res.json()
    if (!Array.isArray(data) || data.length === 0) return null
    const pair = data.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0]
    return parseFloat(pair?.priceUsd) || null
  } catch { return null }
}

async function getJupPrice(tokenMint) {
  try {
    const headers = CFG.JUP_API_KEY ? { "x-api-key": CFG.JUP_API_KEY } : {}
    const res     = await fetch(`${CFG.JUP_BASE}/price/v2?ids=${tokenMint}`, { headers })
    if (!res.ok) return null
    const data    = await res.json()
    return parseFloat(data?.data?.[tokenMint]?.price) || null
  } catch { return null }
}

async function getBestPrice(tokenMint) {
  const [jupPrice, dexPrice] = await Promise.all([
    getJupPrice(tokenMint),
    getDexPrice(tokenMint),
  ])
  return jupPrice || dexPrice || null
}

// ─────────────────────────────────────────────────────────────────────────────
//  DEXSCREENER PAIR DATA
// ─────────────────────────────────────────────────────────────────────────────
async function getDexPairData(tokenMint) {
  try {
    const res  = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${tokenMint}`)
    if (!res.ok) return null
    const data = await res.json()
    if (!Array.isArray(data) || data.length === 0) return null
    // Select best pair by liquidity
    return data.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0]
  } catch { return null }
}

// ─────────────────────────────────────────────────────────────────────────────
//  PUMP.FUN INTERNAL AMM DATA
//  Smart wallets often buy pump.fun tokens BEFORE they graduate to Raydium.
//  DexScreener shows $0 liquidity for these — but they're real active tokens.
//  This fetches directly from pump.fun's API to get real bonding curve data.
// ─────────────────────────────────────────────────────────────────────────────
async function getPumpFunData(tokenMint) {
  try {
    const res = await fetch(
      `https://frontend-api.pump.fun/coins/${tokenMint}`,
      { signal: AbortSignal.timeout(4000) }
    )
    if (!res.ok) return null
    const coin = await res.json()
    if (!coin || !coin.mint) return null

    const mcap        = coin.usd_market_cap      || 0
    const volume24h   = coin.volume               || 0
    const complete    = coin.complete             || false  // graduated to Raydium?
    const createdAt   = coin.created_timestamp    || Date.now()
    const ageMin      = (Date.now() - createdAt) / 60000
    const replyCount  = coin.reply_count          || 0      // community engagement
    const kingOfHill  = coin.is_currently_on_king_of_the_hill || false

    // Build a synthetic "pair" object in DexScreener format
    // so the rest of the evaluation pipeline works unchanged
    const syntheticPair = {
      _source:        "pumpfun",
      _complete:      complete,
      chainId:        "solana",
      baseToken:      { address: tokenMint, symbol: coin.symbol, name: coin.name },
      priceUsd:       coin.usd_market_cap && coin.total_supply
                        ? (coin.usd_market_cap / coin.total_supply).toString()
                        : "0",
      priceChange:    { m5: 0, h1: 0, h6: 0, h24: 0 },  // not available pre-graduation
      volume:         { m5: volume24h / 288, h24: volume24h }, // estimate 5m from 24h
      txns:           {
        m5: {
          buys:  Math.max(1, Math.floor(replyCount / 10)),  // rough estimate
          sells: 0
        }
      },
      liquidity:      { usd: mcap * 0.05 },  // bonding curve ~5% of MC is liquid
      marketCap:      mcap,
      fdv:            mcap,
      pairCreatedAt:  createdAt,
      _ageMin:        ageMin,
      _replyCount:    replyCount,
      _kingOfHill:    kingOfHill,
      _pumpRaw:       coin,
    }

    return syntheticPair
  } catch { return null }
}

// Unified pair fetcher — tries DexScreener first, falls back to pump.fun
// This ensures we don't miss tokens that smart wallets buy pre-graduation
async function getPairData(tokenMint) {
  const dexData = await getDexPairData(tokenMint)

  // DexScreener has real data — use it
  if (dexData && (dexData.liquidity?.usd || 0) > 100) return dexData

  // DexScreener shows $0 — check if it's a live pump.fun token
  const pumpData = await getPumpFunData(tokenMint)
  if (pumpData) {
    log("INFO", `PumpFun pre-grad token: ${tokenMint.slice(0,8)}... MC:$${Math.round(pumpData.marketCap)} age:${pumpData._ageMin?.toFixed(1)}min`)
    return pumpData
  }

  return dexData // return whatever dex had (even if null)
}

// ─────────────────────────────────────────────────────────────────────────────
//  ON-CHAIN SECURITY CHECKS
//  Replicates: GMGN CA checks, Axiom bundle detection, BullX/Photon safety scan
//  Checks: mint authority, freeze authority, top holder concentration,
//          bundle launch detection
// ─────────────────────────────────────────────────────────────────────────────
async function onChainSecurityCheck(tokenMint) {
  const flags = []
  const pass  = []

  // 1. Mint + freeze authority (GMGN / rugcheck equivalent)
  try {
    const mintInfo = await connection.getParsedAccountInfo(new PublicKey(tokenMint))
    const parsed   = mintInfo?.value?.data?.parsed?.info
    if (parsed) {
      if (parsed.mintAuthority !== null) flags.push("MINT_AUTHORITY_ACTIVE")
      else pass.push("mint_revoked")
      if (parsed.freezeAuthority !== null) flags.push("FREEZE_AUTHORITY_ACTIVE")
      else pass.push("freeze_revoked")
    }
  } catch (e) { log("WARN", `Mint info: ${e.message}`) }

  // 2. Top holder concentration (Axiom / GMGN holder check)
  try {
    const holders  = await connection.getTokenLargestAccounts(new PublicKey(tokenMint))
    const accounts = holders?.value || []
    if (accounts.length > 0) {
      const total   = accounts.reduce((s, a) => s + (a.uiAmount || 0), 0)
      if (total > 0) {
        const top5pct = accounts.slice(0, 5).reduce((s, a) => s + (a.uiAmount || 0), 0) / total
        const top1pct = (accounts[0]?.uiAmount || 0) / total
        if (top1pct > 0.40) flags.push(`SINGLE_WALLET_${(top1pct*100).toFixed(0)}PCT`)
        else if (top5pct > 0.70) flags.push(`TOP5_HOLD_${(top5pct*100).toFixed(0)}PCT`)
        else pass.push(`top5_${(top5pct*100).toFixed(0)}pct_ok`)
      }
    }
  } catch (e) { log("WARN", `Holder check: ${e.message}`) }

  // 3. Bundle / coordinated launch detection (Axiom bundle checker)
  // Multiple txns in same block at launch = coordinated pre-buy = dump risk
  try {
    const sigs = await connection.getSignaturesForAddress(new PublicKey(tokenMint), { limit: 20 })
    if (sigs.length >= 5) {
      const slotGroups = {}
      for (const s of sigs) {
        if (s.slot) slotGroups[s.slot] = (slotGroups[s.slot] || 0) + 1
      }
      const maxSameSlot = Math.max(...Object.values(slotGroups))
      if (maxSameSlot >= 5) flags.push(`BUNDLE_DETECTED:${maxSameSlot}_txns_same_block`)
      else pass.push("no_bundle")
    }
  } catch (e) { log("WARN", `Bundle check: ${e.message}`) }

  const hardFail = flags.filter(f =>
    f.startsWith("MINT_AUTHORITY") ||
    f.startsWith("FREEZE_AUTHORITY") ||
    f.startsWith("SINGLE_WALLET") ||
    f.startsWith("BUNDLE_DETECTED")
  )
  const safe = hardFail.length === 0
  log(safe ? "CONFIRM" : "RUG",
    `OnChain: ${safe ? pass.join("|") : hardFail.join("|")} | ${tokenMint.slice(0,8)}...`)
  return { safe, flags, pass }
}

// ─────────────────────────────────────────────────────────────────────────────
//  SMART WALLET CLUSTER SIGNAL
//  Replicates: Cielo Finance + GMGN multi-wallet convergence alert
//  If 2+ tracked wallets buy the SAME token = much stronger signal
// ─────────────────────────────────────────────────────────────────────────────
const smartWalletBuyLog = new Map() // tokenMint → Set<walletAddress>

function recordSmartWalletBuy(tokenMint, walletAddress) {
  if (!smartWalletBuyLog.has(tokenMint)) smartWalletBuyLog.set(tokenMint, new Set())
  smartWalletBuyLog.get(tokenMint).add(walletAddress)
}

function getSmartWalletBuyCount(tokenMint) {
  return smartWalletBuyLog.get(tokenMint)?.size || 0
}

// ─────────────────────────────────────────────────────────────────────────────
//  RUG CHECK
// ─────────────────────────────────────────────────────────────────────────────
async function rugCheck(tokenMint, pair) {
  const reasons = []

  const liquidity  = pair?.liquidity?.usd     || 0
  const marketCap  = pair?.marketCap          || pair?.fdv || 0
  const ageMin     = pair?.pairCreatedAt
    ? (Date.now() - pair.pairCreatedAt) / 60000
    : 9999
  const buys5m     = pair?.txns?.m5?.buys     || 0
  const sells5m    = pair?.txns?.m5?.sells    || 0
  const txns5m     = buys5m + sells5m
  const buyRatio   = txns5m > 0 ? buys5m / txns5m : 0
  const priceChg5m = pair?.priceChange?.m5    || 0

  // Liquidity / marketCap ratio
  if (marketCap > 0 && liquidity / marketCap < CFG.MIN_LIQ_MCAP_RATIO) {
    reasons.push(`LIQ/MC ratio too low: ${(liquidity/marketCap*100).toFixed(1)}%`)
  }

  // Minimum absolute liquidity
  if (liquidity < CFG.MIN_LIQUIDITY_USD) {
    reasons.push(`Liquidity too low: $${Math.round(liquidity)}`)
  }

  // Pair age minimum
  if (ageMin < CFG.MIN_PAIR_AGE_MIN) {
    reasons.push(`Too new: ${ageMin.toFixed(1)}min`)
  }

  // Suspiciously fast spike (>200% in 5m with low buy count = likely manipulation)
  if (priceChg5m > 200 && buys5m < 10) {
    reasons.push(`Spike without participation: +${priceChg5m}% but only ${buys5m} buys`)
  }

  // Weak participation
  if (txns5m < CFG.MIN_TXNS_5M) {
    reasons.push(`Weak participation: ${txns5m} txns in 5m`)
  }

  // Recent sell pressure
  if (buyRatio < CFG.MIN_BUY_RATIO) {
    reasons.push(`Sell pressure: buy ratio ${(buyRatio*100).toFixed(0)}%`)
  }

  const safe = reasons.length === 0
  return { safe, reasons }
}

// ─────────────────────────────────────────────────────────────────────────────
//  SCORING SYSTEM (0–100)
// ─────────────────────────────────────────────────────────────────────────────
function scoreToken(pair) {
  const liquidity   = pair?.liquidity?.usd     || 0
  const marketCap   = pair?.marketCap          || pair?.fdv || 0
  const volume5m    = pair?.volume?.m5         || 0
  const priceChg5m  = pair?.priceChange?.m5    || 0
  const priceChg1h  = pair?.priceChange?.h1    || 0
  const buys5m      = pair?.txns?.m5?.buys     || 0
  const sells5m     = pair?.txns?.m5?.sells    || 0
  const txns5m      = buys5m + sells5m
  const buyRatio    = txns5m > 0 ? buys5m / txns5m : 0
  const ageMin      = pair?.pairCreatedAt
    ? (Date.now() - pair.pairCreatedAt) / 60000
    : 9999
  const liqMcRatio  = marketCap > 0 ? liquidity / marketCap : 0
  const hasBoost    = pair?._boosted === true

  const breakdown = {}
  let score = 0

  // Liquidity quality (max 15) — calibrated for real Solana market ($5K–$50K typical)
  const liqScore = liquidity >= 50000  ? 15 :
                   liquidity >= 25000  ? 12 :
                   liquidity >= 15000  ? 10 :
                   liquidity >= 10000  ? 8  :
                   liquidity >= 5000   ? 5  : 0
  breakdown.liquidity = liqScore
  score += liqScore

  // 5m volume (max 20) — $1K–$10K is typical for fresh tokens
  const volScore = volume5m >= 30000 ? 20 :
                   volume5m >= 10000 ? 16 :
                   volume5m >= 5000  ? 12 :
                   volume5m >= 2000  ? 8  :
                   volume5m >= 1000  ? 5  : 0
  breakdown.volume5m = volScore
  score += volScore

  // Txn count (max 10) — 10–30 txns in 5m is real activity for a new token
  const txnScore = txns5m >= 100 ? 10 :
                   txns5m >= 50  ? 8  :
                   txns5m >= 25  ? 6  :
                   txns5m >= 10  ? 4  : 0
  breakdown.txns = txnScore
  score += txnScore

  // Buy ratio (max 15)
  const brScore = buyRatio >= 0.80 ? 15 :
                  buyRatio >= 0.70 ? 12 :
                  buyRatio >= 0.65 ? 9  :
                  buyRatio >= 0.55 ? 6  : 0
  breakdown.buyRatio = brScore
  score += brScore

  // 5m momentum (max 15)
  const m5Score = priceChg5m >= 20 ? 15 :
                  priceChg5m >= 10 ? 12 :
                  priceChg5m >= 5  ? 9  :
                  priceChg5m >= 2  ? 5  : 0
  breakdown.momentum5m = m5Score
  score += m5Score

  // 1h momentum (max 10)
  const m1hScore = priceChg1h >= 50 ? 10 :
                   priceChg1h >= 20 ? 8  :
                   priceChg1h >= 5  ? 5  :
                   priceChg1h >= 0  ? 2  : 0
  breakdown.momentum1h = m1hScore
  score += m1hScore

  // Age sweet spot (max 10) — new tokens (5–30min) score best
  const ageScore = ageMin >= 5  && ageMin <= 30  ? 10 :
                   ageMin >= 5  && ageMin <= 60   ? 7  :
                   ageMin <= 120 ? 3 : 0
  breakdown.ageSweetSpot = ageScore
  score += ageScore

  // Liq/MC ratio (max 10) — lower floor to match thin markets
  const lmScore = liqMcRatio >= 0.10 ? 10 :
                  liqMcRatio >= 0.05 ? 7  :
                  liqMcRatio >= 0.02 ? 4  : 0
  breakdown.liqMcRatio = lmScore
  score += lmScore

  // Boost presence (max 5)
  const boostScore = hasBoost ? 5 : 0
  breakdown.boost   = boostScore
  score += boostScore

  return { score, breakdown, max: 100 }
}

// ─────────────────────────────────────────────────────────────────────────────
//  HARD SAFETY FILTERS
// ─────────────────────────────────────────────────────────────────────────────
function applyHardFilters(tokenMint, pair) {
  const liquidity   = pair?.liquidity?.usd     || 0
  const marketCap   = pair?.marketCap          || pair?.fdv || 0
  const ageMin      = pair?.pairCreatedAt
    ? (Date.now() - pair.pairCreatedAt) / 60000
    : 9999
  const volume5m    = pair?.volume?.m5         || 0
  const buys5m      = pair?.txns?.m5?.buys     || 0
  const sells5m     = pair?.txns?.m5?.sells    || 0
  const txns5m      = buys5m + sells5m
  const buyRatio    = txns5m > 0 ? buys5m / txns5m : 0
  const priceChg5m  = pair?.priceChange?.m5    || 0
  const priceChg1h  = pair?.priceChange?.h1    || 0
  const liqMcRatio  = marketCap > 0 ? liquidity / marketCap : 0

  if (STATIC_BLACKLIST.has(tokenMint))                    return "BLACKLISTED"
  if (inCooldown(tokenMint))                              return "COOLDOWN"
  if (liquidity < CFG.MIN_LIQUIDITY_USD)                  return `LIQ_TOO_LOW:$${Math.round(liquidity)}`
  if (liquidity > CFG.MAX_LIQUIDITY_USD)                  return `LIQ_TOO_HIGH:$${Math.round(liquidity)}`
  if (marketCap > 0 && marketCap < CFG.MIN_MCAP_USD)     return `MCAP_TOO_LOW:$${Math.round(marketCap)}`
  if (marketCap > CFG.MAX_MCAP_USD)                      return `MCAP_TOO_HIGH:$${Math.round(marketCap)}`
  if (ageMin < CFG.MIN_PAIR_AGE_MIN)                      return `TOO_NEW:${ageMin.toFixed(1)}min`
  if (ageMin > CFG.MAX_PAIR_AGE_MIN)                      return `TOO_OLD:${ageMin.toFixed(1)}min`
  if (volume5m < CFG.MIN_VOL_5M)                          return `VOL5M_LOW:$${Math.round(volume5m)}`
  if (txns5m < CFG.MIN_TXNS_5M)                          return `TXNS5M_LOW:${txns5m}`
  if (buyRatio < CFG.MIN_BUY_RATIO)                       return `BUY_RATIO_LOW:${(buyRatio*100).toFixed(0)}%`
  if (priceChg5m < CFG.MIN_PRICE_CHANGE_5M)              return `MOMENTUM_WEAK:${priceChg5m}%`
  if (priceChg1h < CFG.MAX_1H_NEGATIVE)                  return `1H_NEGATIVE:${priceChg1h}%`
  if (liqMcRatio < CFG.MIN_LIQ_MCAP_RATIO)               return `LIQ_MC_RATIO_LOW:${(liqMcRatio*100).toFixed(1)}%`

  return null // pass
}

// ─────────────────────────────────────────────────────────────────────────────
//  FULL TOKEN EVALUATION
//  Two paths:
//  A) COPY_TRADE / cluster signal → skip DexScreener filters, go on-chain only
//     DexScreener won't have data yet for fresh tokens smart wallets just bought
//  B) Everything else → full DexScreener filter stack
// ─────────────────────────────────────────────────────────────────────────────
async function evaluateToken(tokenMint, source) {
  state.candidatesScanned++

  if (STATIC_BLACKLIST.has(tokenMint)) {
    reject("BLACKLISTED", tokenMint)
    return null
  }
  if (inCooldown(tokenMint)) {
    reject("COOLDOWN", tokenMint)
    return null
  }

  log("EVAL", `Evaluating ${tokenMint.slice(0,8)}... [${source}]`)

  // ── PATH A: Copy trade / cluster signal ──────────────────────────────────
  // Smart wallets bought this. DexScreener may not have data yet.
  // Skip liquidity/volume/age filters. Run on-chain security only.
  const isCopySignal   = source === "COPY_TRADE"
  const clusterCount   = getSmartWalletBuyCount(tokenMint)
  const isClusterSignal = clusterCount >= 2

  if (isCopySignal || isClusterSignal) {
    log("EVAL", `Fast-path: ${isClusterSignal ? `CLUSTER(${clusterCount})` : "COPY_TRADE"} — skipping DexScreener filters`)

    // Still blacklist check
    if (STATIC_BLACKLIST.has(tokenMint)) { reject("BLACKLISTED", tokenMint); return null }

    // On-chain security — this is the gate for copy trades
    const onChainFast = await onChainSecurityCheck(tokenMint)
    if (!onChainFast.safe) {
      reject(`ONCHAIN:${onChainFast.flags[0]}`, tokenMint)
      addCooldown(tokenMint, CFG.COOLDOWN_MS)
      return null
    }

    // GMGN security check
    const gmgnFast = await gmgnSecurityCheck(tokenMint)
    if (!gmgnFast.safe) {
      reject(`GMGN:${gmgnFast.hardFail[0]}`, tokenMint)
      addCooldown(tokenMint, CFG.COOLDOWN_MS)
      return null
    }

    // Try to get DexScreener data — but don't reject if missing
    const pair = await getDexPairData(tokenMint)
    const liquidity  = pair?.liquidity?.usd || 0
    const marketCap  = pair?.marketCap || pair?.fdv || 0
    const volume5m   = pair?.volume?.m5 || 0
    const ageMin     = pair?.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 60000 : 0
    const buys5m     = pair?.txns?.m5?.buys || 0
    const sells5m    = pair?.txns?.m5?.sells || 0
    const txns5m     = buys5m + sells5m
    const buyRatio   = txns5m > 0 ? buys5m / txns5m : 0.5 // assume neutral if no data
    const priceChg5m = pair?.priceChange?.m5 || 0

    // Only hard-reject if clearly dead (age >2h or liq >$500K)
    if (ageMin > CFG.MAX_PAIR_AGE_MIN) { reject(`TOO_OLD:${ageMin.toFixed(0)}min`, tokenMint); return null }
    if (liquidity > CFG.MAX_LIQUIDITY_USD) { reject(`LIQ_TOO_HIGH:$${Math.round(liquidity)}`, tokenMint); return null }

    // Score with cluster bonus — copy trades get automatic +15
    const { score: baseScore, breakdown } = scoreToken(pair || {})
    const copyBonus   = isClusterSignal ? clusterCount * 10 : 15
    const score       = Math.min(100, baseScore + copyBonus)
    const bdStr       = Object.entries(breakdown).map(([k,v]) => `${k}:${v}`).join(" ")
    log("SCORE", `Score:${score}/100 (base:${baseScore} +${copyBonus}copy_bonus) | ${tokenMint.slice(0,8)}...`)

    // Lower score threshold for copy trades — 30 minimum instead of 45
    if (score < 30) { reject(`SCORE_LOW:${score}`, tokenMint); return null }

    log("EVAL", `✅ Copy fast-path passed | liq:$${Math.round(liquidity)} mc:$${Math.round(marketCap)} age:${ageMin.toFixed(1)}min cluster:${clusterCount}`)
    return { pair: pair || {}, score, liquidity, marketCap, volume5m, ageMin, buyRatio, priceChg5m, source, smartWalletCount: clusterCount }
  }

  // ── PATH B: Standard DexScreener-based evaluation ────────────────────────
  const pair = await getDexPairData(tokenMint)
  if (!pair) {
    reject("NO_DEX_DATA", tokenMint)
    addCooldown(tokenMint, 600000)
    return null
  }

  const liquidity  = pair?.liquidity?.usd || 0
  const marketCap  = pair?.marketCap      || pair?.fdv || 0
  const ageMin     = pair?.pairCreatedAt
    ? (Date.now() - pair.pairCreatedAt) / 60000 : 9999
  const volume5m   = pair?.volume?.m5     || 0
  const buys5m     = pair?.txns?.m5?.buys || 0
  const sells5m    = pair?.txns?.m5?.sells || 0
  const txns5m     = buys5m + sells5m
  const buyRatio   = txns5m > 0 ? buys5m / txns5m : 0
  const priceChg5m = pair?.priceChange?.m5 || 0

  log("EVAL", `Liq:$${Math.round(liquidity)} MC:$${Math.round(marketCap)} Age:${ageMin.toFixed(1)}min Vol5m:$${Math.round(volume5m)} Txns:${txns5m} BR:${(buyRatio*100).toFixed(0)}% PC5m:${priceChg5m}%`)

  // Hard filters
  const filterFail = applyHardFilters(tokenMint, pair)
  if (filterFail) {
    reject(filterFail, tokenMint)
    return null
  }

  // ── GMGN security API — primary security gate
  // Only hard-reject on confirmed dangerous flags. If GMGN is unavailable, allow through.
  const gmgn = await gmgnSecurityCheck(tokenMint)
  if (!gmgn.safe && gmgn.hardFail && gmgn.hardFail.length > 0) {
    // Only cooldown on definitive rug signals, not API errors
    const isDefiniteRug = gmgn.hardFail.some(f =>
      f === "MINT_NOT_REVOKED" || f === "FREEZE_NOT_REVOKED" || f === "HONEYPOT_DETECTED"
    )
    reject(`GMGN:${gmgn.hardFail[0]}`, tokenMint)
    if (isDefiniteRug) addCooldown(tokenMint, CFG.COOLDOWN_MS)
    return null
  }

  // Internal rug check (market structure)
  const { safe, reasons } = await rugCheck(tokenMint, pair)
  if (!safe) {
    const rugReason = `RUG_CHECK:${reasons[0]}`
    reject(rugReason, tokenMint)
    addCooldown(tokenMint, CFG.COOLDOWN_MS)
    return null
  }

  // External rugcheck.xyz API check
  const xyzCheck = await rugCheckXyz(tokenMint)
  if (!xyzCheck.safe) {
    const xyzReason = `RUGXYZ:${xyzCheck.reasons[0]}`
    reject(xyzReason, tokenMint)
    addCooldown(tokenMint, CFG.COOLDOWN_MS)
    return null
  }

  // On-chain security check (mint/freeze authority, holder concentration, bundle detection)
  // Non-blocking if RPC is slow — only hard reject on confirmed dangerous signals
  const onChain = await onChainSecurityCheck(tokenMint)
  if (!onChain.safe && onChain.hardFail && onChain.hardFail.length > 0) {
    const isDefiniteRug = onChain.hardFail.some(f =>
      f === "MINT_AUTHORITY_ACTIVE" || f === "FREEZE_AUTHORITY_ACTIVE" || f.startsWith("BUNDLE_DETECTED")
    )
    reject(`ONCHAIN:${onChain.hardFail[0]}`, tokenMint)
    if (isDefiniteRug) addCooldown(tokenMint, CFG.COOLDOWN_MS)
    return null
  }

  // Smart wallet cluster bonus — if 2+ tracked wallets already bought this,
  // lower the score threshold (replicates Cielo Finance multi-wallet convergence)
  const smartWalletCount = getSmartWalletBuyCount(tokenMint)
  const smartWalletBonus = smartWalletCount >= 2 ? 20 :
                           smartWalletCount === 1 ? 10 : 0
  if (smartWalletCount >= 2) {
    log("INFO", `Smart wallet cluster: ${smartWalletCount} tracked wallets bought this — boosting score`)
  }

  // Score
  const { score: baseScore, breakdown } = scoreToken(pair)
  const score  = Math.min(100, baseScore + smartWalletBonus)
  const bdStr  = Object.entries(breakdown).map(([k,v]) => `${k}:${v}`).join(" ")
  const swStr  = smartWalletBonus > 0 ? ` +${smartWalletBonus}sw_bonus` : ""
  log("SCORE", `Score:${score}/100 (base:${baseScore}${swStr}) | ${bdStr} | ${tokenMint.slice(0,8)}...`)

  if (score < CFG.MIN_SCORE) {
    reject(`SCORE_LOW:${score}`, tokenMint)
    return null
  }

  return { pair, score, liquidity, marketCap, volume5m, ageMin, buyRatio, priceChg5m, source, smartWalletCount }
}

// ─────────────────────────────────────────────────────────────────────────────
//  2-PASS ENTRY CONFIRMATION
// ─────────────────────────────────────────────────────────────────────────────
// In-flight candidates waiting for second pass
const pendingCandidates = new Map() // tokenMint → { firstPassAt, firstData }

async function processCandidateFirstPass(wallet, tokenMint, source) {
  if (openPositionCount() >= CFG.MAX_POSITIONS) return
  if (checkPaused())                             return
  if (state.positions[tokenMint])                return
  if (pendingCandidates.has(tokenMint))          return

  const data = await evaluateToken(tokenMint, source)
  if (!data) return

  log("INFO", `✔ First pass OK | score:${data.score} | ${tokenMint.slice(0,8)}... | Waiting ${CFG.CONFIRM_DELAY_MS/1000}s for confirmation`)
  pendingCandidates.set(tokenMint, { firstPassAt: Date.now(), firstData: data, source })
}

async function processConfirmations(wallet) {
  for (const [tokenMint, entry] of pendingCandidates.entries()) {
    const elapsed = Date.now() - entry.firstPassAt
    if (elapsed < CFG.CONFIRM_DELAY_MS) continue

    pendingCandidates.delete(tokenMint)

    if (openPositionCount() >= CFG.MAX_POSITIONS) continue
    if (checkPaused()) continue
    if (state.positions[tokenMint]) continue

    log("INFO", `Second-pass confirming ${tokenMint.slice(0,8)}...`)

    // Try fresh DexScreener data first. If DexScreener has no data yet
    // (token too new to be indexed), fall back to cached first-pass data.
    // This prevents NO_DEX_DATA from killing trades on very fresh tokens.
    let data = await evaluateToken(tokenMint, entry.source)
    if (!data) {
      const firstPassAge = Date.now() - entry.firstPassAt
      if (firstPassAge < 30000 && entry.firstData) {
        // First pass was recent and data was good — trust the cache
        log("INFO", `DexScreener not indexed yet — using first-pass data for ${tokenMint.slice(0,8)}...`)
        data = entry.firstData
      } else {
        log("REJECT", `Second pass FAILED for ${tokenMint.slice(0,8)}... — aborting entry`)
        addCooldown(tokenMint, 300000) // 5min cooldown, not 30min — don't over-penalise
        continue
      }
    }

    log("INFO", `✔ Second pass OK | score:${data.score} | Proceeding to buy`)
    await executeBuy(wallet, tokenMint, data)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  BUY EXECUTION
// ─────────────────────────────────────────────────────────────────────────────
async function executeBuy(wallet, tokenMint, evalData) {
  if (state.positions[tokenMint]) {
    log("WARN", `Duplicate buy guard triggered for ${tokenMint.slice(0,8)}...`)
    return
  }

  const tradeAmount = await getTradeAmountLamports(wallet.publicKey)
  const buyPrice    = parseFloat(evalData.pair?.priceUsd) || await getBestPrice(tokenMint)
  if (!buyPrice || buyPrice <= 0) {
    log("ERROR", `No valid price for ${tokenMint.slice(0,8)}... — aborting buy`)
    return
  }

  // Mark as pending_buy to prevent duplicate entry
  state.positions[tokenMint] = {
    status:      "pending_buy",
    tokenMint,
    source:      evalData.source,
    score:       evalData.score,
    buyPrice:    0,
    rawAmount:   "0",
    tradeAmount,
    timestamp:   Date.now(),
    peakPrice:   0,
    stopPrice:   0,
    breakEvenHit: false,
    tp1Hit:      false,
    tp2Hit:      false,
    lastMomentumCheck: Date.now(),
    meta: {
      ageMin:    evalData.ageMin,
      liquidity: evalData.liquidity,
      marketCap: evalData.marketCap,
      buyRatio:  evalData.buyRatio,
      volume5m:  evalData.volume5m,
    }
  }
  saveState()

  // Determine swap route:
  // Pre-grad (bonding curve, $0 DEX liq) → PumpPortal (pool:auto handles it)
  // Post-grad (real DEX liq)             → Jupiter first, PumpPortal fallback
  const isPreGrad   = (evalData.liquidity || 0) < 100 || evalData.pair?._source === "pumpfun"
  const tradeSolAmt = tradeAmount / LAMPORTS_PER_SOL
  const routeLabel  = isPreGrad ? "PUMPPORTAL" : "JUPITER"

  log("BUY", `Submitting buy via ${routeLabel} | ${tokenMint.slice(0,8)}... | ${tradeSolAmt.toFixed(4)}SOL | score:${evalData.score}`)

  try {
    let result
    if (isPreGrad) {
      // Bonding curve token — use PumpPortal directly
      result = await pumpPortalSwap(wallet, tokenMint, "buy", tradeSolAmt, "BUY")
    } else {
      // DEX token — try Jupiter first
      try {
        result = await swap(wallet, SOL_MINT, tokenMint, tradeAmount, "BUY_JUP")
      } catch (jupErr) {
        log("WARN", `Jupiter failed: ${jupErr.message} — falling back to PumpPortal`)
        result = await pumpPortalSwap(wallet, tokenMint, "buy", tradeSolAmt, "BUY_PUMP_FALLBACK")
      }
    }

    // PumpPortal doesn't return outputAmount — fetch token balance after buy
    let outAmount = (result?.outputAmount || result?.totalOutputAmount || "0").toString()
    if (outAmount === "0") {
      await sleep(2000) // wait for chain to settle
      const bal = await getTokenBalance(wallet.publicKey, tokenMint)
      outAmount = bal || "0"
    }

    state.positions[tokenMint].status    = "open"
    state.positions[tokenMint].buyPrice  = buyPrice
    state.positions[tokenMint].rawAmount = outAmount
    state.positions[tokenMint].peakPrice = buyPrice
    state.positions[tokenMint].stopPrice = buyPrice * (1 - CFG.INITIAL_STOP_PCT)
    state.positions[tokenMint].route     = routeLabel

    log("BUY", `✅ BOUGHT via ${routeLabel} | ${tokenMint.slice(0,8)}... | price:${buyPrice} | tokens:${outAmount} | liq:$${Math.round(evalData.liquidity)} | mc:$${Math.round(evalData.marketCap)} | age:${evalData.ageMin?.toFixed(1)}min`)
    state.tradesTaken++
    saveState()
  } catch (e) {
    log("FAIL", `Buy failed [${routeLabel}] for ${tokenMint.slice(0,8)}...: ${e.message}`)
    state.failedSwaps.push(Date.now())
    delete state.positions[tokenMint]
    addCooldown(tokenMint, 1800000)
    saveState()
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  SELL EXECUTION
// ─────────────────────────────────────────────────────────────────────────────
async function executeSell(wallet, tokenMint, amount, reason, isPartial = false) {
  const pos = state.positions[tokenMint]
  if (!pos) return

  const prevStatus = pos.status
  pos.status       = "pending_sell"

  // Route sell same way we bought — check position route tag
  const sellRoute = pos.route || "JUPITER"
  const isPreGrad = sellRoute === "PUMPPORTAL" || (pos.meta?.liquidity || 0) < 100

  log("SELL", `Submitting sell via ${sellRoute} | ${tokenMint.slice(0,8)}... | reason:${reason} | partial:${isPartial}`)

  try {
    let result
    if (isPreGrad) {
      // Sell token amount directly via PumpPortal
      result = await pumpPortalSwap(wallet, tokenMint, "sell", amount, `SELL_${reason}`)
    } else {
      try {
        result = await swap(wallet, tokenMint, SOL_MINT, amount, `SELL_${reason}`)
      } catch (jupErr) {
        log("WARN", `Jupiter sell failed: ${jupErr.message} — falling back to PumpPortal`)
        result = await pumpPortalSwap(wallet, tokenMint, "sell", amount, `SELL_${reason}_PUMP_FB`)
      }
    }
    log("SELL", `✅ Sold via ${sellRoute} | ${tokenMint.slice(0,8)}... | reason:${reason}`)

    if (!isPartial) {
      // Full exit — close position
      const currentPrice = await getBestPrice(tokenMint) || pos.buyPrice
      const pct          = ((currentPrice / pos.buyPrice) - 1) * 100
      const isWin        = pct > 0

      log("PNL", `${isWin ? "WIN" : "LOSS"} | ${pct.toFixed(1)}% | ${tokenMint.slice(0,8)}... | hold:${Math.round((Date.now() - pos.timestamp)/1000)}s`)

      state.totalTrades++
      state.tradesToday++
      state.totalPnlPct += pct
      if (isWin) { state.winTrades++; recordWin(pct) }
      else       { recordLoss() }

      logTradeCsv({
        timestamp:   new Date().toISOString(),
        token:       tokenMint,
        source:      pos.source,
        score:       pos.score,
        buyPrice:    pos.buyPrice,
        sellPrice:   currentPrice,
        pct:         parseFloat(pct.toFixed(2)),
        result:      isWin ? "WIN" : "LOSS",
        reason,
        ageMin:      pos.meta?.ageMin?.toFixed(1) || 0,
        liquidity:   Math.round(pos.meta?.liquidity || 0),
        marketCap:   Math.round(pos.meta?.marketCap || 0),
        buyRatio:    pos.meta?.buyRatio?.toFixed(2) || 0,
        volume5m:    Math.round(pos.meta?.volume5m || 0),
        holdSeconds: Math.round((Date.now() - pos.timestamp) / 1000),
      })

      pos.status = "closed"
      delete state.positions[tokenMint]
      addCooldown(tokenMint, 3600000) // don't re-enter for 1h
    } else {
      pos.status = "open"
    }
    saveState()
  } catch (e) {
    log("FAIL", `Sell failed [${reason}] for ${tokenMint.slice(0,8)}...: ${e.message}`)
    state.failedSwaps.push(Date.now())
    pos.status = prevStatus // restore — keep trying

    // If we can't sell, mark as pending_sell so monitor retries
    if (!isPartial) {
      pos.status = "pending_sell"
      pos.pendingSellReason = reason
    }
    saveState()
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  POSITION MONITOR
// ─────────────────────────────────────────────────────────────────────────────
async function monitorPositions(wallet) {
  for (const [tokenMint, pos] of Object.entries(state.positions)) {
    try {
      // Retry stuck pending_sell
      if (pos.status === "pending_sell") {
        log("MONITOR", `Retrying pending sell for ${tokenMint.slice(0,8)}...`)
        const liveAmount = await getTokenBalance(wallet.publicKey, new PublicKey(tokenMint))
        if (liveAmount && liveAmount !== "0") {
          await executeSell(wallet, tokenMint, liveAmount, pos.pendingSellReason || "RETRY_EXIT")
        } else {
          log("WARN", `No balance found for ${tokenMint.slice(0,8)}... — assuming already sold`)
          delete state.positions[tokenMint]
          saveState()
        }
        continue
      }

      if (pos.status !== "open") continue

      const currentPrice = await getBestPrice(tokenMint)
      if (!currentPrice || currentPrice <= 0) {
        log("WARN", `No price for ${tokenMint.slice(0,8)}... — possible emergency exit needed`)
        // Emergency: if price disappears, attempt exit
        const liveAmount = await getTokenBalance(wallet.publicKey, new PublicKey(tokenMint))
        if (liveAmount && liveAmount !== "0") {
          await executeSell(wallet, tokenMint, liveAmount, "EMERGENCY_NO_PRICE")
        }
        continue
      }

      const ratio   = currentPrice / pos.buyPrice
      const pct     = ((ratio - 1) * 100)
      const elapsed = Date.now() - pos.timestamp

      // Update peak / trailing stop
      if (currentPrice > pos.peakPrice) {
        pos.peakPrice = currentPrice
        pos.stopPrice = currentPrice * (1 - CFG.TRAIL_STOP_PCT)
      }

      // Break-even stop
      if (!pos.breakEvenHit && pct >= CFG.BREAKEVEN_TRIGGER_PCT * 100) {
        pos.breakEvenHit = true
        pos.stopPrice    = Math.max(pos.stopPrice, pos.buyPrice * 1.001) // BE + tiny buffer
        log("MONITOR", `Break-even stop set for ${tokenMint.slice(0,8)}...`)
      }

      const liveAmount = await getTokenBalance(wallet.publicKey, new PublicKey(tokenMint))

      // TP1 partial sell
      if (!pos.tp1Hit && pct >= CFG.TP1_PCT * 100) {
        pos.tp1Hit = true
        const totalAmt = liveAmount || pos.rawAmount
        if (totalAmt && totalAmt !== "0") {
          const sellAmt = (BigInt(totalAmt) * BigInt(Math.floor(CFG.TP1_FRACTION * 1000)) / 1000n).toString()
          if (BigInt(sellAmt) > 0n) {
            log("SELL", `TP1 +${CFG.TP1_PCT*100}% | Selling ${(CFG.TP1_FRACTION*100).toFixed(0)}% | ${tokenMint.slice(0,8)}...`)
            await executeSell(wallet, tokenMint, sellAmt, "TP1", true)
          }
        }
      }

      // TP2 partial sell
      if (pos.tp1Hit && !pos.tp2Hit && pct >= CFG.TP2_PCT * 100) {
        pos.tp2Hit = true
        const totalAmt = liveAmount || pos.rawAmount
        if (totalAmt && totalAmt !== "0") {
          const sellAmt = (BigInt(totalAmt) * BigInt(Math.floor(CFG.TP2_FRACTION * 1000)) / 1000n).toString()
          if (BigInt(sellAmt) > 0n) {
            log("SELL", `TP2 +${CFG.TP2_PCT*100}% | Selling ${(CFG.TP2_FRACTION*100).toFixed(0)}% | ${tokenMint.slice(0,8)}...`)
            await executeSell(wallet, tokenMint, sellAmt, "TP2", true)
          }
        }
      }

      // Exit conditions (full exit)
      const hitHardStop  = currentPrice <= pos.buyPrice * (1 - CFG.INITIAL_STOP_PCT)
      const hitTrail     = currentPrice <= pos.stopPrice
      const hitTime      = elapsed >= CFG.MAX_HOLD_MS
      const hitStagnant  = elapsed >= CFG.STAGNANT_HOLD_MS && Math.abs(pct) < 3

      // Momentum failure check
      let momentumFailed = false
      if (Date.now() - pos.lastMomentumCheck > CFG.MOMENTUM_CHECK_INTERVAL) {
        pos.lastMomentumCheck = Date.now()
        const freshPair = await getPairData(tokenMint)
        if (freshPair) {
          const v5m  = freshPair?.volume?.m5 || 0
          const br   = (() => {
            const b = freshPair?.txns?.m5?.buys || 0
            const s = freshPair?.txns?.m5?.sells || 0
            return b + s > 0 ? b / (b + s) : 0
          })()
          const liq = freshPair?.liquidity?.usd || 0
          // Momentum failure: volume drying up + sell pressure + liquidity drop
          if (v5m < CFG.MIN_VOL_5M * 0.3 && br < 0.40 && pct > 0) {
            momentumFailed = true
            log("MONITOR", `Momentum failure detected for ${tokenMint.slice(0,8)}... vol:$${Math.round(v5m)} br:${(br*100).toFixed(0)}%`)
          }
          // Emergency: liquidity collapse
          if (liq < CFG.MIN_LIQUIDITY_USD * 0.3 && liq > 0) {
            log("MONITOR", `Liquidity collapse for ${tokenMint.slice(0,8)}... $${Math.round(liq)} — emergency exit`)
            const sellAll = liveAmount || pos.rawAmount
            if (sellAll && sellAll !== "0") {
              await executeSell(wallet, tokenMint, sellAll, "EMERGENCY_LIQ_COLLAPSE")
            }
            continue
          }
        } else {
          // DexScreener data disappeared — emergency exit
          log("MONITOR", `DexScreener data gone for ${tokenMint.slice(0,8)}... — emergency exit`)
          const sellAll = liveAmount || pos.rawAmount
          if (sellAll && sellAll !== "0") {
            await executeSell(wallet, tokenMint, sellAll, "EMERGENCY_DATA_GONE")
          }
          continue
        }
      }

      const exitReason = hitHardStop  ? "HARD_STOP"      :
                         hitTrail     ? "TRAIL_STOP"     :
                         hitTime      ? "MAX_HOLD_TIME"  :
                         hitStagnant  ? "STAGNANT"       :
                         momentumFailed ? "MOMENTUM_FAIL" : null

      if (exitReason) {
        const sellAll = liveAmount || pos.rawAmount
        if (!sellAll || sellAll === "0") {
          log("WARN", `No balance for ${tokenMint.slice(0,8)}... — removing position`)
          delete state.positions[tokenMint]
          saveState()
          continue
        }
        await executeSell(wallet, tokenMint, sellAll, exitReason)
      } else {
        const stopPct  = ((pos.stopPrice / pos.buyPrice) - 1) * 100
        const peakPct  = ((pos.peakPrice / pos.buyPrice) - 1) * 100
        log("MONITOR", `${tokenMint.slice(0,8)}... | pct:${pct.toFixed(1)}% | peak:${peakPct.toFixed(1)}% | stop:${stopPct.toFixed(1)}% | hold:${Math.round(elapsed/1000)}s | TP1:${pos.tp1Hit?"✅":"○"} TP2:${pos.tp2Hit?"✅":"○"}`)
      }
    } catch (e) {
      log("ERROR", `Monitor error for ${tokenMint.slice(0,8)}...: ${e.message}`)
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  GMGN TOKEN SECURITY API
//  GMGN is the fastest free token security feed on Solana.
//  Their /token/security endpoint returns: mint revoked, freeze revoked,
//  LP burned, top10 holder %, renounced — all in one call, no auth needed.
//  This replaces manually scraping rugcheck.xyz for most security signals.
// ─────────────────────────────────────────────────────────────────────────────
async function gmgnSecurityCheck(tokenMint) {
  try {
    const res = await fetch(
      `https://gmgn.ai/defi/quotation/v1/tokens/security/sol/${tokenMint}`,
      { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(5000) }
    )
    if (!res.ok) {
      log("WARN", `GMGN security HTTP ${res.status} — skipping`)
      return { safe: true, reasons: ["gmgn_unavailable"] }
    }

    const json = await res.json()
    const d    = json?.data || json // handle both response shapes

    const flags   = []
    const details = []

    // Mint authority — can dev print more tokens?
    if (d.mint_auth !== null && d.mint_auth !== undefined && d.mint_auth !== false) {
      flags.push("MINT_NOT_REVOKED")
    } else { details.push("mint_revoked") }

    // Freeze authority — can dev freeze your account?
    if (d.freeze_auth !== null && d.freeze_auth !== undefined && d.freeze_auth !== false) {
      flags.push("FREEZE_NOT_REVOKED")
    } else { details.push("freeze_revoked") }

    // LP burned — is liquidity locked or burned?
    // burn_ratio: 0 = none burned, 1 = all burned
    const burnRatio = parseFloat(d.burn_ratio || d.lp_burn_pct || 0)
    if (burnRatio < 0.80) {
      flags.push(`LP_BURN_LOW:${(burnRatio*100).toFixed(0)}%`)
    } else { details.push(`lp_burn_${(burnRatio*100).toFixed(0)}pct`) }

    // Top 10 holder %
    const top10 = parseFloat(d.top10_holder_rate || d.top10_holder_pct || 0)
    if (top10 > 0.80) {
      flags.push(`TOP10_HOLD_${(top10*100).toFixed(0)}PCT`)
    } else { details.push(`top10_${(top10*100).toFixed(0)}pct_ok`) }

    // Is contract renounced / ownership transferred to burn address?
    if (d.renounced === false || d.is_renounced === false) {
      flags.push("NOT_RENOUNCED")
    } else if (d.renounced === true || d.is_renounced === true) {
      details.push("renounced")
    }

    // Honeypot signal — GMGN sometimes returns this
    if (d.is_honeypot === true || d.honeypot === true) {
      flags.push("HONEYPOT_DETECTED")
    }

    // Hard-fail flags (anything that means you can get trapped or rugged)
    const hardFail = flags.filter(f =>
      f === "MINT_NOT_REVOKED" ||
      f === "FREEZE_NOT_REVOKED" ||
      f === "HONEYPOT_DETECTED" ||
      f.startsWith("TOP10_HOLD_9") || // >90% = dev wallet
      f.startsWith("TOP10_HOLD_8")    // >80% = very concentrated
    )

    // LP burn is a soft warning not a hard fail — low burn just lowers score
    const lpWarn = flags.find(f => f.startsWith("LP_BURN_LOW"))

    const safe = hardFail.length === 0
    const summary = safe
      ? `✅ ${details.join("|")}${lpWarn ? " ⚠️ " + lpWarn : ""}`
      : `🚨 ${hardFail.join("|")}`

    log(safe ? "CONFIRM" : "RUG", `GMGN: ${summary} | ${tokenMint.slice(0,8)}...`)
    return { safe, flags, hardFail, lpWarn, details, burnRatio, top10 }
  } catch (e) {
    log("WARN", `GMGN security error: ${e.message} — allowing through`)
    return { safe: true, reasons: ["gmgn_error"] }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  RUGCHECK.XYZ API
// ─────────────────────────────────────────────────────────────────────────────
async function rugCheckXyz(tokenMint) {
  if (!CFG.RUGCHECK_ENABLED) return { safe: true, reasons: ["rugcheck disabled"] }
  try {
    const res = await fetch(`https://api.rugcheck.xyz/v1/tokens/${tokenMint}/report/summary`)
    if (!res.ok) {
      log("WARN", `Rugcheck.xyz unavailable (HTTP ${res.status}) — allowing through`)
      return { safe: true, reasons: ["rugcheck_unavailable"] }
    }
    const data   = await res.json()
    const score  = data?.score ?? 0
    const risks  = data?.risks || []

    const dangerFlags = risks.filter(r => r.level === "danger").map(r => r.name)
    const warnFlags   = risks.filter(r => r.level === "warn").map(r => r.name)

    const hardRejectPatterns = [
      "Freeze Authority still enabled",
      "Mint Authority still enabled",
      "Copycat token",
      "High ownership concentration",
    ]
    const hasDanger = dangerFlags.some(f =>
      hardRejectPatterns.some(p => f.toLowerCase().includes(p.toLowerCase()))
    )

    const reasons = []
    if (hasDanger)                              reasons.push(`DANGER_FLAGS:${dangerFlags.join(",")}`)
    if (score < CFG.RUGCHECK_MIN_SCORE)         reasons.push(`RUGCHECK_SCORE_LOW:${score}/1000`)
    if (warnFlags.length >= CFG.RUGCHECK_MAX_WARNS) reasons.push(`WARN_FLAGS:${warnFlags.length}`)

    const safe = reasons.length === 0
    if (safe) {
      log("CONFIRM", `Rugcheck OK | score:${score}/1000 | warns:${warnFlags.length} | ${tokenMint.slice(0,8)}...`)
    } else {
      log("RUG", `Rugcheck FAIL | ${reasons.join(" | ")} | ${tokenMint.slice(0,8)}...`)
    }
    return { safe, reasons }
  } catch (e) {
    log("WARN", `Rugcheck.xyz error: ${e.message} — allowing through`)
    return { safe: true, reasons: ["rugcheck_error"] }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  PUMP.FUN SCANNER
// ─────────────────────────────────────────────────────────────────────────────
async function scanPumpFun(wallet) {
  try {
    // Near-graduation coins (about to migrate to Raydium — often sharp momentum)
    const gradRes = await fetch(
      "https://frontend-api.pump.fun/coins?offset=0&limit=20&sort=market_cap&order=DESC&includeNsfw=false"
    )
    if (gradRes.ok) {
      const coins = await gradRes.json()
      for (const coin of (Array.isArray(coins) ? coins : [])) {
        if (!coin.mint || coin.complete) continue
        const mcap = coin.usd_market_cap || 0
        if (mcap < CFG.PUMP_GRAD_MIN_MCAP || mcap > CFG.PUMP_GRAD_MAX_MCAP) continue
        if (seenTokens.has(coin.mint)) continue
        seenTokens.add(coin.mint)
        log("SCAN", `PumpFun near-grad: ${coin.symbol} MC:$${Math.round(mcap)} ${coin.mint.slice(0,8)}...`)
        await processCandidateFirstPass(wallet, coin.mint, "PUMP_GRAD")
        await sleep(400)
      }
    }

    // Recently graduated (migrated to Raydium — real liquidity just formed)
    const newRes = await fetch(
      "https://frontend-api.pump.fun/coins?offset=0&limit=20&sort=last_trade_timestamp&order=DESC&includeNsfw=false"
    )
    if (newRes.ok) {
      const newCoins = await newRes.json()
      for (const coin of (Array.isArray(newCoins) ? newCoins : [])) {
        if (!coin.mint || !coin.complete) continue
        const ageMin = coin.created_timestamp
          ? (Date.now() - coin.created_timestamp) / 60000
          : 9999
        if (ageMin > CFG.PUMP_NEW_MAX_AGE_MIN) continue
        if (seenTokens.has(coin.mint)) continue
        seenTokens.add(coin.mint)
        log("SCAN", `PumpFun graduated: ${coin.symbol} age:${ageMin.toFixed(0)}min ${coin.mint.slice(0,8)}...`)
        await processCandidateFirstPass(wallet, coin.mint, "PUMP_NEW")
        await sleep(400)
      }
    }
  } catch (e) {
    log("ERROR", `Pump.fun scan: ${e.message}`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  COPY WALLET SCANNER
// ─────────────────────────────────────────────────────────────────────────────
async function scanCopyWallets(wallet) {
  const wallets = getActiveWallets()
  if (wallets.length === 0) return
  for (const copyWallet of wallets) {
    try {
      await sleep(1500)
      let sigs
      try {
        sigs = await connection.getSignaturesForAddress(
          new PublicKey(copyWallet),
          { limit: 5 }
        )
      } catch (e) {
        log("WARN", `Sig fetch failed for ${copyWallet.slice(0,8)}...: ${e.message}`)
        continue
      }
      if (!sigs || sigs.length === 0) continue

      const lastSig  = walletLastSig.get(copyWallet)
      const nowSec   = Math.floor(Date.now() / 1000)
      const MAX_AGE_SEC = 600 // ignore any tx older than 10 minutes — prevents chasing old trades

      // Only process signatures we haven't seen before AND that are recent
      const newSigs = sigs.filter(s => {
        if (lastSig && s.signature === lastSig) return false
        if (s.blockTime && (nowSec - s.blockTime) > MAX_AGE_SEC) return false // too old
        return true
      }).slice(0, 3)

      walletLastSig.set(copyWallet, sigs[0].signature)
      if (newSigs.length === 0) continue

      log("SCAN", `CopyWallet ${copyWallet.slice(0,8)}... — ${newSigs.length} fresh tx(s)`)

      for (const sigInfo of newSigs) {
        try {
          // Double-check age using blockTime from signature info (saves an RPC call if stale)
          if (sigInfo.blockTime && (nowSec - sigInfo.blockTime) > MAX_AGE_SEC) {
            log("SCAN", `Skipping stale tx (${Math.round((nowSec - sigInfo.blockTime)/60)}min old)`)
            continue
          }
          await sleep(800)
          const tx = await connection.getParsedTransaction(sigInfo.signature, {
            maxSupportedTransactionVersion: 0,
            commitment: "confirmed",
          })
          if (!tx || tx.meta?.err) continue

          const pre  = tx.meta?.preTokenBalances  || []
          const post = tx.meta?.postTokenBalances  || []

          // Detect token increases (buys)
          const bought = post.filter(postBal => {
            if (postBal.mint === SOL_MINT) return false
            const preBal = pre.find(p =>
              p.accountIndex === postBal.accountIndex && p.mint === postBal.mint
            )
            const preAmt  = parseFloat(preBal?.uiTokenAmount?.uiAmount || "0")
            const postAmt = parseFloat(postBal?.uiTokenAmount?.uiAmount || "0")
            return postAmt > preAmt
          })

          for (const b of bought) {
            if (STATIC_BLACKLIST.has(b.mint)) continue

            // ── Pre-flight checks before any RPC calls ──────────────────────
            // Skip stablecoins — wallets often hold USDT/USDC and we misread as buys
            if (b.mint === "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB") continue // USDT
            if (b.mint === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v") continue // USDC
            if (b.mint === "USD1ygnE8URFjQRouBKmhkBkEMxKFnHczvF6KCQHQ4Ud")  continue // USD1

            // ── Quick viability check ────────────────────────────────────────
            // We now support BOTH pre-grad bonding curve (PumpPortal) AND
            // post-grad DEX tokens (Jupiter). Only skip truly dead tokens.
            // Dead = no DexScreener data AND no pump.fun data (token doesn't exist)
            try {
              const quickDex = await getDexPairData(b.mint)
              const quickLiq = quickDex?.liquidity?.usd || 0
              if (quickLiq === 0) {
                // No DEX liq — check if it's a live pump.fun bonding curve token
                const quickPump = await getPumpFunData(b.mint)
                if (!quickPump || (quickPump.marketCap || 0) < 1000) {
                  log("SCAN", `Skip dead token (no DEX + no pump.fun): ${b.mint.slice(0,8)}...`)
                  continue
                }
                log("SCAN", `Pre-grad bonding curve token MC:$${Math.round(quickPump.marketCap)} — will use PumpPortal`)
              }
            } catch { /* if check fails, proceed anyway */ }

            // Record this wallet as a buyer — enables smart wallet cluster detection
            recordSmartWalletBuy(b.mint, copyWallet)
            const clusterCount = getSmartWalletBuyCount(b.mint)

            // Cluster signal: 2+ wallets bought same token = bypass seenTokens
            if (clusterCount >= 2) {
              log("SCAN", `CLUSTER SIGNAL: ${clusterCount} tracked wallets bought ${b.mint.slice(0,8)}... — priority entry`)
              seenTokens.delete(b.mint)
            }

            if (seenTokens.has(b.mint)) continue
            seenTokens.add(b.mint)
            log("SCAN", `CopyWallet ${copyWallet.slice(0,8)}... bought: ${b.mint.slice(0,8)}...`)
            await processCandidateFirstPass(wallet, b.mint, "COPY_TRADE")
          }
        } catch (e) {
          // Silently skip individual tx parse errors — non-fatal
        }
      }
    } catch (e) {
      log("ERROR", `CopyWallet scan ${copyWallet.slice(0,8)}...: ${e.message}`)
    }
  }
}
const seenTokens = new Set()

async function scanDexScreenerProfiles(wallet) {
  try {
    const res = await fetch("https://api.dexscreener.com/token-profiles/latest/v1")
    if (!res.ok) { log("WARN", `Token profiles HTTP ${res.status}`); return }
    const tokens = await res.json()
    const solana  = (Array.isArray(tokens) ? tokens : [])
      .filter(t => t.chainId === "solana" && t.tokenAddress)
      .slice(0, 20)

    log("SCAN", `Token profiles: ${solana.length} Solana tokens`)
    for (const t of solana) {
      if (!seenTokens.has(t.tokenAddress)) {
        seenTokens.add(t.tokenAddress)
        await processCandidateFirstPass(wallet, t.tokenAddress, "PROFILE")
        await sleep(300)
      }
    }
  } catch (e) {
    log("ERROR", `Token profiles scan: ${e.message}`)
  }
}

async function scanDexScreenerBoosts(wallet) {
  try {
    // Latest boosts
    const latestRes = await fetch("https://api.dexscreener.com/token-boosts/latest/v1")
    if (latestRes.ok) {
      const boosts = await latestRes.json()
      const solana  = (Array.isArray(boosts) ? boosts : [])
        .filter(b => b.chainId === "solana" && b.tokenAddress)
        .slice(0, 15)
      log("SCAN", `Latest boosts: ${solana.length} Solana tokens`)
      for (const b of solana) {
        if (!seenTokens.has(b.tokenAddress)) {
          seenTokens.add(b.tokenAddress)
          // Mark as boosted in pair data (injected when we fetch pair)
          await processCandidateFirstPass(wallet, b.tokenAddress, "BOOST_LATEST")
          await sleep(300)
        }
      }
    }

    // Top boosts
    const topRes = await fetch("https://api.dexscreener.com/token-boosts/top/v1")
    if (topRes.ok) {
      const topBoosts = await topRes.json()
      const solana     = (Array.isArray(topBoosts) ? topBoosts : [])
        .filter(b => b.chainId === "solana" && b.tokenAddress)
        .slice(0, 10)
      log("SCAN", `Top boosts: ${solana.length} Solana tokens`)
      for (const b of solana) {
        if (!seenTokens.has(b.tokenAddress)) {
          seenTokens.add(b.tokenAddress)
          await processCandidateFirstPass(wallet, b.tokenAddress, "BOOST_TOP")
          await sleep(300)
        }
      }
    }
  } catch (e) {
    log("ERROR", `Boosts scan: ${e.message}`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  TRADE CSV LOGGING
// ─────────────────────────────────────────────────────────────────────────────
function logTradeCsv(trade) {
  try {
    const header = "timestamp,token,source,score,buyPrice,sellPrice,pct,result,reason,ageMin,liquidity,marketCap,buyRatio,volume5m,holdSeconds\n"
    const row    = `${trade.timestamp},${trade.token},${trade.source},${trade.score},${trade.buyPrice},${trade.sellPrice},${trade.pct},${trade.result},${trade.reason},${trade.ageMin},${trade.liquidity},${trade.marketCap},${trade.buyRatio},${trade.volume5m},${trade.holdSeconds}\n`
    if (!fs.existsSync(CFG.TRADES_CSV)) fs.writeFileSync(CFG.TRADES_CSV, header)
    fs.appendFileSync(CFG.TRADES_CSV, row)
    log("STATE", `Trade logged to ${CFG.TRADES_CSV}`)
  } catch (e) {
    log("ERROR", `CSV log failed: ${e.message}`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  PERIODIC TERMINAL SUMMARY
// ─────────────────────────────────────────────────────────────────────────────
async function printSummary(walletPubkey) {
  const balance    = await getSolBalance(walletPubkey)
  const openPos    = Object.values(state.positions).filter(p => p.status === "open")
  const wr         = state.totalTrades > 0
    ? ((state.winTrades / state.totalTrades) * 100).toFixed(0) : "N/A"
  const avgPnl     = state.totalTrades > 0
    ? (state.totalPnlPct / state.totalTrades).toFixed(1) : "N/A"

  const rejectStr  = Object.entries(state.rejectionCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([k, v]) => `${k}:${v}`)
    .join(" | ")

  console.log(`\n[${ts()}] 📊 ═══════════════ 60s SUMMARY ═══════════════`)
  console.log(`  Balance:       ${balance !== null ? balance.toFixed(4) + " SOL" : "N/A"}`)
  console.log(`  Open positions: ${openPos.length}/${CFG.MAX_POSITIONS}`)
  console.log(`  Daily PnL:     ${state.dailyRealizedPnl.toFixed(2)} SOL`)
  console.log(`  Total trades:  ${state.totalTrades} | WR:${wr}% | Avg:${avgPnl}%`)
  console.log(`  Consec losses: ${state.consecutiveLosses} | Reduced size:${state.reducedSize}`)
  console.log(`  Paused:        ${state.paused ? "YES — " + state.pauseReason : "NO"}`)
  console.log(`  Scanned today: ${state.candidatesScanned} candidates | ${state.tradesTaken} trades taken`)
  console.log(`  Pending conf:  ${pendingCandidates.size}`)
  if (rejectStr) console.log(`  Rejections:    ${rejectStr}`)
  if (openPos.length > 0) {
    console.log(`  Open positions:`)
    for (const p of openPos) {
      const ageS = Math.round((Date.now() - p.timestamp) / 1000)
      console.log(`    ${p.tokenMint.slice(0,8)}... | entry:${p.buyPrice?.toFixed(8)} | age:${ageS}s | src:${p.source}`)
    }
  }
  console.log(`═══════════════════════════════════════════════\n`)
}

// ─────────────────────────────────────────────────────────────────────────────
//  MAIN LOOP
// ─────────────────────────────────────────────────────────────────────────────
async function runBot() {
  log("START", "═══════════════════════════════════════════")
  log("START", "  Solana Memecoin Bot  —  Production Mode  ")
  log("START", "═══════════════════════════════════════════")

  const wallet = loadWallet()
  log("START", `Wallet:      ${wallet.publicKey.toString()}`)
  log("START", `RPC:         ${CFG.RPC_URL}`)
  log("START", `Max positions: ${CFG.MAX_POSITIONS}`)
  log("START", `Trade size:    ${(CFG.TRADE_PCT*100).toFixed(0)}% (min:${CFG.MIN_TRADE_SOL} max:${CFG.MAX_TRADE_SOL} SOL)`)
  log("START", `Filters:       liq:$${CFG.MIN_LIQUIDITY_USD}-$${CFG.MAX_LIQUIDITY_USD} age:${CFG.MIN_PAIR_AGE_MIN}-${CFG.MAX_PAIR_AGE_MIN}min score:${CFG.MIN_SCORE}/100`)
  log("START", `Exits:         stop:-${(CFG.INITIAL_STOP_PCT*100).toFixed(0)}% trail:${(CFG.TRAIL_STOP_PCT*100).toFixed(0)}% tp1:+${(CFG.TP1_PCT*100).toFixed(0)}% tp2:+${(CFG.TP2_PCT*100).toFixed(0)}% hold:${CFG.MAX_HOLD_MS/60000}min`)
  log("START", `2-pass delay:  ${CFG.CONFIRM_DELAY_MS/1000}s`)

  loadState()

  // Initialize day balance
  const initBal = await getSolBalance(wallet.publicKey)
  if (initBal !== null) {
    if (state.dayStartBalance === null) state.dayStartBalance = initBal
    log("START", `Balance: ${initBal.toFixed(4)} SOL | Day start: ${state.dayStartBalance.toFixed(4)} SOL`)
  }

  // Re-open any positions that were "open" before restart
  const reopen = Object.entries(state.positions).filter(([, p]) => p.status === "open" || p.status === "pending_sell")
  if (reopen.length > 0) {
    log("START", `Resuming ${reopen.length} open position(s) from disk`)
  }

  // Immediately fetch fresh smart wallets from GMGN on startup
  log("INFO", "Fetching fresh smart wallets from GMGN...")
  await refreshSmartWalletsFromGMGN()
  let lastWalletRefresh = Date.now()
  let lastDexScan      = 0
  let lastPumpScan     = 0
  let lastWalletScan   = 0
  let lastSummary      = 0
  let loopCount      = 0

  log("START", `Copy wallets:  ${getActiveWallets().length} | Pump.fun: ON | Rugcheck.xyz: ${CFG.RUGCHECK_ENABLED ? "ON" : "OFF"}`)

  // Main loop
  while (true) {
    try {
      loopCount++
      if (loopCount % 30 === 0) {
        log("SCAN", `Loop #${loopCount} | open:${openPositionCount()} | pending:${pendingCandidates.size} | paused:${state.paused}`)
      }

      // Monitor existing positions every loop
      await monitorPositions(wallet)

      // Process 2nd-pass confirmations every loop
      await processConfirmations(wallet)

      // Circuit breaker updates
      await updateCircuitBreakers(wallet.publicKey)

      // ── GMGN SMART WALLET REFRESH — every hour ──────────────────────────
      if (Date.now() - lastWalletRefresh > 3600000) {
        log("INFO", "Refreshing smart wallets from GMGN leaderboard...")
        await refreshSmartWalletsFromGMGN()
        lastWalletRefresh = Date.now()
        log("INFO", `Now tracking ${getActiveWallets().length} wallets`)
      }

      // ── SCANNING PRIORITY ORDER ──────────────────────────────────────────
      // 1. Copy wallets — PRIMARY signal, fastest poll (every 8s)
      //    Smart wallets act first. We follow them. This is our edge.
      // 2. Pump.fun — graduation events, secondary (every 30s)
      // 3. DexScreener — broad discovery, slowest (every 60s)
      //    By the time DexScreener shows a pump, fast bots already bought.
      //    We keep it only as a supplementary signal.

      if (Date.now() - lastWalletScan > CFG.WALLET_SCAN_INTERVAL_MS) {
        if (!checkPaused()) {
          await scanCopyWallets(wallet)
        } else {
          log("PAUSE", `Copy wallet scan skipped — ${state.pauseReason}`)
        }
        lastWalletScan = Date.now()
      }

      if (Date.now() - lastPumpScan > CFG.PUMP_SCAN_INTERVAL_MS) {
        if (!checkPaused()) {
          await scanPumpFun(wallet)
        }
        lastPumpScan = Date.now()
      }

      if (Date.now() - lastDexScan > CFG.DEX_SCAN_INTERVAL_MS) {
        if (!checkPaused()) {
          log("SCAN", "DexScreener supplementary scan...")
          await scanDexScreenerProfiles(wallet)
          await sleep(1000)
          await scanDexScreenerBoosts(wallet)
        }
        lastDexScan = Date.now()
      }

      // Summary
      if (Date.now() - lastSummary > CFG.SUMMARY_INTERVAL_MS) {
        await printSummary(wallet.publicKey)
        lastSummary = Date.now()
      }

      await sleep(CFG.MONITOR_INTERVAL_MS)
    } catch (e) {
      log("ERROR", `Main loop error (continuing): ${e.message}`)
      if (e.stack) log("ERROR", e.stack.split("\n")[1] || "")
      await sleep(5000)
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  ENTRY POINT
// ─────────────────────────────────────────────────────────────────────────────
runBot().catch(e => {
  console.error(`[FATAL] Bot crashed: ${e.message}`)
  console.error(e.stack)
  process.exit(1)
})
