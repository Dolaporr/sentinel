import React, { useEffect, useRef, useState } from 'react';
import { AgentType, ParsedEvent } from '../types/feed';
import { ShieldCheck, ArrowUpRight, HelpCircle, AlertTriangle, ArrowDown, Send, Lock } from 'lucide-react';

interface EventLedgerProps {
  events: ParsedEvent[];
  agentType: AgentType;
}

export const EventLedger: React.FC<EventLedgerProps> = ({ events, agentType }) => {
  const isNaked = agentType === 'naked';
  const isGovernedExpensive = agentType === 'governed-expensive';
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const [isUserScrolledUp, setIsUserScrolledUp] = useState<boolean>(false);

  // Format relative timestamp (+00:01.240s)
  const formatTime = (ms: number) => {
    if (!ms || isNaN(ms) || ms < 0) return '+00:00.00s';
    const totalSec = ms / 1000;
    const mins = Math.floor(totalSec / 60);
    const secs = (totalSec % 60).toFixed(2);
    const paddedSecs = (Number(secs) < 10 ? '0' : '') + secs;
    return `+${mins.toString().padStart(2, '0')}:${paddedSecs}s`;
  };

  const formatCost = (cost?: number) => {
    if (cost === undefined || isNaN(cost)) return null;
    if (cost < 0.01 && cost > 0) return `$${cost.toFixed(6)}`;
    return `$${cost.toFixed(4)}`;
  };

  // Track scroll position to prevent pulling user away from inspecting history
  const handleScroll = () => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    setIsUserScrolledUp(distanceFromBottom > 60);
  };

  const scrollToBottom = () => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    setIsUserScrolledUp(false);
  };

  // Only auto-scroll if user has not scrolled up
  useEffect(() => {
    if (!isUserScrolledUp) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [events.length, isUserScrolledUp]);

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-chassis/60 relative">
      {/* Ledger Header */}
      <div className="px-4 lg:px-5 py-2 bg-ledger-plate/90 border-b border-ledger-border flex items-center justify-between text-xs text-rule select-none">
        <span className="font-medium text-argent">
          {isNaked
            ? 'Execution tape'
            : isGovernedExpensive
            ? 'Admission ledger'
            : 'Execution ledger'}
        </span>
        <span className="text-rule-dim tabular-nums text-[11px]">{events.length} {events.length === 1 ? 'event' : 'events'}</span>
      </div>

      {/* Events Tape */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto p-3.5 lg:p-4 space-y-2 overscroll-contain"
      >
        {events.length === 0 ? (
          <div className="h-32 flex flex-col items-center justify-center text-center p-4 text-rule-dim border border-dashed border-ledger-border rounded">
            <div className="text-xs font-mono mb-1">
              {isNaked
                ? 'No events for unprotected runner'
                : isGovernedExpensive
                ? 'No events for governed runner'
                : 'No events for routed runner'}
            </div>
            <div className="text-[11px] text-rule max-w-xs leading-relaxed">
              Events will appear as the replay tape progresses.
            </div>
          </div>
        ) : (
          events.map((ev, idx) => {
            const isLast = idx === events.length - 1;
            const cost = formatCost(ev.displayCost);

            return (
              <div
                key={`${ev.seq || idx}-${ev.ts}`}
                className={`p-2.5 rounded text-xs transition-all border break-words ${
                  isLast
                    ? isNaked && ev.isDeathTrigger
                      ? 'bg-breach/10 border-breach/50 text-argent shadow-sm'
                      : !isNaked && ev.isDecision
                      ? 'bg-decision/10 border-decision/40 text-argent'
                      : 'bg-ledger border-ledger-subtle text-argent'
                    : ev.isDeathTrigger
                    ? 'bg-breach/10 border-breach/30 text-argent'
                    : ev.isDecision
                    ? 'bg-decision/5 border-decision/25 text-argent'
                    : 'bg-ledger/70 border-ledger-border/60 text-rule-bright'
                }`}
              >
                <div className="flex items-center justify-between font-mono text-[10px] mb-1 gap-2 tabular-nums">
                  <div className="flex items-center flex-wrap gap-1.5">
                    <span className="text-rule-dim">{formatTime(ev.relativeMs)}</span>
                    <span className="text-rule-dim">#{ev.seq}</span>

                    {/* Event Tag */}
                    {ev.isDeathTrigger ? (
                      <span className="px-1.5 py-0.2 rounded bg-breach/15 text-breach-bright font-semibold border border-breach/40 uppercase">
                        {ev.event.replace(/_/g, ' ')}
                      </span>
                    ) : ev.isFailure ? (
                      <span className="px-1.5 py-0.2 rounded bg-ledger-plate text-rule-bright font-semibold border border-ledger-border uppercase flex items-center">
                        <AlertTriangle className="w-2.5 h-2.5 mr-1" />
                        PROVIDER FAULT
                      </span>
                    ) : ev.isDecision ? (
                      <span className="px-1.5 py-0.2 rounded bg-decision/15 text-decision-bright font-semibold border border-decision/40 uppercase flex items-center">
                        <ShieldCheck className="w-2.5 h-2.5 mr-1" />
                        DECISION
                      </span>
                    ) : ev.event === 'RESERVATION_CREATED' || ev.event === 'RESERVATION_EXPIRED' ? (
                      <span className="px-1.5 py-0.2 rounded bg-ledger-plate text-rule-bright border border-ledger-border uppercase flex items-center">
                        <Lock className="w-2.5 h-2.5 mr-0.5" />
                        {ev.event === 'RESERVATION_CREATED' ? 'RESERVE' : 'EXPIRED'}
                      </span>
                    ) : ev.event === 'INFERENCE_INTENT' ? (
                      <span className="px-1.5 py-0.2 rounded bg-ledger-plate text-rule-bright border border-ledger-border uppercase flex items-center">
                        <Send className="w-2.5 h-2.5 mr-0.5" />
                        INTENT
                      </span>
                    ) : ev.event === 'INFERENCE_CALL' ? (
                      <span className="px-1.5 py-0.2 rounded bg-ledger-plate text-argent border border-ledger-border uppercase">
                        INFERENCE
                      </span>
                    ) : ev.event === 'COST_COMMITTED' ? (
                      <span className="px-1.5 py-0.2 rounded bg-ledger-plate text-rule-bright border border-ledger-border uppercase">
                        COST
                      </span>
                    ) : ev.event === 'MODEL_ESCALATED' ? (
                      <span className="px-1.5 py-0.2 rounded bg-decision/10 text-decision-bright border border-decision/30 uppercase flex items-center">
                        <ArrowUpRight className="w-2.5 h-2.5 mr-0.5" />
                        ESCALATE
                      </span>
                    ) : !ev.isKnownEvent ? (
                      <span className="px-1.5 py-0.2 rounded bg-ledger-plate text-rule border border-dashed border-ledger-border uppercase flex items-center text-[9px]">
                        <HelpCircle className="w-2.5 h-2.5 mr-1 text-rule-dim" />
                        {ev.event.replace(/_/g, ' ')}
                      </span>
                    ) : (
                      <span className="px-1.5 py-0.2 rounded bg-ledger-plate text-rule uppercase">
                        {ev.event.replace(/_/g, ' ')}
                      </span>
                    )}
                  </div>

                  {/* Dollar impact */}
                  {cost && (
                    <span className="font-mono tabular-nums text-argent font-medium shrink-0">
                      -{cost}
                    </span>
                  )}
                </div>

                {/* Event Description */}
                <div className="leading-relaxed font-sans text-xs break-words">
                  {ev.humanDescription}
                </div>

                {/* Additional context if refusal threshold or diagnostic */}
                {ev.threshold !== undefined && ev.threshold !== null && ev.isDecision && (
                  <div className="mt-1 text-[10px] font-mono text-decision-bright">
                    Configured Safety Cap: {formatCost(ev.threshold)}
                  </div>
                )}
                {ev.raw?.reason && ev.event !== 'COST_COMMITTED' && (
                  <div className="mt-0.5 text-[10px] font-mono text-rule-dim break-all">
                    Diagnostic: {ev.raw.reason}
                  </div>
                )}
              </div>
            );
          })
        )}
        <div ref={bottomRef} />
      </div>

      {/* Floating Jump to Latest Button when user scrolled up */}
      {isUserScrolledUp && (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-3 right-4 px-2.5 py-1 rounded bg-ledger-subtle hover:bg-ledger border border-ledger-border shadow-lg text-[10px] font-mono text-argent flex items-center space-x-1 transition cursor-pointer z-10"
        >
          <ArrowDown className="w-3 h-3 text-governor-bright" />
          <span>Jump to Latest</span>
        </button>
      )}
    </div>
  );
};
