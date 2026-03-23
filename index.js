// ... [Keep all previous code until the updateCircuitBreakers function] ...

// ─────────────────────────────────────────────────────────────────────────────
//  CIRCUIT BREAKERS & PERFORMANCE CONTROLS
// ─────────────────────────────────────────────────────────────────────────────
function checkPaused() {
  return state.paused
}

async function updateCircuitBreakers(walletPubkey) {
  // DAILY LOSS LIMIT REMOVED 
  // We no longer check drawdown vs CFG.DAILY_LOSS_LIMIT_PCT

  // Consecutive losses → reduce size (Protects against "catching falling knives")
  if (state.consecutiveLosses >= CFG.CONSEC_LOSSES_HALVE && !state.reducedSize) {
    state.reducedSize       = true
    state.reducedSizeReason = `${state.consecutiveLosses} consecutive losses`
    log("WARN", `Size halved: ${state.reducedSizeReason}`)
    saveState()
  }

  // Failed swap rate (Protects against burning priority fees on dead RPCs/APIs)
  const windowStart = Date.now() - CFG.FAILED_SWAP_WINDOW_MS
  state.failedSwaps = state.failedSwaps.filter(t => t > windowStart)
  if (state.failedSwaps.length >= CFG.MAX_FAILED_SWAPS && !state.paused) {
    state.paused      = true
    state.pauseReason = `Too many failed swaps: ${state.failedSwaps.length} in 1h`
    log("PAUSE", state.pauseReason)
    saveState()
  }
}

// ... [Keep recordWin, recordLoss, and pumpPortalSwap functions] ...

// Finalizing the unfinished onChainSecurityCheck from your snippet:
async function onChainSecurityCheck(tokenMint) {
  const flags = []
  const pass  = []

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

  // ... [Additional checks] ...

  const hardFail = flags.filter(f =>
    f.startsWith("MINT_AUTHORITY") ||
    f.startsWith("FREEZE_AUTHORITY")
  )
  
  const safe = hardFail.length === 0
  log(safe ? "CONFIRM" : "RUG", `OnChain: ${safe ? pass.join("|") : hardFail.join("|")} | ${tokenMint.slice(0,8)}...`)
  
  return safe
}
