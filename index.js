/**
 * ═══════════════════════════════════════════════════════════════════
 *  SOLANA COPY BOT — Multi Wallet Mirror
 *  Mirrors trades taken by multiple target wallets.
 *  No scoring. No complex filters. Just copy.
 * ═══════════════════════════════════════════════════════════════════
 */

"use strict"

const fetch  = require("node-fetch")
const bs58   = require("bs58")
const fs     = require("fs")
const {
  Keypair,
  Connection,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
  PublicKey,
} = require("@solana/web3.js")

// ─────────────────────────────────────────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────────────────────────────────────────
const CFG = {
  RPC_URL: process.env.RPC_URL || "https://api.mainnet-beta.solana.com",

  // ── Wallets to copy ───────────────────────────────────────────────────────
  TARGET_WALLETS: (
    process.env.TARGET_WALLETS ||
    "AMRsSeU5JpqwQWJGNLMpZzRCZSFEwYQYbMnms3dD4311,4vw54BmAogeRV3vPKWyFet5yf8DTLcREzdSzx4rw9Ud9"
  )
    .split(",")
    .map(w => w.trim())
    .filter(w => w.length > 30),

  // ── Sizing — pure % of your balance, no hard SOL cap ──────────────────
  TRADE_PCT:        parseFloat(process.env.TRADE_PCT    || "0.05"),
  MIN_TRADE_SOL:    parseFloat(process.env.MIN_TRADE    || "0.01"),
  RESERVE_SOL:      parseFloat(process.env.RESERVE_SOL  || "0.05"),

  // ── Backstop exits ─────────────────────────────────────────────────────
  HARD_STOP_PCT:    parseFloat(process.env.HARD_STOP    || "0.10"),
  MAX_HOLD_MS:      parseInt(  process.env.MAX_HOLD     || "1800000"),

  // ── Circuit breakers ───────────────────────────────────────────────────
  DAILY_LOSS_PCT:   parseFloat(process.env.DAILY_LOSS   || "0.30"),
  MAX_FAILED_SWAPS: parseInt(  process.env.MAX_FAIL     || "5"),
  FAILED_SWAP_WINDOW_MS: 3600000,

  // ── PumpPortal ─────────────────────────────────────────────────────────
  PUMPPORTAL_URL:   "https://pumpportal.fun/api/trade-local",
  PUMP_SLIPPAGE:    parseInt(  process.env.PUMP_SLIPPAGE || "15"),
  PUMP_PRIORITY:    parseFloat(process.env.PUMP_PRIORITY || "0.005"),

  // ── Jupiter fallback ───────────────────────────────────────────────────
  JUP_BASE:         "https://api.jup.ag",
  JUP_API_KEY:      process.env.JUP_API_KEY || "",

  POLL_MS:          parseInt(process.env.POLL_MS || "3000"),
  TX_MAX_AGE_SEC:   90,

  STATE_FILE:       process.env.STATE_FILE || "/tmp/copybot_state.json",
  TRADES_CSV:       process.env.TRADES_CSV || "/tmp/copybot_trades.csv",
}

const SOL_MINT = "So11111111111111111111111111111111111111112"

const SKIP_MINTS = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
  "USD1ygnE8URFjQRouBKmhkBkEMxKFnHczvF6KCQHQ4Ud", // USD1
  SOL_MINT,
])

// ─────────────────────────────────────────────────────────────────────────────
//  STATE
// ─────────────────────────────────────────────────────────────────────────────
let state = {
  positions:       {},   // tokenMint → { buyPrice, rawAmount, timestamp, amountSol, copiedFrom }
  dayStartBalance: null,
  totalTrades:     0,
  winTrades:       0,
  totalPnlPct:     0,
  failedSwaps:     [],
  paused:          false,
  pauseReason:     "",
  lastSeenSig:     {},   // wallet → last signature
}

function loadState() {
  try {
    if (fs.existsSync(CFG.STATE_FILE)) {
      const s               = JSON.parse(fs.readFileSync(CFG.STATE_FILE, "utf8"))
      state.positions       = s.positions || {}
      state.dayStartBalance = s.dayStartBalance || null
      state.totalTrades     = s.totalTrades || 0
      state.winTrades       = s.winTrades || 0
      state.totalPnlPct     = s.totalPnlPct || 0
      state.lastSeenSig     = (s.lastSeenSig && typeof s.lastSeenSig === "object") ? s.lastSeenSig : {}
      log("STATE", `Loaded: ${Object.keys(state.positions).length} open positions`)
    }
  } catch (e) {
    log("WARN", `State load failed: ${e.message}`)
  }
}

