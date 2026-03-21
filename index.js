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
  TRADE_PCT:             parseFloat(process.env.TRADE_PCT    || "0.05"),  // 5% of balance per trade
  MIN_TRADE_SOL:         parseFloat(process.env.MIN_TRADE    || "0.02"),  // hard min
  MAX_TRADE_SOL:         parseFloat(process.env.MAX_TRADE    || "0.25"),  // hard max
  MAX_POSITIONS:         parseInt(  process.env.MAX_POS      || "1"),     // 1 open position at a time

  // Safety filters
  MIN_LIQUIDITY_USD:     parseFloat(process.env.MIN_LIQ      || "5000"),
  MAX_LIQUIDITY_USD:     parseFloat(process.env.MAX_LIQ      || "500000"),
  MIN_MCAP_USD:          parseFloat(process.env.MIN_MCAP     || "10000"),
  MAX_MCAP_USD:          parseFloat(process.env.MAX_MCAP     || "10000000"),
  MIN_PAIR_AGE_MIN:      parseFloat(process.env.MIN_AGE      || "5"),
  MAX_PAIR_AGE_MIN:      parseFloat(process.env.MAX_AGE      || "120"),
  MIN_VOL_5M:            parseFloat(process.env.MIN_VOL5M    || "1000"),
  MIN_TXNS_5M:           parseInt(  process.env.MIN_TXNS5M   || "10"),
  MIN_BUY_RATIO:         parseFloat(process.env.MIN_BR       || "0.55"),
  MIN_PRICE_CHANGE_5M:   parseFloat(process.env.MIN_PC5M     || "2"),
  MAX_1H_NEGATIVE:       parseFloat(process.env.MAX_1H_NEG   || "-30"),
  MIN_LIQ_MCAP_RATIO:    parseFloat(process.env.MIN_LM_RATIO || "0.02"),
  MIN_SCORE:             parseInt(  process.env.MIN_SCORE    || "45"),    // out of 100

  // Exit thresholds
  INITIAL_STOP_PCT:      parseFloat(process.env.STOP_PCT     || "0.12"),  // -12%
  BREAKEVEN_TRIGGER_PCT: parseFloat(process.env.BE_PCT       || "0.10"),  // +10% → move stop to BE
  TP1_PCT:               parseFloat(process.env.TP1          || "0.20"),  // +20% → partial sell
  TP1_FRACTION:          parseFloat(process.env.TP1_FRAC     || "0.40"),  // sell 40%
  TP2_PCT:               parseFloat(process.env.TP2          || "0.40"),  // +40% → partial sell
  TP2_FRACTION:          parseFloat(process.env.TP2_FRAC     || "0.35"),  // sell 35%
  TRAIL_STOP_PCT:        parseFloat(process.env.TRAIL_PCT    || "0.10"),  // 10% trailing
  MAX_HOLD_MS:           parseInt(  process.env.MAX_HOLD     || "900000"),// 15 min
  STAGNANT_HOLD_MS:      parseInt(  process.env.STAGNANT_MS  || "300000"),// 5 min with no progress
  MOMENTUM_CHECK_INTERVAL: 60000,                                          // check momentum every 60s

  // Circuit breakers
  DAILY_LOSS_LIMIT_PCT:  parseFloat(process.env.DAILY_LOSS   || "0.20"),  // -20% day halt
  CONSEC_LOSSES_HALVE:   parseInt(  process.env.CONSEC_L     || "3"),     // 3 losses → half size
  MAX_FAILED_SWAPS:      parseInt(  process.env.MAX_FAIL     || "5"),     // 5 failed swaps → pause
  FAILED_SWAP_WINDOW_MS: 3600000,                                          // 1h window

  // 2-pass entry delay
  CONFIRM_DELAY_MS:      parseInt(  process.env.CONFIRM_DELAY || "15000"), // 15s second check

  // Scan intervals
  DEX_SCAN_INTERVAL_MS:    parseInt(process.env.DEX_INTERVAL    || "20000"),
  PUMP_SCAN_INTERVAL_MS:   parseInt(process.env.PUMP_INTERVAL   || "20000"),
  WALLET_SCAN_INTERVAL_MS: parseInt(process.env.WALLET_INTERVAL || "25000"),
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

// Fallback hardcoded list — override with COPY_WALLETS env var or clear this array
const COPY_WALLETS_DEFAULT = [
  "GdRSPexhxbQz5H2zFQrNN2BAZUqEjAULBigTPvQ6oDMP",
  "9Tee3dgA4agNnvVATUhakWzngwYrGzQWrxyafGGKpYi7",
  "FxwArENkKBx4QyfoEU1vkBnDzMfZV9Z1b8GBzpT9zb5k",
  "HiSo5kykqDPs3EG14Fk9QY4B5RvkuEs8oJTiqPX3EDAn",
  "4BdKaxN8G6ka4GYtQQWk4G4dZRUTX2vQH9GcXdBREFUk",
]

