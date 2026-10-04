import { describe, expect, it } from 'vitest'
import { RtpHeader, RtpPacket } from 'werift'
import { OpusRtpAudioReceiver, REMOTE_AUDIO_PLAYOUT_DELAY_MS } from '../src/audio/webrtc.js'
import { pcmChunk } from '../src/audio/pcm.js'

type Scenario = { duration?: number; late: number | number[]; decode?: number; audio?: number; stall?: number }

// An independent producer keeps sending sequence +1 / timestamp +960 every
// 20ms. Only the fake timer and callbacks incur latency; no diagnostic hooks,
// real sleeps or filesystem I/O participate in the receiver under test.
function simulate(options: Scenario) {
  const duration = options.duration ?? 120_000
  let now = 0, sequence = 0, handle = 0, timerCount = 0, callbacks = 0, stalled = false
  let activeCallback = false, synchronousOutputs = 0, maxOutputsPerCallback = 0
  const tasks = new Map<number, { wake: number; callback: () => void }>()
  const frames: Array<{ at: number; timestamp: number; source: string }> = []
  const arms: Array<{ at: number; deadline: number; delay: number; frames: number }> = []
  const pcm = pcmChunk(Buffer.alloc(1920), 48_000)
  const scheduler = {
    now: () => now,
    setTimeout(callback: () => void, delay: number) {
      const lateness = typeof options.late === 'number' ? options.late : options.late[timerCount % options.late.length]!
      timerCount += 1
      const id = ++handle
      tasks.set(id, { wake: now + delay + lateness, callback })
      arms.push({ at: now, deadline: now + delay, delay, frames: frames.length })
      return id
    },
    clearTimeout(id: number | object) { if (typeof id === 'number') tasks.delete(id) },
  }
  const receiver = new OpusRtpAudioReceiver({ scheduler,
    decoder: {
      decode() { now += options.decode ?? 0; return pcm },
      recoverFec() { throw new Error('continuous input unexpectedly needed FEC') },
      conceal() { throw new Error('continuous input unexpectedly needed PLC') },
    },
    onAudio(_chunk, timing) {
      if (activeCallback) synchronousOutputs += 1
      frames.push({ at: now, timestamp: timing.timestamp, source: timing.source })
      now += options.audio ?? 0
    },
  })
  try {
    while (now < duration) {
      if (options.stall && !stalled && now >= 10_000) { now += options.stall; stalled = true }
      const first = [...tasks].sort((a, b) => a[1].wake - b[1].wake)[0]
      const nextInput = sequence * 20
      if (!first || nextInput <= first[1].wake || nextInput <= now) {
        now = Math.max(now, nextInput)
        receiver.push(new RtpPacket(new RtpHeader({ ssrc: 1, sequenceNumber: sequence & 65535,
          timestamp: (sequence * 960) >>> 0, payloadType: 111 }), Buffer.from([1])))
        sequence += 1
      } else {
        now = Math.max(now, first[1].wake)
        tasks.delete(first[0])
        synchronousOutputs = 0
        activeCallback = true
        first[1].callback()
        activeCallback = false
        maxOutputsPerCallback = Math.max(maxOutputsPerCallback, synchronousOutputs)
        callbacks += 1
        if (callbacks > duration * 2) throw new Error('unbounded timer catch-up')
      }
    }
  } finally { receiver.stop() }
  return { frames, arms, callbacks, maxOutputsPerCallback, queuedTimersAfterStop: tasks.size }
}

describe('absolute receiver playout cadence', () => {
  for (const scenario of [
    { late: 6 }, { late: 6, decode: 3, audio: 2 },
    { late: 18, decode: 1, audio: 1 }, { late: [0, 8, 16, 4], decode: 3, audio: 2 },
  ]) {
    it(`bounds 120-second drift for timer/processing ${JSON.stringify(scenario)}`, () => {
      const result = simulate(scenario)
      // Actual timer arms reveal deadline drift without reading receiver internals.
      // A zero-delay arm can clamp a deadline already passed by processing;
      // permit that bounded (< one frame) observation error, never linear drift.
      const deadlineDrift = result.arms.map(arm => arm.deadline - REMOTE_AUDIO_PLAYOUT_DELAY_MS - arm.frames * 20)
      const mediaDrift = result.frames.map((frame, i) => frame.at - REMOTE_AUDIO_PLAYOUT_DELAY_MS - i * 20)
      expect(Math.min(...deadlineDrift)).toBeGreaterThanOrEqual(0)
      expect(Math.max(...deadlineDrift)).toBeLessThanOrEqual(5)
      expect(Math.max(...mediaDrift)).toBeLessThanOrEqual(23)
      expect(result.frames.length).toBeGreaterThan(5900)
      expect(result.frames.every((frame, i) => frame.timestamp === i * 960 && frame.source === 'packet')).toBe(true)
      expect(result.arms.filter(arm => arm.delay === REMOTE_AUDIO_PLAYOUT_DELAY_MS)).toHaveLength(1)
      expect(result.maxOutputsPerCallback).toBe(1)
      expect(result.queuedTimersAfterStop).toBe(0)
    })
  }

  it('reanchors once after a 200ms stall without clearing PCM or bursting buffered frames', () => {
    const result = simulate({ late: 6, decode: 3, audio: 2, stall: 200 })
    const drift = result.arms.map(arm => arm.deadline - REMOTE_AUDIO_PLAYOUT_DELAY_MS - arm.frames * 20)
    const shifts = result.arms.filter((_arm, i) => i > 0 && drift[i]! - drift[i - 1]! >= 40)
    expect(shifts).toHaveLength(1)
    expect(Math.max(...drift)).toBe(205)
    expect(result.frames.every((frame, i) => frame.timestamp === i * 960)).toBe(true)
    const recovery = shifts[0]!
    expect(recovery.delay).toBe(20)
    expect(result.frames[recovery.frames]!.at - recovery.at).toBeGreaterThanOrEqual(20)
    expect(result.arms.filter(arm => arm.delay === REMOTE_AUDIO_PLAYOUT_DELAY_MS)).toHaveLength(1)
    expect(result.maxOutputsPerCallback).toBe(1)
    expect(result.callbacks).toBeLessThan(6100)
    expect(result.queuedTimersAfterStop).toBe(0)
  })

  it('retains the true discontinuity reset and 120ms recovery after a 2300ms stall', () => {
    const result = simulate({ late: 6, stall: 2300, duration: 20_000 })
    // Buffered arrivals can replace an idle-reset timer with a discontinuity
    // timer before either emits. Count the observable playback recovery, not
    // cancelled arms with the same output-frame index.
    const resets = [...new Map(result.arms
      .filter(arm => arm.delay === REMOTE_AUDIO_PLAYOUT_DELAY_MS && arm.frames > 0)
      .map(arm => [arm.frames, arm])).values()]
    expect(resets).toHaveLength(1)
    const reset = resets[0]!
    const next = result.frames[reset.frames]!
    const previous = result.frames[reset.frames - 1]!
    const skippedSamples = next.timestamp - previous.timestamp - 960
    expect(skippedSamples).toBeGreaterThanOrEqual(96960)
    expect(skippedSamples).toBeLessThanOrEqual(2300 * 48)
    expect(next.at - reset.at).toBeGreaterThanOrEqual(REMOTE_AUDIO_PLAYOUT_DELAY_MS)
    expect(result.maxOutputsPerCallback).toBe(1)
    expect(result.callbacks).toBeLessThan(1000)
    expect(result.queuedTimersAfterStop).toBe(0)
  })
})