function saveState() {
  try {
    fs.writeFileSync(CFG.STATE_FILE, JSON.stringify({
      positions:       state.positions,
      dayStartBalance: state.dayStartBalance,
      totalTrades:     state.totalTrades,
      winTrades:       state.winTrades,
      totalPnlPct:     state.totalPnlPct,
      lastSeenSig:     state.lastSeenSig,
    }, null, 2))
  } catch (e) {
    log("WARN", `State save failed: ${e.message}`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  LOGGING
// ─────────────────────────────────────────────────────────────────────────────
function ts() { return new Date().toISOString().slice(11, 23) }

function log(tag, msg) {
  const icons = {
    START: "🚀", COPY: "📡", BUY: "🟢", SELL: "🔴", PNL: "💰",
    ERROR: "⚠️ ", WARN: "🟡", INFO: "ℹ️ ", STATE: "💾",
    PAUSE: "⏸️ ", CONFIRM: "✅", FAIL: "🚨", SKIP: "⏭️ ", MONITOR: "📈",
  }
  console.log(`[${ts()}] ${icons[tag] || "  "} [${tag.padEnd(7)}] ${msg}`)
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// ─────────────────────────────────────────────────────────────────────────────
//  CONNECTION & WALLET
// ─────────────────────────────────────────────────────────────────────────────
const connection = new Connection(CFG.RPC_URL, {
  commitment: "confirmed",
  confirmTransactionInitialTimeout: 60000,
})

function loadWallet() {
  if (!process.env.PRIVATE_KEY) throw new Error("PRIVATE_KEY env var not set")
  return Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY))
}

async function getSolBalance(pubkey) {
  try {
    return (await connection.getBalance(pubkey)) / LAMPORTS_PER_SOL
  } catch (e) {
    log("ERROR", `Balance failed: ${e.message}`)
    return null
  }
}

async function getTokenBalance(walletPubkey, tokenMint) {
  try {
    const accs = await connection.getParsedTokenAccountsByOwner(
      walletPubkey,
      { mint: new PublicKey(tokenMint) }
    )
    if (!accs.value.length) return "0"
    return accs.value[0].account.data.parsed.info.tokenAmount.amount
  } catch (e) {
    log("ERROR", `Token balance failed: ${e.message}`)
    return "0"
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  SIZING
// ─────────────────────────────────────────────────────────────────────────────
async function getTradeAmountSol(walletPubkey) {
  const bal = await getSolBalance(walletPubkey)
  if (bal === null) return CFG.MIN_TRADE_SOL

  const tradeable = Math.max(0, bal - CFG.RESERVE_SOL)
  const raw       = tradeable * CFG.TRADE_PCT
  const amount    = Math.max(raw, CFG.MIN_TRADE_SOL)

  log("INFO", `Balance:${bal.toFixed(4)}SOL | TradeSize:${amount.toFixed(4)}SOL (${(CFG.TRADE_PCT * 100).toFixed(0)}%)`)
  return amount
}

// ─────────────────────────────────────────────────────────────────────────────
//  PRICE
// ─────────────────────────────────────────────────────────────────────────────
async function getBestPrice(tokenMint) {
  try {
    const headers = CFG.JUP_API_KEY ? { "x-api-key": CFG.JUP_API_KEY } : {}
    const res = await fetch(`${CFG.JUP_BASE}/price/v2?ids=${tokenMint}`, { headers })
    if (res.ok) {
      const p = parseFloat((await res.json())?.data?.[tokenMint]?.price)
      if (p) return p
    }
  } catch {}

  try {
    const res = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${tokenMint}`)
    if (res.ok) {
      const data = await res.json()
      if (Array.isArray(data) && data.length) {
        const pair = data.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0]
        return parseFloat(pair?.priceUsd) || null
      }
    }
  } catch {}

  return null
}

// ─────────────────────────────────────────────────────────────────────────────
//  SWAP EXECUTION
// ─────────────────────────────────────────────────────────────────────────────
async function pumpPortalSwap(wallet, tokenMint, action, amount, label = "") {
  const isSell = action === "sell"
  const body = {
    publicKey:        wallet.publicKey.toString(),
    action,
    mint:             tokenMint,
    amount:           isSell ? amount : Math.floor(amount * LAMPORTS_PER_SOL),
    denominatedInSol: isSell ? "false" : "true",
    slippage:         CFG.PUMP_SLIPPAGE,
    priorityFee:      CFG.PUMP_PRIORITY,
    pool:             "auto",
  }

  const res = await fetch(CFG.PUMPPORTAL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  })

  if (!res.ok) {
    throw new Error(`PumpPortal HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`)
  }

  const txBytes = new Uint8Array(await res.arrayBuffer())
  if (!txBytes?.length) throw new Error("PumpPortal returned empty tx")

  const tx = VersionedTransaction.deserialize(txBytes)
  tx.sign([wallet])

  const sig = await connection.sendTransaction(tx, {
    skipPreflight: false,
    preflightCommitment: "confirmed",
    maxRetries: 3,
  })

  const { value: status } = await connection.confirmTransaction(sig, "confirmed")
  if (status?.err) throw new Error(`On-chain fail: ${JSON.stringify(status.err)}`)

  log("CONFIRM", `PumpPortal ${action} OK | sig:${sig} [${label}]`)
  return { signature: sig }
}

async function jupiterSwap(wallet, inputMint, outputMint, amountLamports, label = "") {
  const headers = {
    "Content-Type": "application/json",
    ...(CFG.JUP_API_KEY ? { "x-api-key": CFG.JUP_API_KEY } : {}),
  }

  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount: amountLamports.toString(),
    taker: wallet.publicKey.toString(),
  })

  const orderRes = await fetch(`${CFG.JUP_BASE}/ultra/v1/order?${params}`, { headers })
  if (!orderRes.ok) throw new Error(`Jup order HTTP ${orderRes.status}`)

  const order = await orderRes.json()
  if (!order?.transaction || !order?.requestId) throw new Error("Malformed Jup order")

  const tx = VersionedTransaction.deserialize(Buffer.from(order.transaction, "base64"))
  tx.sign([wallet])

  const execRes = await fetch(`${CFG.JUP_BASE}/ultra/v1/execute`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      signedTransaction: Buffer.from(tx.serialize()).toString("base64"),
      requestId: order.requestId,
    }),
  })

  if (!execRes.ok) throw new Error(`Jup execute HTTP ${execRes.status}`)

  const result = await execRes.json()
  if (result?.status !== "Success") {
    throw new Error(`Jup not successful: ${JSON.stringify(result).slice(0, 200)}`)
  }

  log("CONFIRM", `Jupiter OK | sig:${result.txSignature} [${label}]`)
  return result
}

async function doBuy(wallet, tokenMint, amountSol, label) {
  try {
    return await pumpPortalSwap(wallet, tokenMint, "buy", amountSol, label)
  } catch (e) {
    log("WARN", `PumpPortal buy failed: ${e.message} — trying Jupiter`)
    return await jupiterSwap(
      wallet,
      SOL_MINT,
      tokenMint,
      Math.floor(amountSol * LAMPORTS_PER_SOL),
      `${label}_JUP`
    )
  }
}

async function doSell(wallet, tokenMint, tokenAmount, label) {
  try {
    return await pumpPortalSwap(wallet, tokenMint, "sell", tokenAmount, label)
  } catch (e) {
    log("WARN", `PumpPortal sell failed: ${e.message} — trying Jupiter`)
    return await jupiterSwap(wallet, tokenMint, SOL_MINT, tokenAmount, `${label}_JUP`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  COPY BUY
// ─────────────────────────────────────────────────────────────────────────────
async function copyBuy(wallet, tokenMint, sourceWallet = "unknown") {
  if (state.positions[tokenMint]) {
    log("SKIP", `Already holding ${tokenMint.slice(0, 8)}...`)
    return
  }

  if (state.paused) {
    log("PAUSE", `Buy skipped — ${state.pauseReason}`)
    return
  }

  const amountSol = await getTradeAmountSol(wallet.publicKey)
  const buyPrice  = await getBestPrice(tokenMint)

  log("BUY", `Copying buy | src:${sourceWallet.slice(0, 6)}... | ${tokenMint.slice(0, 8)}... | ${amountSol.toFixed(4)}SOL | price:${buyPrice || "unknown"}`)

  try {
    await doBuy(wallet, tokenMint, amountSol, "COPY_BUY")
    await sleep(2000)
    const rawAmt = await getTokenBalance(wallet.publicKey, tokenMint)

    state.positions[tokenMint] = {
      tokenMint,
      buyPrice:  buyPrice || 0,
      rawAmount: rawAmt,
      timestamp: Date.now(),
      amountSol,
      copiedFrom: sourceWallet,
    }

    saveState()
    log("BUY", `✅ Bought ${tokenMint.slice(0, 8)}... | tokens:${rawAmt} | paid:${amountSol.toFixed(4)}SOL`)
    logCsv({ type: "BUY", token: tokenMint, amountSol, price: buyPrice || 0, reason: `FROM_${sourceWallet}` })
  } catch (e) {
    log("FAIL", `Copy buy failed ${tokenMint.slice(0, 8)}...: ${e.message}`)
    recordFailedSwap()
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  COPY SELL
// ─────────────────────────────────────────────────────────────────────────────
async function copySell(wallet, tokenMint, reason = "TARGET_SOLD") {
  const pos = state.positions[tokenMint]
  if (!pos) {
    log("SKIP", `No position for ${tokenMint.slice(0, 8)}...`)
    return
  }

  const rawAmt = await getTokenBalance(wallet.publicKey, tokenMint)
  if (!rawAmt || rawAmt === "0") {
    log("WARN", `No balance for ${tokenMint.slice(0, 8)}... — removing position`)
    delete state.positions[tokenMint]
    saveState()
    return
  }

  const sellPrice = await getBestPrice(tokenMint)
  log("SELL", `Copying sell | ${tokenMint.slice(0, 8)}... | reason:${reason} | price:${sellPrice || "unknown"}`)

  try {
    await doSell(wallet, tokenMint, rawAmt, `COPY_SELL_${reason}`)

    const pct   = sellPrice && pos.buyPrice ? ((sellPrice / pos.buyPrice) - 1) * 100 : 0
    const isWin = pct > 0

    state.totalTrades++
    state.totalPnlPct += pct
    if (isWin) state.winTrades++

    log("PNL", `${isWin ? "WIN" : "LOSS"} | ${pct.toFixed(1)}% | ${tokenMint.slice(0, 8)}... | hold:${Math.round((Date.now() - pos.timestamp) / 1000)}s`)
    logCsv({
      type: "SELL",
      token: tokenMint,
      amountSol: pos.amountSol,
      price: sellPrice || 0,
      pct,
      result: isWin ? "WIN" : "LOSS",
      reason,
    })

    delete state.positions[tokenMint]
    saveState()
  } catch (e) {
    log("FAIL", `Copy sell failed ${tokenMint.slice(0, 8)}...: ${e.message}`)
    recordFailedSwap()
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  CIRCUIT BREAKERS
// ─────────────────────────────────────────────────────────────────────────────
function recordFailedSwap() {
  state.failedSwaps.push(Date.now())
  const window = Date.now() - CFG.FAILED_SWAP_WINDOW_MS
  state.failedSwaps = state.failedSwaps.filter(t => t > window)

  if (state.failedSwaps.length >= CFG.MAX_FAILED_SWAPS && !state.paused) {
    state.paused      = true
    state.pauseReason = `${state.failedSwaps.length} failed swaps in 1h`
    log("PAUSE", state.pauseReason)
    saveState()
  }
}

async function checkDailyLoss(walletPubkey) {
  if (state.dayStartBalance === null) return

  const bal = await getSolBalance(walletPubkey)
  if (bal === null) return

  const drawdown = (state.dayStartBalance - bal) / state.dayStartBalance
  if (drawdown >= CFG.DAILY_LOSS_PCT && !state.paused) {
    state.paused      = true
    state.pauseReason = `Daily loss limit hit: -${(drawdown * 100).toFixed(1)}%`
    log("PAUSE", state.pauseReason)
    saveState()
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  BACKSTOP MONITOR
// ─────────────────────────────────────────────────────────────────────────────
async function monitorBackstops(wallet) {
  for (const [tokenMint, pos] of Object.entries(state.positions)) {
    try {
      if (Date.now() - pos.timestamp >= CFG.MAX_HOLD_MS) {
        log("MONITOR", `Max hold hit for ${tokenMint.slice(0, 8)}... — force selling`)
        await copySell(wallet, tokenMint, "MAX_HOLD")
        continue
      }

      if (pos.buyPrice > 0) {
        const price = await getBestPrice(tokenMint)
        if (price && price < pos.buyPrice * (1 - CFG.HARD_STOP_PCT)) {
          log("MONITOR", `Hard stop hit for ${tokenMint.slice(0, 8)}... | current:${price} entry:${pos.buyPrice}`)
          await copySell(wallet, tokenMint, "HARD_STOP")
          continue
        }
      }

      log("MONITOR", `Holding ${tokenMint.slice(0, 8)}... | age:${Math.round((Date.now() - pos.timestamp) / 1000)}s`)
    } catch (e) {
      log("ERROR", `Backstop error ${tokenMint.slice(0, 8)}...: ${e.message}`)
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  TARGET WALLET POLLER
// ─────────────────────────────────────────────────────────────────────────────
async function pollTargets(wallet) {
  for (const targetWallet of CFG.TARGET_WALLETS) {
    const targetPubkey = new PublicKey(targetWallet)

    let sigs
    try {
      sigs = await connection.getSignaturesForAddress(targetPubkey, { limit: 10 })
    } catch (e) {
      log("WARN", `Sig fetch failed (${targetWallet.slice(0, 6)}...): ${e.message}`)
      continue
    }

    if (!sigs?.length) continue

    const nowSec  = Math.floor(Date.now() / 1000)
    const newSigs = []

    for (const s of sigs) {
      if (s.signature === state.lastSeenSig[targetWallet]) break
      if (s.blockTime && (nowSec - s.blockTime) > CFG.TX_MAX_AGE_SEC) continue
      if (s.err) continue
      newSigs.push(s)
    }

    if (sigs[0]) state.lastSeenSig[targetWallet] = sigs[0].signature
    if (!newSigs.length) continue

    log("COPY", `${newSigs.length} new tx(s) from ${targetWallet.slice(0, 6)}... — parsing...`)

    for (const sigInfo of newSigs.reverse()) {
      try {
        await sleep(400)

        const tx = await connection.getParsedTransaction(sigInfo.signature, {
          maxSupportedTransactionVersion: 0,
          commitment: "confirmed",
        })

        if (!tx || tx.meta?.err) continue

        const pre  = tx.meta?.preTokenBalances || []
        const post = tx.meta?.postTokenBalances || []

        // Buys — token amount increased
        for (const postBal of post) {
          if (SKIP_MINTS.has(postBal.mint)) continue

          const preBal  = pre.find(p => p.accountIndex === postBal.accountIndex && p.mint === postBal.mint)
          const preAmt  = parseFloat(preBal?.uiTokenAmount?.uiAmount || "0")
          const postAmt = parseFloat(postBal?.uiTokenAmount?.uiAmount || "0")

          if (postAmt > preAmt) {
            log("COPY", `Target ${targetWallet.slice(0, 6)}... BOUGHT ${postBal.mint.slice(0, 8)}... (${preAmt} → ${postAmt})`)
            await copyBuy(wallet, postBal.mint, targetWallet)
          }
        }

        // Sells — token amount decreased or zeroed
        for (const preBal of pre) {
          if (SKIP_MINTS.has(preBal.mint)) continue
          if (!state.positions[preBal.mint]) continue

          const postBal = post.find(p => p.accountIndex === preBal.accountIndex && p.mint === preBal.mint)
          const preAmt  = parseFloat(preBal?.uiTokenAmount?.uiAmount || "0")
          const postAmt = parseFloat(postBal?.uiTokenAmount?.uiAmount || "0")

          if (preAmt > 0 && postAmt < preAmt) {
            const type = postAmt === 0 ? "FULL" : "PARTIAL"
            log("COPY", `Target ${targetWallet.slice(0, 6)}... SOLD (${type}) ${preBal.mint.slice(0, 8)}... (${preAmt} → ${postAmt})`)
            await copySell(wallet, preBal.mint, `TARGET_SOLD_${type}`)
          }
        }
      } catch (e) {
        log("WARN", `Tx parse error (${targetWallet.slice(0, 6)}...): ${e.message}`)
      }
    }
  }

  saveState()
}

// ─────────────────────────────────────────────────────────────────────────────
//  CSV LOGGING
// ─────────────────────────────────────────────────────────────────────────────
function logCsv(t) {
  try {
    const header = "timestamp,type,token,amountSol,price,pct,result,reason\n"
    const row = `${new Date().toISOString()},${t.type},${t.token},${(t.amountSol || 0).toFixed(4)},${t.price || 0},${(t.pct || 0).toFixed(2)},${t.result || ""},${t.reason || ""}\n`

    if (!fs.existsSync(CFG.TRADES_CSV)) fs.writeFileSync(CFG.TRADES_CSV, header)
    fs.appendFileSync(CFG.TRADES_CSV, row)
  } catch (e) {
    log("ERROR", `CSV log failed: ${e.message}`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  SUMMARY
// ─────────────────────────────────────────────────────────────────────────────
async function printSummary(walletPubkey) {
  const bal    = await getSolBalance(walletPubkey)
  const open   = Object.keys(state.positions)
  const wr     = state.totalTrades > 0 ? ((state.winTrades / state.totalTrades) * 100).toFixed(0) : "N/A"
  const avgPnl = state.totalTrades > 0 ? (state.totalPnlPct / state.totalTrades).toFixed(1) : "N/A"

  console.log(`\n[${ts()}] 📊 ═══════════════ SUMMARY ═══════════════`)
  console.log(`  Copying:        ${CFG.TARGET_WALLETS.join(", ")}`)
  console.log(`  Balance:        ${bal !== null ? bal.toFixed(4) + " SOL" : "N/A"}`)
  console.log(`  Trade size:     ${(CFG.TRADE_PCT * 100).toFixed(0)}% of balance`)
  console.log(`  Open positions: ${open.length} | ${open.map(m => m.slice(0, 8) + "...").join(", ") || "none"}`)
  console.log(`  Total trades:   ${state.totalTrades} | WR:${wr}% | Avg PnL:${avgPnl}%`)
  console.log(`  Paused:         ${state.paused ? "YES — " + state.pauseReason : "NO"}`)
  console.log(`═══════════════════════════════════════════════\n`)
}

// ─────────────────────────────────────────────────────────────────────────────
//  MAIN
// ─────────────────────────────────────────────────────────────────────────────
async function runBot() {
  log("START", "═══════════════════════════════════════════")
  log("START", "   Solana Copy Bot — Multi Wallet Mirror   ")
  log("START", "═══════════════════════════════════════════")

  const wallet = loadWallet()

  log("START", `Your wallet:  ${wallet.publicKey.toString()}`)
  log("START", `Copying:      ${CFG.TARGET_WALLETS.join(", ")}`)
  log("START", `Trade size:   ${(CFG.TRADE_PCT * 100).toFixed(0)}% of balance per trade`)
  log("START", `Hard stop:    -${(CFG.HARD_STOP_PCT * 100).toFixed(0)}%  |  Max hold: ${CFG.MAX_HOLD_MS / 60000}min`)
  log("START", `Poll speed:   every ${CFG.POLL_MS / 1000}s`)

  loadState()

  const initBal = await getSolBalance(wallet.publicKey)
  if (initBal !== null) {
    if (!state.dayStartBalance) state.dayStartBalance = initBal
    log("START", `Balance: ${initBal.toFixed(4)} SOL`)
  }

  // Initialize cursors — don't replay trades from before bot started
  for (const targetWallet of CFG.TARGET_WALLETS) {
    if (!state.lastSeenSig[targetWallet]) {
      try {
        const sigs = await connection.getSignaturesForAddress(new PublicKey(targetWallet), { limit: 1 })
        if (sigs?.[0]) {
          state.lastSeenSig[targetWallet] = sigs[0].signature
          log("START", `Cursor set for ${targetWallet.slice(0, 6)}... — won't replay old trades`)
        }
      } catch (e) {
        log("WARN", `Cursor init failed (${targetWallet.slice(0, 6)}...): ${e.message}`)
      }
    }
  }

  saveState()
  log("START", `Watching for trades... (Ctrl+C to stop)`)

  let lastSummary = 0

  while (true) {
    try {
      await pollTargets(wallet)

      if (Object.keys(state.positions).length > 0) {
        await monitorBackstops(wallet)
      }

      await checkDailyLoss(wallet.publicKey)

      if (Date.now() - lastSummary > 60000) {
        await printSummary(wallet.publicKey)
        lastSummary = Date.now()
      }

      await sleep(CFG.POLL_MS)
    } catch (e) {
      log("ERROR", `Main loop: ${e.message}`)
      await sleep(5000)
    }
  }
}

runBot().catch(e => {
  console.error(`[FATAL] ${e.message}\n${e.stack}`)
  process.exit(1)
})
