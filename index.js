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

  MIN_PAIR_AGE_MIN:      parseFloat(process.env.MIN_AGE      || "2"),

  MAX_PAIR_AGE_MIN:      parseFloat(process.env.MAX_AGE      || "60"),

  MIN_VOL_5M:            parseFloat(process.env.MIN_VOL5M    || "1000"),

  MIN_TXNS_5M:           parseInt(  process.env.MIN_TXNS5M   || "20"),   // need real participation,   // need real participation

  MIN_BUY_RATIO:         parseFloat(process.env.MIN_BR       || "0.65"), // 65% buys — real momentum

  MIN_PRICE_CHANGE_5M:   parseFloat(process.env.MIN_PC5M     || "5"),    // only trade actual pumps

  MAX_1H_NEGATIVE:       parseFloat(process.env.MAX_1H_NEG   || "-30"),

  MIN_LIQ_MCAP_RATIO:    parseFloat(process.env.MIN_LM_RATIO || "0.02"),

  MIN_SCORE:             parseInt(  process.env.MIN_SCORE    || "55"),    // higher bar — trade less, win more,    // out of 100



  // Exit thresholds

  INITIAL_STOP_PCT:      parseFloat(process.env.STOP_PCT     || "0.06"),  // -6% tight stop — bonding curve gaps fast,  // -8% tight stop

  BREAKEVEN_TRIGGER_PCT: parseFloat(process.env.BE_PCT       || "0.05"),  // move to BE at +5%,  // +10% → move stop to BE

  TP1_PCT:               parseFloat(process.env.TP1          || "0.15"),  // take first profit at +15%,  // +20% → partial sell

  TP1_FRACTION:          parseFloat(process.env.TP1_FRAC     || "0.40"),  // sell 40%

  TP2_PCT:               parseFloat(process.env.TP2          || "0.40"),  // +40% → partial sell

  TP2_FRACTION:          parseFloat(process.env.TP2_FRAC     || "0.35"),  // sell 35%

  TRAIL_STOP_PCT:        parseFloat(process.env.TRAIL_PCT    || "0.05"),  // 5% trail — lock profits fast,  // 7% trailing

  MAX_HOLD_MS:           parseInt(  process.env.MAX_HOLD     || "480000"),// 8min max hold,// 15 min

  STAGNANT_HOLD_MS:      parseInt(  process.env.STAGNANT_MS  || "120000"),// exit stagnant trades in 2min,// 5 min with no progress

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

  MONITOR_INTERVAL_MS:     1000, // 1s loop — catch fast dumps before gap-through



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

// Source: GMGN smart money leaderboard — verified by user Mar 23 2026

// Override ALL by setting COPY_WALLETS env var (comma-separated)

const COPY_WALLETS_DEFAULT = [

  "FxwArENkKBx4QyfoEU1vkBnDzMfZV9Z1b8GBzpT9zb5k",

  "HiSo5kykqDPs3EG14Fk9QY4B5RvkuEs8oJTiqPX3EDAn",

  "GdRSPexhxbQz5H2zFQrNN2BAZUqEjAULBigTPvQ6oDMP",

  "AMRsSeU5JpqwQWJGNLMpZzRCZSFEwYQYbMnms3dD4311",

  "BVMJKd35CEw4n6BN7NbYPzV5XsoY24H2TawsAJzLG5rh",

  "cqakon1K22iRvSAnzyNGE44KRk52p7ucRoJtvR6UFem",

  "4BdKaxN8G6ka4GYtQQWk4G4dZRUTX2vQH9GcXdBREFUk",

  "5JJLDJ9d7WeP4sz6KGNRF3ueEF33dtbsihGVC5eyQu9D",

  "5d3jQcuUvsuHyZkhdp78FFqc7WogrzZpTtec1X9VNkuE",

  "7moqFjvm2MwAiMtCZoqYoTAPzRBxxMRT2ddyHThQuWjr",

  "DC99qH3jXiq5pPWQd6PjjJcCxTV593s58CLPxWGpEywt",

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

  r
