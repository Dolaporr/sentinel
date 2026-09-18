import { AgentType, ParsedEvent, RawFeedEvent, SchemaFeedEventType } from '../types/feed';

const KNOWN_SCHEMA_EVENTS: Set<string> = new Set<SchemaFeedEventType>([
  'BALANCE_READ',
  'KEY_CREATED',
  'INFERENCE_INTENT',
  'INFERENCE_CALL',
  'KEY_STATUS_READ',
  'KEY_REVOKED',
  'RECONCILIATION_FAILED',
  'RESERVATION_CREATED',
  'RESERVATION_EXPIRED',
  'COST_COMMITTED',
  'MODEL_REFUSED',
  'BUDGET_REFUSED',
  'OVER_RESERVATION',
  'LATE_RESULT_REJECTED',
  'MISSION_COMPLETE',
  'QUARANTINED_UNPRODUCTIVE',
]);

const KNOWN_EXTENDED_EVENTS: Set<string> = new Set([
  ...KNOWN_SCHEMA_EVENTS,
  'CALL_REFUSED',
  'MODEL_ESCALATED',
  'LOOP_DETECTED',
  'SPEND_VELOCITY_BREACH',
  'AGENT_DIED',
]);

export function parseJsonlFeed(rawText: string): ParsedEvent[] {
  const lines = rawText
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0);

  if (lines.length === 0) return [];

  const rawEvents: RawFeedEvent[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as RawFeedEvent;
      rawEvents.push(parsed);
    } catch (e) {
      console.warn('Failed to parse JSONL line:', line, e);
    }
  }

  if (rawEvents.length === 0) return [];

  // Sort chronologically by timestamp and sequence
  rawEvents.sort((a, b) => {
    const timeDiff = new Date(a.ts).getTime() - new Date(b.ts).getTime();
    if (timeDiff !== 0) return timeDiff;
    return (a.seq || 0) - (b.seq || 0);
  });

  // Determine earliest start timestamp for each agent so all runners replay concurrently from t=0
  const agentStartTimes: Record<string, number> = {};
  for (const raw of rawEvents) {
    const agent = inferAgent(raw);
    const t = new Date(raw.ts).getTime();
    if (agentStartTimes[agent] === undefined || t < agentStartTimes[agent]) {
      agentStartTimes[agent] = t;
    }
  }

  const parsedEvents: ParsedEvent[] = rawEvents.map(raw => {
    const timestampMs = new Date(raw.ts).getTime();
    const parsedAgent = inferAgent(raw);
    const agentBaseTime = agentStartTimes[parsedAgent] ?? timestampMs;
    // Normalized to start at t=0 for concurrent replay without altering internal timing or numbers
    const relativeMs = Math.max(0, timestampMs - agentBaseTime);
    const isKnownEvent = KNOWN_EXTENDED_EVENTS.has(raw.event);
    const { humanDescription, isDecision, isFailure, isDeathTrigger, isCompleteTrigger } = generateEventMetadata(raw, isKnownEvent);

    const displayCost = extractCost(raw);

    return {
      ...raw,
      parsedAgent,
      timestampMs,
      relativeMs,
      displayCost,
      humanDescription,
      isDecision,
      isFailure,
      isDeathTrigger,
      isCompleteTrigger,
      isKnownEvent,
    };
  });

  // Sort by normalized relativeMs so the timeline plays concurrently across all runners
  parsedEvents.sort((a, b) => {
    if (a.relativeMs !== b.relativeMs) {
      return a.relativeMs - b.relativeMs;
    }
    return (a.seq || 0) - (b.seq || 0);
  });

  return parsedEvents;
}

function inferAgent(event: RawFeedEvent): AgentType {
  const candidate = (event.agent || event.raw?.agent || event.payload?.agent || '').toLowerCase();

  if (candidate === 'governed-expensive' || candidate === 'governed_expensive' || candidate === 'governed' || candidate === 'watched-expensive') {
    return 'governed-expensive';
  }
  if (candidate === 'naked' || candidate === 'unprotected') {
    return 'naked';
  }
  if (candidate === 'sentinel' || candidate === 'cheap' || candidate === 'sentinel-cheap' || candidate === 'watched-cheap') {
    return 'sentinel';
  }

  // Reservation or logical call id heuristics if present
  const callId = event.logical_call_id || event.reservation_id || '';
  if (callId.includes('governed-expensive') || callId.includes('watched-expensive')) {
    return 'governed-expensive';
  }
  if (callId.includes('naked')) {
    return 'naked';
  }
  if (callId.includes('sentinel') || callId.includes('watched-a') || callId.includes('watched-b')) {
    return 'sentinel';
  }

  // Event-based heuristics if unassigned
  if (
    event.event === 'LOOP_DETECTED' ||
    event.event === 'SPEND_VELOCITY_BREACH' ||
    event.event === 'AGENT_DIED'
  ) {
    return 'naked';
  }

  const actorLower = (event.actor || '').toLowerCase();
  if (actorLower === 'naked' || actorLower === 'unprotected') return 'naked';
  if (actorLower === 'governed-expensive' || actorLower === 'governed') return 'governed-expensive';

  return 'sentinel';
}

