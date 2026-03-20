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
const RAYDIUM_PROGRAM = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"
const BUY_AMOUNT = 20000000      // 0.02 SOL per snipe
const TAKE_PROFIT = 2.0          // sell at 2x
const STOP_LOSS = 0.5            // sell at -50%
const CHECK_INTERVAL = 3000      // check price every 3s
const MAX_HOLD_TIME = 60000      // force sell after 60s

const positions = new Map()      // tokenMint -> { buyPrice, amount, timestamp }

// ── JUPITER SWAP ──────────────────────────────────────────────────────────────
async function swap(wallet, inputMint, outputMint, amount) {
  const params = new URLSearchParams({ inputMint, outputMint, amount, taker: wallet.publicKey.toString() })
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

// ── GET TOKEN PRICE VIA JUPITER ───────────────────────────────────────────────
async function getPrice(tokenMint) {
  const res = await fetch(`${BASE}/price/v2?ids=${tokenMint}&vsToken=${SOL}`, {
    headers: { "x-api-key": process.env.JUP_API_KEY }
  })
  if (!res.ok) return null
  const data = await res.json()
  return data?.data?.[tokenMint]?.price || null
}

// ── SAFETY CHECKS ─────────────────────────────────────────────────────────────
async function isSafe(tokenMint) {
  try {
    // Check token metadata via Jupiter token list
    const res = await fetch(`${BASE}/tokens/v1/token/${tokenMint}`, {
      headers: { "x-api-key": process.env.JUP_API_KEY }
    })
    if (!res.ok) return false
    const token = await res.json()

    // Skip if freeze authority not revoked (rug risk)
    if (token.freezeAuthority) {
      console.log("⚠️ Freeze authority not revoked, skipping")
      return false
    }
    // Skip if mint authority not revoked
    if (token.mintAuthority) {
      console.log("⚠️ Mint authority not revoked, skipping")
      return false
    }

    return true
  } catch {
    return false
  }
}

// ── MONITOR POSITIONS ─────────────────────────────────────────────────────────
async function monitorPositions(wallet) {
  for (const [tokenMint, pos] of positions.entries()) {
    try {
      const currentPrice = await getPrice(tokenMint)
      if (!currentPrice) continue

      const ratio = currentPrice / pos.buyPrice
      const elapsed = Date.now() - pos.timestamp
      const shouldSell =
        ratio >= TAKE_PROFIT ||
        ratio <= STOP_LOSS ||
        elapsed >= MAX_HOLD_TIME

      if (shouldSell) {
        const reason = ratio >= TAKE_PROFIT ? "🎯 TAKE PROFIT" :
                       ratio <= STOP_LOSS   ? "🛑 STOP LOSS"  : "⏰ TIME LIMIT"
        console.log(`${reason} on ${tokenMint} | ${(ratio * 100 - 100).toFixed(1)}%`)
        await swap(wallet, tokenMint, SOL, pos.amount)
        console.log(`✅ Sold ${tokenMint}`)
        positions.delete(tokenMint)
      }
    } catch (e) {
      console.log(`❌ Monitor error for ${tokenMint}:`, e.message)
    }
  }
}

// ── SNIPE NEW POOL ─────────────────────────────────────────────────────────────
async function snipeToken(wallet, tokenMint) {
  if (positions.has(tokenMint)) return
  if (positions.size >= 3) return  // max 3 open positions

  console.log(`🎯 Sniping: ${tokenMint}`)

  const safe = await isSafe(tokenMint)
  if (!safe) {
    console.log(`❌ Safety check failed for ${tokenMint}`)
    return
  }

  const buyPrice = await getPrice(tokenMint)
  if (!buyPrice) return

  try {
    const result = await swap(wallet, SOL, tokenMint, BUY_AMOUNT)
    const outAmount = result.outputAmount || result.totalOutputAmount
    console.log(`✅ Bought ${tokenMint} | amount: ${outAmount}`)
    positions.set(tokenMint, {
      buyPrice,
      amount: outAmount,
      timestamp: Date.now()
    })
  } catch (e) {
    console.log(`❌ Buy failed: ${e.message}`)
  }
}

// ── WATCH FOR NEW RAYDIUM POOLS ───────────────────────────────────────────────
async function watchNewPools(wallet) {
  console.log("👀 Watching for new Raydium pools...")

  connection.onLogs(
    new PublicKey(RAYDIUM_PROGRAM),
    async ({ logs, signature }) => {
      try {
        // Look for pool initialization logs
        const isNewPool = logs.some(log =>
          log.includes("initialize2") || log.includes("InitializeInstruction2")
        )
        if (!isNewPool) return

        console.log(`🆕 New pool detected! TX: ${signature}`)

        // Get transaction to find the token mint
        await sleep(2000) // wait for confirmation
        const tx = await connection.getParsedTransaction(signature, {
          maxSupportedTransactionVersion: 0
        })
        if (!tx) return

        // Extract token mints from the transaction
        const mints = tx.transaction.message.accountKeys
          .map(k => k.pubkey.toString())
          .filter(k => k !== SOL && k !== "So11111111111111111111111111111111111111112")

        for (const mint of mints) {
          // Skip well-known tokens
          if (mint.length < 32) continue
          await snipeToken(wallet, mint)
          break // only try first candidate
        }
      } catch (e) {
        console.log("❌ Pool watch error:", e.message)
      }
    },
    "confirmed"
  )
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function runBot() {
  const wallet = loadWallet()
  console.log("🚀 Sniper running:", wallet.publicKey.toString())

  await watchNewPools(wallet)

  // Continuously monitor open positions
  while (true) {
    await monitorPositions(wallet)
    await sleep(CHECK_INTERVAL)
  }
}

runBot()
