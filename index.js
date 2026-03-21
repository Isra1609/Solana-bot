const fetch = require("node-fetch")
const bs58 = require("bs58")
const {
  Keypair,
  Connection,
  VersionedTransaction,
  LAMPORTS_PER_SOL
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

async function getTradeAmount(wallet) {
  try {
    const balance = await connection.getBalance(wallet.publicKey)
    const solBalance = balance / LAMPORTS_PER_SOL
    const tradeAmount = Math.floor((solBalance * 0.25) * LAMPORTS_PER_SOL)
    const minAmount = 10000000
    const maxAmount = 500000000
    const finalAmount = Math.max(minAmount, Math.min(maxAmount, tradeAmount))
    console.log(`💰 Balance: ${solBalance.toFixed(4)} SOL | Trade: ${(finalAmount/LAMPORTS_PER_SOL).toFixed(4)} SOL (25%)`)
    return finalAmount
  } catch (e) {
    console.log(`❌ Balance check failed: ${e.message}`)
    return 20000000
  }
}

const SOL = "So11111111111111111111111111111111111111112"
const BASE = "https://api.jup.ag"

const TAKE_PROFIT        = 3.0
const INITIAL_STOP       = 0.75
const TRAIL_STOP_PCT     = 0.12
const MAX_HOLD_TIME      = 120000
const DEX_SCAN_INTERVAL  = 10000
const PUMP_SCAN_INTERVAL = 8000
const MAX_POSITIONS      = 2
const MIN_SCORE          = 7

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
])

const positions = new Map()
const triedTokens = new Set()
let totalTrades = 0
let winTrades = 0
let totalPnl = 0

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