function extractCost(event: RawFeedEvent): number | undefined {
  if (event.raw?.usage_cost) {
    return Number(event.raw.usage_cost);
  }
  if (typeof event.committed_exact === 'number' && event.committed_exact > 0) {
    return event.committed_exact;
  }
  if (typeof event.committed_estimated === 'number' && event.committed_estimated > 0) {
    return event.committed_estimated;
  }
  if (typeof event.committed_total === 'number') {
    return event.committed_total;
  }
  if (event.payload?.cost || event.raw?.cost) {
    return Number(event.payload?.cost || event.raw?.cost);
  }
  return undefined;
}

function formatUsd(amount?: number | null): string {
  if (amount === undefined || amount === null || isNaN(amount)) return '$0.00';
  if (amount < 0) {
    const pos = Math.abs(amount);
    return `-$${pos < 0.01 && pos > 0 ? pos.toFixed(6) : pos.toFixed(4)}`;
  }
  if (amount < 0.01 && amount > 0) {
    return `$${amount.toFixed(6)}`;
  }
  return `$${amount.toFixed(4)}`;
}

function generateEventMetadata(event: RawFeedEvent, isKnown: boolean): {
  humanDescription: string;
  isDecision: boolean;
  isFailure: boolean;
  isDeathTrigger: boolean;
  isCompleteTrigger: boolean;
} {
  const ev = event.event;
  const reason = event.reason || event.raw?.reason || '';
  const threshold = event.threshold;
  const model = event.raw?.model || event.raw?.attempted_model || '';

  let humanDescription = '';
  let isDecision = false;
  let isFailure = false;
  let isDeathTrigger = false;
  let isCompleteTrigger = false;

  // Check for upstream provider or socket faults
  const lowerReason = reason.toLowerCase();
  const rawError = event.raw?.error || event.raw?.err;
  if (
    lowerReason.includes('stream_cut') ||
    lowerReason.includes('socket') ||
    lowerReason.includes('timeout') ||
    lowerReason.includes('disconnect') ||
    lowerReason.includes('connection_reset') ||
    lowerReason.includes('500') ||
    lowerReason.includes('502') ||
    lowerReason.includes('503') ||
    lowerReason.includes('504') ||
    rawError
  ) {
    isFailure = true;
  }

  switch (ev) {
    case 'BALANCE_READ':
      humanDescription = `Session initialized • Capital allocated: ${formatUsd(event.orbio_balance ?? event.threshold ?? 0.25)}`;
      break;

    case 'KEY_CREATED':
      humanDescription = `Gateway key provisioned • ID: ${event.key_id || 'primary'} • Spend cap: ${formatUsd(event.threshold)}`;
      break;

    case 'INFERENCE_INTENT':
      const intentPrompt = event.raw?.prompt_prefix
        ? `"${event.raw.prompt_prefix.length > 45 ? event.raw.prompt_prefix.slice(0, 45).replace(/\n/g, ' ').trim() + '…' : event.raw.prompt_prefix.replace(/\n/g, ' ').trim()}" • `
        : '';
      const worstCase = event.raw?.worst_case_usd
        ? ` • Max exposure: ${formatUsd(event.raw.worst_case_usd)}`
        : event.reserved_total
        ? ` • Max exposure: ${formatUsd(event.reserved_total)}`
        : '';
      humanDescription = `${intentPrompt}Dispatch intent registered • Target: ${model || 'default-tier'}${worstCase}`;
      break;

    case 'INFERENCE_CALL':
      const promptSnippet = event.raw?.prompt_prefix
        ? `"${event.raw.prompt_prefix.length > 45 ? event.raw.prompt_prefix.slice(0, 45).replace(/\n/g, ' ').trim() + '…' : event.raw.prompt_prefix.replace(/\n/g, ' ').trim()}" • `
        : '';
      const tokenCount = event.raw?.output_tokens ? ` (${event.raw.output_tokens} tokens)` : '';
      humanDescription = `${promptSnippet}Inference resolved • Target: ${model || 'default-tier'}${tokenCount}`;
      break;

    case 'KEY_STATUS_READ':
      humanDescription = `Key status telemetry • State: ${event.key_state || 'active'} • Spent: ${formatUsd(event.orbio_spent)} • Available: ${formatUsd(event.orbio_balance)}`;
      break;

    case 'KEY_REVOKED':
      isDecision = true;
      humanDescription = `Key revoked by governor • ${reason || 'Threshold breach or safety cutoff'}`;
      break;

    case 'RECONCILIATION_FAILED':
      isFailure = true;
      humanDescription = `Reconciliation mismatch • Out-of-band spend drift detected (${reason || 'audit discrepancy'})`;
      break;

    case 'RESERVATION_CREATED':
      const resAmount = event.reserved_total
        ? formatUsd(event.reserved_total)
        : (event.raw?.base_worst_case_usd
          ? formatUsd(Number(event.raw.base_worst_case_usd) * (event.reservation_safety_multiplier || 1.25))
          : 'allocation');
      humanDescription = `Reserve locked: ${resAmount} ${model ? `(${model})` : ''} • Governor admission verified`;
      break;

    case 'RESERVATION_EXPIRED':
      humanDescription = `Reservation expired • Allocation of ${formatUsd(event.reserved_total)} safely released back to balance pool`;
      break;

    case 'COST_COMMITTED':
      const costVal = event.committed_exact || event.committed_estimated || event.raw?.usage_cost || 0;
      const costStr = formatUsd(costVal);
      const src = event.cost_source ? `[${event.cost_source}]` : '';
      if (reason === 'stream_cut') {
        isFailure = true;
      }
      humanDescription = `Committed ${costStr} ${src} ${model ? `for ${model}` : ''} ${reason ? `(${reason})` : ''}`;
      break;

    case 'MODEL_REFUSED':
      isDecision = true;
      humanDescription = `Refused: model ${model || 'tier'} exceeds per-call safety cap ${threshold ? `(${formatUsd(threshold)})` : ''}`;
      break;

    case 'BUDGET_REFUSED':
      isDecision = true;
      const attempted = event.raw?.amount_usd ? ` (${formatUsd(event.raw.amount_usd)} attempted against ${formatUsd(threshold)} cap)` : threshold ? ` (cap: ${formatUsd(threshold)})` : '';
      humanDescription = `Refused: would exceed remaining budget${attempted} • Call blocked safely`;
      break;

    case 'OVER_RESERVATION':
      isDecision = true;
      humanDescription = `Refused: over-reservation buffer exceeded ${threshold ? `(ceiling: ${formatUsd(threshold)})` : ''} • Allocation denied`;
      break;

    case 'LATE_RESULT_REJECTED':
      isDecision = true;
      isFailure = true;
      humanDescription = `Refused: late inference result rejected • Arrived post-expiration; uncommitted spend avoided`;
      break;

    case 'MISSION_COMPLETE':
      isCompleteTrigger = true;
      humanDescription = `Mission complete • All reservations cleared, remaining capital preserved solvent`;
      break;

    case 'QUARANTINED_UNPRODUCTIVE':
      isDecision = true;
      const quarantineReason = reason ? reason.replace(/_/g, ' ') : event.raw?.unfinished_condition || 'zero progress';
      humanDescription = `Governor intervention: quarantined unproductive • ${quarantineReason}`;
      break;

    case 'CALL_REFUSED':
      isDecision = true;
      humanDescription = `Refused: governor blocked call • ${reason || 'threshold exceeded'} ${threshold ? `(${formatUsd(threshold)})` : ''}`;
      break;

    case 'MODEL_ESCALATED':
      isDecision = true;
      humanDescription = `Model escalated: routed to ${model || 'higher tier'} (${reason || 'reasoning required'})`;
      break;

    case 'LOOP_DETECTED':
      isDeathTrigger = true;
      humanDescription = `Halted: redundant inference loop detected • ${reason || 'unproductive repeated cycles'}`;
      break;

    case 'SPEND_VELOCITY_BREACH':
      isDeathTrigger = true;
      humanDescription = `Halted: spend velocity breach • Exceeded ${threshold ? formatUsd(threshold) : '$0.0500'}/sec burn limit`;
      break;

    case 'AGENT_DIED':
      isDeathTrigger = true;
      humanDescription = `Fatal: agent balance exhausted (${formatUsd(event.orbio_balance ?? 0)}) • Mission halted incomplete`;
      break;

    default: {
      const cleanEventName = ev.replace(/_/g, ' ');
      const upper = ev.toUpperCase();
      if (
        upper.includes('REFUSE') ||
        upper.includes('DENIED') ||
        upper.includes('BLOCK') ||
        upper.includes('REJECT') ||
        upper.includes('OVER') ||
        upper.includes('GOVERN')
      ) {
        isDecision = true;
      } else if (
        upper.includes('BREACH') ||
        upper.includes('LOOP') ||
        upper.includes('DIED') ||
        upper.includes('HALT') ||
        upper.includes('FATAL')
      ) {
        isDeathTrigger = true;
      } else if (
        upper.includes('COMPLETE') ||
        upper.includes('SOLVENT') ||
        upper.includes('SUCCESS')
      ) {
        isCompleteTrigger = true;
      } else if (
        upper.includes('FAIL') ||
        upper.includes('ERR') ||
        upper.includes('TIMEOUT') ||
        upper.includes('DROP')
      ) {
        isFailure = true;
      }

      let diagnostic = '';
      if (reason) {
        diagnostic = `: ${reason.length > 120 ? reason.substring(0, 117) + '...' : reason}`;
      } else if (event.raw && Object.keys(event.raw).length > 0) {
        const rawStr = Object.entries(event.raw)
          .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
          .join(', ');
        diagnostic = ` (${rawStr.length > 100 ? rawStr.substring(0, 97) + '...' : rawStr})`;
      } else if (!isKnown) {
        diagnostic = ' [unrecognized event]';
      }

      humanDescription = `${cleanEventName}${diagnostic}`;
      break;
    }
  }

  return { humanDescription, isDecision, isFailure, isDeathTrigger, isCompleteTrigger };
}
