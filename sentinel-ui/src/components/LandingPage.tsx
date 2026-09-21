import React, { useState, useEffect } from 'react';
import { Copy, Check, Play, Maximize2, ExternalLink, ArrowRight, ArrowDown } from 'lucide-react';
import { SentinelLogo } from './SentinelLogo';
import { SentinelBackdrop } from './SentinelBackdrop';
import { GithubIcon } from './GithubIcon';
import { ScrollReveal } from './ScrollReveal';
import { useReplayEngine } from '../hooks/useReplayEngine';
import { PlaybackControls } from './PlaybackControls';
import { SplitScreen } from './SplitScreen';

interface LandingPageProps {
  onNavigateReplay: () => void;
}

const TERMINAL_LINES = [
  { text: 'Sentinel listening on http://127.0.0.1:8787', type: 'startup' },
  { text: 'budget $5.0000/day', type: 'startup' },
  { text: 'price table 452 models from gateway', type: 'startup' },
  { text: 'upstream key configured (your tools never see it)', type: 'startup' },
  { text: '[admitted] gpt-4.1-mini · reserved $0.0021 · $4.9979', type: 'admitted' },
  { text: '[admitted] gpt-4.1 · reserved $0.0287 · $4.9692', type: 'admitted' },
  { text: '[admitted] gpt-4.1 · reserved $0.0294 · $4.9398', type: 'admitted' },
  { text: '...', type: 'dots' },
  { text: '[REFUSED] gpt-4.1 · worst case $0.0438 > $0.0176 left', type: 'refused' },
  { text: '402 · no upstream call made', type: 'outcome' },
];

