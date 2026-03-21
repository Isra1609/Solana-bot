const fetch = require("node-fetch")
const bs58 = require("bs58")
const fs = require("fs")
const {
  Keypair,
  Connection,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
  PublicKey
} = require("@solana/web3.js")

const connection = new Connection(
  process.env.RPC_URL || "https://api.mainnet-beta.solana.com",
  "confirmed"
)

function loadWallet() {
  if (!process.env.PRIVATE_KEY) throw new Error("Missing PRIVATE_KEY")
  return Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY))
}

function sleep(ms) {
  return new Promise(res => setTimeout(res, ms))
}

function logTrade(trade) {
  const logFile = "/tmp/trades.csv"
  const header = "timestamp,token,source,score,buyPrice,sellPrice,pct,result,ageMin,liquidity,marketCap,buyRatio,volume5m,holdSeconds\n"
  const row = `${trade.timestamp},${trade.token},${trade.source},${trade.score},${trade.buyPrice},${trade.sellPrice},${trade.pct},${trade.result},${trade.ageMin},${trade.liquidity},${trade.marketCap},${trade.buyRatio},${trade.volume5m},${trade.holdSeconds}\n`
  if (!fs.existsSync(logFile)) fs.writeFileSync(logFile, header)
  fs.appendFileSync(logFile, row)
  console.log(`📝 Logged to ${logFile}`)
}

function printStats() {
  const logFile = "/tmp/trades.csv"
  if (!fs.existsSync(logFile)) return
  const lines = fs.readFileSync(logFile, "utf8").trim().split("\n").slice(1).filter(Boolean)
  if (lines.length === 0) return

  const trades = lines.map(l => {
    const [timestamp,token,source,score,buyPrice,sellPrice,pct,result] = l.split(",")
    return { source, pct: parseFloat(pct), result, score: parseInt(score) }
  })

  const wins = trades.filter(t => t.result === "WIN").length
  const losses = trades.filter(t => t.result === "LOSS").length
  const totalPnl = trades.reduce((sum, t) => sum + t.pct, 0)
  const avgWin = trades.filter(t => t.result === "WIN").reduce((sum, t) => sum + t.pct, 0) / (wins || 1)
  const avgLoss = trades.filter(t => t.result === "LOSS").reduce((sum, t) => sum + t.pct, 0) / (losses || 1)

  const bySource = {}
  trades.forEach(t => {
    if (!bySource[t.source]) bySource[t.source] = { wins: 0, total: 0, pnl: 0 }
    bySource[t.source].total++
    bySource[t.source].pnl += t.pct
    if (t.result === "WIN") bySource[t.source].wins++
  })

  console.log(`\n📊 ═══════════════ TRADE STATS ═══════════════`)
  console.log(`Total:${trades.length} | Wins:${wins} | Losses:${losses} | WR:${((wins/trades.length)*100).toFixed(0)}%`)
  console.log(`PnL:${totalPnl.toFixed(1)}% | AvgWin:+${avgWin.toFixed(1)}% | AvgLoss:${avgLoss.toFixed(1)}%`)
  console.log(`By Source:`)
  Object.entries(bySource).forEach(([src, data]) => {
    console.log(`  ${src}: ${data.total} trades | WR:${((data.wins/data.total)*100).toFixed(0)}% | PnL:${data.pnl.toFixed(1)}%`)
  })
  console.log(`═════════════════════════════════════════════\n`)
}

async function getTradeAmount(wallet) {
  try {
    const balance = await connection.getBalance(wallet.publicKey)
    const solBalance = balance / LAMPORTS_PER_SOL
    const target = Math.min(solBalance * 0.08, 0.35)
    const clamped = Math.max(0.01, target)
    const finalAmount = Math.floor(clamped * LAMPORTS_PER_SOL)
    console.log(`💰 Balance: ${solBalance.toFixed(4)} SOL | Trade: ${clamped.toFixed(4)} SOL (8%)`)
    return finalAmount
  } catch (e) {
    console.log(`❌ Balance check failed: ${e.message}`)
    return Math.floor(0.02 * LAMPORTS_PER_SOL)
  }
}

const SOL  = "So11111111111111111111111111111111111111112"
const BASE = "https://api.jup.ag"