const ACTIVE_COPY_WALLETS = COPY_WALLETS.length > 0 ? COPY_WALLETS : COPY_WALLETS_DEFAULT
const walletLastSig       = new Map() // copyWallet → last seen signature

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

  const pair = await getDexPairData(tokenMint)
  if (!pair) {
    reject("NO_DEX_DATA", tokenMint)
    addCooldown(tokenMint, 600000) // 10min cooldown
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

  // Score
  const { score, breakdown } = scoreToken(pair)
  const bdStr = Object.entries(breakdown).map(([k,v]) => `${k}:${v}`).join(" ")
  log("SCORE", `Score:${score}/100 | ${bdStr} | ${tokenMint.slice(0,8)}...`)

  if (score < CFG.MIN_SCORE) {
    reject(`SCORE_LOW:${score}`, tokenMint)
    return null
  }

  return { pair, score, liquidity, marketCap, volume5m, ageMin, buyRatio, priceChg5m, source }
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
    const data = await evaluateToken(tokenMint, entry.source)
    if (!data) {
      log("REJECT", `Second pass FAILED for ${tokenMint.slice(0,8)}... — aborting entry`)
      addCooldown(tokenMint, 1800000) // 30min after double-fail
      continue
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

  log("BUY", `Submitting buy | ${tokenMint.slice(0,8)}... | ${(tradeAmount/LAMPORTS_PER_SOL).toFixed(4)}SOL | score:${evalData.score}`)

  try {
    const result   = await swap(wallet, SOL_MINT, tokenMint, tradeAmount, "BUY")
    const outAmount = (result.outputAmount || result.totalOutputAmount || "0").toString()

    state.positions[tokenMint].status    = "open"
    state.positions[tokenMint].buyPrice  = buyPrice
    state.positions[tokenMint].rawAmount = outAmount
    state.positions[tokenMint].peakPrice = buyPrice
    state.positions[tokenMint].stopPrice = buyPrice * (1 - CFG.INITIAL_STOP_PCT)

    log("BUY", `✅ BOUGHT | ${tokenMint.slice(0,8)}... | price:${buyPrice} | tokens:${outAmount} | liq:$${Math.round(evalData.liquidity)} | mc:$${Math.round(evalData.marketCap)} | age:${evalData.ageMin.toFixed(1)}min`)
    state.tradesTaken++
    saveState()
  } catch (e) {
    log("FAIL", `Buy failed for ${tokenMint.slice(0,8)}...: ${e.message}`)
    state.failedSwaps.push(Date.now())
    delete state.positions[tokenMint]
    addCooldown(tokenMint, 1800000) // 30min after buy fail
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

  log("SELL", `Submitting sell | ${tokenMint.slice(0,8)}... | reason:${reason} | amount:${amount} | partial:${isPartial}`)

  try {
    const result = await swap(wallet, tokenMint, SOL_MINT, amount, `SELL_${reason}`)
    log("SELL", `✅ Sold | ${tokenMint.slice(0,8)}... | reason:${reason}`)

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
        const freshPair = await getDexPairData(tokenMint)
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
  if (ACTIVE_COPY_WALLETS.length === 0) return

  for (const copyWallet of ACTIVE_COPY_WALLETS) {
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

      const lastSig = walletLastSig.get(copyWallet)
      // Only process signatures we haven't seen before
      const newSigs = lastSig
        ? sigs.filter(s => s.signature !== lastSig).slice(0, 3)
        : sigs.slice(0, 1) // on first run, only look at the very latest

      walletLastSig.set(copyWallet, sigs[0].signature)
      if (newSigs.length === 0) continue

      log("SCAN", `CopyWallet ${copyWallet.slice(0,8)}... — ${newSigs.length} new tx(s)`)

      for (const sigInfo of newSigs) {
        try {
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
            if (seenTokens.has(b.mint))       continue
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

  let lastDexScan    = 0
  let lastPumpScan   = 0
  let lastWalletScan = 0
  let lastSummary    = 0
  let loopCount      = 0

  log("START", `Copy wallets:  ${ACTIVE_COPY_WALLETS.length} | Pump.fun: ON | Rugcheck.xyz: ${CFG.RUGCHECK_ENABLED ? "ON" : "OFF"}`)

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

      // Scanning
      if (Date.now() - lastDexScan > CFG.DEX_SCAN_INTERVAL_MS) {
        if (!checkPaused()) {
          log("SCAN", "Starting DexScreener scan cycle...")
          await scanDexScreenerProfiles(wallet)
          await sleep(1000)
          await scanDexScreenerBoosts(wallet)
        } else {
          log("PAUSE", `DexScreener scan skipped — ${state.pauseReason}`)
        }
        lastDexScan = Date.now()
      }

      if (Date.now() - lastPumpScan > CFG.PUMP_SCAN_INTERVAL_MS) {
        if (!checkPaused()) {
          await scanPumpFun(wallet)
        }
        lastPumpScan = Date.now()
      }

      if (Date.now() - lastWalletScan > CFG.WALLET_SCAN_INTERVAL_MS) {
        if (!checkPaused()) {
          await scanCopyWallets(wallet)
        }
        lastWalletScan = Date.now()
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
