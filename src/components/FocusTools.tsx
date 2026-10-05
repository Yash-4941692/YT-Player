import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, ChevronDown, CircleCheck, CirclePlus, Clock3, Minus, Pause, Play, RotateCcw, Target, Trash2 } from 'lucide-react';
import type { FocusSession, StudyTask } from '../types';

interface Props {
  sessions: FocusSession[];
  goalMinutes: number;
  tasks: StudyTask[];
  onComplete: (minutes: number) => void;
  onGoalChange: (minutes: number) => void;
  onAddTask: (title: string) => void;
  onToggleTask: (taskId: string) => void;
  onRemoveTask: (taskId: string) => void;
}

function isToday(timestamp: number): boolean {
  const date = new Date(timestamp);
  const today = new Date();
  return date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
}

function clock(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
}

export function FocusTools({ sessions, goalMinutes, tasks, onComplete, onGoalChange, onAddTask, onToggleTask, onRemoveTask }: Props) {
  const todayMinutes = sessions.filter((session) => isToday(session.endedAt)).reduce((total, session) => total + session.minutes, 0);
  const progress = Math.min(100, (todayMinutes / Math.max(goalMinutes, 1)) * 100);
  const [preset, setPreset] = useState(25);
  const [remaining, setRemaining] = useState(25 * 60);
  const [running, setRunning] = useState(false);
  const [taskDraft, setTaskDraft] = useState('');
  const endAtRef = useRef(0);
  const finishRef = useRef(onComplete);
  const completedPresetRef = useRef(preset);
  finishRef.current = onComplete;
  completedPresetRef.current = preset;

  useEffect(() => {
    if (!running) return;
    const update = () => {
      const secondsLeft = Math.max(0, Math.ceil((endAtRef.current - Date.now()) / 1000));
      setRemaining(secondsLeft);
      if (secondsLeft <= 0) {
        setRunning(false);
        finishRef.current(completedPresetRef.current);
      }
    };
    update();
    const timer = window.setInterval(update, 500);
    return () => window.clearInterval(timer);
  }, [running]);

  function choosePreset(value: number) {
    if (running) return;
    setPreset(value);
    setRemaining(value * 60);
  }

  function toggleTimer() {
    if (running) {
      setRemaining(Math.max(0, Math.ceil((endAtRef.current - Date.now()) / 1000)));
      setRunning(false);
    } else {
      if (remaining <= 0) setRemaining(preset * 60);
      endAtRef.current = Date.now() + Math.max(remaining, 1) * 1000;
      setRunning(true);
    }
  }

  function resetTimer() {
    setRunning(false);
    setRemaining(preset * 60);
  }

  function addTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = taskDraft.trim();
    if (!title) return;
    onAddTask(title);
    setTaskDraft('');
  }

  function editGoal() {
    const answer = window.prompt('Set your daily JEE study goal in minutes:', String(goalMinutes));
    if (answer === null) return;
    const value = Number(answer);
    if (Number.isFinite(value) && value >= 15 && value <= 1440) onGoalChange(Math.round(value));
  }

  return (
    <section className="study-tools glass-card">
      <div className="section-heading tools-heading">
        <div><p className="eyebrow">STAY IN THE FLOW</p><h3>Focus tools</h3></div>
        <span className="tiny-icon violet"><Target size={15} /></span>
      </div>

      <div className="goal-mini">
        <div className="goal-topline"><span>Today's study goal</span><button className="text-button" onClick={editGoal}>Edit target</button></div>
        <div className="goal-numbers"><strong>{todayMinutes}<small> min</small></strong><span>of {goalMinutes} min</span></div>
        <div className="progress-track goal-progress"><span style={{ width: `${progress}%` }} /></div>
        <div className="goal-bottomline"><span>{progress >= 100 ? 'Daily target reached — excellent work.' : `${Math.max(goalMinutes - todayMinutes, 0)} min to your target`}</span><span>{Math.round(progress)}%</span></div>
      </div>

      <div className="timer-block">
        <div className="timer-copy"><span className="timer-label"><Clock3 size={13} /> POMODORO</span><strong className={running ? 'timer-running' : ''}>{clock(remaining)}</strong><span>{running ? 'One thing at a time.' : 'A focused session, then a breather.'}</span></div>
        <div className="timer-actions"><button className="timer-main-button" onClick={toggleTimer} aria-label={running ? 'Pause focus timer' : 'Start focus timer'}>{running ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}</button><button className="timer-reset-button" onClick={resetTimer} aria-label="Reset timer"><RotateCcw size={14} /></button></div>
        <div className="timer-presets"><button className={preset === 25 ? 'selected' : ''} onClick={() => choosePreset(25)} disabled={running}>25 min</button><button className={preset === 50 ? 'selected' : ''} onClick={() => choosePreset(50)} disabled={running}>50 min</button></div>
      </div>

      <details className="plan-block">
        <summary className="plan-title"><span className="plan-title-copy"><span className="eyebrow">YOUR CHECKLIST</span><strong>Today's plan</strong></span><span className="plan-summary-count">{tasks.filter((task) => task.done).length}/{tasks.length} done</span><ChevronDown className="plan-chevron" size={18} /></summary>
        <form className="task-add-form" onSubmit={addTask}><input value={taskDraft} onChange={(event) => setTaskDraft(event.target.value)} placeholder="Add a topic to revise…" aria-label="New study task" maxLength={100} /><button type="submit" aria-label="Add task" disabled={!taskDraft.trim()}><CirclePlus size={18} /></button></form>
        {tasks.length === 0 ? <p className="task-empty">Add a short list for this study session.</p> : (
          <ul className="task-list">
            {tasks.slice(0, 5).map((task) => <li key={task.id} className={task.done ? 'task-done' : ''}><button className="task-check" onClick={() => onToggleTask(task.id)} aria-label={task.done ? 'Mark task incomplete' : 'Complete task'}>{task.done ? <Check size={13} /> : <span />}</button><span>{task.title}</span><button className="task-remove" onClick={() => onRemoveTask(task.id)} aria-label={`Remove ${task.title}`}><Trash2 size={14} /></button></li>)}
          </ul>
        )}
        {tasks.length > 5 && <p className="task-overflow"><CircleCheck size={14} /> {tasks.length - 5} more in today's plan</p>}
      </details>
      <p className="timer-disclaimer"><Minus size={12} /> Focus sessions are saved to your study history when the timer completes.</p>
    </section>
  );
}