const TAKE_PROFIT          = 1.40   // +40%
const INITIAL_STOP         = 0.93   // -7% hard stop (tighter)
const TRAIL_STOP_PCT       = 0.06   // 6% trail
const MAX_HOLD_TIME        = 90000  // 90s — get out faster
const DEX_SCAN_INTERVAL    = 20000
const PUMP_SCAN_INTERVAL   = 18000
const WALLET_SCAN_INTERVAL = 35000
const MAX_POSITIONS        = 2      // focus on fewer, better trades
const MIN_SCORE            = 12     // balanced — still blocks weak setups

const DAILY_LOSS_LIMIT_PCT = 0.20
let dayStartBalance        = null
let circuitBroken          = false

async function checkCircuitBreaker(wallet) {
  if (circuitBroken) return true
  try {
    const balance = await connection.getBalance(wallet.publicKey)
    const sol = balance / LAMPORTS_PER_SOL
    if (dayStartBalance === null) { dayStartBalance = sol; return false }
    const drawdown = (dayStartBalance - sol) / dayStartBalance
    if (drawdown >= DAILY_LOSS_LIMIT_PCT) {
      console.log(`🛑 CIRCUIT BREAKER: down ${(drawdown*100).toFixed(1)}% today. Halting buys.`)
      circuitBroken = true
      return true
    }
  } catch {}
  return false
}

// ─── COPY WALLETS DISABLED — previous wallets were rugging you ───────────────
// To re-enable: go to gmgn.ai → Smart Money → find wallets with
// >60% win rate, >30 trades in last 7 days → paste addresses here
const COPY_WALLETS = []

const BLACKLIST = new Set([
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs",
  "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",
  "So11111111111111111111111111111111111111112",
  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
  "WENWENvqqNya429ubCdR81ZmD69brwQaaBYY6p3LCpk",
  "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
  "orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE",
  // tokens that rugged you today
  "8immgrdVcwzXvSjeQBu363D6QyyLiT1pjEVYw6bonk",
  "AJwfjnjw964Z5SZPsvshJwF41EaQo2xNkKuEtHCepump",
])

const positions     = new Map()
const triedTokens   = new Map()
const walletLastSig = new Map()
let totalTrades = 0
let winTrades   = 0
let totalPnl    = 0

const TRIED_TTL_MS = 12 * 60 * 1000

async function swap(wallet, inputMint, outputMint, amount) {
  const params = new URLSearchParams({
    inputMint, outputMint, amount,
    taker: wallet.publicKey.toString()
  })
  const orderRes = await fetch(`${BASE}/ultra/v1/order?${params}`, {
    headers: { "x-api-key": process.env.JUP_API_KEY }
  })
  if (!orderRes.ok) throw new Error(`Order failed: ${orderRes.status}`)
  const order = await orderRes.json()

  const tx = VersionedTransaction.deserialize(Buffer.from(order.transaction, "base64"))
  tx.sign([wallet])
  const signedTx = Buffer.from(tx.serialize()).toString("base64")

  const execRes = await fetch(`${BASE}/ultra/v1/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": process.env.JUP_API_KEY },
    body: JSON.stringify({ signedTransaction: signedTx, requestId: order.requestId })
  })
  if (!execRes.ok) throw new Error(`Execute failed: ${execRes.status}`)
  const result = await execRes.json()
  if (result.status !== "Success") throw new Error(`Swap failed: ${JSON.stringify(result)}`)
  return result
}

async function getPrice(tokenMint) {
  try {
    const res = await fetch(`${BASE}/price/v2?ids=${tokenMint}`, {
      headers: { "x-api-key": process.env.JUP_API_KEY }
    })
    if (!res.ok) return null
    const data = await res.json()
    return parseFloat(data?.data?.[tokenMint]?.price) || null
  } catch { return null }
}

async function getDexPrice(tokenMint) {
  try {
    const res = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${tokenMint}`)
    if (!res.ok) return null
    const data = await res.json()
    if (!Array.isArray(data) || data.length === 0) return null
    const pair = data.sort((a, b) => (b.liquidity?.usd||0) - (a.liquidity?.usd||0))[0]
    return parseFloat(pair?.priceUsd) || null
  } catch { return null }
}

