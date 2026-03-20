const fetch = require("node-fetch")
const bs58 = require("bs58")
const {
  Keypair,
  Connection,
  VersionedTransaction,
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

const SOL = "So11111111111111111111111111111111111111112"
const BASE = "https://api.jup.ag"
const BUY_AMOUNT = 20000000
const TAKE_PROFIT = 2.0
const STOP_LOSS = 0.5
const MAX_HOLD_TIME = 60000
const DEX_SCAN_INTERVAL = 30000

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

// ── NEW SAFETY CHECK — uses DexScreener data ──────────────────────────────────
async function isSafe(tokenMint) {
  try {
    const res = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${tokenMint}`)
    if (!res.ok) return false
    const data = await res.json()

    if (!data || data.length === 0) return false
    const pair = data[0]

    const liquidity = pair?.liquidity?.usd || 0
    const volume24h = pair?.volume?.h24 || 0
    const age = pair?.pairCreatedAt
      ? (Date.now() - pair.pairCreatedAt) / 1000 / 60  // age in minutes
      : 9999

    console.log(`🔎 Liquidity: $${liquidity} | Vol24h: $${volume24h} | Age: ${age.toFixed(1)}min`)

    // Filters:
    if (liquidity < 5000) { console.log("❌ Too little liquidity"); return false }
    if (liquidity > 500000) { console.log("❌ Too big, not enough upside"); return false }
    if (volume24h < 1000) { console.log("❌ Too little volume"); return false }
    if (age > 120) { console.log("❌ Token too old"); return false }

    return true
  } catch (e) {
    console.log(`❌ Safety check error: ${e.message}`)
    return false
  }
}

async function buyToken(wallet, tokenMint, source) {
  if (!tokenMint || positions.has(tokenMint)) return
  if (triedTokens.has(tokenMint)) return
  if (positions.size >= 3) return

  triedTokens.add(tokenMint)
  console.log(`🎯 [${source}] Trying: ${tokenMint}`)

  const safe = await isSafe(tokenMint)
  if (!safe) return

  const buyPrice = await getPrice(tokenMint)
  if (!buyPrice) { console.log(`❌ No price found`); return }

  try {
    const result = await swap(wallet, SOL, tokenMint, BUY_AMOUNT)
    const outAmount = result.outputAmount || result.totalOutputAmount
    console.log(`✅ Bought ${tokenMint} | price: $${buyPrice} | amount: ${outAmount}`)
    positions.set(tokenMint, { buyPrice, amount: outAmount, timestamp: Date.now(), source })
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
        console.log(`✅ Sold ${tokenMint}`)
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
    console.log("🔍 Scanning DexScreener...")

    // Top boosted tokens
    const boostRes = await fetch("https://api.dexscreener.com/token-boosts/top/v1")
    if (boostRes.ok) {
      const tokens = await boostRes.json()
      const top = tokens
        .filter(t => t.chainId === "solana" && t.amount > 50)
        .slice(0, 5)
      for (const token of top) {
        if (token.tokenAddress) {
          console.log(`📈 Boosted: ${token.tokenAddress} | boost: ${token.amount}`)
          await buyToken(wallet, token.tokenAddress, "BOOST")
          await sleep(500)
        }
      }
    }

    // Latest new tokens
    const newRes = await fetch("https://api.dexscreener.com/token-profiles/latest/v1")
    if (newRes.ok) {
      const tokens = await newRes.json()
      const newSolana = tokens.filter(t => t.chainId === "solana").slice(0, 5)
      for (const token of newSolana) {
        if (token.tokenAddress) {
          console.log(`🆕 New token: ${token.tokenAddress}`)
          await buyToken(wallet, token.tokenAddress, "NEW")
          await sleep(500)
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

  await scanDexScreener(wallet)

  let lastDexScan = Date.now()

  while (true) {
    await monitorPositions(wallet)

    if (Date.now() - lastDexScan > DEX_SCAN_INTERVAL) {
      await scanDexScreener(wallet)
      lastDexScan = Date.now()
    }

    await sleep(3000)
  }
}

runBot()
