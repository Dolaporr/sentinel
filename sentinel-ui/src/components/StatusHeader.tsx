import React, { useRef } from 'react';
import { Upload, RefreshCw, FileText } from 'lucide-react';
import { SentinelLogo } from './SentinelLogo';
import { GithubIcon } from './GithubIcon';

interface StatusHeaderProps {
  activeFeedName: string;
  onUploadCustomFeed: (content: string, filename: string) => void;
  onResetDefault: () => void;
  eventCount: number;
  initialBudget: number;
  onNavigateLanding?: () => void;
}

export const StatusHeader: React.FC<StatusHeaderProps> = ({
  activeFeedName,
  onUploadCustomFeed,
  onResetDefault,
  eventCount,
  initialBudget,
  onNavigateLanding,
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = event => {
      const text = event.target?.result as string;
      if (text) {
        onUploadCustomFeed(text, file.name);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  return (
    <header className="bg-chassis border-b border-ledger-border px-4 lg:px-6 py-2.5 flex flex-wrap items-center justify-between gap-3 shrink-0 animate-fade-in-down">
      {/* Brand & Mission Specification */}
      <div className="flex items-center space-x-3 lg:space-x-4">
        <div className="flex items-center space-x-2.5">
          {onNavigateLanding ? (
            <button
              onClick={onNavigateLanding}
              className="flex items-center space-x-2 font-semibold text-sm tracking-tight text-argent hover:text-white transition-colors cursor-pointer text-left group"
              title="Return to Sentinel home"
            >
              <SentinelLogo size={18} className="text-white group-hover:text-argent transition-colors" />
              <span>Sentinel Telemetry</span>
            </button>
          ) : (
            <div className="flex items-center space-x-2 font-semibold text-sm tracking-tight text-argent">
              <SentinelLogo size={18} className="text-white" />
              <span>Sentinel Telemetry</span>
            </div>
          )}
        </div>

        <div className="hidden md:block h-3.5 w-[1px] bg-ledger-border" />

        <div className="hidden md:flex items-center space-x-2 text-xs text-rule">
          <span>Autonomous ingestion benchmark</span>
          <span className="text-rule-dim">•</span>
          <span className="tabular-nums">${initialBudget.toFixed(4)} allocation per runner</span>
          <span className="text-rule-dim">•</span>
          <span className="text-rule-dim">Runs recorded sequentially · replayed from each agent&apos;s start.</span>
        </div>
      </div>

      {/* Feed Source & Controls */}
      <div className="flex items-center space-x-3">
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleFileChange}
          accept=".jsonl,.json,.txt"
          className="hidden"
        />

        <div className="flex items-center space-x-2 bg-ledger-plate border border-ledger-border px-2.5 py-1 rounded text-xs font-mono">
          <FileText className="w-3.5 h-3.5 text-rule" />
          <span className="text-rule truncate max-w-[160px]" title={activeFeedName}>
            {activeFeedName}
          </span>
          <span className="text-[10px] text-rule-dim">({eventCount} events)</span>
        </div>

        <button
          onClick={() => fileInputRef.current?.click()}
          className="px-2.5 py-1 rounded text-xs text-rule hover:text-argent bg-ledger border border-ledger-border hover:border-rule-dim transition flex items-center space-x-1 cursor-pointer"
          title="Load recorded JSONL run"
        >
          <Upload className="w-3 h-3 text-rule" />
          <span className="hidden sm:inline">Load feed</span>
        </button>

        {activeFeedName !== 'sample-feed.jsonl' && (
          <button
            onClick={onResetDefault}
            className="p-1 rounded text-rule hover:text-argent hover:bg-ledger transition cursor-pointer"
            title="Reset to sample-feed.jsonl"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        )}

        <div className="h-3.5 w-[1px] bg-ledger-border hidden sm:block" />

        <a
          href="https://github.com/Dolaporr/sentinel"
          target="_blank"
          rel="noreferrer"
          className="px-2.5 py-1 rounded text-xs text-rule hover:text-argent bg-ledger border border-ledger-border hover:border-rule-dim transition flex items-center space-x-1.5 cursor-pointer"
          title="View Sentinel repository on GitHub"
        >
          <GithubIcon size={13} className="text-rule hover:text-white transition-colors" />
          <span className="hidden sm:inline">GitHub</span>
        </a>
      </div>
    </header>
  );
};