async function isRug(tokenMint) {
  try {
    const res = await fetch(`https://api.rugcheck.xyz/v1/tokens/${tokenMint}/report/summary`)
    if (!res.ok) {
      console.log(`⚠️  Rugcheck unavailable — rejecting to be safe`)
      return true
    }
    const data  = await res.json()
    const score = data?.score ?? 0
    const risks = data?.risks || []

    const dangerFlags = risks.filter(r => r.level === "danger").map(r => r.name)
    const warnFlags   = risks.filter(r => r.level === "warn").map(r => r.name)

    const hardReject = [
      "Freeze Authority still enabled",
      "Mint Authority still enabled",
      "Copycat token",
      "High ownership concentration",
    ]
    const hasDanger = dangerFlags.some(f => hardReject.some(h => f.includes(h)))

    if (hasDanger) { console.log(`🚨 Rug danger: ${dangerFlags.join(", ")}`); return true }
    if (score < 300) { console.log(`🚨 Rugcheck score too low: ${score}/1000`); return true }
    if (warnFlags.length >= 3) { console.log(`⚠️  Too many warn flags (${warnFlags.length})`); return true }

    console.log(`✅ Rugcheck OK | Score:${score} | Warns:${warnFlags.length}`)
    return false
  } catch (e) {
    console.log(`❌ isRug error: ${e.message} — rejecting to be safe`)
    return true
  }
}

async function getTokenBalance(walletPubkey, tokenMint) {
  try {
    const accounts = await connection.getParsedTokenAccountsByOwner(walletPubkey, {
      mint: new PublicKey(tokenMint)
    })
    if (accounts.value.length === 0) return null
    return accounts.value[0].account.data.parsed.info.tokenAmount.amount
  } catch (e) {
    console.log(`❌ getTokenBalance error: ${e.message}`)
    return null
  }
}

