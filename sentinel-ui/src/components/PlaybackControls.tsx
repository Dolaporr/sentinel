import React from 'react';
import { Play, Pause, RotateCcw } from 'lucide-react';

interface PlaybackControlsProps {
  isPlaying: boolean;
  currentTimeMs: number;
  totalDurationMs: number;
  speed: number;
  divergenceTimeMs: number | null;
  deathTimeMs: number | null;
  completionTimeMs: number | null;
  onPlay: () => void;
  onPause: () => void;
  onTogglePlay: () => void;
  onRestart: () => void;
  onSeek: (ms: number) => void;
  onSpeedChange: (speed: number) => void;
}

export const PlaybackControls: React.FC<PlaybackControlsProps> = ({
  isPlaying,
  currentTimeMs,
  totalDurationMs,
  speed,
  divergenceTimeMs,
  deathTimeMs,
  completionTimeMs,
  onTogglePlay,
  onRestart,
  onSeek,
  onSpeedChange,
}) => {
  const formatTime = (ms: number) => {
    if (!ms || isNaN(ms) || ms < 0) return '00:00.00';
    const totalSec = ms / 1000;
    const hours = Math.floor(totalSec / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    const secs = (totalSec % 60).toFixed(2);
    const paddedSecs = (Number(secs) < 10 ? '0' : '') + secs;
    if (hours > 0) {
      return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${paddedSecs}`;
    }
    return `${mins.toString().padStart(2, '0')}:${paddedSecs}`;
  };

  const speeds = [0.5, 1, 2, 5, 10];

  return (
    <div className="bg-ledger-plate border-y border-ledger-border px-4 lg:px-6 py-2.5 select-none shrink-0">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-2.5">
        {/* Play/Pause, Rewind, and Quick Jumps */}
        <div className="flex items-center space-x-2 shrink-0">
          <button
            onClick={onRestart}
            title="Rewind to Start"
            className="p-1.5 rounded hover:bg-chassis text-rule hover:text-argent transition border border-ledger-border cursor-pointer"
          >
            <RotateCcw className="w-4 h-4" />
          </button>

          <button
            onClick={onTogglePlay}
            className={`px-3.5 py-1.5 rounded text-xs font-mono font-semibold flex items-center space-x-1.5 transition cursor-pointer ${
              isPlaying
                ? 'bg-chassis border border-ledger-subtle text-argent hover:border-rule'
                : 'bg-argent text-chassis hover:bg-white'
            }`}
          >
            {isPlaying ? (
              <>
                <Pause className="w-3.5 h-3.5" />
                <span>PAUSE</span>
              </>
            ) : (
              <>
                <Play className="w-3.5 h-3.5 fill-current" />
                <span>{currentTimeMs >= totalDurationMs ? 'REPLAY' : 'PLAY'}</span>
              </>
            )}
          </button>

          {/* Quick Milestone Jumps */}
          {completionTimeMs !== null && (
            <button
              onClick={() => onSeek(completionTimeMs)}
              className="px-2 py-1 rounded text-[11px] font-mono text-rule hover:text-argent hover:bg-chassis border border-ledger-border transition hidden lg:inline-flex items-center cursor-pointer"
              title="Seek to Sentinel completion"
            >
              Complete ({formatTime(completionTimeMs)})
            </button>
          )}

          {divergenceTimeMs !== null && (
            <button
              onClick={() => onSeek(divergenceTimeMs)}
              className="px-2 py-1 rounded text-[11px] font-mono text-decision-bright hover:bg-decision/10 border border-decision/40 transition hidden sm:inline-flex items-center cursor-pointer"
              title="Seek to Governor refusal"
            >
              Divergence ({formatTime(divergenceTimeMs)})
            </button>
          )}

          {deathTimeMs !== null && (
            <button
              onClick={() => onSeek(deathTimeMs)}
              className="px-2 py-1 rounded text-[11px] font-mono text-breach-bright hover:bg-breach/10 border border-breach/40 transition hidden sm:inline-flex items-center cursor-pointer"
              title="Seek to Naked budget breach"
            >
              Breach ({formatTime(deathTimeMs)})
            </button>
          )}
        </div>

        {/* Central Scrubber Slider with Milestones */}
        <div className="flex-1 max-w-xl mx-2 flex flex-col justify-center min-w-[200px]">
          <div className="relative flex items-center h-4">
            {/* Base track */}
            <input
              type="range"
              min={0}
              max={totalDurationMs}
              value={currentTimeMs}
              onChange={e => onSeek(Number(e.target.value))}
              className="w-full h-1.5 bg-chassis rounded-lg appearance-none cursor-pointer accent-argent z-10"
            />

            {/* Completion marker tick (Neutral) */}
            {completionTimeMs !== null && totalDurationMs > 0 && (
              <div
                style={{ left: `${(completionTimeMs / totalDurationMs) * 100}%` }}
                className="absolute top-0 bottom-0 w-0.5 bg-rule z-0 pointer-events-none"
                title="Completion"
              />
            )}

            {/* Divergence marker tick (Decision Blue) */}
            {divergenceTimeMs !== null && totalDurationMs > 0 && (
              <div
                style={{ left: `${(divergenceTimeMs / totalDurationMs) * 100}%` }}
                className="absolute top-0 bottom-0 w-0.5 bg-decision-bright z-0 pointer-events-none"
                title="Governor Intercept"
              />
            )}

            {/* Breach marker tick (Breach Red) */}
            {deathTimeMs !== null && totalDurationMs > 0 && (
              <div
                style={{ left: `${(deathTimeMs / totalDurationMs) * 100}%` }}
                className="absolute top-0 bottom-0 w-0.5 bg-breach-bright z-0 pointer-events-none"
                title="Budget Breach"
              />
            )}
          </div>

          <div className="flex justify-between text-[10px] font-mono text-rule-dim mt-0.5 tabular-nums">
            <span>00:00.00</span>
            <span className="text-rule font-medium">
              Tape {formatTime(currentTimeMs)} / {formatTime(totalDurationMs)}
            </span>
            <span>{formatTime(totalDurationMs)}</span>
          </div>
        </div>

        {/* Speed Selector Buttons */}
        <div className="flex items-center space-x-1 shrink-0">
          <span className="text-[10px] font-mono uppercase text-rule-dim mr-1 hidden lg:inline">Speed:</span>
          {speeds.map(s => (
            <button
              key={s}
              onClick={() => onSpeedChange(s)}
              className={`px-2 py-0.5 rounded text-[11px] font-mono font-medium transition cursor-pointer ${
                speed === s
                  ? 'bg-chassis border border-argent text-argent'
                  : 'text-rule hover:text-argent hover:bg-chassis/60'
              }`}
            >
              {s}x
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};
