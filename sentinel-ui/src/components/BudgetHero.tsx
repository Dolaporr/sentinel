import React from 'react';
import { AgentRunState } from '../types/feed';

interface BudgetHeroProps {
  state: AgentRunState;
  divergenceHappened: boolean;
  roleLabel?: string;
  isDominant?: boolean;
  isRecessed?: boolean;
}

export const BudgetHero: React.FC<BudgetHeroProps> = ({
  state,
  roleLabel,
  isDominant = true,
  isRecessed = false,
}) => {
  const isNaked = state.agent === 'naked';
  const isGovernedExpensive = state.agent === 'governed-expensive';
  const isQuarantined = state.missionState === 'quarantined_unproductive';
  const isOvershot = state.isOvershot || state.budgetRemaining < 0;
  const isComplete = state.status === 'COMPLETED';
  const isIdle = state.status === 'IDLE';

  const initial = state.initialBudget > 0 ? state.initialBudget : 0.25;
  const spent = state.committedTotal;
  const remaining = state.budgetRemaining;
  const reserved = state.reservedTotal;

  // Exact percentages based on allocation
  const spentPct = (spent / initial) * 100;
  const overshootPct = isOvershot ? Math.max(0, spentPct - 100) : 0;

  // Format currency with precision (including negative values)
  const formatMoney = (val: number) => {
    if (val === undefined || isNaN(val)) return '$0.0000';
    if (val < 0) {
      const pos = Math.abs(val);
      return `-$${pos.toFixed(4)}`;
    }
    return `$${val.toFixed(4)}`;
  };

  return (
    <div
      className={`p-5 lg:p-6 bg-ledger flex flex-col justify-between select-none transition-all duration-300 ${
        isRecessed ? 'opacity-40 hover:opacity-75' : 'opacity-100'
      }`}
    >
      {/* Runner Identity & Status Bar */}
      <div>
        <div className="flex items-start justify-between mb-3 gap-2">
          <div className="min-w-0">
            <div className="text-[11px] font-mono tracking-wide text-rule truncate">
              {roleLabel || (isNaked ? 'Unprotected baseline' : isGovernedExpensive ? 'Governed runner' : 'Cheap-routed runner')}
            </div>
            <div className="text-sm font-semibold tracking-tight text-argent truncate mt-0.5">
              {state.name}
            </div>
            <div className="text-[11px] font-mono text-rule-dim truncate mt-0.5">
              {state.model}
            </div>
          </div>

          {/* Status Pill - 3 semantic states: Breach, Decision, or Neutral */}
          <div className="shrink-0">
            {isOvershot ? (
              <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase bg-breach/15 text-breach-bright border border-breach/40 animate-pulse">
                Budget breached
              </span>
            ) : isQuarantined ? (
              <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-mono font-medium uppercase bg-decision/15 text-decision-bright border border-decision/40">
                Quarantined
              </span>
            ) : isComplete ? (
              <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-mono font-medium uppercase bg-ledger-plate text-argent border border-ledger-border">
                Completed
              </span>
            ) : isIdle ? (
              <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-mono uppercase bg-chassis text-rule-dim border border-ledger-border">
                Queued
              </span>
            ) : (
              <span className="inline-flex items-center space-x-1.5 px-2 py-0.5 rounded text-[10px] font-mono uppercase bg-ledger-plate text-rule-bright border border-ledger-border">
                <span className="w-1.5 h-1.5 rounded-full bg-argent animate-ping" />
                <span>{state.inFlightIntentCount > 0 ? `In flight (${state.inFlightIntentCount})` : 'Active'}</span>
              </span>
            )}
          </div>
        </div>

        {/* PROTAGONIST: LIVE BUDGET READOUT */}
        <div className="my-3">
          <div className="text-[11px] font-mono text-rule flex items-center justify-between">
            <span>Remaining budget</span>
            <span className="text-[11px] text-rule-dim tabular-nums">Initial {formatMoney(initial)}</span>
          </div>

          <div className="mt-1 flex items-baseline space-x-2">
            <span
              className={`font-sans font-black tracking-tight tabular-nums transition-all duration-200 ${
                isDominant
                  ? 'text-4xl xl:text-5xl'
                  : isRecessed
                  ? 'text-3xl xl:text-4xl text-rule'
                  : 'text-4xl xl:text-5xl'
              } ${
                isOvershot
                  ? 'text-breach-bright'
                  : isRecessed
                  ? 'text-rule'
                  : 'text-argent'
              }`}
            >
              {formatMoney(remaining)}
            </span>
          </div>

          {/* METRICS LINE (Plain text line replacing 9 bordered boxes) */}
          <div className="mt-2 text-[11px] font-mono text-rule flex items-center space-x-2 tabular-nums">
            <span>{formatMoney(state.burnRatePerSec)}/s burn</span>
            <span className="text-rule-dim">•</span>
            <span>{state.callCount} calls</span>
            <span className="text-rule-dim">•</span>
            <span>{isNaked ? 'unmetered' : state.refusalCount > 0 ? `${state.refusalCount} refused` : '0 refused'}</span>
            {state.failureCount > 0 && (
              <>
                <span className="text-rule-dim">•</span>
                <span className="text-rule-dim">{state.failureCount} upstream faults</span>
              </>
            )}
          </div>

          {/* THE SHARED CEILING BAR & PHYSICAL RUPTURE */}
          <div className="mt-4">
            {/* Datum label above bar */}
            <div className="relative mb-1 flex items-center justify-between text-[10px] font-mono text-rule-dim select-none">
              <span>$0.0000</span>
              <span
                style={{ left: '75%' }}
                className="absolute -translate-x-full pr-1.5 font-medium text-rule whitespace-nowrap"
              >
                Ceiling {formatMoney(initial)}
              </span>
              {isOvershot ? (
                <span className="text-breach-bright font-bold whitespace-nowrap tabular-nums">
                  +{formatMoney(state.overshootAmount)}
                </span>
              ) : null}
            </div>

            {/* Bar Track Container with Shared 75% Hard Ceiling Edge */}
            <div className="relative">
              <div
                className={`h-3.5 w-full bg-chassis rounded-xs flex border relative ${
                  isOvershot ? 'border-breach/50 shadow-sm shadow-breach/20' : 'border-ledger-border'
                }`}
              >
                {/* 100% Shared Budget Ceiling Line (at exactly 75% width) */}
                <div
                  style={{ left: '75%' }}
                  className={`absolute top-[-2px] bottom-[-2px] w-[2px] z-20 pointer-events-none transition-colors ${
                    isOvershot ? 'bg-breach-bright' : 'bg-rule'
                  }`}
                  title={`Hard Ceiling (${formatMoney(initial)})`}
                />

                {/* Normal Spent Portion (scaled so 100% budget fills 75% track width) */}
                <div
                  style={{ width: `${Math.min(75, (Math.min(100, spentPct) / 100) * 75)}%` }}
                  className={`h-full transition-all duration-100 ${
                    isOvershot
                      ? 'bg-breach'
                      : isGovernedExpensive
                      ? 'bg-rule-bright'
                      : 'bg-rule-dim'
                  }`}
                />

                {/* In-Flight Reservation Portion */}
                {reserved > 0 && !isOvershot && (
                  <div
                    style={{
                      width: `${Math.min(75 - (Math.min(100, spentPct) / 100) * 75, (reserved / initial) * 75)}%`,
                    }}
                    className="h-full bg-decision transition-all duration-100 animate-pulse"
                    title={`In-flight exposure: ${formatMoney(reserved)}`}
                  />
                )}

                {/* THE PHYSICAL BREACH RUPTURE (Naked blowing through ceiling) */}
                {isOvershot && (
                  <div
                    style={{
                      left: '75%',
                      width: `${Math.min(25, (overshootPct / 25) * 25)}%`,
                    }}
                    className="absolute top-[-1px] bottom-[-1px] bg-breach z-10 animate-pulse flex items-center border-l-2 border-white"
                    title={`BREACH: +${formatMoney(state.overshootAmount)} beyond ceiling`}
                  />
                )}
              </div>

              {/* Overhanging geometric breach tag when limit punctured */}
              {isOvershot && (
                <div className="mt-1.5 flex items-center justify-between text-[11px] font-mono">
                  <span className="text-rule">
                    Spent {formatMoney(spent)} ({spentPct.toFixed(1)}%)
                  </span>
                  <span className="text-breach-bright font-bold uppercase tracking-wider animate-pulse">
                    Breach: +{formatMoney(state.overshootAmount)}
                  </span>
                </div>
              )}

              {!isOvershot && (
                <div className="mt-1.5 flex items-center justify-between text-[11px] font-mono text-rule">
                  <span>
                    Spent {formatMoney(spent)} ({spentPct.toFixed(1)}%)
                  </span>
                  <span className="text-argent tabular-nums">
                    {((remaining / initial) * 100).toFixed(1)}% solvent
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* PLAIN CAPTION (Replaces loud explainer cards: no box, no tint, no icon) */}
      <div className="mt-2 min-h-[2.5rem] flex items-end">
        {isNaked && isOvershot && (
          <div className="text-xs text-breach-bright leading-relaxed font-mono">
            Budget ceiling breached by +{formatMoney(state.overshootAmount)}. Unprotected runner sailed past allocation limit.
          </div>
        )}

        {isGovernedExpensive && isQuarantined && (
          <div className="text-xs text-rule leading-relaxed">
            <span className="text-argent font-medium">Governor admission intercept.</span>{' '}
            Ran identical model as Naked; halted dispatches once limit was reached, preserving{' '}
            <span className="text-argent font-semibold tabular-nums">{formatMoney(remaining)}</span> solvent.
          </div>
        )}

        {!isNaked && !isGovernedExpensive && isComplete && (
          <div className="text-xs text-rule leading-relaxed">
            <span className="text-argent font-medium">Max solvency route.</span>{' '}
            Cheap-routed model preserved{' '}
            <span className="text-argent font-semibold tabular-nums">{formatMoney(remaining)}</span>{' '}
            ({((remaining / initial) * 100).toFixed(1)}%) of allocation.
          </div>
        )}
      </div>
    </div>
  );
};