export const LandingPage: React.FC<LandingPageProps> = ({ onNavigateReplay }) => {
  const [copiedCommand, setCopiedCommand] = useState(false);
  const [copiedBaseUrl, setCopiedBaseUrl] = useState(false);
  const [visibleLineCount, setVisibleLineCount] = useState(TERMINAL_LINES.length);
  const [isReducedMotion, setIsReducedMotion] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  // Initialize replay engine for embedded evidence section
  const {
    events,
    isLoading: isReplayLoading,
    error: replayError,
    isPlaying,
    currentTimeMs,
    totalDurationMs,
    speed,
    divergenceTimeMs,
    deathTimeMs,
    completionTimeMs,
    nakedState,
    governedExpensiveState,
    sentinelState,
    play,
    pause,
    togglePlay,
    restart,
    seek,
    setSpeed,
  } = useReplayEngine('/sample-feed.jsonl');

  const divergenceHappened = divergenceTimeMs !== null && currentTimeMs >= divergenceTimeMs;

  // Check prefers-reduced-motion
  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    setIsReducedMotion(mediaQuery.matches);

    const handleChange = (e: MediaQueryListEvent) => {
      setIsReducedMotion(e.matches);
    };
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  // Terminal line-by-line typing loop (crisp pacing)
  useEffect(() => {
    if (isReducedMotion) {
      setVisibleLineCount(TERMINAL_LINES.length);
      return;
    }

    let timeouts: ReturnType<typeof setTimeout>[] = [];

    const scheduleSequence = () => {
      setVisibleLineCount(0);
      timeouts.forEach(clearTimeout);
      timeouts = [];

      const lineDelays = [
        0,     // line 0: listening
        240,   // line 1: budget
        480,   // line 2: price table
        720,   // line 3: upstream key
        1100,  // line 4: admitted mini
        1550,  // line 5: admitted 4.1
        2000,  // line 6: admitted 4.1
        2450,  // line 7: dots
        3050,  // line 8: REFUSED (deliberate beat)
        3600,  // line 9: 402 outcome
      ];

      lineDelays.forEach((delay, idx) => {
        const t = setTimeout(() => {
          setVisibleLineCount(idx + 1);
        }, delay);
        timeouts.push(t);
      });

      // Hold for 4.5 seconds after completion before restarting
      const loopTimeout = setTimeout(() => {
        scheduleSequence();
      }, 3600 + 4500);
      timeouts.push(loopTimeout);
    };

    scheduleSequence();

    return () => {
      timeouts.forEach(clearTimeout);
    };
  }, [isReducedMotion]);

  const copyToClipboard = async (text: string, kind: 'command' | 'baseurl') => {
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const textArea = document.createElement('textarea');
        textArea.value = text;
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
      }

      if (kind === 'command') {
        setCopiedCommand(true);
        setTimeout(() => setCopiedCommand(false), 2000);
      } else {
        setCopiedBaseUrl(true);
        setTimeout(() => setCopiedBaseUrl(false), 2000);
      }
    } catch {
      // ignore
    }
  };

  const scrollToSection = (id: string) => {
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth' });
    }
  };

  return (
    <div className="min-h-screen bg-chassis text-argent font-sans antialiased selection:bg-ledger-subtle selection:text-argent relative">
      {/* Subtle Atmospheric Sentinel Silhouette & Ambient Refraction Lighting */}
      <SentinelBackdrop mode="landing" />

      {/* Top minimal frosted console bar */}
      <nav className="sticky top-0 z-30 border-b border-white/[0.08] px-4 sm:px-8 py-3 backdrop-blur-md bg-chassis/80">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2.5 sm:space-x-3 shrink-0">
            <SentinelLogo size={18} className="text-white" />
            <span className="font-semibold text-sm tracking-tight text-argent font-mono">
              SENTINEL
            </span>
            <span className="text-white/20 hidden sm:inline">/</span>
            <span className="text-xs text-rule font-mono hidden sm:inline">
              spend governor for autonomous agents
            </span>
          </div>

          {/* Desktop Nav Links (Hidden on Mobile) */}
          <div className="hidden md:flex items-center space-x-3.5 lg:space-x-4 text-xs font-mono text-rule">
            <button
              onClick={() => scrollToSection('quickstart')}
              className="hover:text-argent transition-colors cursor-pointer"
            >
              quickstart
            </button>
            <span className="text-white/10">·</span>
            <button
              onClick={() => scrollToSection('architecture')}
              className="hover:text-argent transition-colors cursor-pointer"
            >
              how it works
            </button>
            <span className="text-white/10">·</span>
            <button
              onClick={() => scrollToSection('proof')}
              className="hover:text-argent transition-colors cursor-pointer"
            >
              proof
            </button>
            <span className="text-white/10">·</span>
            <button
              onClick={() => scrollToSection('evidence')}
              className="hover:text-argent transition-colors cursor-pointer text-argent font-medium"
            >
              evidence
            </button>
            <span className="text-white/10">·</span>
            <button
              onClick={() => scrollToSection('limitations')}
              className="hover:text-argent transition-colors cursor-pointer"
            >
              limitations
            </button>

            <span className="text-white/20">|</span>

            <button
              onClick={onNavigateReplay}
              className="flex items-center space-x-1 hover:text-argent transition-colors cursor-pointer text-argent group"
              title="Open dedicated full-screen replay console"
            >
              <Play className="w-3 h-3 fill-current text-rule group-hover:text-argent transition-colors shrink-0" />
              <span>full-screen</span>
            </button>

            <a
              href="https://github.com/Dolaporr/sentinel"
              target="_blank"
              rel="noreferrer"
              className="flex items-center space-x-1.5 hover:text-argent transition-colors"
              title="View Sentinel on GitHub"
            >
              <GithubIcon size={14} />
              <span>github</span>
            </a>
          </div>

          {/* Styled Sentinel Mobile Collapsible Toggle Button */}
          <button
            onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
            className="md:hidden inline-flex items-center space-x-1.5 px-2.5 py-1.5 rounded-lg border border-white/[0.12] bg-white/[0.04] hover:bg-white/[0.08] active:bg-white/[0.1] text-argent font-mono text-xs transition cursor-pointer select-none"
            aria-label="Toggle navigation menu"
            aria-expanded={isMobileMenuOpen}
          >
            <span className="text-amber-400 font-bold text-[11px] select-none">[</span>
            <span className="text-rule text-[11px] uppercase tracking-wider font-semibold">
              {isMobileMenuOpen ? 'close' : 'menu'}
            </span>
            <div className="w-3.5 h-3 flex flex-col justify-between items-center py-0.5 ml-0.5">
              <span
                className={`block w-3 h-[1.5px] bg-argent transition-all duration-200 ${
                  isMobileMenuOpen ? 'rotate-45 translate-y-[3.5px]' : ''
                }`}
              />
              <span
                className={`block w-3 h-[1.5px] bg-argent transition-all duration-200 ${
                  isMobileMenuOpen ? 'opacity-0 scale-x-0' : 'opacity-100'
                }`}
              />
              <span
                className={`block w-3 h-[1.5px] bg-argent transition-all duration-200 ${
                  isMobileMenuOpen ? '-rotate-45 -translate-y-[3.5px]' : ''
                }`}
              />
            </div>
            <span className="text-amber-400 font-bold text-[11px] select-none">]</span>
          </button>
        </div>

        {/* Collapsible Mobile Menu Drawer */}
        {isMobileMenuOpen && (
          <div className="md:hidden pt-3 pb-2 mt-2 border-t border-white/[0.08] font-mono text-xs animate-fade-in-down">
            <div className="flex items-center justify-between text-[10px] uppercase tracking-widest text-rule-dim mb-2 px-1">
              <span>Operator Navigation</span>
              <span className="text-amber-400/90 font-medium">proxy · active</span>
            </div>

            <div className="flex flex-col space-y-1">
              <button
                onClick={() => {
                  scrollToSection('quickstart');
                  setIsMobileMenuOpen(false);
                }}
                className="flex items-center justify-between py-2.5 px-3 rounded-lg text-argent hover:bg-white/[0.06] active:bg-white/[0.08] transition text-left cursor-pointer"
              >
                <span className="flex items-center space-x-2.5">
                  <span className="text-rule-dim text-[11px]">01</span>
                  <span className="font-medium">Quickstart</span>
                </span>
                <span className="text-[10px] text-rule-dim font-sans">↓</span>
              </button>

              <button
                onClick={() => {
                  scrollToSection('architecture');
                  setIsMobileMenuOpen(false);
                }}
                className="flex items-center justify-between py-2.5 px-3 rounded-lg text-argent hover:bg-white/[0.06] active:bg-white/[0.08] transition text-left cursor-pointer"
              >
                <span className="flex items-center space-x-2.5">
                  <span className="text-rule-dim text-[11px]">02</span>
                  <span className="font-medium">How it works (Architecture)</span>
                </span>
                <span className="text-[10px] text-rule-dim font-sans">↓</span>
              </button>

              <button
                onClick={() => {
                  scrollToSection('proof');
                  setIsMobileMenuOpen(false);
                }}
                className="flex items-center justify-between py-2.5 px-3 rounded-lg text-argent hover:bg-white/[0.06] active:bg-white/[0.08] transition text-left cursor-pointer"
              >
                <span className="flex items-center space-x-2.5">
                  <span className="text-rule-dim text-[11px]">03</span>
                  <span className="font-medium">Technical Proof</span>
                </span>
                <span className="text-[10px] text-rule-dim font-sans">↓</span>
              </button>

              <button
                onClick={() => {
                  scrollToSection('evidence');
                  setIsMobileMenuOpen(false);
                }}
                className="flex items-center justify-between py-2.5 px-3 rounded-lg text-white font-medium bg-white/[0.04] border border-white/[0.08] active:bg-white/[0.08] transition text-left cursor-pointer"
              >
                <span className="flex items-center space-x-2.5">
                  <span className="text-amber-400 text-[11px]">04</span>
                  <span>Evidence: 3-Agent Replay</span>
                </span>
                <span className="text-[10px] text-amber-400/90 font-mono bg-amber-400/[0.1] px-1.5 py-0.5 rounded">
                  centerpiece
                </span>
              </button>

              <button
                onClick={() => {
                  scrollToSection('limitations');
                  setIsMobileMenuOpen(false);
                }}
                className="flex items-center justify-between py-2.5 px-3 rounded-lg text-argent hover:bg-white/[0.06] active:bg-white/[0.08] transition text-left cursor-pointer"
              >
                <span className="flex items-center space-x-2.5">
                  <span className="text-rule-dim text-[11px]">05</span>
                  <span className="font-medium">Limitations</span>
                </span>
                <span className="text-[10px] text-rule-dim font-sans">↓</span>
              </button>
            </div>

            <div className="pt-3 mt-2 border-t border-white/[0.08] flex items-center gap-2">
              <button
                onClick={() => {
                  setIsMobileMenuOpen(false);
                  onNavigateReplay();
                }}
                className="flex-1 py-2 px-3 rounded-lg bg-white/[0.07] hover:bg-white/[0.12] active:bg-white/[0.15] border border-white/10 text-white font-medium flex items-center justify-center space-x-1.5 transition text-xs cursor-pointer shadow-sm"
              >
                <Play className="w-3 h-3 fill-current text-argent" />
                <span>Full-Screen Console ↗</span>
              </button>

              <a
                href="https://github.com/Dolaporr/sentinel"
                target="_blank"
                rel="noreferrer"
                className="py-2 px-3 rounded-lg bg-white/[0.03] hover:bg-white/[0.08] border border-white/[0.08] text-rule hover:text-argent flex items-center space-x-1.5 transition text-xs"
              >
                <GithubIcon size={13} />
                <span>GitHub</span>
              </a>
            </div>
          </div>
        )}
      </nav>

      {/* Main Content Container */}
      <main className="relative z-10 max-w-5xl mx-auto px-4 sm:px-8 pt-8 sm:pt-16 pb-24 space-y-16 sm:space-y-24">

        {/* ─── 00. TOP-LEVEL NARRATIVE (10-SECOND PRODUCT COMPREHENSION) ─── */}
        <section className="space-y-8">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
            {/* Left Column: Core Narrative Header */}
            <div className="lg:col-span-6 space-y-5 animate-fade-in-up">
              {/* Operator Status Badge */}
              <div className="inline-flex items-center space-x-2 px-2.5 py-1 rounded-full border border-white/10 bg-white/[0.04] backdrop-blur-md text-[11px] font-mono text-rule">
                <span className="w-1.5 h-1.5 rounded-full bg-[#E9A13B] animate-pulse" />
                <span>the gate · armed · local proxy 127.0.0.1:8787</span>
              </div>

              <div className="space-y-2">
                <div className="font-mono text-xs text-rule tracking-wider uppercase">
                  SENTINEL
                </div>
                <h1 className="text-3xl sm:text-4xl lg:text-[42px] font-semibold text-argent tracking-tight leading-[1.15]">
                  Stop agents before they overspend.
                </h1>
              </div>

              <p className="text-rule text-base sm:text-lg font-normal leading-relaxed">
                Local admission control for Orbio inference. Every request is priced before dispatch. Calls that do not fit the budget never reach the gateway.
              </p>

              {/* Action Buttons */}
              <div className="flex flex-wrap items-center gap-3 pt-2 font-mono text-xs">
                <button
                  onClick={() => scrollToSection('quickstart')}
                  className="px-4 py-2 rounded-lg bg-argent text-chassis font-semibold hover:bg-white transition shadow-sm cursor-pointer"
                >
                  Quickstart ↓
                </button>
                <button
                  onClick={() => scrollToSection('evidence')}
                  className="px-4 py-2 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] text-argent border border-white/10 transition cursor-pointer flex items-center space-x-1.5"
                >
                  <Play className="w-3 h-3 fill-current text-rule" />
                  <span>View Evidence Replay</span>
                </button>
                <a
                  href="https://github.com/Dolaporr/sentinel"
                  target="_blank"
                  rel="noreferrer"
                  className="px-3 py-2 rounded-lg text-rule hover:text-argent transition flex items-center space-x-1.5"
                >
                  <GithubIcon size={14} />
                  <span>GitHub</span>
                  <ExternalLink className="w-3 h-3 text-rule-dim" />
                </a>
              </div>
            </div>

            {/* Right Column: Live Intercepting Terminal Simulation */}
            <div className="lg:col-span-6 animate-fade-in-up delay-150">
              <div className="glass-card rounded-2xl overflow-hidden font-mono text-xs sm:text-[13px] leading-relaxed shadow-2xl transition-all">
                {/* Terminal Header */}
                <div className="px-4 py-2.5 border-b border-white/[0.08] bg-white/[0.02] flex items-center justify-between text-rule-dim text-[11px]">
                  <div className="flex items-center space-x-2">
                    <span className="w-2.5 h-2.5 rounded-full bg-red-400/30 border border-red-400/40" />
                    <span className="w-2.5 h-2.5 rounded-full bg-amber-400/30 border border-amber-400/40" />
                    <span className="w-2.5 h-2.5 rounded-full bg-emerald-400/30 border border-emerald-400/40" />
                    <span className="ml-2 tracking-wide font-mono text-[11px] text-rule-dim">
                      127.0.0.1:8787 · proxy.log
                    </span>
                  </div>
                  <span className="text-[10px] px-2 py-0.5 rounded-full border border-white/10 bg-white/[0.03] text-rule-dim tabular-nums">
                    {visibleLineCount === TERMINAL_LINES.length ? 'refused · 402' : 'intercepting...'}
                  </span>
                </div>

                {/* Log Stream */}
                <div className="p-4 sm:p-5 space-y-1.5 min-h-[250px] select-text overflow-x-auto bg-chassis/40">
                  {TERMINAL_LINES.slice(0, visibleLineCount).map((line, idx) => {
                    if (line.type === 'startup') {
                      return (
                        <div key={idx} className="text-rule">
                          {line.text}
                        </div>
                      );
                    }
                    if (line.type === 'admitted') {
                      return (
                        <div key={idx} className="text-argent-muted tabular-nums whitespace-pre">
                          {line.text}
                        </div>
                      );
                    }
                    if (line.type === 'dots') {
                      return (
                        <div key={idx} className="text-rule-dim tracking-widest pl-1">
                          {line.text}
                        </div>
                      );
                    }
                    if (line.type === 'refused') {
                      return (
                        <div key={idx} className="bg-red-500/[0.08] border border-red-500/20 rounded px-2 py-1 text-crimson-bright font-semibold my-1 whitespace-pre">
                          {line.text}
                        </div>
                      );
                    }
                    if (line.type === 'outcome') {
                      return (
                        <div key={idx} className="text-crimson/90 font-medium pl-2 whitespace-pre">
                          {line.text}
                        </div>
                      );
                    }
                    return null;
                  })}
                  {visibleLineCount < TERMINAL_LINES.length && !isReducedMotion && (
                    <span className="inline-block w-1.5 h-3.5 bg-rule animate-pulse align-middle ml-0.5" />
                  )}
                </div>
              </div>
            </div>
          </div>
        </section>


        {/* ─── 01. PRODUCT / QUICKSTART SECTION ─── */}
        <ScrollReveal delay={50}>
          <section id="quickstart" className="border-t border-white/[0.08] pt-8 sm:pt-14 space-y-6">
            <div className="flex items-center justify-between text-xs font-mono text-rule">
              <span className="uppercase tracking-wider">// 01 · Quickstart</span>
              <span>local proxy · ready in 5s</span>
            </div>

            <div className="glass-card rounded-2xl p-5 sm:p-7 space-y-5 border border-white/[0.1]">
              <div className="space-y-1">
                <h2 className="text-base sm:text-lg font-semibold text-argent tracking-tight font-mono">
                  Spin up the local spend governor
                </h2>
                <p className="text-xs sm:text-sm text-rule">
                  Point your agent or tool at the loopback proxy and it cannot spend past your configured daily ceiling.
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Command Card */}
                <div className="space-y-1.5">
                  <span className="text-[11px] font-mono text-rule-dim uppercase tracking-wider">
                    Step 1 · Start Sentinel
                  </span>
                  <div
                    onClick={() => copyToClipboard('npx github:Dolaporr/sentinel --budget 5', 'command')}
                    className="group glass-card glass-card-hover rounded-xl p-3.5 sm:p-4 flex items-center justify-between gap-3 cursor-pointer transition-all"
                    title="Click to copy start command"
                  >
                    <div className="flex items-center space-x-2 overflow-hidden">
                      <span className="text-rule-dim font-mono text-xs select-none">$</span>
                      <code className="font-mono text-xs sm:text-[13px] text-argent group-hover:text-white select-all break-all">
                        npx github:Dolaporr/sentinel --budget 5
                      </code>
                    </div>
                    <div className="flex items-center space-x-1.5 shrink-0">
                      <span className="text-[10px] font-mono text-rule-dim hidden sm:inline">
                        {copiedCommand ? 'copied!' : 'copy'}
                      </span>
                      <button
                        type="button"
                        aria-label="Copy command"
                        className="p-1.5 rounded-lg text-rule group-hover:text-white bg-white/[0.04] border border-white/[0.06] transition"
                      >
                        {copiedCommand ? <Check className="w-3.5 h-3.5 text-argent" /> : <Copy className="w-3.5 h-3.5" />}
                      </button>
                    </div>
                  </div>
                </div>

                {/* Base URL Card */}
                <div className="space-y-1.5">
                  <span className="text-[11px] font-mono text-rule-dim uppercase tracking-wider">
                    Step 2 · Point your agent base URL
                  </span>
                  <div
                    onClick={() => copyToClipboard('http://127.0.0.1:8787/v1', 'baseurl')}
                    className="group glass-card glass-card-hover rounded-xl p-3.5 sm:p-4 flex items-center justify-between gap-3 cursor-pointer transition-all"
                    title="Click to copy Base URL"
                  >
                    <div className="flex items-center space-x-2 overflow-hidden">
                      <span className="text-rule-dim font-mono text-xs select-none">URL:</span>
                      <code className="font-mono text-xs sm:text-[13px] text-argent group-hover:text-white select-all break-all">
                        Base URL: http://127.0.0.1:8787/v1
                      </code>
                    </div>
                    <div className="flex items-center space-x-1.5 shrink-0">
                      <span className="text-[10px] font-mono text-rule-dim hidden sm:inline">
                        {copiedBaseUrl ? 'copied!' : 'copy'}
                      </span>
                      <button
                        type="button"
                        aria-label="Copy base URL"
                        className="p-1.5 rounded-lg text-rule group-hover:text-white bg-white/[0.04] border border-white/[0.06] transition"
                      >
                        {copiedBaseUrl ? <Check className="w-3.5 h-3.5 text-argent" /> : <Copy className="w-3.5 h-3.5" />}
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              {/* Protocol & Key Storage Disclosure */}
              <div className="pt-3 border-t border-white/[0.06] space-y-1.5 font-mono text-xs text-rule leading-relaxed">
                <p>
                  The proxy exposes an OpenAI-style <span className="text-argent font-medium">/v1/chat/completions</span> endpoint.
                </p>
                <p className="text-rule-dim">
                  Holds your real upstream key locally in <span className="text-argent">.env</span> as <span className="text-argent">ORBIO_API_KEY</span>. Your agent tool never sees it.
                </p>
              </div>
            </div>
          </section>
        </ScrollReveal>


        {/* ─── 02. THE ORIGIN STORY & THE PROBLEM ─── */}
        <ScrollReveal delay={50}>
          <section className="border-t border-white/[0.08] pt-8 sm:pt-14 max-w-2xl space-y-4 text-argent-muted text-base sm:text-lg leading-relaxed font-normal">
            <p>
              Yash told every builder in Build Week not to point their coding agent at Orbio credits. Most did it anyway. Half the room hit zero.
            </p>
            <p>
              That&apos;s not a discipline problem. A warning can&apos;t refuse a request.
            </p>
            <p className="text-argent font-medium">
              Sentinel sits between your tool and the gateway and decides, before every call, whether you can afford it.
            </p>
          </section>
        </ScrollReveal>


        {/* ─── 03. VISUAL ARCHITECTURE & FLOW ─── */}
        <ScrollReveal delay={50}>
          <section id="architecture" className="border-t border-white/[0.08] pt-8 sm:pt-14 space-y-6">
            <div className="flex items-center justify-between text-xs font-mono text-rule">
              <span className="uppercase tracking-wider">// 02 · How it works</span>
              <span>in-process admission control</span>
            </div>

            <div className="glass-card rounded-2xl p-5 sm:p-8 space-y-6">
              {/* Desktop Horizontal Visual Pipeline */}
              <div className="hidden md:flex items-center justify-between gap-3 font-mono">
                {/* Node 1: Agent / Tool */}
                <div className="flex-1 bg-chassis/80 border border-white/[0.1] rounded-xl p-4 text-center space-y-1">
                  <div className="text-[10px] uppercase tracking-wider text-rule-dim">Client</div>
                  <div className="text-sm font-semibold text-argent">Agent / Tool</div>
                  <div className="text-[11px] text-rule">dispatches request</div>
                </div>

                {/* Arrow 1 */}
                <div className="flex flex-col items-center px-1 shrink-0 text-rule-dim">
                  <span className="text-[10px] mb-1 text-rule">POST /v1/chat/completions</span>
                  <ArrowRight className="w-4 h-4 text-rule" />
                </div>

                {/* Node 2: Sentinel */}
                <div className="flex-[1.4] bg-chassis border border-white/[0.2] rounded-xl p-4 text-center space-y-2 relative shadow-lg">
                  <div className="inline-flex items-center space-x-1 px-2 py-0.5 rounded-full bg-amber-400/[0.08] border border-amber-400/20 text-[10px] text-amber-300 font-medium">
                    <span>holds real key locally</span>
                  </div>
                  <div className="text-base font-bold text-white tracking-tight">Sentinel</div>
                  <div className="flex items-center justify-center space-x-1.5 text-xs text-argent-muted bg-white/[0.03] py-1.5 px-2 rounded-lg border border-white/[0.06]">
                    <span className="text-argent font-semibold">price</span>
                    <span className="text-rule-dim">→</span>
                    <span className="text-argent font-semibold">reserve</span>
                    <span className="text-rule-dim">→</span>
                    <span className="text-argent font-semibold">admit / refuse</span>
                  </div>
                  <div className="text-[10px] text-rule-dim">refused calls return 402 · zero upstream bytes</div>
                </div>

                {/* Arrow 2 */}
                <div className="flex flex-col items-center px-1 shrink-0 text-rule-dim">
                  <span className="text-[10px] mb-1 text-emerald-400/90">admitted only</span>
                  <ArrowRight className="w-4 h-4 text-emerald-400/90" />
                </div>

                {/* Node 3: Orbio Gateway */}
                <div className="flex-1 bg-chassis/80 border border-white/[0.1] rounded-xl p-4 text-center space-y-1">
                  <div className="text-[10px] uppercase tracking-wider text-rule-dim">Upstream</div>
                  <div className="text-sm font-semibold text-argent">Orbio Gateway</div>
                  <div className="text-[11px] text-rule">executes inference</div>
                </div>
              </div>

              {/* Mobile Vertical Visual Pipeline */}
              <div className="md:hidden flex flex-col items-center space-y-2.5 font-mono">
                {/* Node 1 */}
                <div className="w-full bg-chassis/80 border border-white/[0.1] rounded-xl p-3.5 text-center space-y-1">
                  <div className="text-[10px] uppercase tracking-wider text-rule-dim">Client</div>
                  <div className="text-sm font-semibold text-argent">Agent / Tool</div>
                  <div className="text-[11px] text-rule">dispatches to http://127.0.0.1:8787/v1</div>
                </div>

                <div className="flex items-center space-x-2 text-rule py-0.5">
                  <ArrowDown className="w-3.5 h-3.5" />
                  <span className="text-[10px]">POST /v1/chat/completions</span>
                </div>

                {/* Node 2 */}
                <div className="w-full bg-chassis border border-white/[0.22] rounded-xl p-4 text-center space-y-2 shadow-lg">
                  <div className="inline-flex items-center space-x-1 px-2 py-0.5 rounded-full bg-amber-400/[0.08] border border-amber-400/20 text-[10px] text-amber-300 font-medium">
                    <span>the gate · holds key locally</span>
                  </div>
                  <div className="text-base font-bold text-white tracking-tight">Sentinel</div>
                  <div className="flex items-center justify-center space-x-1.5 text-xs text-argent-muted bg-white/[0.03] py-1.5 px-2 rounded-lg border border-white/[0.06]">
                    <span className="text-argent font-semibold">price</span>
                    <span className="text-rule-dim">→</span>
                    <span className="text-argent font-semibold">reserve</span>
                    <span className="text-rule-dim">→</span>
                    <span className="text-argent font-semibold">admit / refuse</span>
                  </div>
                  <div className="text-[10px] text-rule-dim">refused calls return 402 · never dispatched</div>
                </div>

                <div className="flex items-center space-x-2 text-emerald-400/90 py-0.5">
                  <ArrowDown className="w-3.5 h-3.5" />
                  <span className="text-[10px]">admitted requests only</span>
                </div>

                {/* Node 3 */}
                <div className="w-full bg-chassis/80 border border-white/[0.1] rounded-xl p-3.5 text-center space-y-1">
                  <div className="text-[10px] uppercase tracking-wider text-rule-dim">Upstream</div>
                  <div className="text-sm font-semibold text-argent">Orbio Gateway</div>
                  <div className="text-[11px] text-rule">executes model · returns exact token cost</div>
                </div>
              </div>

              {/* Three Technical Principles */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6 pt-5 border-t border-white/[0.08] font-mono text-xs sm:text-[13px] text-rule">
                <div className="space-y-1">
                  <p className="text-argent font-medium">1. Worst-case reservation</p>
                  <p className="text-rule-dim leading-relaxed">
                    Prices every incoming call before dispatch based on model rate cards and requested max output tokens.
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="text-argent font-medium">2. Process admission</p>
                  <p className="text-rule-dim leading-relaxed">
                    Refuses any call exceeding remaining budget with HTTP 402 before any packet leaves the process.
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="text-argent font-medium">3. Exact reconciliation</p>
                  <p className="text-rule-dim leading-relaxed">
                    Commits the real cost from the response and immediately returns unspent reserved budget.
                  </p>
                </div>
              </div>

              <p className="text-xs font-mono text-rule-dim pt-1 text-center md:text-left">
                The key detail: the key lives in the middle box. Your editor never sees it.
              </p>
            </div>
          </section>
        </ScrollReveal>


        {/* ─── 04. STRONG PROOF BLOCK (CONCURRENCY & LIVE VERIFICATION) ─── */}
        <ScrollReveal delay={50}>
          <section id="proof" className="border-t border-white/[0.08] pt-8 sm:pt-14 space-y-6">
            <div className="flex items-center justify-between text-xs font-mono text-rule">
              <span className="uppercase tracking-wider">// 03 · Technical Proof</span>
              <span>measured concurrency</span>
            </div>

            <div className="glass-card rounded-2xl p-6 sm:p-8 space-y-6 border border-white/[0.12]">
              <div className="space-y-3">
                <div className="flex items-center space-x-2 text-amber-400 font-mono text-xs uppercase tracking-wider">
                  <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
                  <span>The Race Condition</span>
                </div>
                <h2 className="text-2xl sm:text-3xl font-semibold text-argent tracking-tight font-mono leading-snug">
                  20 concurrent calls. $100 balance. 313ms to drain it.
                </h2>
                <p className="text-base sm:text-lg text-rule font-normal leading-relaxed">
                  A polling watchdog was already too late. Sentinel moved the decision before dispatch.
                </p>
              </div>

              {/* Verified Metrics Breakdown */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-4 border-t border-white/[0.08] font-mono text-xs">
                <div className="p-3.5 rounded-lg bg-chassis/60 border border-white/[0.06] space-y-1">
                  <p className="text-rule-dim">Live verification</p>
                  <p className="text-argent font-medium">45 live calls · real money</p>
                  <p className="text-[11px] text-rule">Tested against live Orbio gateway, not mocks.</p>
                </div>
                <div className="p-3.5 rounded-lg bg-chassis/60 border border-white/[0.06] space-y-1">
                  <p className="text-rule-dim">Exact reconciliation</p>
                  <p className="text-argent font-medium">Zero estimated cost</p>
                  <p className="text-[11px] text-rule">Ledger matches gateway usage.cost to the last digit.</p>
                </div>
                <div className="p-3.5 rounded-lg bg-chassis/60 border border-white/[0.06] space-y-1">
                  <p className="text-rule-dim">Proxy overhead</p>
                  <p className="text-argent font-medium">&lt; run noise floor</p>
                  <p className="text-[11px] text-rule">Streamed calls commit exact with zero perceptible latency.</p>
                </div>
              </div>

              {/* Direct Verification Document Link */}
              <div className="pt-2 flex flex-wrap items-center gap-4 font-mono text-xs">
                <a
                  href="https://github.com/Dolaporr/sentinel/blob/main/docs/PROXY_VERIFICATION.md"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center space-x-1.5 text-argent underline underline-offset-4 decoration-rule-dim hover:decoration-argent transition-colors"
                >
                  <span>the full verification report (docs/PROXY_VERIFICATION.md)</span>
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
                <span className="text-rule-dim hidden sm:inline">
                  (generated by the verification script; numbers cannot drift)
                </span>
              </div>
            </div>
          </section>
        </ScrollReveal>


        {/* ─── 05. EVIDENCE SECTION: THREE-AGENT REPLAY EXPERIMENT (CENTERPIECE) ─── */}
        <ScrollReveal delay={50}>
          <section id="evidence" className="border-t border-white/[0.08] pt-8 sm:pt-14 space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-3 text-xs font-mono text-rule">
              <div className="flex items-center space-x-2">
                <span className="uppercase tracking-wider">// 04 · Evidence</span>
                <span>·</span>
                <span className="text-argent">Controlled Experiment Replay</span>
              </div>
              <button
                onClick={onNavigateReplay}
                className="flex items-center space-x-1.5 text-argent hover:text-white bg-white/[0.06] hover:bg-white/[0.1] px-2.5 py-1 rounded border border-white/10 transition cursor-pointer"
                title="Open full-screen telemetry console"
              >
                <Maximize2 className="w-3 h-3" />
                <span>Open Full-Screen Console ↗</span>
              </button>
            </div>

            <div className="space-y-2">
              <h2 className="text-xl sm:text-2xl font-semibold text-argent tracking-tight font-mono">
                Controlled Telemetry Arena
              </h2>
              <p className="text-xs sm:text-sm text-rule font-mono">
                Three AI agents · identical task · $0.25 budget each · {events.length} live telemetry calls replayed concurrently from start.
              </p>
            </div>

            {/* Embedded Replay Frame */}
            <div className="rounded-2xl border border-ledger-border overflow-hidden bg-chassis flex flex-col shadow-2xl h-[660px] sm:h-[700px]">
              {/* Replay Tape Controls */}
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
              {replayError && (
                <div className="p-3 bg-crimson/20 border-b border-crimson/40 text-crimson-bright text-xs font-mono">
                  Feed Load Error: {replayError}
                </div>
              )}

              {/* Loading State or Live Split Screen */}
              {isReplayLoading ? (
                <div className="flex-1 flex items-center justify-center font-mono text-xs text-rule">
                  <span>Loading telemetry fixture from sample-feed.jsonl...</span>
                </div>
              ) : (
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

            {/* Context Explainer underneath the centerpiece */}
            <div className="pt-1 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs font-mono text-rule-dim">
              <p>
                Divergence Point: 04:00.962 · Unprotected overshot $0.25 ceiling ($0.2960) · Governed stopped before dispatch ($0.1683).
              </p>
              <button
                onClick={onNavigateReplay}
                className="text-argent underline underline-offset-4 decoration-rule-dim hover:decoration-argent transition-colors self-start sm:self-auto cursor-pointer"
              >
                Expand in full-screen console →
              </button>
            </div>
          </section>
        </ScrollReveal>


        {/* ─── 06. LIMITATIONS SECTION ─── */}
        <ScrollReveal delay={50}>
          <section id="limitations" className="border-t border-white/[0.08] pt-8 sm:pt-14 space-y-4">
            <div className="flex items-center justify-between text-xs font-mono text-rule">
              <span className="uppercase tracking-wider">// 05 · Limitations</span>
              <span>strict operational boundaries</span>
            </div>

            <h2 className="text-sm font-mono uppercase tracking-wider text-rule">
              What it doesn&apos;t do
            </h2>

            <div className="glass-card rounded-2xl p-6 sm:p-8">
              <ul className="space-y-3 text-sm sm:text-base text-argent-muted leading-relaxed list-disc list-outside pl-4 font-normal">
                <li>The cap is per machine, not per account.</li>
                <li>
                  Any local process can reach the proxy. It&apos;s loopback trust, not authentication — but nothing in your editor&apos;s settings holds a key that can spend.
                </li>
                <li>Anything that bypasses the proxy is ungoverned.</li>
                <li>Streamed responses don&apos;t yet report whether the cost was exact or estimated.</li>
              </ul>
            </div>

            <p className="text-xs font-mono text-rule-dim pt-2">
              Full list in{' '}
              <a
                href="https://github.com/Dolaporr/sentinel/blob/main/docs/LIMITATIONS.md"
                target="_blank"
                rel="noreferrer"
                className="text-argent underline underline-offset-4 decoration-rule-dim hover:decoration-argent transition-colors"
              >
                LIMITATIONS.md
              </a>
              .
            </p>
          </section>
        </ScrollReveal>
      </main>


      {/* ─── 07. CONSOLE FOOTER ─── */}
      <ScrollReveal delay={50}>
        <footer className="border-t border-white/[0.08] py-8 px-4 sm:px-8 font-mono text-xs text-rule flex flex-wrap items-center justify-between gap-4 max-w-5xl mx-auto">
          <div className="flex flex-wrap items-center gap-4">
            <a
              href="https://github.com/Dolaporr/sentinel"
              target="_blank"
              rel="noreferrer"
              className="flex items-center space-x-1.5 hover:text-argent transition-colors"
            >
              <GithubIcon size={14} />
              <span>github.com/Dolaporr/sentinel</span>
            </a>
            <span className="text-white/20">·</span>
            <button
              onClick={onNavigateReplay}
              className="flex items-center space-x-1.5 hover:text-argent transition-colors cursor-pointer group"
            >
              <Play className="w-3 h-3 fill-current text-rule group-hover:text-argent transition-colors" />
              <span>replay viewer</span>
            </button>
            <span className="text-white/20">·</span>
            <a
              href="https://github.com/Dolaporr/sentinel/blob/main/docs/PROXY_VERIFICATION.md"
              target="_blank"
              rel="noreferrer"
              className="hover:text-argent transition-colors"
            >
              evidence doc
            </a>
          </div>

          <div className="text-rule-dim">
            built for{' '}
            <a
              href="https://www.orbio.so/build"
              target="_blank"
              rel="noreferrer"
              className="hover:text-argent transition-colors"
            >
              Orbio Build Week
            </a>
          </div>
        </footer>
      </ScrollReveal>
    </div>
  );
};
