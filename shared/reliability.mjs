// Pure logic, no sockets. Times in microseconds unless stated.
export class AdaptiveTimeout {
  alpha = 0.125; beta = 0.25; srtt = 0; rttvar = 0; init = false;
  onSample(rttMs) {
    if (!this.init) { this.srtt = rttMs; this.rttvar = rttMs / 2; this.init = true; return; }
    this.rttvar = (1 - this.beta) * this.rttvar + this.beta * Math.abs(this.srtt - rttMs);
    this.srtt = (1 - this.alpha) * this.srtt + this.alpha * rttMs;
  }
  rtoMs() { return this.init ? Math.min(3000, Math.max(100, this.srtt + 4 * this.rttvar)) : 1000; }
}

export class ReliableChannel {
  constructor(maxAttempts = 5) { this.max = maxAttempts; this.pending = new Map(); this.failed = []; }
  onSent(seq, raw, nowUs) { this.pending.set(seq, { raw, firstSentUs: nowUs, lastSentUs: nowUs, attempts: 1 }); }
  onAck(seq) { const p = this.pending.get(seq); if (!p) return null; this.pending.delete(seq); return p; }
  // Exponential backoff: rto * 2^(attempts-1). Over the limit -> failed.
  collect(nowUs, rtoUs) {
    const due = [];
    for (const [seq, p] of this.pending) {
      if (nowUs - p.lastSentUs < rtoUs * 2 ** (p.attempts - 1)) continue;
      if (p.attempts >= this.max) { this.pending.delete(seq); this.failed.push(seq); continue; }
      p.attempts++; p.lastSentUs = nowUs; due.push(p);
    }
    return due;
  }
  drainFailed() { return this.failed.splice(0); }
}
