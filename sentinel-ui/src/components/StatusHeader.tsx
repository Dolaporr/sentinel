import React, { useRef } from 'react';
import { Upload, RefreshCw, FileText } from 'lucide-react';

interface StatusHeaderProps {
  activeFeedName: string;
  onUploadCustomFeed: (content: string, filename: string) => void;
  onResetDefault: () => void;
  eventCount: number;
  initialBudget: number;
}

export const StatusHeader: React.FC<StatusHeaderProps> = ({
  activeFeedName,
  onUploadCustomFeed,
  onResetDefault,
  eventCount,
  initialBudget,
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
    <header className="bg-chassis border-b border-ledger-border px-4 lg:px-6 py-2.5 flex flex-wrap items-center justify-between gap-3 shrink-0">
      {/* Brand & Mission Specification */}
      <div className="flex items-center space-x-3 lg:space-x-4">
        <div className="flex items-center space-x-2.5">
          <span className="font-semibold text-sm tracking-tight text-argent">
            Sentinel Telemetry
          </span>
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
      </div>
    </header>
  );
};
