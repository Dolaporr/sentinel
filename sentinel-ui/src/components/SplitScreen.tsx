import React, { useState } from 'react';
import { AgentRunState } from '../types/feed';
import { BudgetHero } from './BudgetHero';
import { EventLedger } from './EventLedger';

interface SplitScreenProps {
  nakedState: AgentRunState;
  governedExpensiveState: AgentRunState;
  sentinelState: AgentRunState;
  divergenceHappened: boolean;
  currentTimeMs?: number;
  totalDurationMs?: number;
  divergenceTimeMs?: number | null;
  deathTimeMs?: number | null;
  completionTimeMs?: number | null;
}

export const SplitScreen: React.FC<SplitScreenProps> = ({
  nakedState,
  governedExpensiveState,
  sentinelState,
  divergenceHappened,
  currentTimeMs = 0,
  totalDurationMs = 298016,
  divergenceTimeMs = 240962,
  deathTimeMs = 296016,
  completionTimeMs = 48735,
}) => {
  const [mobileTab, setMobileTab] = useState<'all' | 'naked' | 'governed' | 'sentinel'>('all');

  const compTime = completionTimeMs ?? 48735;
  const divTime = divergenceTimeMs ?? 240962;
  const dTime = deathTimeMs ?? 296016;
  const isTapeComplete = totalDurationMs ? currentTimeMs >= totalDurationMs - 500 : currentTimeMs >= dTime;

  // Visual weight tracking along concurrent timeline:
  const isTerminalPhase = currentTimeMs >= dTime || isTapeComplete || nakedState.isOvershot;
  const isNakedRunawayPhase = !isTerminalPhase && currentTimeMs > divTime;
  const isControlledRacePhase = !isTerminalPhase && currentTimeMs > compTime && currentTimeMs <= divTime;
  const isInitialSprintPhase = !isTerminalPhase && currentTimeMs <= compTime;

  let nakedDominant = false;
  let nakedRecessed = false;
  let governedDominant = false;
  let governedRecessed = false;
  let sentinelDominant = false;
  let sentinelRecessed = false;

  if (isTerminalPhase) {
    nakedDominant = true;
    nakedRecessed = false;
    governedDominant = true;
    governedRecessed = false;
    sentinelDominant = false;
    sentinelRecessed = true;
  } else if (isNakedRunawayPhase) {
    nakedDominant = true;
    nakedRecessed = false;
    governedDominant = false;
    governedRecessed = true;
    sentinelDominant = false;
    sentinelRecessed = true;
  } else if (isControlledRacePhase) {
    nakedDominant = false;
    nakedRecessed = false;
    governedDominant = false;
    governedRecessed = false;
    sentinelDominant = false;
    sentinelRecessed = true;
  } else if (isInitialSprintPhase) {
    nakedDominant = false;
    nakedRecessed = false;
    governedDominant = false;
    governedRecessed = false;
    sentinelDominant = false;
    sentinelRecessed = false;
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      {/* ─── MOBILE RUNNER SWITCHER TABS (VISIBLE ON < XL) ─── */}
      <div className="xl:hidden bg-ledger-plate border-b border-ledger-border px-3 py-2 flex items-center justify-between gap-1 overflow-x-auto shrink-0 z-20 select-none">
        <button
          onClick={() => setMobileTab('all')}
          className={`px-3 py-1.5 rounded text-xs font-mono transition-colors shrink-0 cursor-pointer ${
            mobileTab === 'all'
              ? 'bg-argent text-chassis font-semibold shadow-sm'
              : 'text-rule hover:text-argent bg-ledger/60'
          }`}
        >
          All 3 Runners
        </button>

        <button
          onClick={() => setMobileTab('naked')}
          className={`px-2.5 py-1.5 rounded text-xs font-mono transition-colors shrink-0 flex items-center space-x-1.5 cursor-pointer ${
            mobileTab === 'naked'
              ? 'bg-breach-bright text-white font-semibold shadow-sm'
              : 'text-rule hover:text-argent bg-ledger/60'
          }`}
        >
          <span>1. Unprotected</span>
          <span className="text-[10px] tabular-nums opacity-90">${nakedState.committedTotal.toFixed(4)}</span>
        </button>

        <button
          onClick={() => setMobileTab('governed')}
          className={`px-2.5 py-1.5 rounded text-xs font-mono transition-colors shrink-0 flex items-center space-x-1.5 cursor-pointer ${
            mobileTab === 'governed'
              ? 'bg-decision-bright text-white font-semibold shadow-sm'
              : 'text-rule hover:text-argent bg-ledger/60'
          }`}
        >
          <span>2. Governed</span>
          <span className="text-[10px] tabular-nums opacity-90">${governedExpensiveState.committedTotal.toFixed(4)}</span>
        </button>

        <button
          onClick={() => setMobileTab('sentinel')}
          className={`px-2.5 py-1.5 rounded text-xs font-mono transition-colors shrink-0 flex items-center space-x-1.5 cursor-pointer ${
            mobileTab === 'sentinel'
              ? 'bg-emerald-600 text-white font-semibold shadow-sm'
              : 'text-rule hover:text-argent bg-ledger/60'
          }`}
        >
          <span>3. Optimizer</span>
          <span className="text-[10px] tabular-nums opacity-90">${sentinelState.committedTotal.toFixed(4)}</span>
        </button>
      </div>

      {/* ─── MOBILE SCROLLABLE VIEW (< XL) ─── */}
      <div className="xl:hidden flex-1 overflow-y-auto flex flex-col min-h-0 bg-chassis divide-y divide-ledger-border">
        {/* VIEW A: ALL 3 RUNNERS STACKED WITH FULL BUDGET HEROES */}
        {mobileTab === 'all' && (
          <>
            {/* Controlled Experiment Header */}
            <div className="bg-ledger-plate px-4 py-2 border-b border-ledger-border text-xs shrink-0">
              <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                <span className="font-semibold text-argent">Controlled experiment:</span>
                <span className="text-rule">identical openai/gpt-4.1 with &amp; without Sentinel</span>
              </div>
            </div>

            {/* Runner 1: Naked (Unprotected Baseline) */}
            <div className="flex flex-col bg-ledger/20 shrink-0">
              <BudgetHero
                state={nakedState}
                divergenceHappened={divergenceHappened}
                roleLabel="1. Unprotected baseline (openai/gpt-4.1)"
                isDominant={nakedDominant}
                isRecessed={nakedRecessed}
              />
              <div className="max-h-60 sm:max-h-72 overflow-y-auto border-t border-ledger-border/60">
                <EventLedger events={nakedState.eventHistory} agentType="naked" />
              </div>
            </div>

            {/* Runner 2: Governed Expensive */}
            <div className="flex flex-col bg-ledger/20 shrink-0 border-t border-ledger-border">
              <BudgetHero
                state={governedExpensiveState}
                divergenceHappened={divergenceHappened}
                roleLabel="2. Governed (identical model + budget governor)"
                isDominant={governedDominant}
                isRecessed={governedRecessed}
              />
              <div className="max-h-60 sm:max-h-72 overflow-y-auto border-t border-ledger-border/60">
                <EventLedger events={governedExpensiveState.eventHistory} agentType="governed-expensive" />
              </div>
            </div>

            {/* Routed Optimizer Header */}
            <div className="bg-ledger-plate px-4 py-2 border-y border-ledger-border text-xs shrink-0">
              <div className="flex items-center space-x-1.5">
                <span className="font-semibold text-argent">Routed optimizer:</span>
                <span className="text-rule">openai/gpt-4.1-mini</span>
              </div>
            </div>

            {/* Runner 3: Sentinel Cheap-Routed */}
            <div className="flex flex-col bg-chassis/40 shrink-0 pb-8">
              <BudgetHero
                state={sentinelState}
                divergenceHappened={divergenceHappened}
                roleLabel="3. Cheap-routed optimizer (openai/gpt-4.1-mini)"
                isDominant={sentinelDominant}
                isRecessed={sentinelRecessed}
              />
              <div className="max-h-60 sm:max-h-72 overflow-y-auto border-t border-ledger-border/60">
                <EventLedger events={sentinelState.eventHistory} agentType="sentinel" />
              </div>
            </div>
          </>
        )}

        {/* VIEW B: RUNNER 1 ISOLATED (UNPROTECTED) */}
        {mobileTab === 'naked' && (
          <div className="flex-1 flex flex-col min-h-0">
            <BudgetHero
              state={nakedState}
              divergenceHappened={divergenceHappened}
              roleLabel="Unprotected baseline (openai/gpt-4.1)"
              isDominant={true}
              isRecessed={false}
            />
            <div className="flex-1 min-h-0 overflow-y-auto border-t border-ledger-border">
              <EventLedger events={nakedState.eventHistory} agentType="naked" />
            </div>
          </div>
        )}

        {/* VIEW C: RUNNER 2 ISOLATED (GOVERNED) */}
        {mobileTab === 'governed' && (
          <div className="flex-1 flex flex-col min-h-0">
            <BudgetHero
              state={governedExpensiveState}
              divergenceHappened={divergenceHappened}
              roleLabel="Governed (identical model + admission governor)"
              isDominant={true}
              isRecessed={false}
            />
            <div className="flex-1 min-h-0 overflow-y-auto border-t border-ledger-border">
              <EventLedger events={governedExpensiveState.eventHistory} agentType="governed-expensive" />
            </div>
          </div>
        )}

        {/* VIEW D: RUNNER 3 ISOLATED (OPTIMIZER) */}
        {mobileTab === 'sentinel' && (
          <div className="flex-1 flex flex-col min-h-0">
            <BudgetHero
              state={sentinelState}
              divergenceHappened={divergenceHappened}
              roleLabel="Cheap-routed optimizer (openai/gpt-4.1-mini)"
              isDominant={true}
              isRecessed={false}
            />
            <div className="flex-1 min-h-0 overflow-y-auto border-t border-ledger-border">
              <EventLedger events={sentinelState.eventHistory} agentType="sentinel" />
            </div>
          </div>
        )}
      </div>

      {/* ─── DESKTOP 3-COLUMN SPLIT SCREEN (VISIBLE ON >= XL) ─── */}
      <div className="hidden xl:grid xl:grid-cols-10 divide-x divide-ledger-border overflow-hidden min-h-0 flex-1">
        {/* LEFT 70%: THE CONTROLLED EXPERIMENT (IDENTICAL MODEL: openai/gpt-4.1) */}
        <div className="xl:col-span-7 flex flex-col h-full overflow-hidden min-w-0">
          {/* Controlled Experiment Plain Language Header */}
          <div className="bg-ledger-plate px-5 py-2.5 border-b border-ledger-border flex items-center justify-between text-xs select-none shrink-0 animate-fade-in delay-100">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="font-semibold text-argent">
                Controlled experiment:
              </span>
              <span className="text-rule">
                identical openai/gpt-4.1 model with and without Sentinel admission control
              </span>
            </div>
          </div>

          {/* The Two Side-by-Side Controlled Runners */}
          <div className="flex-1 grid grid-cols-2 divide-x divide-ledger-border min-h-0 overflow-hidden">
            {/* Runner 1: Naked (Ungoverned, Expensive Model) */}
            <div className="flex flex-col h-full overflow-hidden bg-ledger/20 min-w-0 animate-fade-in-up delay-150">
              <BudgetHero
                state={nakedState}
                divergenceHappened={divergenceHappened}
                roleLabel="Unprotected baseline"
                isDominant={nakedDominant}
                isRecessed={nakedRecessed}
              />
              <EventLedger events={nakedState.eventHistory} agentType="naked" />
            </div>

            {/* Runner 2: Governed Expensive (Same Model, Admission Governor Active) */}
            <div className="flex flex-col h-full overflow-hidden bg-ledger/20 min-w-0 animate-fade-in-up delay-250">
              <BudgetHero
                state={governedExpensiveState}
                divergenceHappened={divergenceHappened}
                roleLabel="Governed (identical model)"
                isDominant={governedDominant}
                isRecessed={governedRecessed}
              />
              <EventLedger events={governedExpensiveState.eventHistory} agentType="governed-expensive" />
            </div>
          </div>
        </div>

        {/* RIGHT 30%: CHEAP-ROUTED OPTIMIZER (openai/gpt-4.1-mini) */}
        <div className="xl:col-span-3 flex flex-col h-full overflow-hidden bg-chassis/40 min-w-0">
          {/* Optimizer Bracket Header */}
          <div className="bg-ledger-plate px-4 py-2.5 border-b border-ledger-border flex items-center justify-between text-xs select-none shrink-0 animate-fade-in delay-200">
            <div className="flex items-center space-x-2 truncate">
              <span className="font-semibold text-argent">
                Routed optimizer:
              </span>
              <span className="text-rule truncate">
                openai/gpt-4.1-mini
              </span>
            </div>
          </div>

          {/* Runner 3: Sentinel Cheap-Routed */}
          <div className="flex-1 flex flex-col h-full overflow-hidden min-w-0 animate-fade-in-up delay-350">
            <BudgetHero
              state={sentinelState}
              divergenceHappened={divergenceHappened}
              roleLabel="Cheap-routed optimizer"
              isDominant={sentinelDominant}
              isRecessed={sentinelRecessed}
            />
            <EventLedger events={sentinelState.eventHistory} agentType="sentinel" />
          </div>
        </div>
      </div>
    </div>
  );
};
