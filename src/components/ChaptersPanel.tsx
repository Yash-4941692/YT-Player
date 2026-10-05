import { useEffect, useRef } from 'react';
import { ChevronRight, CirclePlay, Clock3, ListMusic, MoveUpRight } from 'lucide-react';
import type { Chapter } from '../types';
import { formatTime } from '../lib/youtube';

interface Props {
  chapters: Chapter[];
  activeIndex: number;
  currentTime: number;
  onSeek: (seconds: number) => void;
  onAddTimestamps?: () => void;
  compact?: boolean;
}

export function ChaptersPanel({ chapters, activeIndex, currentTime, onSeek, onAddTimestamps, compact = false }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const pauseUntilRef = useRef(0);
  const programmaticRef = useRef(false);
  const activeIndexRef = useRef(activeIndex);
  const resumeScrollRef = useRef(0);
  const programmaticResetRef = useRef(0);
  activeIndexRef.current = activeIndex;

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const handleScroll = () => {
      if (programmaticRef.current) return;
      pauseUntilRef.current = Date.now() + 4000;
      window.clearTimeout(resumeScrollRef.current);
      resumeScrollRef.current = window.setTimeout(() => {
        const row = rowRefs.current[activeIndexRef.current];
        if (!row) return;
        programmaticRef.current = true;
        row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        window.clearTimeout(programmaticResetRef.current);
        programmaticResetRef.current = window.setTimeout(() => { programmaticRef.current = false; }, 800);
      }, 4000);
    };
    element.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      element.removeEventListener('scroll', handleScroll);
      window.clearTimeout(resumeScrollRef.current);
      window.clearTimeout(programmaticResetRef.current);
    };
  }, []);

  useEffect(() => {
    if (activeIndex < 0 || Date.now() < pauseUntilRef.current) return;
    const activeRow = rowRefs.current[activeIndex];
    if (!activeRow) return;
    programmaticRef.current = true;
    activeRow.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    window.clearTimeout(programmaticResetRef.current);
    programmaticResetRef.current = window.setTimeout(() => { programmaticRef.current = false; }, 800);
    return () => {
      window.clearTimeout(programmaticResetRef.current);
      programmaticRef.current = false;
    };
  }, [activeIndex, chapters.length]);

  if (!chapters.length) {
    return (
      <div className="empty-panel chapters-empty">
        <div className="empty-panel-icon"><ListMusic size={20} /></div>
        <strong>Your timestamps live here</strong>
        <p>Paste the timestamps from the video description. The active chapter follows along as you watch.</p>
        {onAddTimestamps
          ? <button className="button-outline small-outline" onClick={onAddTimestamps}><ListMusic size={14} /> Add timestamps</button>
          : <span className="example-code">00:00 · Introduction</span>}
      </div>
    );
  }

  const active = activeIndex >= 0 ? chapters[activeIndex] : null;
  const dividerIndex = activeIndex >= 0 ? activeIndex + 1 : 0;

  return (
    <div className={`chapters-panel ${compact ? 'compact-chapters' : ''}`}>
      <div className="now-playing-card">
        <div className="now-playing-icon"><CirclePlay size={17} /></div>
        <div className="now-playing-copy">
          <span>NOW PLAYING</span>
          <strong>{active?.label ?? 'Before the first chapter'}</strong>
        </div>
        <div className="now-playing-time"><Clock3 size={12} /> {formatTime(currentTime)}</div>
      </div>
      <div className="chapters-scroll" ref={scrollRef}>
        {chapters.map((chapter, index) => (
          <div key={`${chapter.seconds}-${chapter.label}-${index}`}>
            {index === dividerIndex && <div className="up-next-divider"><span /> UP NEXT <span /></div>}
            <button
              ref={(element) => { rowRefs.current[index] = element; }}
              className={`chapter-row ${index === activeIndex ? 'active' : ''} ${index < activeIndex ? 'chapter-past' : ''}`}
              onClick={() => onSeek(chapter.seconds)}
              aria-current={index === activeIndex ? 'true' : undefined}
              title={`Jump to ${chapter.label}`}
            >
              <span className="chapter-time">{chapter.timeLabel}</span>
              <span className="chapter-label">{chapter.label}</span>
              <span className="chapter-indicator">{index === activeIndex ? <span className="equalizer"><i /><i /><i /></span> : <ChevronRight size={15} />}</span>
            </button>
          </div>
        ))}
        {dividerIndex >= chapters.length && <div className="up-next-divider end-divider"><span /> END OF CHAPTERS <span /></div>}
      </div>
      <div className="chapter-footnote"><MoveUpRight size={12} /> Select any chapter to jump straight to it</div>
    </div>
  );
}
