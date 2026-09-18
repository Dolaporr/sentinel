import React from 'react';
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
  const compTime = completionTimeMs ?? 48735;
  const divTime = divergenceTimeMs ?? 240962;
  const dTime = deathTimeMs ?? 296016;
  const isTapeComplete = totalDurationMs ? currentTimeMs >= totalDurationMs - 500 : currentTimeMs >= dTime;

  // Visual weight tracking along concurrent timeline:
  // 1. Initial sprint (0 to compTime, ~48s): All 3 runners active and racing concurrently at full strength
  // 2. Controlled race (compTime to divTime, ~48s to ~241s): Sentinel finished and recedes; Naked & Governed battle side-by-side
  // 3. Naked runaway (divTime to dTime, ~241s to ~296s): Governor halts Governed; Naked runs uncontrolled towards breach
  // 4. Terminal phase (dTime onwards, ~296s+): Naked breached ceiling; Governed held solvent; controlled pair spotlighted side-by-side
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
    // Both terminal outcomes of the controlled experiment hold full weight; optimizer recedes
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
    // All 3 runners actively executing concurrently
    nakedDominant = false;
    nakedRecessed = false;
    governedDominant = false;
    governedRecessed = false;
    sentinelDominant = false;
    sentinelRecessed = false;
  }

  return (
    <div className="flex-1 grid grid-cols-1 xl:grid-cols-10 divide-y xl:divide-y-0 xl:divide-x divide-ledger-border overflow-hidden min-h-0">
      {/* LEFT 70%: THE CONTROLLED EXPERIMENT (IDENTICAL MODEL: openai/gpt-4.1) */}
      <div className="xl:col-span-7 flex flex-col h-full overflow-hidden min-w-0">
        {/* Controlled Experiment Plain Language Header */}
        <div className="bg-ledger-plate px-5 py-2.5 border-b border-ledger-border flex items-center justify-between text-xs select-none shrink-0">
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
        <div className="flex-1 grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-ledger-border min-h-0 overflow-hidden">
          {/* Runner 1: Naked (Ungoverned, Expensive Model) */}
          <div className="flex flex-col h-full overflow-hidden bg-ledger/20 min-w-0">
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
          <div className="flex flex-col h-full overflow-hidden bg-ledger/20 min-w-0">
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
        <div className="bg-ledger-plate px-4 py-2.5 border-b border-ledger-border flex items-center justify-between text-xs select-none shrink-0">
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
        <div className="flex-1 flex flex-col h-full overflow-hidden min-w-0">
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
  );
};
