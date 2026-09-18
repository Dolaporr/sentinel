import { useReplayEngine } from './hooks/useReplayEngine';
import { StatusHeader } from './components/StatusHeader';
import { PlaybackControls } from './components/PlaybackControls';
import { SplitScreen } from './components/SplitScreen';
import { AlertTriangle } from 'lucide-react';

export function App() {
  const {
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
    resetToDefaultFixture,
  } = useReplayEngine('/sample-feed.jsonl');

  const divergenceHappened = divergenceTimeMs !== null && currentTimeMs >= divergenceTimeMs;

  return (
    <div className="h-screen w-screen flex flex-col bg-chassis text-argent overflow-hidden select-none font-sans">
      {/* Top Telemetry Header */}
      <StatusHeader
        activeFeedName={activeFeedName}
        onUploadCustomFeed={loadRawFeed}
        onResetDefault={resetToDefaultFixture}
        eventCount={events.length}
        initialBudget={initialBudget}
      />

      {/* Main Playback Tape Controls */}
      <PlaybackControls
        isPlaying={isPlaying}
        currentTimeMs={currentTimeMs}
        totalDurationMs={totalDurationMs}
        speed={speed}
        divergenceTimeMs={divergenceTimeMs}
        deathTimeMs={deathTimeMs}
        completionTimeMs={completionTimeMs}
        onPlay={play}
        onPause={pause}
        onTogglePlay={togglePlay}
        onRestart={restart}
        onSeek={seek}
        onSpeedChange={setSpeed}
      />

      {/* Error state if feed load fails */}
      {error && (
        <div className="p-4 bg-crimson/20 border-b border-crimson/40 text-crimson-bright text-xs font-mono flex items-center space-x-2 shrink-0">
          <AlertTriangle className="w-4 h-4" />
          <span>Feed Load Error: {error}</span>
        </div>
      )}

      {/* Loading state */}
      {isLoading ? (
        <div className="flex-1 flex items-center justify-center font-mono text-xs text-rule">
          <div className="flex items-center space-x-2">
            <span className="w-2 h-2 rounded-full bg-governor-bright animate-ping" />
            <span>Parsing telemetry stream from sample-feed.jsonl...</span>
          </div>
        </div>
      ) : (
        /* The Asymmetric 2+1 Divergence Arena */
        <SplitScreen
          nakedState={nakedState}
          governedExpensiveState={governedExpensiveState}
          sentinelState={sentinelState}
          divergenceHappened={divergenceHappened}
          currentTimeMs={currentTimeMs}
          totalDurationMs={totalDurationMs}
          divergenceTimeMs={divergenceTimeMs}
          deathTimeMs={deathTimeMs}
          completionTimeMs={completionTimeMs}
        />
      )}
    </div>
  );
}
