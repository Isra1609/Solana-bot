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

// ✅ NEW: RUG CHECK
async function rugCheck(tokenMint) {
  try {
    const res = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${tokenMint}`)
    if (!res.ok) return false
    const data = await res.json()
    if (!data || data.length === 0) return false

    const pair = data[0]
    const liquidity = pair?.liquidity?.usd || 0
    const fdv = pair?.fdv || 0

    if (liquidity < fdv * 0.05) {
      console.log("❌ Liquidity too low vs MC")
      return false
    }

    if (liquidity < 20000) {
      console.log("❌ Unsafe liquidity")
      return false
    }

    return true
  } catch {
    return false
  }
}

async function getTradeAmount(wallet) {
  const balance = await connection.getBalance(wallet.publicKey)
  const solBalance = balance / LAMPORTS_PER_SOL

  // ✅ SAFER SIZE (10%)
  const tradeAmount = Math.floor((solBalance * 0.1) * LAMPORTS_PER_SOL)

  return Math.max(10000000, Math.min(500000000, tradeAmount))
}

const SOL = "So11111111111111111111111111111111111111112"
const BASE = "https://api.jup.ag"

const TAKE_PROFIT = 3.0
const INITIAL_STOP = 0.75
const TRAIL_STOP_PCT = 0.12
const MAX_HOLD_TIME = 120000

const positions = new Map()
const triedTokens = new Set()

async function getPrice(tokenMint) {
  try {
    const res = await fetch(`${BASE}/price/v2?ids=${tokenMint}`, {
      headers: { "x-api-key": process.env.JUP_API_KEY }
    })
    const data = await res.json()
    return parseFloat(data?.data?.[tokenMint]?.price) || null
  } catch { return null }
}

// ✅ FULLY FIXED FILTERS
async function checkToken(tokenMint) {
  try {
    const res = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${tokenMint}`)
    const data = await res.json()
    if (!data || data.length === 0) return null

    const pair = data[0]

    const liquidity = pair?.liquidity?.usd || 0
    const volume5m = pair?.volume?.m5 || 0
    const priceChange5m = pair?.priceChange?.m5 || 0
    const priceChange1h = pair?.priceChange?.h1 || 0
    const marketCap = pair?.marketCap || pair?.fdv || 0
    const ageMin = pair?.pairCreatedAt
      ? (Date.now() - pair.pairCreatedAt) / 60000
      : 9999

    const buys = pair?.txns?.m5?.buys || 0
    const sells = pair?.txns?.m5?.sells || 0
    const txns = buys + sells
    const buyRatio = txns > 0 ? buys / txns : 0

    // 🚫 STRICT RUG FILTERS
    if (liquidity < 15000) return null
    if (liquidity > 200000) return null

    if (marketCap < 50000 || marketCap > 2000000) return null

    if (ageMin < 5 || ageMin > 90) return null

    if (volume5m < 2000) return null
    if (txns < 25) return null

    if (buyRatio < 0.65) return null

    if (priceChange5m < 8) return null
    if (priceChange1h < -5) return null

    return { pair, liquidity, marketCap }
  } catch {
    return null
  }
}

async function swap(wallet, inputMint, outputMint, amount) {
  const params = new URLSearchParams({
    inputMint, outputMint, amount,
    taker: wallet.publicKey.toString()
  })

  const order = await fetch(`${BASE}/ultra/v1/order?${params}`, {
    headers: { "x-api-key": process.env.JUP_API_KEY }
  }).then(r => r.json())

  const tx = VersionedTransaction.deserialize(Buffer.from(order.transaction, "base64"))
  tx.sign([wallet])

  const exec = await fetch(`${BASE}/ultra/v1/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": process.env.JUP_API_KEY },
    body: JSON.stringify({
      signedTransaction: Buffer.from(tx.serialize()).toString("base64"),
      requestId: order.requestId
    })
  }).then(r => r.json())

  return exec
}

async function buyToken(wallet, tokenMint) {
  if (positions.has(tokenMint)) return
  if (triedTokens.has(tokenMint)) return

  triedTokens.add(tokenMint)

  const check = await checkToken(tokenMint)
  if (!check) return

  // ✅ RUG CHECK
  const safe = await rugCheck(tokenMint)
  if (!safe) return

  const price = await getPrice(tokenMint)
  if (!price) return

  const amount = await getTradeAmount(wallet)

  const result = await swap(wallet, SOL, tokenMint, amount)

  positions.set(tokenMint, {
    buyPrice: price,
    amount: result.outputAmount,
    peakPrice: price,
    stopPrice: price * INITIAL_STOP,
    timestamp: Date.now()
  })

  console.log("🚀 BOUGHT:", tokenMint)
}

async function monitor(wallet) {
  for (const [token, pos] of positions) {
    const price = await getPrice(token)
    if (!price) continue

    const ratio = price / pos.buyPrice

    if (price > pos.peakPrice) {
      pos.peakPrice = price
      pos.stopPrice = price * (1 - TRAIL_STOP_PCT)
    }

    if (
      ratio >= TAKE_PROFIT ||
      price <= pos.stopPrice ||
      Date.now() - pos.timestamp > MAX_HOLD_TIME
    ) {
      await swap(wallet, token, SOL, pos.amount)
      positions.delete(token)
      console.log("💰 SOLD:", token)
    }
  }
}

async function runBot() {
  const wallet = loadWallet()
  console.log("🚀 Running:", wallet.publicKey.toString())

  while (true) {
    await monitor(wallet)

    const res = await fetch("https://api.dexscreener.com/token-profiles/latest/v1")
    const tokens = await res.json()

    for (const t of tokens.slice(0, 5)) {
      if (t.chainId === "solana") {
        await buyToken(wallet, t.tokenAddress)
      }
    }

    await sleep(5000)
  }
}

runBot()