async function checkToken(tokenMint) {
  try {
    const res = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${tokenMint}`)
    if (!res.ok) return null
    const data = await res.json()
    if (!data || data.length === 0) return null

    const pair = data.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0]

    const liquidity     = pair?.liquidity?.usd || 0
    const volume5m      = pair?.volume?.m5 || 0
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

    if (BLACKLIST.has(tokenMint))             { console.log("❌ Blacklisted"); return null }
    if (liquidity < 1000)                     { console.log("❌ Liq too low"); return null }
    if (liquidity > 150000)                   { console.log("❌ Too big"); return null }
    if (marketCap > 3000000)                  { console.log("❌ MC too high"); return null }
    if (ageMin > 120)                         { console.log("❌ Too old"); return null }
    if (ageMin < 2)                           { console.log("❌ Too new"); return null }
    if (volume5m < 500)                       { console.log("❌ Low vol"); return null }
    if (txns5m < 10)                          { console.log("❌ Low txns"); return null }
    if (priceChange5m < 3)                    { console.log("❌ Not pumping"); return null }
    if (buyRatio < 0.55)                      { console.log("❌ Too many sells"); return null }
    if (ageMin > 30 && priceChange1h < 0)     { console.log("❌ Down 1h"); return null }
    if (ageMin > 60 && priceChange6h < 10)    { console.log("❌ Weak 6h"); return null }

    let score = 0

    if (priceChange5m > 20)      score += 4
    else if (priceChange5m > 10) score += 3
    else if (priceChange5m > 5)  score += 2
    else                         score += 1

    if (volume5m > 10000)        score += 4
    else if (volume5m > 5000)    score += 3
    else if (volume5m > 2000)    score += 2
    else                         score += 1

    if (buyRatio > 0.75)         score += 3
    else if (buyRatio > 0.65)    score += 2
    else                         score += 1

    if (txns5m > 100)            score += 2
    else if (txns5m > 50)        score += 1

    if (ageMin < 10)             score += 3
    else if (ageMin < 30)        score += 2
    else if (ageMin < 60)        score += 1

    if (liquidity > 10000 && liquidity < 80000) score += 2

    console.log(`⭐ Score: ${score}/18`)
    if (score < MIN_SCORE) { console.log("❌ Score too low"); return null }

    return { pair, score, liquidity, marketCap, priceChange5m, ageMin, buyRatio, volume5m }
  } catch (e) {
    console.log(`❌ Check error: ${e.message}`)
    return null
  }
}

async function buyToken(wallet, tokenMint, source) {
  if (!tokenMint || positions.has(tokenMint)) return
  if (triedTokens.has(tokenMint)) return
  if (positions.size >= MAX_POSITIONS) return

  triedTokens.add(tokenMint)
  console.log(`🎯 [${source}] Evaluating: ${tokenMint}`)

  const check = await checkToken(tokenMint)
  if (!check) return

  const buyPrice = await getPrice(tokenMint)
  if (!buyPrice) { console.log(`❌ No price`); return }

  const tradeAmount = await getTradeAmount(wallet)

  try {
    const result = await swap(wallet, SOL, tokenMint, tradeAmount)
    const outAmount = result.outputAmount || result.totalOutputAmount
    console.log(`🚀 BOUGHT [${source}] score:${check.score} liq:$${Math.round(check.liquidity)} mc:$${Math.round(check.marketCap)} age:${check.ageMin.toFixed(0)}m size:${(tradeAmount/LAMPORTS_PER_SOL).toFixed(4)}SOL ${tokenMint}`)
    positions.set(tokenMint, {
      buyPrice,
      amount: outAmount,
      tradeAmount,
      timestamp: Date.now(),
      source,
      score: check.score,
      peakPrice: buyPrice,
      stopPrice: buyPrice * INITIAL_STOP
    })
  } catch (e) {
    console.log(`❌ Buy failed: ${e.message}`)
  }
}

async function monitorPositions(wallet) {
  for (const [tokenMint, pos] of positions.entries()) {
    try {
      const currentPrice = await getPrice(tokenMint)
      if (!currentPrice) continue

      const ratio   = currentPrice / pos.buyPrice
      const elapsed = Date.now() - pos.timestamp
      const pct     = ((ratio - 1) * 100).toFixed(1)
      const peakPct = ((pos.peakPrice / pos.buyPrice - 1) * 100).toFixed(1)

      if (currentPrice > pos.peakPrice) {
        pos.peakPrice = currentPrice
        pos.stopPrice = currentPrice * (1 - TRAIL_STOP_PCT)
      }

      const hitTP    = ratio >= TAKE_PROFIT
      const hitTrail = currentPrice <= pos.stopPrice
      const hitTime  = elapsed >= MAX_HOLD_TIME

      if (hitTP || hitTrail || hitTime) {
        const reason = hitTP    ? "🎯 TAKE PROFIT" :
                       hitTrail ? "📉 TRAIL STOP"  : "⏰ TIME LIMIT"
        console.log(`${reason} | ${pct}% | peak:${peakPct}% | ${tokenMint}`)
        try {
          await swap(wallet, tokenMint, SOL, pos.amount)
          const tradePnl = (ratio - 1) * 100
          totalTrades++
          totalPnl += tradePnl
          if (tradePnl > 0) winTrades++
          const winRate = ((winTrades / totalTrades) * 100).toFixed(0)
          console.log(`✅ Sold ${pct}% | Trades:${totalTrades} | WR:${winRate}% | PnL:${totalPnl.toFixed(1)}%`)
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

async function scanPumpFun(wallet) {
  try {
    const res = await fetch("https://frontend-api.pump.fun/coins?offset=0&limit=20&sort=market_cap&order=DESC&includeNsfw=false")
    if (!res.ok) return
    const coins = await res.json()

    for (const coin of coins) {
      if (!coin.mint || coin.complete) continue
      const mcap = coin.usd_market_cap || 0
      if (mcap < 50000 || mcap > 69000) continue
      console.log(`🎓 Near grad: ${coin.symbol} MC:$${Math.round(mcap)} ${coin.mint}`)
      await buyToken(wallet, coin.mint, "PUMP_GRAD")
      await sleep(200)
    }

    const gradRes = await fetch("https://frontend-api.pump.fun/coins?offset=0&limit=20&sort=last_trade_timestamp&order=DESC&includeNsfw=false")
    if (!gradRes.ok) return
    const gradCoins = await gradRes.json()

    for (const coin of gradCoins) {
      if (!coin.mint || !coin.complete) continue
      const ageMin = (Date.now() - coin.created_timestamp) / 1000 / 60
      if (ageMin > 30) continue
      console.log(`🆕 Graduated: ${coin.symbol} age:${ageMin.toFixed(0)}m ${coin.mint}`)
      await buyToken(wallet, coin.mint, "PUMP_NEW")
      await sleep(200)
    }
  } catch (e) {
    console.log(`❌ Pump.fun error: ${e.message}`)
  }
}

async function scanDexScreener(wallet) {
  try {
    console.log("🔍 Scanning DexScreener...")

    const boostRes = await fetch("https://api.dexscreener.com/token-boosts/top/v1")
    if (boostRes.ok) {
      const tokens = await boostRes.json()
      const top = tokens
        .filter(t => t.chainId === "solana")
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 10)
      for (const t of top) {
        if (t.tokenAddress) {
          await buyToken(wallet, t.tokenAddress, "BOOST")
          await sleep(200)
        }
      }
    }

    const newRes = await fetch("https://api.dexscreener.com/token-profiles/latest/v1")
    if (newRes.ok) {
      const tokens = await newRes.json()
      const newSolana = tokens
        .filter(t => t.chainId === "solana")
        .slice(0, 10)
      for (const t of newSolana) {
        if (t.tokenAddress) {
          await buyToken(wallet, t.tokenAddress, "NEW")
          await sleep(200)
        }
      }
    }
  } catch (e) {
    console.log(`❌ DexScreener error: ${e.message}`)
  }
}

async function runBot() {
  const wallet = loadWallet()
  console.log("🚀 Bot running:", wallet.publicKey.toString())
  console.log(`⚙️  sizing:25% | tp:${TAKE_PROFIT}x | trail:${TRAIL_STOP_PCT*100}% | stop:${(1-INITIAL_STOP)*100}% | hold:${MAX_HOLD_TIME/1000}s | maxPos:${MAX_POSITIONS}`)

  await scanDexScreener(wallet)
  await scanPumpFun(wallet)

  let lastDexScan  = Date.now()
  let lastPumpScan = Date.now()
  let lastStats    = Date.now()

  while (true) {
    await monitorPositions(wallet)

    if (Date.now() - lastDexScan > DEX_SCAN_INTERVAL) {
      await scanDexScreener(wallet)
      lastDexScan = Date.now()
    }

    if (Date.now() - lastPumpScan > PUMP_SCAN_INTERVAL) {
      await scanPumpFun(wallet)
      lastPumpScan = Date.now()
    }

    if (Date.now() - lastStats > 300000) {
      const wr = totalTrades > 0 ? ((winTrades/totalTrades)*100).toFixed(0) : 0
      const bal = await connection.getBalance(wallet.publicKey)
      console.log(`📈 STATS | Trades:${totalTrades} | WR:${wr}% | PnL:${totalPnl.toFixed(1)}% | Balance:${(bal/LAMPORTS_PER_SOL).toFixed(4)}SOL | Open:${positions.size}`)
      lastStats = Date.now()
    }

    await sleep(2000)
  }
}

runBot()
