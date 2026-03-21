const fetch = require("node-fetch")
const bs58 = require("bs58")
const {
  Keypair,
  Connection,
  VersionedTransaction
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

const SOL = "So11111111111111111111111111111111111111112"
const BASE = "https://api.jup.ag"
const BUY_AMOUNT = 20000000
const TAKE_PROFIT = 2.0
const STOP_LOSS = 0.6
const MAX_HOLD_TIME = 90000
const DEX_SCAN_INTERVAL = 20000

const BLACKLIST = new Set([
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs",
  "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",
  "So11111111111111111111111111111111111111112",
])

const positions = new Map()
const triedTokens = new Set()

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

    const pair = data[0]
    const liquidity = pair?.liquidity?.usd || 0
    const volume5m = pair?.volume?.m5 || 0
    const priceChange5m = pair?.priceChange?.m5 || 0
    const priceChange1h = pair?.priceChange?.h1 || 0
    const fdv = pair?.fdv || 0
    const ageMin = pair?.pairCreatedAt
      ? (Date.now() - pair.pairCreatedAt) / 1000 / 60
      : 9999
    const txns5m = (pair?.txns?.m5?.buys || 0) + (pair?.txns?.m5?.sells || 0)

    console.log(`🔎 Liq: $${Math.round(liquidity)} | FDV: $${Math.round(fdv)} | Age: ${ageMin.toFixed(0)}min | 5m: ${priceChange5m}% | Vol5m: $${Math.round(volume5m)} | Txns5m: ${txns5m}`)

    if (BLACKLIST.has(tokenMint)) { console.log("❌ Blacklisted"); return null }
    if (liquidity < 3000) { console.log("❌ Liquidity too low"); return null }
    if (liquidity > 200000) { console.log("❌ Too big"); return null }
    if (fdv > 5000000) { console.log("❌ FDV too high"); return null }
    if (ageMin > 180) { console.log("❌ Token too old"); return null }
    if (volume5m < 500) { console.log("❌ Not enough 5m volume"); return null }
    if (txns5m < 10) { console.log("❌ Not enough transactions"); return null }
    if (priceChange5m < 2) { console.log("❌ Not pumping fast enough"); return null }

    // Only apply 1h filter if token is older than 30 min
    if (ageMin > 30 && priceChange1h < 0) { console.log("❌ Down on 1h — avoid"); return null }

    let score = 0
    if (priceChange5m > 10) score += 3
    else if (priceChange5m > 5) score += 2
    else score += 1

    if (volume5m > 5000) score += 3
    else if (volume5m > 2000) score += 2
    else score += 1

    if (txns5m > 50) score += 2
    else if (txns5m > 20) score += 1

    if (liquidity > 20000) score += 2
    if (ageMin < 30) score += 2

    console.log(`⭐ Score: ${score}/12`)
    if (score < 5) { console.log("❌ Score too low"); return null }

    return { pair, score, liquidity, fdv, priceChange5m, ageMin }
  } catch (e) {
    console.log(`❌ Check error: ${e.message}`)
    return null
  }
}

async function buyToken(wallet, tokenMint, source) {
  if (!tokenMint || positions.has(tokenMint)) return
  if (triedTokens.has(tokenMint)) return
  if (positions.size >= 3) return

  triedTokens.add(tokenMint)
  console.log(`🎯 [${source}] Evaluating: ${tokenMint}`)

  const check = await checkToken(tokenMint)
  if (!check) return

  const buyPrice = await getPrice(tokenMint)
  if (!buyPrice) { console.log(`❌ No price`); return }

  try {
    const result = await swap(wallet, SOL, tokenMint, BUY_AMOUNT)
    const outAmount = result.outputAmount || result.totalOutputAmount
    console.log(`✅ BOUGHT | score:${check.score} | liq:$${Math.round(check.liquidity)} | fdv:$${Math.round(check.fdv)} | ${tokenMint}`)
    positions.set(tokenMint, { buyPrice, amount: outAmount, timestamp: Date.now(), source, score: check.score })
  } catch (e) {
    console.log(`❌ Buy failed: ${e.message}`)
  }
}

async function monitorPositions(wallet) {
  for (const [tokenMint, pos] of positions.entries()) {
    try {
      const currentPrice = await getPrice(tokenMint)
      if (!currentPrice) continue

      const ratio = currentPrice / pos.buyPrice
      const elapsed = Date.now() - pos.timestamp
      const pct = ((ratio - 1) * 100).toFixed(1)

      if (ratio >= TAKE_PROFIT || ratio <= STOP_LOSS || elapsed >= MAX_HOLD_TIME) {
        const reason = ratio >= TAKE_PROFIT ? "🎯 TAKE PROFIT" :
                       ratio <= STOP_LOSS   ? "🛑 STOP LOSS"  : "⏰ TIME LIMIT"
        console.log(`${reason} | ${pct}% | ${tokenMint}`)
        await swap(wallet, tokenMint, SOL, pos.amount)
        console.log(`✅ Sold`)
        positions.delete(tokenMint)
      } else {
        console.log(`📊 ${tokenMint.slice(0,8)}... | ${pct}% | ${Math.floor(elapsed/1000)}s`)
      }
    } catch (e) {
      console.log(`❌ Monitor error: ${e.message}`)
    }
  }
}

async function scanDexScreener(wallet) {
  try {
    console.log("🔍 Scanning...")

    const boostRes = await fetch("https://api.dexscreener.com/token-boosts/top/v1")
    if (boostRes.ok) {
      const tokens = await boostRes.json()
      const top = tokens.filter(t => t.chainId === "solana").slice(0, 8)
      for (const t of top) {
        if (t.tokenAddress) {
          await buyToken(wallet, t.tokenAddress, "BOOST")
          await sleep(300)
        }
      }
    }

    const newRes = await fetch("https://api.dexscreener.com/token-profiles/latest/v1")
    if (newRes.ok) {
      const tokens = await newRes.json()
      const newSolana = tokens.filter(t => t.chainId === "solana").slice(0, 8)
      for (const t of newSolana) {
        if (t.tokenAddress) {
          await buyToken(wallet, t.tokenAddress, "NEW")
          await sleep(300)
        }
      }
    }
  } catch (e) {
    console.log(`❌ Scan error: ${e.message}`)
  }
}

async function runBot() {
  const wallet = loadWallet()
  console.log("🚀 Bot running:", wallet.publicKey.toString())

  await scanDexScreener(wallet)

  let lastScan = Date.now()

  while (true) {
    await monitorPositions(wallet)

    if (Date.now() - lastScan > DEX_SCAN_INTERVAL) {
      await scanDexScreener(wallet)
      lastScan = Date.now()
    }

    await sleep(3000)
  }
}

runBot()
