const fetch = require("node-fetch")
const bs58 = require("bs58")
const {
  Keypair,
  Connection,
  VersionedTransaction,
  PublicKey
} = require("@solana/web3.js")

const connection = new Connection(
  process.env.RPC_URL || "https://rpc.ankr.com/solana",
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
const BUY_AMOUNT = 20000000      // 0.02 SOL
const TAKE_PROFIT = 2.0          // sell at 2x
const STOP_LOSS = 0.5            // sell at -50%
const CHECK_INTERVAL = 3000      // check positions every 3s
const MAX_HOLD_TIME = 60000      // force sell after 60s
const DEX_SCAN_INTERVAL = 30000  // scan dexscreener every 30s

const positions = new Map()
const triedTokens = new Set()    // avoid buying same token twice

// ── JUPITER SWAP ──────────────────────────────────────────────────────────────
async function swap(wallet, inputMint, outputMint, amount) {
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount,
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

// ── GET TOKEN PRICE ───────────────────────────────────────────────────────────
async function getPrice(tokenMint) {
  try {
    const res = await fetch(`${BASE}/price/v2?ids=${tokenMint}`, {
      headers: { "x-api-key": process.env.JUP_API_KEY }
    })
    if (!res.ok) return null
    const data = await res.json()
    return parseFloat(data?.data?.[tokenMint]?.price) || null
  } catch {
    return null
  }
}

// ── SAFETY CHECK ──────────────────────────────────────────────────────────────
async function isSafe(tokenMint) {
  try {
    const res = await fetch(`${BASE}/tokens/v1/token/${tokenMint}`, {
      headers: { "x-api-key": process.env.JUP_API_KEY }
    })
    if (!res.ok) return false
    const token = await res.json()
    if (token.freezeAuthority) return false
    if (token.mintAuthority) return false
    return true
  } catch {
    return false
  }
}

// ── BUY TOKEN ─────────────────────────────────────────────────────────────────
async function buyToken(wallet, tokenMint, source) {
  if (positions.has(tokenMint)) return
  if (triedTokens.has(tokenMint)) return
  if (positions.size >= 3) return

  triedTokens.add(tokenMint)
  console.log(`🎯 [${source}] Trying: ${tokenMint}`)

  const safe = await isSafe(tokenMint)
  if (!safe) {
    console.log(`❌ Safety check failed`)
    return
  }

  const buyPrice = await getPrice(tokenMint)
  if (!buyPrice) {
    console.log(`❌ Could not get price`)
    return
  }

  try {
    const result = await swap(wallet, SOL, tokenMint, BUY_AMOUNT)
    const outAmount = result.outputAmount || result.totalOutputAmount
    console.log(`✅ Bought ${tokenMint} at $${buyPrice} | amount: ${outAmount}`)
    positions.set(tokenMint, {
      buyPrice,
      amount: outAmount,
      timestamp: Date.now(),
      source
    })
  } catch (e) {
    console.log(`❌ Buy failed: ${e.message}`)
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
      const pct = ((ratio - 1) * 100).toFixed(1)

      const shouldSell =
        ratio >= TAKE_PROFIT ||
        ratio <= STOP_LOSS ||
        elapsed >= MAX_HOLD_TIME

      if (shouldSell) {
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

// ── DEXSCREENER SCAN ──────────────────────────────────────────────────────────
async function scanDexScreener(wallet) {
  try {
    console.log("🔍 Scanning DexScreener...")

    // Get top trending Solana tokens
    const res = await fetch(
      "https://api.dexscreener.com/token-boosts/top/v1"
    )
    if (!res.ok) return
    const tokens = await res.json()

    // Filter for Solana tokens with strong metrics
    const solanaTokens = tokens
      .filter(t =>
        t.chainId === "solana" &&
        t.amount > 100  // has decent boost amount
      )
      .slice(0, 5)  // top 5

    for (const token of solanaTokens) {
      const mint = token.tokenAddress
      if (!mint || triedTokens.has(mint)) continue

      console.log(`📈 DexScreener boost: ${mint} | amount: ${token.amount}`)
      await buyToken(wallet, mint, "DEXSCREENER")
      await sleep(1000)
    }

    // Also check latest new pairs on Solana
    const pairsRes = await fetch(
      "https://api.dexscreener.com/token-profiles/latest/v1"
    )
    if (!pairsRes.ok) return
    const pairs = await pairsRes.json()

    const newSolanaPairs = pairs
      .filter(t => t.chainId === "solana")
      .slice(0, 3)

    for (const token of newSolanaPairs) {
      const mint = token.tokenAddress
      if (!mint || triedTokens.has(mint)) continue

      console.log(`🆕 New Solana token: ${mint}`)
      await buyToken(wallet, mint, "NEW_PAIR")
      await sleep(1000)
    }
  } catch (e) {
    console.log(`❌ DexScreener error: ${e.message}`)
  }
}

// ── WATCH RAYDIUM POOLS ───────────────────────────────────────────────────────
async function watchNewPools(wallet) {
  console.log("👀 Watching for new Raydium pools...")
  connection.onLogs(
    new PublicKey(RAYDIUM_PROGRAM),
    async ({ logs, signature }) => {
      try {
        const isNewPool = logs.some(log =>
          log.includes("initialize2") || log.includes("InitializeInstruction2")
        )
        if (!isNewPool) return

        console.log(`🆕 New Raydium pool! TX: ${signature}`)
        await sleep(2000)

        const tx = await connection.getParsedTransaction(signature, {
          maxSupportedTransactionVersion: 0
        })
        if (!tx) return

        const mints = tx.transaction.message.accountKeys
          .map(k => k.pubkey.toString())
          .filter(k =>
            k !== SOL &&
            k !== "So11111111111111111111111111111111111111112" &&
            k.length >= 32
          )

        for (const mint of mints) {
          await buyToken(wallet, mint, "RAYDIUM")
          break
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
  console.log("🚀 Bot running:", wallet.publicKey.toString())

  await watchNewPools(wallet)

  // Initial DexScreener scan
  await scanDexScreener(wallet)

  // Main loop
  let lastDexScan = Date.now()
  while (true) {
    await monitorPositions(wallet)

    // Scan DexScreener every 30s
    if (Date.now() - lastDexScan > DEX_SCAN_INTERVAL) {
      await scanDexScreener(wallet)
      lastDexScan = Date.now()
    }

    await sleep(CHECK_INTERVAL)
  }
}

runBot()
