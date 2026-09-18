import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { AgentRunState, AgentType, ParsedEvent } from '../types/feed';
import { parseJsonlFeed } from '../lib/feedParser';

interface ReplayEngineReturn {
  events: ParsedEvent[];
  isLoading: boolean;
  error: string | null;
  isPlaying: boolean;
  currentTimeMs: number;
  totalDurationMs: number;
  speed: number;
  initialBudget: number;
  divergenceTimeMs: number | null;
  deathTimeMs: number | null;
  completionTimeMs: number | null;
  nakedState: AgentRunState;
  governedExpensiveState: AgentRunState;
  sentinelState: AgentRunState;
  activeFeedName: string;
  play: () => void;
  pause: () => void;
  togglePlay: () => void;
  restart: () => void;
  seek: (timeMs: number) => void;
  setSpeed: (speed: number) => void;
  loadRawFeed: (text: string, filename?: string) => void;
  resetToDefaultFixture: () => void;
}

export function useReplayEngine(defaultFeedUrl: string = '/sample-feed.jsonl'): ReplayEngineReturn {
  const [rawContent, setRawContent] = useState<string>('');
  const [activeFeedName, setActiveFeedName] = useState<string>('sample-feed.jsonl');
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>('');

  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [currentTimeMs, setCurrentTimeMs] = useState<number>(0);
  const [speed, setSpeedState] = useState<number>(1);

  const rafRef = useRef<number | null>(null);
  const lastTickRef = useRef<number | null>(null);

  // Load default fixture
  const loadDefault = useCallback(() => {
    setIsLoading(true);
    setError('');
    fetch(defaultFeedUrl)
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${defaultFeedUrl}`);
        return res.text();
      })
      .then(text => {
        setRawContent(text);
        setActiveFeedName('sample-feed.jsonl');
        setIsLoading(false);
      })
      .catch(err => {
        console.error('Failed to load feed fixture:', err);
        setError(err.message || 'Failed to load feed fixture');
        setIsLoading(false);
      });
  }, [defaultFeedUrl]);

  useEffect(() => {
    loadDefault();
  }, [loadDefault]);

  // Parse events
  const events = useMemo(() => {
    if (!rawContent) return [];
    return parseJsonlFeed(rawContent);
  }, [rawContent]);

  // Derive initial budget dynamically from feed events (governor threshold or balance)
  const initialBudget = useMemo(() => {
    // Look for governor event threshold (mission budget per agent), then balance, fallback 0.25
    const thresholdEv = events.find(e => typeof e.threshold === 'number' && e.threshold > 0);
    if (thresholdEv && typeof thresholdEv.threshold === 'number') {
      return thresholdEv.threshold;
    }
    const balanceEv = events.find(e => typeof e.orbio_balance === 'number' && e.orbio_balance > 0);
    if (balanceEv && typeof balanceEv.orbio_balance === 'number') {
      return balanceEv.orbio_balance;
    }
    return 0.25;
  }, [events]);

  // Duration
  const totalDurationMs = useMemo(() => {
    if (events.length === 0) return 35000;
    const maxRel = Math.max(...events.map(e => e.relativeMs));
    return Math.max(maxRel + 2000, 5000);
  }, [events]);

  // Find key milestone moments
  const { divergenceTimeMs, deathTimeMs, completionTimeMs } = useMemo(() => {
    let divTime: number | null = null;
    let dTime: number | null = null;
    let cTime: number | null = null;

    let cumulativeNakedSpend = 0;

    for (const ev of events) {
      if (
        (ev.event === 'BUDGET_REFUSED' ||
          ev.event === 'MODEL_REFUSED' ||
          ev.event === 'CALL_REFUSED' ||
          ev.event === 'OVER_RESERVATION' ||
          ev.event === 'QUARANTINED_UNPRODUCTIVE' ||
          ev.event === 'KEY_REVOKED') &&
        divTime === null
      ) {
        divTime = ev.relativeMs;
      }
      if (ev.isDeathTrigger && dTime === null) {
        dTime = ev.relativeMs;
      }
      if (ev.isCompleteTrigger && cTime === null) {
        cTime = ev.relativeMs;
      }

      // Check for naked overshoot moment as death milestone if no explicit death event
      if (ev.parsedAgent === 'naked' && ev.event === 'INFERENCE_CALL') {
        const cost = ev.raw?.usage_cost ?? (typeof ev.committed_exact === 'number' ? ev.committed_exact : 0);
        cumulativeNakedSpend += Number(cost);
        if (cumulativeNakedSpend > initialBudget && dTime === null) {
          dTime = ev.relativeMs;
        }
      }
    }

    return {
      divergenceTimeMs: divTime,
      deathTimeMs: dTime,
      completionTimeMs: cTime,
    };
  }, [events, initialBudget]);

  // Playback loop
  useEffect(() => {
    if (!isPlaying) {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      lastTickRef.current = null;
      return;
    }

    const tick = (now: number) => {
      if (lastTickRef.current === null) {
        lastTickRef.current = now;
      }
      const delta = now - lastTickRef.current;
      lastTickRef.current = now;

      setCurrentTimeMs(prev => {
        const next = prev + delta * speed;
        if (next >= totalDurationMs) {
          setIsPlaying(false);
          return totalDurationMs;
        }
        return next;
      });

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [isPlaying, speed, totalDurationMs]);

  // Transport controls
  const play = useCallback(() => {
    if (currentTimeMs >= totalDurationMs) {
      setCurrentTimeMs(0);
    }
    setIsPlaying(true);
  }, [currentTimeMs, totalDurationMs]);

  const pause = useCallback(() => {
    setIsPlaying(false);
  }, []);

  const togglePlay = useCallback(() => {
    if (isPlaying) {
      pause();
    } else {
      play();
    }
  }, [isPlaying, pause, play]);

  const restart = useCallback(() => {
    setIsPlaying(false);
    setCurrentTimeMs(0);
  }, []);

  const seek = useCallback((timeMs: number) => {
    const clamped = Math.max(0, Math.min(timeMs, totalDurationMs));
    setCurrentTimeMs(clamped);
  }, [totalDurationMs]);

  const setSpeed = useCallback((s: number) => {
    setSpeedState(s);
  }, []);

  const loadRawFeed = useCallback((text: string, filename: string = 'custom-feed.jsonl') => {
    setIsPlaying(false);
    setCurrentTimeMs(0);
    setRawContent(text);
    setActiveFeedName(filename);
  }, []);

  // Compute live agent states for all 3 runners using dynamically derived initial budget
  const { nakedState, governedExpensiveState, sentinelState } = useMemo(() => {
    return computeAgentStates(events, currentTimeMs, initialBudget);
  }, [events, currentTimeMs, initialBudget]);

  return {
    events,
    isLoading,
    error,
    isPlaying,
    currentTimeMs,
    totalDurationMs,
    speed,
    initialBudget,
    divergenceTimeMs,
    deathTimeMs,
    completionTimeMs,
    nakedState,
    governedExpensiveState,
    sentinelState,
    activeFeedName,
    play,
    pause,
    togglePlay,
    restart,
    seek,
    setSpeed,
    loadRawFeed,
    resetToDefaultFixture: loadDefault,
  };
}

function computeAgentStates(
  allEvents: ParsedEvent[],
  currentTimeMs: number,
  globalInitialBudget: number
): {
  nakedState: AgentRunState;
  governedExpensiveState: AgentRunState;
  sentinelState: AgentRunState;
} {
  const visibleEvents = allEvents.filter(e => e.relativeMs <= currentTimeMs);

  const nakedEvents = visibleEvents.filter(e => e.parsedAgent === 'naked');
  const governedExpensiveEvents = visibleEvents.filter(e => e.parsedAgent === 'governed-expensive');
  const sentinelEvents = visibleEvents.filter(e => e.parsedAgent === 'sentinel');

  // Check for agent-specific initial allocation in feed, falling back to globalInitialBudget
  const nakedBudget = findAgentInitialBudget(allEvents.filter(e => e.parsedAgent === 'naked'), globalInitialBudget);
  const governedBudget = findAgentInitialBudget(allEvents.filter(e => e.parsedAgent === 'governed-expensive'), globalInitialBudget);
  const sentinelBudget = findAgentInitialBudget(allEvents.filter(e => e.parsedAgent === 'sentinel'), globalInitialBudget);

  const nakedState = buildStateForAgent('naked', 'Unprotected Runner', 'openai/gpt-4.1', nakedEvents, nakedBudget, currentTimeMs);
  const governedExpensiveState = buildStateForAgent('governed-expensive', 'Governed (Identical Model)', 'openai/gpt-4.1', governedExpensiveEvents, governedBudget, currentTimeMs);
  const sentinelState = buildStateForAgent('sentinel', 'Sentinel Cheap-Routed', 'openai/gpt-4.1-mini', sentinelEvents, sentinelBudget, currentTimeMs);

  return { nakedState, governedExpensiveState, sentinelState };
}

function findAgentInitialBudget(agentEvents: ParsedEvent[], fallback: number): number {
  const thresholdEv = agentEvents.find(e => typeof e.threshold === 'number' && e.threshold > 0);
  if (thresholdEv && typeof thresholdEv.threshold === 'number') {
    return thresholdEv.threshold;
  }
  const balanceEv = agentEvents.find(e => typeof e.orbio_balance === 'number' && e.orbio_balance > 0);
  if (balanceEv && typeof balanceEv.orbio_balance === 'number') {
    return balanceEv.orbio_balance;
  }
  return fallback;
}

function buildStateForAgent(
  agent: AgentType,
  name: string,
  defaultModel: string,
  events: ParsedEvent[],
  initialBudget: number,
  currentTimeMs: number
): AgentRunState {
  let committedTotal = 0;
  let reservedTotal = 0;
  let callCount = 0;
  let refusalCount = 0;
  let failureCount = 0;
  let keyState: AgentRunState['keyState'] = 'active';
  let causeOfDeath: AgentRunState['causeOfDeath'] = undefined;
  let missionState: AgentRunState['missionState'] = 'running';
  let detectedModel = defaultModel;
  const pendingIntents = new Map<string, number>();

  for (const ev of events) {
    if (ev.raw?.model) {
      detectedModel = ev.raw.model;
    }

    if (ev.key_state) {
      keyState = ev.key_state;
    }

    if (ev.isFailure) {
      failureCount++;
    }

    if (ev.event === 'BALANCE_READ' || ev.event === 'KEY_STATUS_READ') {
      if (typeof ev.orbio_spent === 'number') {
        committedTotal = ev.orbio_spent;
      }
    }

    if (ev.event === 'INFERENCE_INTENT') {
      const intentId = ev.raw?.intent_id || `intent-${ev.seq || ev.timestampMs}`;
      const worstCase = ev.raw?.worst_case_usd ?? ev.reserved_total ?? 0;
      pendingIntents.set(intentId, worstCase);
      // For runners where reservations aren't explicitly pre-allocated (e.g. naked),
      // or to reflect in-flight exposure when no existing reservation is active:
      if (reservedTotal === 0 && worstCase > 0) {
        reservedTotal = worstCase;
      }
    }

    if (ev.event === 'INFERENCE_CALL') {
      callCount++;
      const intentId = ev.raw?.intent_id;
      if (intentId) {
        pendingIntents.delete(intentId);
      } else if (pendingIntents.size > 0) {
        const firstKey = pendingIntents.keys().next().value;
        if (firstKey) pendingIntents.delete(firstKey);
      }

      // If all pending intents resolved and naked runner, clear reserved total
      if (agent === 'naked' && pendingIntents.size === 0) {
        reservedTotal = 0;
      }

      // Unprotected runner runs directly against gateway: accumulate its exact inference costs
      if (agent === 'naked') {
        const stepCost = ev.raw?.usage_cost ?? (typeof ev.committed_exact === 'number' ? ev.committed_exact : 0);
        committedTotal += Number(stepCost);
      }
    }

    if (ev.event === 'RESERVATION_CREATED') {
      if (typeof ev.reserved_total === 'number') {
        reservedTotal = ev.reserved_total;
      } else if (ev.raw?.base_worst_case_usd) {
        reservedTotal = Number(ev.raw.base_worst_case_usd) * (ev.reservation_safety_multiplier || 1.25);
      }
    }

    // Reservation expiration: safe release of locked funds back to available pool
    if (ev.event === 'RESERVATION_EXPIRED') {
      reservedTotal = 0;
    }

    if (ev.event === 'COST_COMMITTED') {
      // If no INFERENCE_CALL preceded in this runner's events, track callCount
      if (!events.some(e => e.event === 'INFERENCE_CALL')) {
        callCount++;
      }

      // Governed agent spend settlement
      if (typeof ev.committed_total === 'number') {
        committedTotal = ev.committed_total;
      } else if (typeof ev.committed_exact === 'number' || typeof ev.committed_estimated === 'number') {
        committedTotal = (ev.committed_exact ?? 0) + (ev.committed_estimated ?? 0);
      } else {
        const exact = ev.committed_exact ?? 0;
        const est = ev.committed_estimated ?? 0;
        const rawCost = ev.raw?.usage_cost ?? 0;
        const stepCost = exact > 0 ? exact : (est > 0 ? est : rawCost);
        committedTotal += stepCost;
      }

      if (typeof ev.reserved_total === 'number') {
        reservedTotal = ev.reserved_total;
      } else {
        reservedTotal = 0;
      }
    }

    // Count refusal and governor intervention decisions
    if (
      ev.event === 'CALL_REFUSED' ||
      ev.event === 'BUDGET_REFUSED' ||
      ev.event === 'MODEL_REFUSED' ||
      ev.event === 'OVER_RESERVATION' ||
      ev.event === 'LATE_RESULT_REJECTED' ||
      ev.event === 'KEY_REVOKED' ||
      (ev.isDecision && !ev.isKnownEvent)
    ) {
      refusalCount++;
    }

    if (ev.event === 'KEY_REVOKED') {
      keyState = 'revoked';
      if (agent === 'naked' && !causeOfDeath) {
        causeOfDeath = {
          event: 'KEY_REVOKED',
          reason: ev.reason || 'Key revoked due to threshold breach',
          threshold: ev.threshold ?? undefined,
          timestampMs: ev.relativeMs,
        };
        missionState = 'died';
      }
    }

    if (ev.event === 'MISSION_COMPLETE') {
      missionState = 'complete';
      reservedTotal = 0;
    }

    if (ev.event === 'QUARANTINED_UNPRODUCTIVE') {
      missionState = 'quarantined_unproductive';
      reservedTotal = 0;
    }

    if (ev.event === 'AGENT_DIED') {
      missionState = 'died';
      causeOfDeath = {
        event: 'AGENT_DIED',
        reason: ev.reason || 'Agent balance depleted without completing mission',
        threshold: ev.threshold ?? undefined,
        timestampMs: ev.relativeMs,
      };
    }

    if (ev.event === 'LOOP_DETECTED') {
      missionState = 'died';
      causeOfDeath = {
        event: 'LOOP_DETECTED',
        reason: ev.reason || 'Repeated unproductive query pattern detected',
        threshold: ev.threshold ?? undefined,
        timestampMs: ev.relativeMs,
      };
    }

    if (ev.event === 'SPEND_VELOCITY_BREACH') {
      missionState = 'died';
      causeOfDeath = {
        event: 'SPEND_VELOCITY_BREACH',
        reason: ev.reason || `Spend velocity limit exceeded (${ev.threshold ? `$${ev.threshold}/s` : '$0.050/s'})`,
        threshold: ev.threshold ?? undefined,
        value: ev.raw?.velocity ?? undefined,
        timestampMs: ev.relativeMs,
      };
    }

    // For unknown events with cost
    if (!ev.isKnownEvent && ev.displayCost) {
      committedTotal += ev.displayCost;
    }
  }

  // EXACT remaining budget: NEVER clamp to 0! Without admission control, it goes negative!
  const budgetRemaining = initialBudget - committedTotal;
  const isOvershot = budgetRemaining < 0;
  const overshootAmount = isOvershot ? Math.abs(budgetRemaining) : 0;

  // If budget hit zero or negative and not complete, flag death for unprotected runner
  if (budgetRemaining <= 0 && agent === 'naked' && missionState !== 'complete' && !causeOfDeath) {
    causeOfDeath = {
      event: isOvershot ? 'BUDGET_OVERRUN' : 'BALANCE_EXHAUSTED',
      reason: isOvershot
        ? `Sailed past budget ceiling: spent $${committedTotal.toFixed(4)} of $${initialBudget.toFixed(4)}`
        : 'Balance depleted to $0.0000 with mission unfinished',
      threshold: initialBudget,
      timestampMs: currentTimeMs,
    };
    missionState = 'died';
  }

  // Compute burn rate in $/sec over the active elapsed window
  const elapsedSec = currentTimeMs / 1000;
  const burnRatePerSec = elapsedSec > 0 ? committedTotal / elapsedSec : 0;

  let status: AgentRunState['status'] = 'RUNNING';
  if (events.length === 0) {
    status = 'IDLE';
  } else if (missionState === 'complete') {
    status = 'COMPLETED';
  } else if (missionState === 'died' || missionState === 'quarantined_unproductive' || causeOfDeath) {
    status = 'HALTED';
  }

  return {
    agent,
    name,
    model: detectedModel,
    status,
    initialBudget,
    budgetRemaining,
    committedTotal,
    reservedTotal,
    callCount,
    inFlightIntentCount: pendingIntents.size,
    refusalCount,
    failureCount,
    burnRatePerSec,
    isOvershot,
    overshootAmount,
    keyState,
    causeOfDeath,
    missionState,
    lastEvent: events[events.length - 1],
    eventHistory: events,
  };
}