async function checkToken(tokenMint) {
  try {
    const res = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${tokenMint}`)
    if (!res.ok) return null
    const data = await res.json()
    if (!data || data.length === 0) return null

    const pair = data.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0]

    const liquidity     = pair?.liquidity?.usd || 0
    const volume5m      = pair?.volume?.m5 || 0
    const volume1m      = pair?.volume?.m1 || 0
    const priceChange5m = pair?.priceChange?.m5 || 0
    const priceChange1h = pair?.priceChange?.h1 || 0
    const priceChange6h = pair?.priceChange?.h6 || 0
    const fdv           = pair?.fdv || 0
    const marketCap     = pair?.marketCap || fdv
    const ageMin        = pair?.pairCreatedAt
      ? (Date.now() - pair.pairCreatedAt) / 1000 / 60
      : 9999
    const buys5m   = pair?.txns?.m5?.buys || 0
    const sells5m  = pair?.txns?.m5?.sells || 0
    const txns5m   = buys5m + sells5m
    const buyRatio = txns5m > 0 ? buys5m / txns5m : 0

    console.log(`🔎 Liq:$${Math.round(liquidity)} MC:$${Math.round(marketCap)} Age:${ageMin.toFixed(0)}m 5m:${priceChange5m}% Vol5m:$${Math.round(volume5m)} B:${buys5m} S:${sells5m} BR:${(buyRatio*100).toFixed(0)}%`)

    if (BLACKLIST.has(tokenMint))                        { console.log("❌ Blacklisted"); return null }
    if (liquidity < 3000 && ageMin > 15)                 { console.log("❌ Liq too low"); return null }
    if (liquidity > 100000)                              { console.log("❌ Too big"); return null }
    if (marketCap > 2000000)                             { console.log("❌ MC too high"); return null }
    if (ageMin > 60)                                     { console.log("❌ Too old"); return null }
    if (ageMin < 3)                                      { console.log("❌ Too new"); return null }
    if (volume5m < 1000)                                 { console.log("❌ Low vol"); return null }
    if (txns5m < 15)                                     { console.log("❌ Low txns"); return null }
    if (priceChange5m < 3)                               { console.log("❌ Not pumping"); return null }
    if (buyRatio < 0.60)                                 { console.log("❌ Too many sells"); return null }
    if (ageMin > 30 && priceChange1h < -10)              { console.log("❌ Down 1h"); return null }
    if (ageMin > 45 && priceChange6h < 10)               { console.log("❌ Weak 6h"); return null }

    let score = 0

    if (priceChange5m > 20)      score += 4
    else if (priceChange5m > 10) score += 3
    else if (priceChange5m > 5)  score += 2
    else                         score += 1

    if (volume5m > 15000)        score += 4
    else if (volume5m > 7000)    score += 3
    else if (volume5m > 3000)    score += 2
    else                         score += 1

    if (volume5m > 0 && volume1m / volume5m > 0.35) score += 2

    if (buyRatio > 0.78)         score += 3
    else if (buyRatio > 0.68)    score += 2
    else                         score += 1

    if (txns5m > 120)            score += 2
    else if (txns5m > 60)        score += 1

    if (ageMin < 10)             score += 3
    else if (ageMin < 30)        score += 2
    else if (ageMin < 60)        score += 1

    if (liquidity > 8000 && liquidity < 80000) score += 1

    console.log(`⭐ Score: ${score}/20`)
    if (score < MIN_SCORE) { console.log("❌ Score too low"); return null }

    return { pair, score, liquidity, marketCap, priceChange5m, ageMin, buyRatio, volume5m }
  } catch (e) {
    console.log(`❌ Check error: ${e.message}`)
    return null
  }
}

async function buyToken(wallet, tokenMint, source) {
  if (!tokenMint || positions.has(tokenMint)) return
  if (positions.size >= MAX_POSITIONS) return

  const lastTried = triedTokens.get(tokenMint)
  if (lastTried && Date.now() - lastTried < TRIED_TTL_MS) return
  triedTokens.set(tokenMint, Date.now())

  if (circuitBroken) { console.log(`🛑 Circuit breaker active — skipping`); return }

  console.log(`🎯 [${source}] Evaluating: ${tokenMint}`)

  const check = await checkToken(tokenMint)
  if (!check) return

  console.log(`🔍 Running rugcheck...`)
  const rug = await isRug(tokenMint)
  if (rug) return

  const buyPrice = parseFloat(check.pair?.priceUsd) || await getPrice(tokenMint)
  if (!buyPrice) { console.log(`❌ No price`); return }

  const tradeAmount = await getTradeAmount(wallet)

  try {
    const result = await swap(wallet, SOL, tokenMint, tradeAmount)
    const outAmount = result.outputAmount || result.totalOutputAmount
    console.log(`🚀 BOUGHT [${source}] score:${check.score} liq:$${Math.round(check.liquidity)} mc:$${Math.round(check.marketCap)} age:${check.ageMin.toFixed(0)}m size:${(tradeAmount/LAMPORTS_PER_SOL).toFixed(4)}SOL ${tokenMint}`)
    positions.set(tokenMint, {
      buyPrice,
      rawAmount: outAmount,
      tradeAmount,
      timestamp: Date.now(),
      source,
      score: check.score,
      peakPrice: buyPrice,
      stopPrice: buyPrice * INITIAL_STOP,
      meta: {
        ageMin: check.ageMin,
        liquidity: check.liquidity,
        marketCap: check.marketCap,
        buyRatio: check.buyRatio,
        volume5m: check.volume5m
      }
    })
  } catch (e) {
    console.log(`❌ Buy failed: ${e.message}`)
  }
}

async function monitorPositions(wallet) {
  for (const [tokenMint, pos] of positions.entries()) {
    try {
      const currentPrice = (await getPrice(tokenMint)) || (await getDexPrice(tokenMint))
      if (!currentPrice || currentPrice <= 0) continue

      const ratio   = currentPrice / pos.buyPrice
      const elapsed = Date.now() - pos.timestamp
      const pct     = ((ratio - 1) * 100).toFixed(1)
      const peakPct = ((pos.peakPrice / pos.buyPrice - 1) * 100).toFixed(1)

      if (currentPrice > pos.peakPrice) {
        pos.peakPrice = currentPrice
        pos.stopPrice = currentPrice * (1 - TRAIL_STOP_PCT)
      }

      const hitTP    = ratio >= TAKE_PROFIT
      const hitTrail = currentPrice <= pos.stopPrice && ratio < 1.05
      const hitStop  = currentPrice <= pos.buyPrice * INITIAL_STOP
      const hitTime  = elapsed >= MAX_HOLD_TIME

      if (hitTP || hitTrail || hitStop || hitTime) {
        const reason = hitTP    ? "🎯 TAKE PROFIT" :
                       hitStop  ? "🛑 HARD STOP"   :
                       hitTrail ? "📉 TRAIL STOP"  : "⏰ TIME LIMIT"
        console.log(`${reason} | ${pct}% | peak:${peakPct}% | ${tokenMint}`)
        try {
          const liveAmount = await getTokenBalance(wallet.publicKey, tokenMint)
          const sellAmount = liveAmount || pos.rawAmount
          if (!sellAmount || sellAmount === "0") {
            console.log(`⚠️  Zero balance — already sold or error`)
            positions.delete(tokenMint)
            continue
          }

          await swap(wallet, tokenMint, SOL, sellAmount)
          const tradePnl = (ratio - 1) * 100
          totalTrades++
          totalPnl += tradePnl
          const isWin = tradePnl > 0
          if (isWin) winTrades++
          const winRate = ((winTrades / totalTrades) * 100).toFixed(0)
          console.log(`✅ Sold ${pct}% | Trades:${totalTrades} | WR:${winRate}% | PnL:${totalPnl.toFixed(1)}%`)

          logTrade({
            timestamp: new Date().toISOString(),
            token: tokenMint,
            source: pos.source,
            score: pos.score,
            buyPrice: pos.buyPrice,
            sellPrice: currentPrice,
            pct: parseFloat(pct),
            result: isWin ? "WIN" : "LOSS",
            ageMin: pos.meta?.ageMin?.toFixed(1) || 0,
            liquidity: Math.round(pos.meta?.liquidity || 0),
            marketCap: Math.round(pos.meta?.marketCap || 0),
            buyRatio: pos.meta?.buyRatio?.toFixed(2) || 0,
            volume5m: Math.round(pos.meta?.volume5m || 0),
            holdSeconds: Math.round(elapsed / 1000)
          })
        } catch (e) {
          console.log(`❌ Sell failed: ${e.message}`)
        }
        positions.delete(tokenMint)
      } else {
        console.log(`📊 ${tokenMint.slice(0,8)}... | ${pct}% | peak:${peakPct}% | stop:${(((pos.stopPrice/pos.buyPrice)-1)*100).toFixed(1)}% | ${Math.floor(elapsed/1000)}s`)
      }
    } catch (e) {
      console.log(`❌ Monitor error: ${e.message}`)
    }
  }
}

async function scanCopyWallets(wallet) {
  if (COPY_WALLETS.length === 0) return
  for (const copyWallet of COPY_WALLETS) {
    try {
      await sleep(2500)
      const sigs = await connection.getSignaturesForAddress(
        new PublicKey(copyWallet),
        { limit: 3 }
      )
      if (sigs.length === 0) continue

      const lastSig = walletLastSig.get(copyWallet)
      const newSigs = lastSig
        ? sigs.filter(s => s.signature !== lastSig).slice(0, 2)
        : sigs.slice(0, 1)

      walletLastSig.set(copyWallet, sigs[0].signature)

      for (const sigInfo of newSigs) {
        try {
          await sleep(1200)
          const tx = await connection.getParsedTransaction(sigInfo.signature, {
            maxSupportedTransactionVersion: 0
          })
          if (!tx) continue

          const preBalances  = tx.meta?.preTokenBalances || []
          const postBalances = tx.meta?.postTokenBalances || []

          const bought = postBalances.filter(post => {
            const pre = preBalances.find(p =>
              p.accountIndex === post.accountIndex &&
              p.mint === post.mint
            )
            const preAmt  = parseFloat(pre?.uiTokenAmount?.uiAmount || 0)
            const postAmt = parseFloat(post?.uiTokenAmount?.uiAmount || 0)
            return postAmt > preAmt && post.mint !== SOL
          })

          for (const b of bought) {
            if (BLACKLIST.has(b.mint)) continue
            console.log(`👛 Copy wallet ${copyWallet.slice(0,8)}... bought: ${b.mint}`)
            await buyToken(wallet, b.mint, "COPY_TRADE")
          }
        } catch (e) {}
      }
    } catch (e) {
      console.log(`❌ Wallet scan error ${copyWallet.slice(0,8)}...: ${e.message}`)
    }
  }
}

async function scanPumpFun(wallet) {
  try {
    const res = await fetch("https://frontend-api.pump.fun/coins?offset=0&limit=20&sort=market_cap&order=DESC&includeNsfw=false")
    if (!res.ok) return
    const coins = await res.json()

    for (const coin of coins) {
      if (!coin.mint || coin.complete) continue
      const mcap = coin.usd_market_cap || 0
      if (mcap < 55000 || mcap > 69000) continue
      console.log(`🎓 Near grad: ${coin.symbol} MC:$${Math.round(mcap)} ${coin.mint}`)
      await buyToken(wallet, coin.mint, "PUMP_GRAD")
      await sleep(600)
    }

    const gradRes = await fetch("https://frontend-api.pump.fun/coins?offset=0&limit=20&sort=last_trade_timestamp&order=DESC&includeNsfw=false")
    if (!gradRes.ok) return
    const gradCoins = await gradRes.json()

    for (const coin of gradCoins) {
      if (!coin.mint || !coin.complete) continue
      const ageMin = (Date.now() - coin.created_timestamp) / 1000 / 60
      if (ageMin > 25) continue
      console.log(`🆕 Graduated: ${coin.symbol} age:${ageMin.toFixed(0)}m ${coin.mint}`)
      await buyToken(wallet, coin.mint, "PUMP_NEW")
      await sleep(600)
    }
  } catch (e) {
    console.log(`❌ Pump.fun error: ${e.message}`)
  }
}

async function scanDexScreener(wallet) {
  try {
    console.log("🔍 Scanning DexScreener...")
    const newRes = await fetch("https://api.dexscreener.com/token-profiles/latest/v1")
    if (!newRes.ok) return
    const tokens = await newRes.json()
    const newSolana = tokens
      .filter(t => t.chainId === "solana")
      .slice(0, 12)
    for (const t of newSolana) {
      if (t.tokenAddress) {
        await buyToken(wallet, t.tokenAddress, "NEW")
        await sleep(600)
      }
    }
  } catch (e) {
    console.log(`❌ DexScreener error: ${e.message}`)
  }
}

async function runBot() {
  const wallet = loadWallet()
  console.log("🚀 Bot running:", wallet.publicKey.toString())
  console.log(`⚙️  size:8% | tp:+40% | stop:-8% | trail:7% | hold:${MAX_HOLD_TIME/1000}s | maxPos:${MAX_POSITIONS} | minScore:${MIN_SCORE}/20`)
  console.log(`👛 Copy wallets: ${COPY_WALLETS.length} (disabled — add verified wallets from gmgn.ai)`)
  console.log(`🛡️  Rug check: ON | Circuit breaker: -${DAILY_LOSS_LIMIT_PCT*100}%/day`)

  try {
    const bal = await connection.getBalance(wallet.publicKey)
    dayStartBalance = bal / LAMPORTS_PER_SOL
    console.log(`📊 Starting balance: ${dayStartBalance.toFixed(4)} SOL`)
  } catch {}

  await scanDexScreener(wallet)
  await scanPumpFun(wallet)
  await scanCopyWallets(wallet)

  let lastDexScan    = Date.now()
  let lastPumpScan   = Date.now()
  let lastWalletScan = Date.now()
  let lastStats      = Date.now()

  while (true) {
    await monitorPositions(wallet)
    await checkCircuitBreaker(wallet)

    if (Date.now() - lastDexScan > DEX_SCAN_INTERVAL) {
      await scanDexScreener(wallet)
      lastDexScan = Date.now()
    }
    if (Date.now() - lastPumpScan > PUMP_SCAN_INTERVAL) {
      await scanPumpFun(wallet)
      lastPumpScan = Date.now()
    }
    if (Date.now() - lastWalletScan > WALLET_SCAN_INTERVAL) {
      await scanCopyWallets(wallet)
      lastWalletScan = Date.now()
    }
    if (Date.now() - lastStats > 300000) {
      const wr = totalTrades > 0 ? ((winTrades/totalTrades)*100).toFixed(0) : 0
      const bal = await connection.getBalance(wallet.publicKey)
      console.log(`📈 STATS | Trades:${totalTrades} | WR:${wr}% | PnL:${totalPnl.toFixed(1)}% | Balance:${(bal/LAMPORTS_PER_SOL).toFixed(4)}SOL | Open:${positions.size}`)
      printStats()
      lastStats = Date.now()
    }

    await sleep(2000)
  }
}

runBot()
